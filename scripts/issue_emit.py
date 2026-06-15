#!/usr/bin/env python3
r"""issue_emit.py -- Emit GitHub issues FROM scope vBRIEFs (the write path).

This is the symmetric reverse of :mod:`scripts.issue_ingest`. Where
``task issue:ingest`` reads a GitHub issue and materialises a scope vBRIEF,
``task issue:emit`` reads one or more scope vBRIEFs and files GitHub
issue(s), then records the resulting issue URL back into each source
vBRIEF's ``plan.references[]`` as an ``x-vbrief/github-issue`` entry with
``TrustLevel: external``. Together the two verbs close the
vBRIEF <-> GitHub-issue trust loop (#1274 Change 2 / epic #1284).

Modes:
    uv run python scripts/issue_emit.py <vbrief-path>
        File ONE issue for the named vBRIEF and write the URL back into it.
    uv run python scripts/issue_emit.py --umbrella <glob> [<glob> ...]
        File ONE umbrella issue with a checklist of the matched vBRIEFs and
        write the umbrella URL back into EVERY matched vBRIEF.
    uv run python scripts/issue_emit.py --per-vbrief <glob> [<glob> ...]
        File one issue per matched vBRIEF.

Flags:
    --dry-run         Print the plan of issues that WOULD be filed; make no
                      forge write and no on-disk vBRIEF mutation.
    --repo OWNER/REPO Target repo (highest precedence; falls back to
                      $DEFT_PROJECT_REPO / git remote detection).
    --project-root    Consumer project root for repo / glob anchoring.
    --title           Umbrella issue title override (--umbrella mode only).
    --json            Emit a machine-readable JSON summary instead of prose.

Network honour:
    ``DEFT_NO_NETWORK=1`` is treated identically to ``--dry-run`` -- a plan
    is printed, no issue is filed, and no source vBRIEF is mutated on disk.

Idempotency:
    A source vBRIEF that already carries a matching ``x-vbrief/github-issue``
    reference is detected and skipped rather than re-filed, so a re-run does
    not create duplicate issues.

All ``gh`` invocations route through :func:`scripts.scm.call` (#1145 / N5)
so the SCM boundary holds; the issue body is passed via
``gh issue create --body-file`` (written as pathlib UTF-8) rather than an
inline ``--body`` so non-ASCII narrative glyphs survive the round-trip.

Exit codes:
    0 -- emit completed (including dry-run / no-network plans and pure-skip)
    2 -- usage / configuration / forge error

Story: #1274 Change 2 (task issue:emit); epic #1284.
"""

from __future__ import annotations

import argparse
import contextlib
import glob as globlib
import json
import os
import re
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

# Make sibling scripts importable both when run as __main__ and when imported
# by tests that pre-populate sys.path with the ``scripts/`` directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _project_context import resolve_project_repo, resolve_project_root  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402

import scm  # noqa: E402 -- sibling-first path insertion above is intentional

reconfigure_stdio()

# --- Constants --------------------------------------------------------------

#: Canonical reference type recorded on a source vBRIEF after a successful
#: emit. Matches ``conventions/references.md`` and the
#: ``EXTERNAL_REFERENCE_TYPES`` set in ``scripts/_vbrief_build.py``.
GITHUB_ISSUE_REF_TYPE = "x-vbrief/github-issue"

#: TrustLevel stamped on the emitted reference. An issue filed from a
#: vBRIEF lives on the external forge, so it is ``external`` (the same
#: default ``reference_with_default_trust`` would assign).
EXTERNAL_TRUST_LEVEL = "external"

#: Extracts the browser issue URL from ``gh issue create`` stdout. gh prints
#: the created issue URL (e.g. ``https://github.com/o/r/issues/42``) as the
#: final line of stdout on success.
_ISSUE_URL_RE = re.compile(r"https?://\S+?/issues/\d+")


class IssueEmitError(RuntimeError):
    """Raised when filing a GitHub issue through the scm shim fails."""


# --- vBRIEF helpers ---------------------------------------------------------


