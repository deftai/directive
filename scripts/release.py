#!/usr/bin/env python3
"""release.py -- Automate the v0.X.Y release flow (#74).

Wraps the mechanical steps of cutting a deft release into a single
deterministic Python entry-point so contributors do not have to remember
the order: pre-flight -> CI -> CHANGELOG promote -> ROADMAP refresh ->
build dist -> tag -> push tag -> GitHub release.

The script is intentionally side-effect-loud (every step prints
``[N/M] <step>... <result>`` so operators can tail it during a release)
and supports a ``--dry-run`` mode that prints the full plan without
touching the filesystem or invoking any external command.

Background
----------
Issue #74 ("chore: automate release process and CI changelog
enforcement") flagged the manual release flow as error-prone. PR #73
documented the convention in ``scm/changelog.md`` but relied on human
discipline. The vBRIEF
``vbrief/pending/2026-04-23-233-more-determinism-full-initiative-phase-0-spec.vbrief.json``
``task-release`` plan.item carries the Action ("automate the v0.X.Y
release flow -- tag, build, dist, CHANGELOG promote, ROADMAP
move-to-completed") and Acceptance ("`task release -- 0.21.0` produces
a clean tag + GitHub release on a dry-run fixture; tests/cli/test_release.py
covers CHANGELOG promotion and ROADMAP move-to-completed").

Per the canonical [#642 workflow comment]
(https://github.com/deftai/directive/issues/642#issuecomment-4330742436)
locked decision and the Rule Authority [AXIOM] block in ``main.md``,
deterministic / Taskfile encodings rank above prose: this script is the
deterministic encoding of the release flow, surfaced via
``task release -- <version>`` (see ``tasks/release.yml``).

Usage
-----
    uv run python scripts/release.py 0.21.0
    uv run python scripts/release.py 0.21.0 --dry-run
    uv run python scripts/release.py 0.21.0 --skip-tag --skip-release
    uv run python scripts/release.py 0.21.0 --repo deftai/directive
    uv run python scripts/release.py 0.21.0 --allow-dirty
    uv run python scripts/release.py 0.21.0 --no-draft  # rare direct-publish

Exit codes
----------
    0 -- release flow completed successfully (or dry-run preview ok)
    1 -- pre-flight or pipeline-step violation (dirty tree, wrong branch,
         CI failure, CHANGELOG lacks [Unreleased], gh release failure ...)
    2 -- config / argument error (malformed version, repo unresolvable,
         CHANGELOG malformed, ...)

Draft default (#716 safety hardening)
-------------------------------------
``gh release create`` is invoked with ``--draft`` by default so the
*artifact production* phase (which fires release.yml CI and uploads
binaries) is decoupled from the *consumer-visibility* phase. Pair this
script with ``scripts/release_publish.py`` (``task release:publish --
<version>``) to flip the draft to public after manual review of the
binaries / notes / asset list. ``--no-draft`` opts back into the
prior direct-publish behavior (only intended for automated security
patches where there is no review gate).

Refs #74, #233, #642, #635, #709 (Repair Authority [AXIOM]),
#710 (data-file-conventions check follow-up), #716 (safety hardening).
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

# ---- Exit codes -------------------------------------------------------------

EXIT_OK = 0
EXIT_VIOLATION = 1
EXIT_CONFIG_ERROR = 2

# ---- Constants --------------------------------------------------------------

DEFAULT_REPO = "deftai/directive"
DEFAULT_BASE_BRANCH = "master"

# Strict semver pattern (no pre-release / build metadata; deft tags are X.Y.Z).
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
_TAG_RE = re.compile(r"^v(\d+\.\d+\.\d+)$")
_UNRELEASED_RE = re.compile(r"^##\s+\[Unreleased\]\s*$", re.MULTILINE)
_UNRELEASED_LINK_RE = re.compile(
    r"^\[Unreleased\]:\s+https?://github\.com/[^/]+/[^/]+/compare/v(?P<prev>\d+\.\d+\.\d+)\.\.\.HEAD\s*$",
    re.MULTILINE,
)

FRESH_UNRELEASED_BLOCK = (
    "## [Unreleased]\n"
    "\n"
    "### Added\n"
    "\n"
    "### Changed\n"
    "\n"
    "### Fixed\n"
    "\n"
    "### Removed\n"
)


# ---- Data classes -----------------------------------------------------------


@dataclass
class ReleaseConfig:
    version: str
    repo: str
    base_branch: str
    project_root: Path
    dry_run: bool
    skip_tag: bool
    skip_release: bool
    allow_dirty: bool
    # #716: default-draft so the GitHub release lands as an unpublished
    # draft until ``task release:publish`` flips it. Operators can opt
    # out via --no-draft (rare; e.g. automated security patches).
    draft: bool = True
    # #720: e2e-rehearsal escape hatches. ``--skip-ci`` skips Step 3
    # (task ci:local / task check fallback) so the rehearsal does not
    # re-run CI inside an auto-created temp repo (CI semantics are
    # covered by the unit tests at every commit on master). ``--skip-build``
    # skips Step 6 (task build) similarly. Defaults preserve pre-#720
    # behaviour: both run unless the operator explicitly opts out.
    skip_ci: bool = False
    skip_build: bool = False
    # release-narrative-gap: optional one-line operator-authored summary
    # injected as a Markdown blockquote at the top of the promoted
    # CHANGELOG ``[<version>]`` section. None preserves pre-existing
    # behaviour byte-for-byte. The same blockquote naturally flows
    # through to the GitHub release body (via ``_section_for_version``)
    # and is the canonical source for the Phase 8 Slack ``*Summary*:``
    # slot per ``skills/deft-directive-release/SKILL.md``.
    summary: str | None = None
    # #734: vBRIEF-lifecycle reconciliation gate escape hatch. The
    # pipeline runs ``check_vbrief_lifecycle_sync`` between Step 2
    # (branch guard) and Step 4 (CI) so a release cannot ship with
    # closed-issue vBRIEFs still living in proposed/ / pending/ /
    # active/. The flag is the explicit-acknowledgment escape hatch
    # (analogous to ``--allow-dirty`` for the dirty-tree gate) for
    # cases where the operator has reviewed the drift and chooses to
    # proceed -- e.g. a hot-fix release where the lifecycle reconcile
    # is intentionally deferred to the next refinement pass.
    allow_vbrief_drift: bool = False


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="release",
        description=(
            "Automate the v0.X.Y release flow (#74): pre-flight, CI, CHANGELOG "
            "promote, ROADMAP refresh, build, tag, push, gh release. Halt-friendly: "
            "supports --dry-run / --skip-tag / --skip-release for safe rehearsals."
        ),
    )
    parser.add_argument(
        "version",
        help="Release version, e.g. 0.21.0 (no leading 'v', strict X.Y.Z).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the full release plan without writing files or invoking external commands.",
    )
    parser.add_argument(
        "--skip-tag",
        action="store_true",
        help="Do not invoke git tag / git push origin <tag> (still updates CHANGELOG).",
    )
    parser.add_argument(
        "--skip-release",
        action="store_true",
        help="Do not invoke gh release create.",
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Bypass the dirty-tree pre-flight (use only for rehearsals).",
    )
    parser.add_argument(
        "--allow-vbrief-drift",
        action="store_true",
        default=False,
        help=(
            "Bypass the vBRIEF-lifecycle sync pre-flight gate (#734). "
            "Use only when the operator has reviewed the drift and "
            "explicitly accepts that closed-issue vBRIEFs may still "
            "live in non-completed/ folders. The clean path is to "
            "run `task reconcile:issues -- --apply-lifecycle-fixes` "
            "first."
        ),
    )
    # #720: e2e-rehearsal escape hatches.
    parser.add_argument(
        "--skip-ci",
        action="store_true",
        help=(
            "Skip Step 3 (task ci:local / task check fallback). Used by "
            "`task release:e2e` to keep wall-clock manageable inside the "
            "auto-created temp repo (CI semantics are covered by the "
            "unit-test suite, not the e2e rehearsal)."
        ),
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help=(
            "Skip Step 6 (task build). Used by `task release:e2e` to keep "
            "wall-clock manageable; build artefacts are not needed for the "
            "draft-release verification step."
        ),
    )
    # #716: default-draft. ``--no-draft`` opts out (rare; security patches).
    parser.add_argument(
        "--no-draft",
        action="store_false",
        dest="draft",
        default=True,
        help=(
            "Publish the GitHub release immediately instead of creating a draft "
            "(default: --draft, paired with `task release:publish -- <version>`)."
        ),
    )
    parser.add_argument(
        "--repo",
        default=None,
        metavar="OWNER/REPO",
        help=(
            "Override the GitHub repository (default: resolved from `git remote get-url origin`, "
            f"falling back to {DEFAULT_REPO!r})."
        ),
    )
    parser.add_argument(
        "--base-branch",
        default=DEFAULT_BASE_BRANCH,
        metavar="BRANCH",
        help=f"Expected base branch for releases (default: {DEFAULT_BASE_BRANCH}).",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Repository root (default: $DEFT_PROJECT_ROOT or the parent of the scripts/ "
            "directory)."
        ),
    )
    parser.add_argument(
        "--summary",
        default=None,
        metavar="TEXT",
        help=(
            "Optional one-line summary to inject as a Markdown blockquote at "
            "the top of the promoted CHANGELOG section. Flows through to the "
            "GitHub release body and the Slack announcement template (Phase 8). "
            "Recommended length 80-160 chars."
        ),
    )
    return parser


# ---- Helpers ----------------------------------------------------------------


def _resolve_project_root(arg_root: Path | None) -> Path:
    if arg_root is not None:
        return arg_root.resolve()
    env_root = os.environ.get("DEFT_PROJECT_ROOT")
    if env_root:
        return Path(env_root).resolve()
    return Path(__file__).resolve().parent.parent


def _resolve_repo(arg_repo: str | None, project_root: Path) -> str:
    """Resolve OWNER/REPO via flag > git remote > DEFAULT_REPO fallback."""
    if arg_repo:
        return arg_repo
    try:
        result = subprocess.run(
            ["git", "-C", str(project_root), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return DEFAULT_REPO
    if result.returncode != 0:
        return DEFAULT_REPO
    url = result.stdout.strip()
    # Accept https://github.com/OWNER/REPO(.git)? and git@github.com:OWNER/REPO(.git)?
    match = re.match(
        r"^(?:https?://github\.com/|git@github\.com:)(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$",
        url,
    )
    if not match:
        return DEFAULT_REPO
    return f"{match.group('owner')}/{match.group('repo')}"


def _validate_version(version: str) -> None:
    """Raise ValueError if the version does not match strict X.Y.Z semver."""
    if not _VERSION_RE.match(version):
        raise ValueError(
            f"Invalid version {version!r}. Expected strict semver X.Y.Z "
            f"(no leading 'v', no pre-release suffix)."
        )


def _today_iso() -> str:
    return _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%d")


# ---- gh CLI resolution (Windows PATHEXT fix, #721) -------------------------


def _resolve_gh() -> str | None:
    """Resolve the absolute path to the ``gh`` CLI binary.

    On Windows, ``gh`` is installed as ``gh.cmd`` (a shell-launcher shim).
    Python's ``subprocess.run(["gh", ...])`` does NOT honor PATHEXT when
    resolving ``argv[0]`` via the OS's CreateProcess path, so the launcher
    cannot be found even when ``gh`` works fine from the operator's
    terminal. ``shutil.which`` DOES honor PATHEXT, so resolving once via
    this helper and passing the absolute path as ``argv[0]`` (e.g.
    ``C:\\Program Files\\GitHub CLI\\gh.cmd``) makes the four release
    scripts work uniformly across Windows / macOS / Linux (#721).

    Returns the absolute path string when ``gh`` is on PATH, or ``None``
    when it is not -- callers MUST surface the canonical
    ``"gh CLI not found on PATH"`` reason on ``None`` to keep error
    messages stable for tests and operators.
    """
    return shutil.which("gh")


# ---- Step 1/2 -- git pre-flight --------------------------------------------


def _run_git(project_root: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(project_root), *args],
        capture_output=True,
        text=True,
        timeout=30,
        check=check,
    )


def check_git_clean(project_root: Path) -> tuple[bool, str]:
    result = _run_git(project_root, "status", "--porcelain")
    if result.returncode != 0:
        return False, f"git status failed: {result.stderr.strip()}"
    output = result.stdout.strip()
    if output:
        return False, output
    return True, ""


def current_branch(project_root: Path) -> str:
    result = _run_git(project_root, "branch", "--show-current")
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


# ---- Step 3 -- vBRIEF lifecycle sync (#734) --------------------------------


def check_vbrief_lifecycle_sync(
    project_root: Path, repo: str
) -> tuple[bool, int, str]:
    """Reconcile vBRIEF references against open GitHub issues (#734).

    Wraps ``scripts/reconcile_issues.py`` so the release pipeline can
    refuse to cut a release while there are closed-issue vBRIEFs still
    living in non-``completed/`` lifecycle folders -- the v0.21.0 cut
    surfaced 13 stranded vBRIEFs (8 cycle-relevant + 5 historical
    residue) post-publish, the recurrence record this gate prevents.

    Returns ``(ok, mismatch_count, reason)``:
      - ``ok=True, mismatch_count=0`` -- clean (Section (c) is empty).
      - ``ok=False, mismatch_count=N`` -- N closed-issue vBRIEFs are NOT
        in ``completed/``; operator must run
        ``task reconcile:issues -- --apply-lifecycle-fixes`` (or pass
        ``--allow-vbrief-drift`` to override).
      - ``ok=False, mismatch_count=-1`` -- configuration error (vbrief
        directory missing, ``gh`` unavailable, etc.).

    The function delegates to the existing ``reconcile_issues``
    helpers so a single source of truth governs both the standalone
    CLI and the pipeline gate.
    """
    # Local import to avoid pulling reconcile_issues + its transitive
    # imports at module load time (fast unit-test startup matters in
    # this codebase). The script-relative import path mirrors the
    # convention used by the e2e harness and rollback helpers.
    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        import reconcile_issues  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        return False, -1, f"reconcile_issues import failed: {exc}"

    vbrief_dir = project_root / "vbrief"
    if not vbrief_dir.is_dir():
        return False, -1, f"vbrief directory not found at {vbrief_dir}"

    issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)
    open_issues = reconcile_issues.fetch_open_issues(repo, cwd=project_root)
    if open_issues is None:
        return False, -1, "failed to fetch open issues from gh"

    report = reconcile_issues.reconcile(issue_to_vbriefs, open_issues)
    # Section (c) entries that are NOT already in completed/ -- the
    # apply-mode candidates. Reverse mismatches (issues that reopened
    # after a vBRIEF landed in completed/) are intentionally NOT
    # counted here per #734 (operator decision; report-only).
    mismatches = [
        rel
        for entry in report.get("no_open_issue", [])
        for rel in entry.get("vbrief_files", [])
        if not rel.startswith("completed/")
    ]
    count = len(mismatches)
    if count == 0:
        return True, 0, "no mismatches"
    return False, count, (
        f"{count} closed-issue vBRIEF(s) not in completed/: "
        f"{', '.join(mismatches[:5])}"
        + (" ..." if count > 5 else "")
    )


# ---- Step 4 -- CI ----------------------------------------------------------


def task_binary_available() -> bool:
    return shutil.which("task") is not None


def task_has_target(target: str, *, cwd: Path) -> bool:
    """Return True if ``task --list-all`` reports the given target.

    Uses ``--list-all`` (which surfaces tasks regardless of ``desc:`` presence)
    so a target can be discovered even if it lacks documentation.
    """
    if not task_binary_available():
        return False
    try:
        result = subprocess.run(
            ["task", "--list-all"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(cwd),
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        return False
    pattern = re.compile(rf"^\*?\s*{re.escape(target)}:", re.MULTILINE)
    return bool(pattern.search(result.stdout))


def run_ci(project_root: Path) -> tuple[bool, str]:
    """Run ``task ci:local`` if available, else fall back to ``task check``.

    Returns ``(ok, reason)`` -- ``reason`` describes which target ran (or why
    nothing did, when a fallback is also unavailable).
    """
    if not task_binary_available():
        return False, "task binary not found on PATH"
    if task_has_target("ci:local", cwd=project_root):
        target = "ci:local"
    else:
        target = "check"
        if not task_has_target("check", cwd=project_root):
            return False, "neither task ci:local nor task check is defined"
    try:
        result = subprocess.run(
            ["task", target],
            cwd=str(project_root),
            check=False,
        )
    except FileNotFoundError:
        return False, "task binary not found on PATH"
    if result.returncode != 0:
        return False, f"task {target} failed (exit {result.returncode})"
    return True, f"ran task {target}"


# ---- Step 4 -- CHANGELOG promotion -----------------------------------------


def _split_body_and_links(text: str) -> tuple[str, str]:
    """Split CHANGELOG content into (body, link-footer).

    The link footer is the trailing block of `[X.Y.Z]: url` lines. We split
    on the FIRST link line so we can inject a new line at the top of the
    block while preserving comment markers (e.g. ``<!-- ... -->``) that may
    be interleaved with the link list.
    """
    lines = text.splitlines(keepends=True)
    first_link_idx: int | None = None
    for idx, line in enumerate(lines):
        if line.startswith("[Unreleased]:") or re.match(r"^\[\d+\.\d+\.\d+\]:", line):
            first_link_idx = idx
            break
    if first_link_idx is None:
        return text, ""
    body = "".join(lines[:first_link_idx])
    footer = "".join(lines[first_link_idx:])
    return body, footer


def _extract_previous_version(footer: str) -> str | None:
    """Return the previous version from the existing ``[Unreleased]:`` link, or None."""
    match = _UNRELEASED_LINK_RE.search(footer)
    if match:
        return match.group("prev")
    return None


def promote_changelog(
    text: str,
    version: str,
    repo: str,
    today: str,
    summary: str | None = None,
) -> str:
    """Promote ``[Unreleased]`` to ``[<version>] - <today>`` and refresh the link footer.

    Raises ValueError when the input lacks an ``[Unreleased]`` heading or
    appears malformed.

    When ``summary`` is a non-empty string, a one-line Markdown blockquote
    (``> <summary>``) is injected directly after the new
    ``## [<version>] - <today>`` heading and before the first sub-section
    so the promoted block reads::

        ## [<version>] - <date>

        > <summary>

        ### Added
        - ...

    The blockquote is sandwiched by blank lines for proper Keep-a-Changelog
    rendering. The summary is treated as inline Markdown and preserved
    verbatim (operators may include ``**bold**``, ``[link](url)``, etc.).
    Newlines in the summary cause a ``ValueError`` -- the slot is
    explicitly single-line per the release-narrative-gap scope vBRIEF.
    Empty / ``None`` summary preserves pre-existing behaviour byte-for-byte
    (no blockquote is emitted).
    """
    if not _UNRELEASED_RE.search(text):
        raise ValueError("CHANGELOG.md does not contain a '## [Unreleased]' heading.")

    if summary is not None and ("\n" in summary or "\r" in summary):
        raise ValueError(
            "--summary is single-line; got embedded newline. "
            "Author the blockquote on a single line."
        )

    body, footer = _split_body_and_links(text)

    # Promote: rename heading + insert fresh empty Unreleased block above.
    promoted_heading = f"## [{version}] - {today}"
    if summary:
        # Sandwich the blockquote with blank lines so Keep-a-Changelog
        # renders it as a real blockquote (a ``>`` line glued to the
        # heading or the first sub-section can break Markdown rendering
        # in some clients). Layout in the substitution result:
        #
        #   ## [<v>] - <d>\n     <- heading
        #   \n                    <- blank line
        #   > <summary>\n        <- blockquote line + newline
        #   <next char from body, which is "\n### Added...">
        #
        # so the rendered shape is heading / blank / > summary / blank /
        # ### Added. The trailing ``\n`` we append below combines with
        # the single ``\n`` left in body after the regex (the
        # ``_UNRELEASED_RE`` ``\s*`` greedy-then-backtrack consumes one
        # of the two ``\n``s following ``## [Unreleased]``) to form the
        # blank line.
        promoted_heading = f"{promoted_heading}\n\n> {summary}\n"
    fresh_block = FRESH_UNRELEASED_BLOCK.rstrip() + "\n\n"
    # P1 (#730 Greptile): use a callable replacement so Python's ``re``
    # module does NOT interpret backslash sequences in the operator's
    # summary as group backreferences (``\1``-``\9``, ``\g<name>``).
    # ``_UNRELEASED_RE`` has no capture groups, so a literal-string
    # replacement containing e.g. ``"\\1"`` would raise an uncaught
    # ``re.error: invalid group reference`` -- ugly traceback that
    # bypasses the ``ValueError`` newline guard. A lambda repl returns
    # the value verbatim and skips all backslash interpretation.
    replacement = fresh_block + promoted_heading
    new_body, count = _UNRELEASED_RE.subn(
        lambda _match: replacement,
        body,
        count=1,
    )
    if count != 1:
        raise ValueError("Failed to locate exactly one '## [Unreleased]' heading.")

    # Refresh the link footer.
    prev = _extract_previous_version(footer)
    new_unreleased_link = (
        f"[Unreleased]: https://github.com/{repo}/compare/v{version}...HEAD"
    )
    if prev:
        version_link = (
            f"[{version}]: https://github.com/{repo}/compare/v{prev}...v{version}"
        )
    else:
        version_link = (
            f"[{version}]: https://github.com/{repo}/releases/tag/v{version}"
        )
    if footer:
        footer_lines = footer.splitlines(keepends=True)
        # Replace the existing [Unreleased]: line (assumed first link) and
        # prepend the new version-link line immediately after it.
        replaced = False
        new_footer_lines: list[str] = []
        for line in footer_lines:
            if not replaced and line.startswith("[Unreleased]:"):
                new_footer_lines.append(new_unreleased_link + "\n")
                new_footer_lines.append(version_link + "\n")
                replaced = True
                continue
            new_footer_lines.append(line)
        if not replaced:
            # No prior [Unreleased]: line; prepend both lines.
            new_footer_lines = [new_unreleased_link + "\n", version_link + "\n"] + footer_lines
        new_footer = "".join(new_footer_lines)
    else:
        new_footer = new_unreleased_link + "\n" + version_link + "\n"

    return new_body + new_footer


def _section_for_version(text: str, version: str) -> str:
    """Extract the body of ``## [<version>] - <date>`` for use as release notes."""
    pattern = re.compile(
        rf"^##\s+\[{re.escape(version)}\][^\n]*\n(?P<body>.*?)(?=^##\s+\[|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        return ""
    return match.group("body").strip()


# ---- Step 5 -- ROADMAP refresh ---------------------------------------------


def refresh_roadmap(project_root: Path) -> tuple[bool, str]:
    """Re-render ROADMAP.md via ``task roadmap:render``.

    ``scripts/roadmap_render.py`` already aggregates ``vbrief/pending/``
    (Active) and ``vbrief/completed/`` (Completed) idempotently, so the
    release script trusts the renderer rather than mutating the file
    directly. vBRIEFs that should appear in ``## Completed`` are expected
    to have been moved via ``task scope:complete`` in advance.
    """
    if not task_binary_available():
        return False, "task binary not found on PATH"
    if not task_has_target("roadmap:render", cwd=project_root):
        return True, "task roadmap:render not defined; skipping"
    try:
        result = subprocess.run(
            ["task", "roadmap:render"],
            cwd=str(project_root),
            check=False,
        )
    except FileNotFoundError:
        return False, "task binary not found on PATH"
    if result.returncode != 0:
        return False, f"task roadmap:render failed (exit {result.returncode})"
    return True, "ROADMAP.md re-rendered"


# ---- Step 6 -- build dist --------------------------------------------------


def run_build(project_root: Path, version: str | None = None) -> tuple[bool, str]:
    """Run ``task build`` for the release, pinning the artifact version (#723).

    The Taskfile resolves its ``VERSION`` variable via the inline POSIX
    ``sh:`` block in ``Taskfile.yml`` ``vars: VERSION``, which honors
    ``DEFT_RELEASE_VERSION`` over the latest annotated git tag (mirrored
    in ``scripts/resolve_version.py`` for Python callers + tests).
    Setting the env var here makes the in-flight release version (e.g.
    ``0.21.0``) the canonical source for the artifact filename so
    ``dist/deft-{version}.zip`` always matches the requested release
    rather than a stale Taskfile literal or the most-recent tag (which
    lags the in-flight tag during ``task release``).

    ``version`` may be ``None`` for callers that want the resolver
    default (git tag -> dev fallback). When ``version`` is falsy, any
    inherited ``DEFT_RELEASE_VERSION`` value is explicitly stripped from
    the subprocess env -- otherwise a stale value leaked from the parent
    shell (e.g. an interrupted prior ``task release`` run that exported
    the var into the operator's session) would silently re-introduce the
    exact stale-version bug #723 just closed.

    Contract:
        - ``version`` truthy: subprocess env carries
          ``DEFT_RELEASE_VERSION=<version>``.
        - ``version`` falsy / ``None``: subprocess env carries NO
          ``DEFT_RELEASE_VERSION`` (any inherited value is removed).
    """
    if not task_binary_available():
        return False, "task binary not found on PATH"
    if not task_has_target("build", cwd=project_root):
        return True, "task build not defined; skipping"
    env = os.environ.copy()
    if version:
        env["DEFT_RELEASE_VERSION"] = version
    else:
        # Strip any inherited value so version=None means "let the
        # Taskfile resolver decide" (git tag -> dev fallback) and never
        # "use whatever leaked from the parent shell" -- see #723.
        env.pop("DEFT_RELEASE_VERSION", None)
    try:
        result = subprocess.run(
            ["task", "build"],
            cwd=str(project_root),
            env=env,
            check=False,
        )
    except FileNotFoundError:
        return False, "task binary not found on PATH"
    if result.returncode != 0:
        return False, f"task build failed (exit {result.returncode})"
    suffix = f" (DEFT_RELEASE_VERSION={version})" if version else ""
    return True, f"task build ran clean{suffix}"


# ---- Step 7/8 -- commit + tag + push ---------------------------------------


# Files written by the release pipeline (steps 4 + 5) that MUST be committed
# before tagging so the annotated tag and GitHub release point at the
# CHANGELOG-promoted / ROADMAP-refreshed commit (#74 Greptile P1).
_RELEASE_ARTIFACTS = ("CHANGELOG.md", "ROADMAP.md")


def _release_commit_subject(version: str) -> str:
    """Return the canonical subject line for the release commit."""
    return f"chore(release): v{version} -- promote CHANGELOG + ROADMAP"


def commit_release_artifacts(
    project_root: Path, version: str
) -> tuple[bool, str]:
    """Stage and commit CHANGELOG.md / ROADMAP.md before tagging.

    Without this step the annotated tag would land on the pre-release HEAD
    commit -- meaning the tagged commit and GitHub release would be anchored
    to content that predates the CHANGELOG promotion, AND the working tree
    would remain dirty after the pipeline (#74 Greptile P1).

    Stages only the canonical release artifacts (CHANGELOG.md / ROADMAP.md)
    so any unrelated changes the operator left in the tree are NOT silently
    swept into the release commit. If neither file actually changed, the
    function reports a clean no-op so callers can proceed to tagging without
    a bogus empty commit.
    """
    paths_to_stage = [
        path
        for path in _RELEASE_ARTIFACTS
        if (project_root / path).is_file()
    ]
    if not paths_to_stage:
        return True, "no release artifacts to commit (none exist)"

    add = _run_git(project_root, "add", "--", *paths_to_stage)
    if add.returncode != 0:
        return False, f"git add failed: {add.stderr.strip()}"

    # Confirm something is actually staged before committing -- a no-op
    # `git commit` would otherwise return non-zero with "nothing to commit".
    diff = _run_git(project_root, "diff", "--cached", "--quiet")
    if diff.returncode == 0:
        return True, "release artifacts already up-to-date; no commit needed"

    subject = _release_commit_subject(version)
    commit = _run_git(project_root, "commit", "-m", subject)
    if commit.returncode != 0:
        return False, f"git commit failed: {commit.stderr.strip()}"
    return True, f"committed release artifacts ({subject})"


def create_tag(project_root: Path, version: str) -> tuple[bool, str]:
    tag = f"v{version}"
    result = _run_git(project_root, "tag", "-a", tag, "-m", f"Release {tag}")
    if result.returncode != 0:
        return False, f"git tag failed: {result.stderr.strip()}"
    return True, f"created tag {tag}"


def push_release(
    project_root: Path, version: str, base_branch: str
) -> tuple[bool, str]:
    """Push the release commit + the annotated tag to ``origin`` atomically.

    The branch update is published BEFORE the tag (`--atomic`) so the tag
    always resolves to a publicly-fetchable commit on ``origin/<base>``.
    Without the branch push the tag would dangle on origin until the next
    push of the branch, breaking ``gh release create --notes-from-tag`` and
    `git describe` for downstream consumers.
    """
    tag = f"v{version}"
    result = _run_git(
        project_root, "push", "--atomic", "origin", base_branch, tag
    )
    if result.returncode != 0:
        return False, f"git push failed: {result.stderr.strip()}"
    return True, f"pushed {base_branch} + {tag} to origin"


# Backwards-compatible alias for callers (and tests) that still reference
# the original symbol name.
def push_tag(project_root: Path, version: str) -> tuple[bool, str]:
    """Deprecated alias kept for backwards compatibility.

    Prefer ``push_release`` which atomically pushes the release branch and
    its annotated tag together (#74 Greptile P1). This shim exists so
    pre-existing callers that reference ``push_tag`` continue to work; new
    code MUST call ``push_release`` directly.
    """
    return push_release(project_root, version, DEFAULT_BASE_BRANCH)


# ---- Step 9 -- gh release create -------------------------------------------


def create_github_release(
    project_root: Path,
    version: str,
    repo: str,
    notes: str,
    *,
    draft: bool = True,
) -> tuple[bool, str]:
    """Create the GitHub release tagged ``v<version>``.

    ``draft`` defaults to True (#716 safety hardening): the release is
    created in draft state so binaries upload via release.yml CI but the
    artifact is not yet visible to consumers. ``task release:publish --
    <version>`` flips the draft to public after manual review.

    Notes-file path (#731): when ``notes`` is non-empty we materialise
    it to a UTF-8 temp file and pass ``--notes-file <path>`` to ``gh``
    rather than ``--notes "<text>"``. Inlining a multi-KB CHANGELOG
    section as a single argv element overflows the Windows command-line
    buffer (~32 KB) and surfaces from CreateProcess as
    ``FileNotFoundError(winerror=206, ERROR_FILENAME_EXCED_RANGE)``. The
    temp file is cleaned up in a ``try/finally`` regardless of
    subprocess outcome (success, non-zero exit, FileNotFoundError, any
    other exception). When ``notes`` is empty we fall through to
    ``--generate-notes`` (gh-side auto-generation from PR titles since
    the previous tag) so the release body is never blank.
    """
    gh_path = _resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    tag = f"v{version}"
    cmd = [
        gh_path, "release", "create", tag,
        "--repo", repo,
        "--title", tag,
    ]
    if draft:
        cmd.append("--draft")

    # Materialise notes to a UTF-8 temp file when non-empty so the
    # gh release create command line stays well under the OS argv cap
    # (~32 KB on Windows; ARG_MAX 128 KB-2 MB elsewhere). The previous
    # ``--notes <text>`` shape blew up on the v0.21.0 e2e cut against
    # deft's own CHANGELOG (#731).
    notes_file: Path | None = None
    if notes:
        # delete=False because we close the handle BEFORE invoking gh:
        # Windows holds an exclusive lock on a NamedTemporaryFile while
        # it is open, which would prevent gh from reading the file.
        # Cleanup happens in the finally block below.
        #
        # Greptile P2 (#732 review): assign ``notes_file`` BEFORE the
        # write so the outer ``finally`` cleanup can still find the
        # path if ``fh.write(notes)`` raises (e.g. disk-full OSError).
        # The file already exists on disk at this point (delete=False),
        # so leaving ``notes_file = None`` would orphan the temp file.
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            suffix=".md",
            delete=False,
        ) as fh:
            notes_file = Path(fh.name)
            fh.write(notes)
        cmd.extend(["--notes-file", str(notes_file)])
    else:
        cmd.append("--generate-notes")

    try:
        try:
            result = subprocess.run(
                cmd,
                cwd=str(project_root),
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
                env=os.environ.copy(),
            )
        except FileNotFoundError as exc:
            # Windows error 206 (ERROR_FILENAME_EXCED_RANGE) surfaces as
            # FileNotFoundError because Python's CreateProcess wrapper
            # maps it that way. Distinguish the cmd-line-overflow case
            # from a genuinely missing gh binary so operators see an
            # accurate diagnostic instead of being mis-pointed at the
            # #722 PATHEXT shim (#731).
            if getattr(exc, "winerror", None) == 206:
                return False, (
                    "gh release create command line exceeded Windows "
                    "limit (winerror 206, ERROR_FILENAME_EXCED_RANGE). "
                    "This should be mitigated by the --notes-file "
                    "switch landed in #731 -- if you still see this "
                    "with notes already in a file, file a follow-up."
                )
            return False, "gh CLI not found on PATH"
        if result.returncode != 0:
            return False, f"gh release create failed: {result.stderr.strip()}"
        suffix = " (draft)" if draft else ""
        return True, f"created GitHub release {tag}{suffix}"
    finally:
        if notes_file is not None:
            # Cleanup is best-effort; an undeleted temp file in the OS
            # temp dir is a housekeeping issue, not a release-pipeline
            # failure (ruff SIM105: contextlib.suppress over try/pass).
            with contextlib.suppress(OSError):
                notes_file.unlink(missing_ok=True)


# ---- Step 11 -- post-create verify-isDraft gate (#724) ---------------------


VERIFY_DRAFT_MAX_ATTEMPTS = 5
VERIFY_DRAFT_INTERVAL_SECONDS = 1.0


def _gh_release_view_is_draft(
    gh_path: str, version: str, repo: str, project_root: Path
) -> tuple[str, str]:
    """Return ``(state, detail)`` for a single isDraft probe.

    ``state`` is one of:
        - ``"draft"``: release exists with isDraft=true (verified safe).
        - ``"public"``: release exists with isDraft=false (defense-in-depth
          flip required).
        - ``"not-found"``: gh reported the release does not exist yet.
        - ``"error"``: gh failed for an unrelated reason; ``detail`` carries
          the stderr line.
    """
    tag = f"v{version}"
    cmd = [
        gh_path, "release", "view", tag,
        "--repo", repo,
        "--json", "isDraft",
    ]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return "error", "gh CLI not found on PATH"
    except subprocess.TimeoutExpired:
        return "error", "gh release view timed out"
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        # gh exits non-zero with a "release not found" / "not found"
        # diagnostic when the tag has no release yet -- treat that as
        # the not-found state so the verify gate can keep polling.
        if "not found" in stderr.lower() or "release not found" in stderr.lower():
            return "not-found", stderr
        return "error", stderr
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        return "error", f"unparseable gh JSON: {exc}"
    is_draft = payload.get("isDraft")
    if is_draft is True:
        return "draft", ""
    if is_draft is False:
        return "public", ""
    return "error", f"isDraft missing from gh response: {payload!r}"


def _gh_release_flip_to_draft(
    gh_path: str, version: str, repo: str, project_root: Path
) -> tuple[bool, str]:
    """Invoke ``gh release edit v<version> --draft=true``."""
    tag = f"v{version}"
    cmd = [
        gh_path, "release", "edit", tag,
        "--repo", repo,
        "--draft=true",
    ]
    try:
        result = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    except subprocess.TimeoutExpired:
        return False, "gh release edit timed out"
    if result.returncode != 0:
        return False, f"gh release edit failed: {(result.stderr or '').strip()}"
    return True, f"flipped {tag} to draft"


def verify_release_draft(
    project_root: Path,
    version: str,
    repo: str,
    *,
    max_attempts: int = VERIFY_DRAFT_MAX_ATTEMPTS,
    interval: float = VERIFY_DRAFT_INTERVAL_SECONDS,
    sleep: Callable[[float], None] | None = None,
) -> tuple[bool, str]:
    """Verify the freshly-created release actually landed in draft state (#724).

    Polls ``gh release view v<version> --json isDraft`` up to
    ``max_attempts`` times with ``interval`` seconds between attempts (5s
    total budget by default). Three terminal states:

    - ``"draft"``: release exists with ``isDraft=true``. Returns
      ``(True, "verified draft")`` -- the happy path.
    - ``"public"``: release exists with ``isDraft=false``. Immediately
      invokes ``gh release edit --draft=true`` and emits a ``WARNING``
      line citing #724. Returns ``(True, "flipped to draft (...)")`` on
      successful flip; ``(False, ...)`` only if the flip itself fails.
    - ``"not-found"`` after every poll: the release record has not
      propagated yet (release.yml CI may still be processing). Returns
      ``(True, "not found within budget; release.yml may still be
      processing")`` -- emits a WARN line but does not fail the pipeline,
      since the create call itself exited 0.

    The auto-flip is defense-in-depth: it covers the case where the
    create command exited 0 but the release somehow landed as public
    (e.g. operator-error variant of #724 where an alternate code path
    sent the release without ``--draft``). It is a no-op on the happy
    path and never fires when the create call itself failed.
    """
    if max_attempts <= 0:
        return True, "verify gate disabled (max_attempts <= 0)"
    sleep_fn = sleep if sleep is not None else time.sleep
    gh_path = _resolve_gh()
    if gh_path is None:
        # Surface a non-fatal warning -- the verify gate is best-effort
        # defense-in-depth and the create call already exited 0.
        print(
            "WARNING: cannot verify draft state (gh CLI not found on PATH); "
            "defense-in-depth gate skipped (see #724)",
            file=sys.stderr,
        )
        return True, "gh CLI not found on PATH; verify gate skipped"
    last_state = ""
    last_detail = ""
    for attempt in range(1, max_attempts + 1):
        state, detail = _gh_release_view_is_draft(
            gh_path, version, repo, project_root
        )
        last_state, last_detail = state, detail
        if state == "draft":
            return True, f"verified draft on attempt {attempt}/{max_attempts}"
        if state == "public":
            print(
                f"WARNING: release v{version} landed as public; "
                f"flipping to draft (defense-in-depth, see #724)",
                file=sys.stderr,
            )
            ok, reason = _gh_release_flip_to_draft(
                gh_path, version, repo, project_root
            )
            if ok:
                return True, f"flipped to draft ({reason})"
            return False, reason
        # not-found / error -- keep polling; sleep between attempts only
        # while we still have budget. ``sleep_fn`` is typed as
        # ``Callable[[float], None]`` so callers (production: ``time.sleep``;
        # tests: 1-arg stubs like ``lambda _s: None`` or
        # ``lambda s: sleeps.append(s)``) all accept the interval argument.
        if attempt < max_attempts:
            sleep_fn(interval)
    if last_state == "not-found":
        print(
            f"WARNING: release v{version} not found within "
            f"{max_attempts}*{interval}s budget; release.yml CI may still "
            f"be processing (see #724)",
            file=sys.stderr,
        )
        return True, "not found within budget; verify gate inconclusive"
    print(
        f"WARNING: verify gate could not confirm draft state for v{version}: "
        f"last state {last_state!r}; detail: {last_detail} (see #724)",
        file=sys.stderr,
    )
    return True, f"inconclusive ({last_state}); verify gate skipped"


# ---- Pipeline orchestration ------------------------------------------------


_TOTAL_STEPS = 12


def _emit(step: int, label: str, status: str, *, file=None) -> None:
    # Resolve sys.stderr at call time so test capture (pytest's capsys, which
    # rebinds sys.stderr per-test) sees emitted lines. Binding the default at
    # function-definition time would freeze the original stderr captured at
    # module load and bypass capsys.
    target = file if file is not None else sys.stderr
    print(f"[{step}/{_TOTAL_STEPS}] {label}... {status}", file=target)


def run_pipeline(config: ReleaseConfig) -> int:
    """Execute the release pipeline; returns the process exit code."""
    project_root = config.project_root
    version = config.version
    today = _today_iso()
    changelog_path = project_root / "CHANGELOG.md"

    # Step 1: dirty-tree guard.
    label = "Pre-flight git status"
    if config.dry_run:
        _emit(1, label, f"DRYRUN (would run `git status --porcelain` in {project_root})")
    else:
        ok, output = check_git_clean(project_root)
        if ok:
            _emit(1, label, "OK (tree clean)")
        elif config.allow_dirty:
            _emit(1, label, f"WARN (dirty, --allow-dirty set):\n{output}")
        else:
            _emit(
                1,
                label,
                "FAIL (working tree is dirty; commit/stash or pass --allow-dirty)",
            )
            print(output, file=sys.stderr)
            return EXIT_VIOLATION

    # Step 2: branch guard.
    label = f"Pre-flight branch == {config.base_branch}"
    if config.dry_run:
        _emit(2, label, f"DRYRUN (would assert current branch == {config.base_branch})")
    else:
        branch = current_branch(project_root)
        if branch == config.base_branch:
            _emit(2, label, f"OK (on {branch})")
        else:
            _emit(
                2,
                label,
                f"FAIL (on {branch!r}; expected {config.base_branch!r})",
            )
            return EXIT_VIOLATION

    # Step 3: vBRIEF lifecycle sync (#734).
    label = "Pre-flight vBRIEF lifecycle sync"
    if config.allow_vbrief_drift:
        _emit(3, label, "SKIP (--allow-vbrief-drift)")
    elif config.dry_run:
        _emit(
            3,
            label,
            "DRYRUN (would scan vbrief/ + gh open issues for closed-issue mismatches)",
        )
    else:
        ok, mismatch_count, reason = check_vbrief_lifecycle_sync(
            project_root, config.repo
        )
        if ok:
            _emit(3, label, "OK (no mismatches)")
        elif mismatch_count == -1:
            _emit(3, label, f"FAIL ({reason})")
            return EXIT_CONFIG_ERROR
        else:
            _emit(
                3,
                label,
                (
                    f"FAIL ({mismatch_count} mismatches; "
                    "run task reconcile:issues -- --apply-lifecycle-fixes "
                    "to fix, or pass --allow-vbrief-drift to override)"
                ),
            )
            print(reason, file=sys.stderr)
            return EXIT_VIOLATION

    # Step 4: CI.
    label = "Pre-flight CI (task ci:local | fallback task check)"
    if config.skip_ci:
        # #720: e2e rehearsal opts out -- CI is covered by the unit-test
        # suite at every commit on master, not by re-running it inside
        # the auto-created temp repo.
        _emit(4, label, "SKIP (--skip-ci)")
    elif config.dry_run:
        _emit(4, label, "DRYRUN (would run task ci:local with task check fallback)")
    else:
        ok, reason = run_ci(project_root)
        if ok:
            _emit(4, label, f"OK ({reason})")
        else:
            _emit(4, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 5: CHANGELOG promotion.
    label = "CHANGELOG promotion"
    if not changelog_path.is_file():
        _emit(5, label, f"FAIL (CHANGELOG.md not found at {changelog_path})")
        return EXIT_CONFIG_ERROR
    original_changelog = changelog_path.read_text(encoding="utf-8")
    try:
        promoted_changelog = promote_changelog(
            original_changelog,
            version,
            config.repo,
            today,
            summary=config.summary,
        )
    except ValueError as exc:
        _emit(5, label, f"FAIL ({exc})")
        return EXIT_CONFIG_ERROR
    # Surface whether a summary was supplied so operators can validate
    # the wording during Phase 2 dry-run before any file is written
    # (release-narrative-gap scope vBRIEF).
    if config.summary:
        truncated = config.summary[:60]
        # P2 (#730 Greptile): variable name ``ellipsis`` shadows the
        # Python builtin (the type of ``...``). Rename to
        # ``truncation_suffix`` to avoid the shadow.
        truncation_suffix = "..." if len(config.summary) > 60 else ""
        summary_note = f' summary: "{truncated}{truncation_suffix}"'
    else:
        summary_note = " no summary"
    if config.dry_run:
        _emit(
            5,
            label,
            f"DRYRUN (would rewrite {changelog_path.name}: "
            f"## [Unreleased] -> ## [{version}] - {today}; new compare link added;"
            f"{summary_note})",
        )
    else:
        changelog_path.write_text(promoted_changelog, encoding="utf-8")
        _emit(5, label, f"OK (## [{version}] - {today};{summary_note})")

    # Step 6: ROADMAP refresh.
    label = "ROADMAP refresh (task roadmap:render)"
    if config.dry_run:
        _emit(6, label, "DRYRUN (would run task roadmap:render)")
    else:
        ok, reason = refresh_roadmap(project_root)
        if ok:
            _emit(6, label, f"OK ({reason})")
        else:
            _emit(6, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 7: build dist (#723: pin DEFT_RELEASE_VERSION so the artifact
    # filename matches the in-flight release version, not the stale
    # Taskfile literal or the most-recent git tag; #720: --skip-build
    # opts out for e2e rehearsals where build artefacts are not needed
    # for the draft-release verification step).
    label = f"Build dist (task build, DEFT_RELEASE_VERSION={version})"
    if config.skip_build:
        _emit(7, label, "SKIP (--skip-build)")
    elif config.dry_run:
        _emit(
            7,
            label,
            f"DRYRUN (would run `task build` with DEFT_RELEASE_VERSION={version})",
        )
    else:
        ok, reason = run_build(project_root, version)
        if ok:
            _emit(7, label, f"OK ({reason})")
        else:
            _emit(7, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 8: commit release artifacts (CHANGELOG + ROADMAP) before tagging
    # so the annotated tag and GitHub release anchor at the promoted commit
    # rather than the pre-release HEAD (#74 Greptile P1). Skipped together
    # with tagging when --skip-tag is set, since a committed-but-untagged
    # state would still leave the working tree dirty post-pipeline.
    label = f"Commit release artifacts ({', '.join(_RELEASE_ARTIFACTS)})"
    if config.skip_tag:
        _emit(8, label, "SKIP (--skip-tag)")
    elif config.dry_run:
        _emit(
            8,
            label,
            f"DRYRUN (would run `git add {' '.join(_RELEASE_ARTIFACTS)}` + "
            f"`git commit -m '{_release_commit_subject(version)}'`)",
        )
    else:
        ok, reason = commit_release_artifacts(project_root, version)
        if ok:
            _emit(8, label, f"OK ({reason})")
        else:
            _emit(8, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 9: git tag.
    label = f"Tag v{version}"
    if config.skip_tag:
        _emit(9, label, "SKIP (--skip-tag)")
    elif config.dry_run:
        _emit(9, label, f"DRYRUN (would run `git tag -a v{version} -m 'Release v{version}'`)")
    else:
        ok, reason = create_tag(project_root, version)
        if ok:
            _emit(9, label, f"OK ({reason})")
        else:
            _emit(9, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 10: push branch + tag atomically.
    label = f"Push {config.base_branch} + v{version} to origin (atomic)"
    if config.skip_tag:
        _emit(10, label, "SKIP (--skip-tag)")
    elif config.dry_run:
        _emit(
            10,
            label,
            f"DRYRUN (would run `git push --atomic origin {config.base_branch} v{version}`)",
        )
    else:
        ok, reason = push_release(project_root, version, config.base_branch)
        if ok:
            _emit(10, label, f"OK ({reason})")
        else:
            _emit(10, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 11: GitHub release.
    draft_suffix = " (draft)" if config.draft else " (PUBLIC)"
    label = f"GitHub release v{version}{draft_suffix}"
    create_succeeded = False
    if config.skip_release:
        _emit(11, label, "SKIP (--skip-release)")
    elif config.dry_run:
        draft_flag = " --draft" if config.draft else ""
        _emit(
            11,
            label,
            (
                f"DRYRUN (would run `gh release create v{version} "
                f"--repo {config.repo}{draft_flag} ...`)"
            ),
        )
    else:
        notes = _section_for_version(promoted_changelog, version)
        ok, reason = create_github_release(
            project_root, version, config.repo, notes, draft=config.draft
        )
        if ok:
            _emit(11, label, f"OK ({reason})")
            create_succeeded = True
        else:
            _emit(11, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 12: post-create verify-isDraft gate (#724). Defense in depth
    # against the v0.21.0 incident where a manual recovery created a
    # public release for ~90s before being flipped. Skipped when the
    # create step itself was skipped, when the operator opted into a
    # direct-publish via --no-draft, and during dry-run.
    label = f"Verify draft state of v{version} (#724 defense-in-depth)"
    if config.skip_release:
        _emit(12, label, "SKIP (--skip-release)")
    elif not config.draft:
        _emit(12, label, "SKIP (--no-draft; intentional public release)")
    elif config.dry_run:
        _emit(
            12,
            label,
            (
                f"DRYRUN (would poll `gh release view v{version} --json isDraft`"
                f" up to {VERIFY_DRAFT_MAX_ATTEMPTS}x at {VERIFY_DRAFT_INTERVAL_SECONDS}s"
                " intervals; auto-flip via `gh release edit --draft=true` on isDraft=false)"
            ),
        )
    elif not create_succeeded:
        # Should be unreachable -- the create branch returns
        # EXIT_VIOLATION on failure -- but guard explicitly for the
        # benefit of unit-test stubs that bypass the early return.
        _emit(12, label, "SKIP (release was not created in this run)")
    else:
        ok, reason = verify_release_draft(
            project_root, version, config.repo
        )
        if ok:
            _emit(12, label, f"OK ({reason})")
        else:
            _emit(12, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    print(
        f"Release v{version} pipeline complete "
        f"(dry_run={config.dry_run}, skip_tag={config.skip_tag}, "
        f"skip_release={config.skip_release}).",
        file=sys.stderr,
    )
    return EXIT_OK


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        _validate_version(args.version)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    project_root = _resolve_project_root(args.project_root)
    repo = _resolve_repo(args.repo, project_root)

    config = ReleaseConfig(
        version=args.version,
        repo=repo,
        base_branch=args.base_branch,
        project_root=project_root,
        dry_run=args.dry_run,
        skip_tag=args.skip_tag,
        skip_release=args.skip_release,
        allow_dirty=args.allow_dirty,
        draft=args.draft,
        skip_ci=args.skip_ci,
        skip_build=args.skip_build,
        summary=args.summary,
        allow_vbrief_drift=args.allow_vbrief_drift,
    )
    return run_pipeline(config)


if __name__ == "__main__":
    sys.exit(main())
