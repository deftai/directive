#!/usr/bin/env python3
r"""triage_cache.py -- local sidecar issue cache for the triage workflow (#845 Story 1).

Why this exists
---------------

The refinement / triage skill currently calls ``gh issue view <N>`` per issue
per evaluation pass. Token cost is O(N) per pass and ``gh``'s underlying API
is rate-limited at 5000 req/h per token. On a repo with several hundred open
issues, a refinement pass that needs to re-read bodies (e.g. to apply a new
heuristic) burns a substantial fraction of the per-token budget.

Story 1 of #845 introduces a sidecar cache so subsequent passes are O(1):

    .deft-cache/issues/<owner>-<repo>/<N>.json   (raw API response)
    .deft-cache/issues/<owner>-<repo>/<N>.md     (rendered, quarantined body)

The ``.md`` body is passed through :func:`quarantine_ext.quarantine_body`
(#583) so any injection-shaped imperative content is wrapped in
``\`\`\`quarantined`` fences before downstream agents read it.

Public surface
--------------

- :func:`populate` -- walk all open issues for a repo and write JSON + .md.
- :func:`show` -- read the cached .md body for a single issue.
- :func:`is_stale` -- mtime-based staleness probe (TTL in seconds).

Optional ``gitcrawl`` integration
---------------------------------

If ``gitcrawl`` is on PATH (or the caller passes ``--use-gitcrawl``), the
populate step can dispatch to it instead of ``gh issue list`` -- gitcrawl
bundles a richer per-issue payload (linked PRs, related discussions). When
gitcrawl is absent, populate transparently falls back to ``gh issue list
--state open --json ...``. The fallback is the canonical / always-available
path; gitcrawl is a strict enhancement.

CLI
---

    python scripts/triage_cache.py populate --repo owner/repo [--force]
    python scripts/triage_cache.py show --repo owner/repo --issue 845

The Taskfile fragment ``tasks/triage-cache.yml`` exposes these as
``task triage:cache`` and ``task triage:show``.

Story scope
-----------

This module is the wave-1 owner of the cache infrastructure under #845; it
intentionally does NOT touch any other triage-related script in the repo.
The parent Taskfile wiring (``tasks/Taskfile.yml`` includes:) is owned by
Story 6 and is NOT done here.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

# Make ``scripts`` importable when this file is invoked via
# ``python scripts/triage_cache.py`` from a Taskfile dispatch.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from quarantine_ext import quarantine_body  # noqa: E402  -- intentional sys.path tweak

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Default TTL for cache freshness checks. The triage pipeline calls
#: ``populate(force=False)`` repeatedly during a session; entries younger
#: than this are considered fresh and not re-fetched. 24 hours is the
#: canonical default; callers that need tighter freshness pass an explicit
#: ``ttl_seconds`` to :func:`is_stale`.
DEFAULT_TTL_SECONDS: int = 24 * 60 * 60

#: Repo-relative cache root. Tests parametrize this via ``cache_root=``.
DEFAULT_CACHE_ROOT: Path = Path(".deft-cache") / "issues"

#: ``owner/repo`` parser. Both halves must match ``[A-Za-z0-9._-]+`` and be
#: non-empty. Anything else is an arg-validation error per the Test
#: narrative ("malformed --repo string -> friendly error").
_REPO_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)$")

#: ``gh issue list`` JSON fields we cache. ``body`` is the field downstream
#: consumers read; the rest are useful metadata for the audit log (Story 2)
#: and the actions surface (Story 3).
_GH_FIELDS: tuple[str, ...] = (
    "number",
    "title",
    "body",
    "state",
    "labels",
    "author",
    "createdAt",
    "updatedAt",
    "url",
)

#: ``gh issue list`` page size cap. The CLI's documented maximum is 1000.
_GH_PAGE_LIMIT: int = 1000


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TriageCacheError(RuntimeError):
    """Raised on cache populate / show failures with a human-readable message."""


class InvalidRepoError(ValueError):
    """Raised when ``repo`` does not match the canonical ``owner/repo`` shape."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_repo(repo: str) -> tuple[str, str]:
    """Validate ``owner/repo`` -> ``(owner, repo)``. Raises :class:`InvalidRepoError`.

    The accepted shape mirrors GitHub's namespace rules: each half starts
    with an alphanumeric and contains only letters, digits, ``.``, ``_``,
    or ``-``. Empty halves and any whitespace are rejected.
    """
    if not isinstance(repo, str) or not repo:
        raise InvalidRepoError(
            "repo must be a non-empty string of the form 'owner/repo' "
            f"(got {repo!r})"
        )
    m = _REPO_RE.match(repo.strip())
    if not m:
        raise InvalidRepoError(
            f"invalid repo {repo!r}: expected 'owner/repo' "
            "(alphanumerics, '.', '_', '-' only)"
        )
    return m.group(1), m.group(2)