def load_vbrief(path: Path) -> dict:
    """Read and parse a vBRIEF JSON file (UTF-8)."""
    data: Any = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def write_vbrief(path: Path, data: dict) -> None:
    """Write a vBRIEF dict back to disk as pretty-printed UTF-8 JSON.

    Uses ``ensure_ascii=False`` so non-ASCII narrative glyphs round-trip as
    real UTF-8 bytes (``task verify:encoding`` flags mojibake / BOM, and a
    locale-default write would risk both on Windows hosts).
    """
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def vbrief_title(data: dict) -> str:
    """Resolve a human title for a vBRIEF.

    Prefers ``plan.title``; falls back to ``vBRIEFInfo.description`` and then
    a generic placeholder so a malformed vBRIEF still produces a usable issue
    title rather than an empty string.
    """
    plan = data.get("plan", {}) if isinstance(data, dict) else {}
    title = plan.get("title") if isinstance(plan, dict) else None
    if isinstance(title, str) and title.strip():
        return title.strip()
    info = data.get("vBRIEFInfo", {}) if isinstance(data, dict) else {}
    desc = info.get("description", "") if isinstance(info, dict) else ""
    if isinstance(desc, str) and desc.strip():
        return desc.strip()
    return "Untitled vBRIEF"


def existing_github_issue_ref(data: dict) -> str | None:
    """Return the first ``x-vbrief/github-issue`` reference URI, or None.

    Used for idempotency: a vBRIEF that already carries a github-issue
    reference has already been tracked, so ``emit`` skips it instead of
    filing a duplicate. Returns the empty string when a matching reference
    exists but carries no URI (still a positive "already tracked" signal).
    """
    if not isinstance(data, dict):
        return None
    plan = data.get("plan", {})
    refs = plan.get("references", []) if isinstance(plan, dict) else []
    for ref in refs:
        if isinstance(ref, dict) and ref.get("type") == GITHUB_ISSUE_REF_TYPE:
            uri = ref.get("uri") or ref.get("url")
            return uri if isinstance(uri, str) and uri else ""
    return None


def add_github_issue_reference(data: dict, url: str) -> dict:
    """Append an external github-issue reference to ``plan.references[]``.

    Mutates ``data`` in place (and returns it for convenience). The appended
    entry is the canonical ``{uri, type, TrustLevel}`` shape required by the
    #1274 acceptance criteria.
    """
    plan = data.setdefault("plan", {})
    refs = plan.setdefault("references", [])
    refs.append(
        {
            "uri": url,
            "type": GITHUB_ISSUE_REF_TYPE,
            "TrustLevel": EXTERNAL_TRUST_LEVEL,
        }
    )
    return data


# --- Issue body rendering ---------------------------------------------------


def render_issue_body(data: dict) -> str:
    """Render a GitHub issue body from a vBRIEF's narratives.

    Sections, in order: Description, Acceptance (plan-level narrative plus
    per-item ``narrative.Acceptance`` bullets), and Traces. Empty sections
    are omitted. A vBRIEF with no usable narrative still yields a non-empty
    body naming the scope so ``gh issue create`` never receives an empty
    ``--body-file``.
    """
    plan = data.get("plan", {}) if isinstance(data, dict) else {}
    narratives = plan.get("narratives", {}) if isinstance(plan, dict) else {}
    if not isinstance(narratives, dict):
        narratives = {}

    parts: list[str] = []

    desc = narratives.get("Description")
    if isinstance(desc, str) and desc.strip():
        parts.append("## Description\n\n" + desc.strip())

    acceptance_lines: list[str] = []
    plan_acceptance = narratives.get("Acceptance")
    if isinstance(plan_acceptance, str) and plan_acceptance.strip():
        acceptance_lines.append(plan_acceptance.strip())
    for item in plan.get("items", []) if isinstance(plan, dict) else []:
        if not isinstance(item, dict):
            continue
        item_narrative = item.get("narrative", {})
        acc = item_narrative.get("Acceptance") if isinstance(item_narrative, dict) else None
        if isinstance(acc, str) and acc.strip():
            item_title = str(item.get("title", "")).strip()
            if item_title:
                acceptance_lines.append(f"- **{item_title}**: {acc.strip()}")
            else:
                acceptance_lines.append(f"- {acc.strip()}")
    if acceptance_lines:
        parts.append("## Acceptance\n\n" + "\n".join(acceptance_lines))

    traces = narratives.get("Traces")
    if isinstance(traces, str) and traces.strip():
        parts.append("## Traces\n\n" + traces.strip())

    if not parts:
        return f"Scope vBRIEF: {vbrief_title(data)}\n"
    return "\n\n".join(parts) + "\n"


def render_umbrella_body(entries: list[tuple[str, dict]], *, intro: str | None = None) -> str:
    """Render an umbrella issue body with a checklist of tracked vBRIEFs.

    ``entries`` is a list of ``(relative-or-display-path, vbrief-data)``
    tuples. Each becomes an unchecked task-list item naming the vBRIEF title
    and its path so the umbrella reads as a roadmap.
    """
    lines: list[str] = []
    if intro:
        lines.append(intro.strip())
        lines.append("")
    lines.append("## Tracked vBRIEFs")
    lines.append("")
    for display_path, data in entries:
        lines.append(f"- [ ] {vbrief_title(data)} (`{display_path}`)")
    return "\n".join(lines) + "\n"


# --- Forge interaction ------------------------------------------------------


def file_issue(
    repo: str,
    title: str,
    body: str,
    *,
    scm_call: Callable[..., Any] | None = None,
) -> str:
    """File a single GitHub issue via the scm shim and return its URL.

    The body is written to a temporary UTF-8 file and passed through
    ``gh issue create --body-file`` so non-ASCII glyphs survive (an inline
    ``--body`` risks codepage corruption on Windows hosts). The call routes
    through :func:`scripts.scm.call` with ``source="github-issue"`` so the
    #1145 SCM boundary holds, and forces ``encoding="utf-8",
    errors="replace"`` per the #1366 safe-capture rule.

    Raises :class:`IssueEmitError` on a non-zero exit or when no issue URL
    can be parsed from stdout.
    """
    # Resolve the binding at call time (not as a default arg) so tests that
    # monkeypatch ``issue_emit.scm.call`` take effect.
    if scm_call is None:
        scm_call = scm.call
    fd, tmp_name = tempfile.mkstemp(suffix=".md", prefix="deft-issue-emit-")
    os.close(fd)
    body_path = Path(tmp_name)
    try:
        body_path.write_text(body, encoding="utf-8")
        result = scm_call(
            "github-issue",
            "issue",
            [
                "create",
                "--repo",
                repo,
                "--title",
                title,
                "--body-file",
                str(body_path),
            ],
            timeout=60,
            encoding="utf-8",
            errors="replace",
        )
    finally:
        with contextlib.suppress(OSError):
            body_path.unlink()

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise IssueEmitError(f"gh issue create failed (exit {result.returncode}): {stderr}")
    stdout = (result.stdout or "").strip()
    match = _ISSUE_URL_RE.search(stdout)
    if match:
        return match.group(0)
    if stdout:
        return stdout
    raise IssueEmitError("gh issue create succeeded but emitted no issue URL on stdout")


# --- Emit actions -----------------------------------------------------------


def emit_single(
    path: Path,
    *,
    repo: str,
    scm_call: Callable[..., Any] | None = None,
    no_network: bool = False,
    display_path: str | None = None,
) -> dict:
    """File one issue for a single vBRIEF and write the URL back into it.

    Returns an action dict with ``result`` one of ``"created"`` /
    ``"dryrun"`` / ``"skipped"``. ``no_network`` (dry-run or DEFT_NO_NETWORK)
    prints nothing here -- it returns a ``"dryrun"`` action and makes no
    forge write and no on-disk mutation. A vBRIEF that already carries a
    github-issue reference returns ``"skipped"`` (idempotency).
    """
    shown = display_path or str(path)
    data = load_vbrief(path)
    existing = existing_github_issue_ref(data)
    if existing is not None:
        return {
            "result": "skipped",
            "vbrief": shown,
            "url": existing or None,
            "title": vbrief_title(data),
        }

    title = vbrief_title(data)
    if no_network:
        return {
            "result": "dryrun",
            "vbrief": shown,
            "url": None,
            "title": title,
        }

    body = render_issue_body(data)
    url = file_issue(repo, title, body, scm_call=scm_call)
    add_github_issue_reference(data, url)
    write_vbrief(path, data)
    return {"result": "created", "vbrief": shown, "url": url, "title": title}