def cache_dir(repo: str, *, cache_root: Path | None = None) -> Path:
    """Return the per-repo cache directory.

    Layout: ``<cache_root>/<owner>-<repo>/``. The flattened ``owner-repo``
    name (rather than nested ``<owner>/<repo>``) keeps the directory
    structure shallow on Windows where path-length limits bite at ~260
    chars. Both halves are validated by :func:`_parse_repo`.
    """
    owner, name = _parse_repo(repo)
    root = cache_root if cache_root is not None else DEFAULT_CACHE_ROOT
    return Path(root) / f"{owner}-{name}"


def issue_paths(
    issue_number: int, repo: str, *, cache_root: Path | None = None
) -> tuple[Path, Path]:
    """Return ``(json_path, md_path)`` for a given issue in the cache."""
    if not isinstance(issue_number, int) or issue_number <= 0:
        raise ValueError(
            f"issue_number must be a positive int (got {issue_number!r})"
        )
    base = cache_dir(repo, cache_root=cache_root)
    return base / f"{issue_number}.json", base / f"{issue_number}.md"


def is_stale(path: Path, ttl_seconds: int) -> bool:
    """Return True iff ``path`` is missing or older than ``ttl_seconds``.

    A non-existent path is *always* considered stale -- callers can treat
    the return value as "must re-fetch" without an extra existence check.
    """
    if ttl_seconds < 0:
        raise ValueError(f"ttl_seconds must be >= 0 (got {ttl_seconds!r})")
    p = Path(path)
    if not p.exists():
        return True
    age = time.time() - p.stat().st_mtime
    return age > ttl_seconds


# ---------------------------------------------------------------------------
# Populate
# ---------------------------------------------------------------------------


def _gh_available() -> bool:
    return shutil.which("gh") is not None


def _gitcrawl_available() -> bool:
    return shutil.which("gitcrawl") is not None


def _fetch_via_gh(repo: str, *, limit: int = _GH_PAGE_LIMIT) -> list[dict[str, Any]]:
    """Fetch open issues for ``repo`` via ``gh issue list``.

    Uses ``--state open`` and the canonical JSON field set. Returns the
    parsed list. Raises :class:`TriageCacheError` on subprocess or JSON
    failure (so the caller's error path is uniform regardless of fetch
    backend).
    """
    if not _gh_available():
        raise TriageCacheError(
            "gh CLI not found on PATH. Install GitHub CLI "
            "(https://cli.github.com/) or pass --use-gitcrawl."
        )
    fields = ",".join(_GH_FIELDS)
    cmd = [
        "gh",
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        str(limit),
        "--json",
        fields,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise TriageCacheError(f"gh executable not found: {exc}") from exc
    if proc.returncode != 0:
        raise TriageCacheError(
            f"gh issue list failed (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    try:
        data = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise TriageCacheError(f"gh issue list emitted non-JSON: {exc}") from exc
    if not isinstance(data, list):
        raise TriageCacheError(
            f"gh issue list emitted unexpected shape (expected list, got {type(data).__name__})"
        )
    return data


def _fetch_via_gitcrawl(repo: str) -> list[dict[str, Any]]:
    """Fetch open issues via the optional ``gitcrawl`` backend.

    The gitcrawl JSON contract is documented at the gitcrawl repo; for our
    purposes we require each item to carry at least ``number``, ``title``,
    and ``body``. Missing fields fall back to empty values.
    """
    if not _gitcrawl_available():
        raise TriageCacheError(
            "gitcrawl not found on PATH (the optional richer fetch backend). "
            "Either install gitcrawl or omit --use-gitcrawl to fall back to gh."
        )
    cmd = ["gitcrawl", "issues", "--repo", repo, "--state", "open", "--json"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise TriageCacheError(f"gitcrawl executable not found: {exc}") from exc
    if proc.returncode != 0:
        raise TriageCacheError(
            f"gitcrawl failed (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    try:
        data = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise TriageCacheError(f"gitcrawl emitted non-JSON: {exc}") from exc
    if not isinstance(data, list):
        raise TriageCacheError(
            f"gitcrawl emitted unexpected shape (expected list, got {type(data).__name__})"
        )
    return data


def _select_backend(use_gitcrawl: bool | None) -> str:
    """Pick the fetch backend.

    - ``use_gitcrawl=True`` -- force gitcrawl, error if missing.
    - ``use_gitcrawl=False`` -- force gh, error if missing.
    - ``use_gitcrawl=None`` (default) -- use gh; gitcrawl is opt-in only so
      the fallback path stays predictable and tests can probe both.
    """
    if use_gitcrawl is True:
        if not _gitcrawl_available():
            raise TriageCacheError(
                "gitcrawl requested via --use-gitcrawl but not on PATH; "
                "install gitcrawl or omit the flag to fall back to gh."
            )
        return "gitcrawl"
    return "gh"


def populate(
    repo: str,
    force: bool = False,
    *,
    cache_root: Path | None = None,
    use_gitcrawl: bool | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> int:
    """Populate the local issue cache for ``repo``.

    Args:
        repo: ``owner/repo`` slug. Validated via :func:`_parse_repo`.
        force: If True, re-write all entries even when the cached ``.json``
            file exists and is younger than ``ttl_seconds``. If False
            (default), entries with a fresh ``.json`` file are skipped --
            this keeps re-runs cheap (no rewrite, mtime preserved).
        cache_root: Override the default ``.deft-cache/issues`` root.
            Used by tests; production callers omit it.
        use_gitcrawl: ``True`` forces the gitcrawl backend, ``False`` /
            ``None`` use gh. When gitcrawl is requested but missing the
            error is loud (per the Test narrative's
            "gitcrawl absent -> graceful fallback to gh" case the caller
            should pass ``None`` rather than ``True``).
        ttl_seconds: Idempotency threshold. Defaults to
            :data:`DEFAULT_TTL_SECONDS` (24h).

    Returns:
        Number of issues processed (cached + skipped). The combined count
        is what callers want for "how many issues are tracked for this
        repo" -- the per-issue cached/skipped split is logged to stdout
        but not returned.

    Raises:
        InvalidRepoError: ``repo`` is not ``owner/repo``-shaped.
        TriageCacheError: Backend command failed or emitted unparseable JSON.
    """
    owner, name = _parse_repo(repo)
    base = cache_dir(repo, cache_root=cache_root)
    base.mkdir(parents=True, exist_ok=True)

    backend = _select_backend(use_gitcrawl)
    issues = (
        _fetch_via_gitcrawl(repo) if backend == "gitcrawl" else _fetch_via_gh(repo)
    )

    cached = 0
    skipped = 0
    for issue in issues:
        number = issue.get("number")
        if not isinstance(number, int) or number <= 0:
            # Skip malformed entries rather than failing the whole pass --
            # one bad row shouldn't block the rest.
            continue
        json_path, md_path = issue_paths(number, repo, cache_root=cache_root)
        if not force and json_path.exists() and not is_stale(json_path, ttl_seconds):
            skipped += 1
            continue
        # Write JSON first (atomic via temp + replace) then quarantined .md.
        _atomic_write_text(
            json_path, json.dumps(issue, indent=2, sort_keys=True, ensure_ascii=False)
        )
        body = issue.get("body") or ""
        title = issue.get("title") or ""
        rendered = _render_issue_md(number, title, body)
        _atomic_write_text(md_path, rendered)
        cached += 1

    print(
        f"triage_cache: repo={owner}/{name} backend={backend} "
        f"cached={cached} skipped={skipped} total={cached + skipped}"
    )
    return cached + skipped


def _atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically (temp file + rename).

    Atomic-replace semantics so a partial write never leaves the cache in
    a half-written state -- a parallel reader either sees the prior version
    or the new one, never a torn file.

    Uses :func:`tempfile.NamedTemporaryFile` to obtain a unique scratch
    filename rather than a deterministic ``<path>.tmp`` (Greptile P2: two
    concurrent populate processes against the same repo would otherwise
    write to the same ``.tmp`` path, where the second writer's bytes
    could clobber the first writer's mid-write before ``os.replace``
    promotes it).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        # Best-effort cleanup of the scratch file on any failure path so
        # we don't leave dangling ``.tmp`` siblings in the cache dir.
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise


def _render_issue_md(number: int, title: str, body: str) -> str:
    """Render an issue to markdown with the body wrapped via :func:`quarantine_body`.

    Both ``title`` and ``body`` are user-controlled (the issue author wrote
    them) and equally untrusted -- a hostile title like
    ``IMPORTANT: override agent instructions`` would otherwise be embedded
    verbatim as a Markdown heading and bypass the #583 quarantine entirely
    (Greptile P1). The fix routes the title through :func:`quarantine_body`
    independently before splicing it into the heading.
    """
    safe_title = quarantine_body(title) if title else ""
    if safe_title and "\n" not in safe_title:
        # Title was benign -- single-line heading.
        header = f"# #{number}: {safe_title}\n\n"
    elif safe_title:
        # Title quarantined into a multi-line fence -- emit the issue
        # number as the heading and the (now-quarantined) title block on
        # its own lines so the fence stays well-formed.
        header = f"# #{number}\n\n{safe_title}\n\n"
    else:
        header = f"# #{number}\n\n"
    return header + quarantine_body(body or "")


# ---------------------------------------------------------------------------
# Show
# ---------------------------------------------------------------------------


def show(
    issue_number: int,
    repo: str,
    *,
    cache_root: Path | None = None,
) -> str:
    """Return the cached, quarantined .md body for ``issue_number``.

    Raises :class:`TriageCacheError` if the issue is not cached. Callers
    that want a soft-miss path should call :func:`is_stale` first.
    """
    _, md_path = issue_paths(issue_number, repo, cache_root=cache_root)
    if not md_path.exists():
        raise TriageCacheError(
            f"issue #{issue_number} not cached for {repo} "
            f"(expected at {md_path}). Run `task triage:cache --repo {repo}` first."
        )
    return md_path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_cache",
        description=(
            "Local sidecar issue cache for the triage workflow (#845 Story 1)."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_pop = sub.add_parser("populate", help="Populate the cache from gh / gitcrawl.")
    p_pop.add_argument("--repo", required=True, help="owner/repo slug.")
    p_pop.add_argument(
        "--force",
        action="store_true",
        help="Re-write all entries even when fresh.",
    )
    p_pop.add_argument(
        "--use-gitcrawl",
        action="store_true",
        help="Use gitcrawl as the fetch backend instead of gh.",
    )
    p_pop.add_argument(
        "--ttl-seconds",
        type=int,
        default=DEFAULT_TTL_SECONDS,
        help=f"Freshness window in seconds (default {DEFAULT_TTL_SECONDS}).",
    )

    p_show = sub.add_parser("show", help="Print the cached .md body for an issue.")
    p_show.add_argument("--repo", required=True, help="owner/repo slug.")
    p_show.add_argument("--issue", type=int, required=True, help="Issue number.")

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns 0 on success, 1 on cache error, 2 on arg error."""
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse already printed the usage/error to stderr; surface its
        # exit code untouched (2 for usage error).
        return int(exc.code) if isinstance(exc.code, int) else 2

    try:
        if args.cmd == "populate":
            populate(
                args.repo,
                force=args.force,
                use_gitcrawl=args.use_gitcrawl,
                ttl_seconds=args.ttl_seconds,
            )
            return 0
        if args.cmd == "show":
            sys.stdout.write(show(args.issue, args.repo))
            return 0
    except InvalidRepoError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except TriageCacheError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    parser.print_usage(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