def emit_per_vbrief(
    paths: list[Path],
    *,
    repo: str,
    scm_call: Callable[..., Any] | None = None,
    no_network: bool = False,
    display_paths: list[str] | None = None,
) -> list[dict]:
    """File one issue per matched vBRIEF (delegates to :func:`emit_single`)."""
    shown = display_paths or [str(p) for p in paths]
    actions: list[dict] = []
    for path, disp in zip(paths, shown, strict=True):
        actions.append(
            emit_single(
                path,
                repo=repo,
                scm_call=scm_call,
                no_network=no_network,
                display_path=disp,
            )
        )
    return actions


def emit_umbrella(
    paths: list[Path],
    *,
    repo: str,
    scm_call: Callable[..., Any] | None = None,
    no_network: bool = False,
    title: str | None = None,
    display_paths: list[str] | None = None,
) -> dict:
    """File ONE umbrella issue tracking the matched vBRIEFs.

    Writes the umbrella URL back into every matched vBRIEF that does not
    already carry a github-issue reference. When EVERY matched vBRIEF is
    already tracked, the umbrella is treated as a no-op (``"skipped"``) so a
    re-run does not file a duplicate roadmap issue.

    Returns an action dict with ``result`` one of ``"created"`` /
    ``"dryrun"`` / ``"skipped"`` and a ``vbriefs`` list of per-file outcomes.
    """
    shown = display_paths or [str(p) for p in paths]
    loaded: list[tuple[Path, str, dict]] = []
    for path, disp in zip(paths, shown, strict=True):
        loaded.append((path, disp, load_vbrief(path)))

    pending = [
        (path, disp, data) for path, disp, data in loaded if existing_github_issue_ref(data) is None
    ]
    already = [
        {"vbrief": disp, "result": "skipped"}
        for path, disp, data in loaded
        if existing_github_issue_ref(data) is not None
    ]

    umbrella_title = title or _default_umbrella_title(loaded)

    if not pending:
        return {
            "result": "skipped",
            "url": None,
            "title": umbrella_title,
            "vbriefs": already,
        }

    if no_network:
        return {
            "result": "dryrun",
            "url": None,
            "title": umbrella_title,
            "vbriefs": [{"vbrief": disp, "result": "dryrun"} for _path, disp, _data in pending]
            + already,
        }

    body = render_umbrella_body([(disp, data) for _path, disp, data in pending])
    url = file_issue(repo, umbrella_title, body, scm_call=scm_call)

    written: list[dict] = []
    for path, disp, data in pending:
        add_github_issue_reference(data, url)
        write_vbrief(path, data)
        written.append({"vbrief": disp, "result": "created"})

    return {
        "result": "created",
        "url": url,
        "title": umbrella_title,
        "vbriefs": written + already,
    }


def _default_umbrella_title(loaded: list[tuple[Path, str, dict]]) -> str:
    """Synthesise an umbrella title when the caller did not supply one."""
    count = len(loaded)
    noun = "vBRIEF" if count == 1 else "vBRIEFs"
    return f"Umbrella: {count} tracked {noun}"


# --- Path expansion ---------------------------------------------------------


def expand_patterns(patterns: list[str], *, root: Path | None = None) -> list[Path]:
    """Expand glob ``patterns`` into a de-duplicated, ordered list of paths.

    Patterns are resolved relative to ``root`` (the project root) when given
    and not already absolute. A pattern with no glob matches that names an
    existing file is taken literally so ``emit <one-file>`` works without a
    wildcard. Document order is preserved; duplicates are dropped.
    """
    seen: set[str] = set()
    out: list[Path] = []
    for pattern in patterns:
        candidate = pattern
        if root is not None and not os.path.isabs(pattern):
            candidate = str(root / pattern)
        matches = sorted(globlib.glob(candidate))
        if not matches and Path(candidate).exists():
            matches = [candidate]
        for match in matches:
            resolved = str(Path(match).resolve())
            if resolved in seen:
                continue
            seen.add(resolved)
            out.append(Path(match))
    return out


# --- CLI --------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "File GitHub issue(s) from scope vBRIEFs and record the issue "
            "URL back into each vBRIEF's references[] (#1274 Change 2)."
        ),
    )
    parser.add_argument(
        "patterns",
        nargs="*",
        help="vBRIEF path (single mode) or glob(s) (--umbrella / --per-vbrief)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--umbrella",
        action="store_true",
        help="File ONE umbrella issue with a checklist of matched vBRIEFs",
    )
    mode.add_argument(
        "--per-vbrief",
        action="store_true",
        help="File one issue per matched vBRIEF",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="Umbrella issue title (--umbrella mode only)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the plan without filing issues or mutating vBRIEFs",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON summary instead of prose",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help="GitHub repo OWNER/REPO (highest precedence; beats env / git remote)",
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help="Consumer project root used for repo detection and glob anchoring",
    )
    return parser


def _is_no_network(dry_run: bool) -> bool:
    """Return True when network access is disabled (dry-run or env opt-out)."""
    return dry_run or os.environ.get("DEFT_NO_NETWORK") == "1"


def _print_summary(summary: dict, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return
    mode = summary["mode"]
    no_network = summary["no_network"]
    banner = "issue:emit plan (no network)" if no_network else "issue:emit"
    print(f"{banner} -- mode: {mode}")
    if mode == "umbrella":
        action = summary["umbrella"]
        verb = {
            "created": "FILED umbrella",
            "dryrun": "WOULD FILE umbrella",
            "skipped": "SKIP umbrella (already tracked)",
        }[action["result"]]
        url = f" -> {action['url']}" if action.get("url") else ""
        print(f"  {verb}: {action['title']}{url}")
        for child in action["vbriefs"]:
            print(f"    - {child['result'].upper():8} {child['vbrief']}")
    else:
        for action in summary["actions"]:
            verb = {
                "created": "FILED",
                "dryrun": "WOULD FILE",
                "skipped": "SKIP (already tracked)",
            }[action["result"]]
            url = f" -> {action['url']}" if action.get("url") else ""
            print(f"  {verb:22} {action['vbrief']}{url}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.patterns:
        parser.error("Provide a vBRIEF path or glob(s) to emit")

    if args.title and not args.umbrella:
        parser.error("--title is only valid with --umbrella")

    project_root = resolve_project_root(args.project_root)
    paths = expand_patterns(args.patterns, root=project_root)
    if not paths:
        print(
            f"Error: no vBRIEF files matched {args.patterns!r}.",
            file=sys.stderr,
        )
        return 2

    no_network = _is_no_network(args.dry_run)

    # Repo is only required for a real (network) filing. Dry-run / no-network
    # plans never call the forge, so a missing repo is not fatal there.
    repo = ""
    if not no_network:
        repo = resolve_project_repo(args.repo, project_root=project_root) or ""
        if not repo:
            print(
                "Error: could not detect repo. Pass --repo OWNER/NAME, set "
                "$DEFT_PROJECT_REPO, or run from the consumer repo (#538).",
                file=sys.stderr,
            )
            return 2

    display = [_display_path(p, project_root) for p in paths]

    try:
        if args.umbrella:
            action = emit_umbrella(
                paths,
                repo=repo,
                no_network=no_network,
                title=args.title,
                display_paths=display,
            )
            summary = {
                "mode": "umbrella",
                "no_network": no_network,
                "umbrella": action,
            }
        elif args.per_vbrief:
            actions = emit_per_vbrief(
                paths,
                repo=repo,
                no_network=no_network,
                display_paths=display,
            )
            summary = {
                "mode": "per-vbrief",
                "no_network": no_network,
                "actions": actions,
            }
        else:
            if len(paths) != 1:
                print(
                    "Error: single mode expects exactly one vBRIEF; matched "
                    f"{len(paths)}. Use --umbrella or --per-vbrief for globs.",
                    file=sys.stderr,
                )
                return 2
            action = emit_single(
                paths[0],
                repo=repo,
                no_network=no_network,
                display_path=display[0],
            )
            summary = {
                "mode": "single",
                "no_network": no_network,
                "actions": [action],
            }
    except IssueEmitError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    _print_summary(summary, as_json=args.json)
    return 0


def _display_path(path: Path, project_root: Path | None) -> str:
    """Return ``path`` relative to the project root when possible."""
    if project_root is not None:
        try:
            return str(path.resolve().relative_to(project_root.resolve()))
        except ValueError:
            pass
    return str(path)


if __name__ == "__main__":
    raise SystemExit(main())
