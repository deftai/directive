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

Exit codes
----------
    0 -- release flow completed successfully (or dry-run preview ok)
    1 -- pre-flight or pipeline-step violation (dirty tree, wrong branch,
         CI failure, CHANGELOG lacks [Unreleased], gh release failure ...)
    2 -- config / argument error (malformed version, repo unresolvable,
         CHANGELOG malformed, ...)

Refs #74, #233, #642, #635, #709 (Repair Authority [AXIOM]),
#710 (data-file-conventions check follow-up).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import shutil
import subprocess
import sys
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


# ---- Step 3 -- CI ----------------------------------------------------------


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


def promote_changelog(text: str, version: str, repo: str, today: str) -> str:
    """Promote ``[Unreleased]`` to ``[<version>] - <today>`` and refresh the link footer.

    Raises ValueError when the input lacks an ``[Unreleased]`` heading or
    appears malformed.
    """
    if not _UNRELEASED_RE.search(text):
        raise ValueError("CHANGELOG.md does not contain a '## [Unreleased]' heading.")

    body, footer = _split_body_and_links(text)

    # Promote: rename heading + insert fresh empty Unreleased block above.
    promoted_heading = f"## [{version}] - {today}"
    fresh_block = FRESH_UNRELEASED_BLOCK.rstrip() + "\n\n"
    new_body, count = _UNRELEASED_RE.subn(
        fresh_block + promoted_heading,
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


def run_build(project_root: Path) -> tuple[bool, str]:
    if not task_binary_available():
        return False, "task binary not found on PATH"
    if not task_has_target("build", cwd=project_root):
        return True, "task build not defined; skipping"
    try:
        result = subprocess.run(
            ["task", "build"],
            cwd=str(project_root),
            check=False,
        )
    except FileNotFoundError:
        return False, "task binary not found on PATH"
    if result.returncode != 0:
        return False, f"task build failed (exit {result.returncode})"
    return True, "task build ran clean"


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
    project_root: Path, version: str, repo: str, notes: str
) -> tuple[bool, str]:
    if shutil.which("gh") is None:
        return False, "gh CLI not found on PATH"
    tag = f"v{version}"
    cmd = [
        "gh", "release", "create", tag,
        "--repo", repo,
        "--title", tag,
    ]
    if notes:
        cmd.extend(["--notes", notes])
    else:
        cmd.append("--generate-notes")
    try:
        result = subprocess.run(
            cmd,
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh release create failed: {result.stderr.strip()}"
    return True, f"created GitHub release {tag}"


# ---- Pipeline orchestration ------------------------------------------------


_TOTAL_STEPS = 10


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

    # Step 3: CI.
    label = "Pre-flight CI (task ci:local | fallback task check)"
    if config.dry_run:
        _emit(3, label, "DRYRUN (would run task ci:local with task check fallback)")
    else:
        ok, reason = run_ci(project_root)
        if ok:
            _emit(3, label, f"OK ({reason})")
        else:
            _emit(3, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 4: CHANGELOG promotion.
    label = "CHANGELOG promotion"
    if not changelog_path.is_file():
        _emit(4, label, f"FAIL (CHANGELOG.md not found at {changelog_path})")
        return EXIT_CONFIG_ERROR
    original_changelog = changelog_path.read_text(encoding="utf-8")
    try:
        promoted_changelog = promote_changelog(
            original_changelog, version, config.repo, today
        )
    except ValueError as exc:
        _emit(4, label, f"FAIL ({exc})")
        return EXIT_CONFIG_ERROR
    if config.dry_run:
        _emit(
            4,
            label,
            f"DRYRUN (would rewrite {changelog_path.name}: "
            f"## [Unreleased] -> ## [{version}] - {today}; new compare link added)",
        )
    else:
        changelog_path.write_text(promoted_changelog, encoding="utf-8")
        _emit(4, label, f"OK (## [{version}] - {today})")

    # Step 5: ROADMAP refresh.
    label = "ROADMAP refresh (task roadmap:render)"
    if config.dry_run:
        _emit(5, label, "DRYRUN (would run task roadmap:render)")
    else:
        ok, reason = refresh_roadmap(project_root)
        if ok:
            _emit(5, label, f"OK ({reason})")
        else:
            _emit(5, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 6: build dist.
    label = "Build dist (task build)"
    if config.dry_run:
        _emit(6, label, "DRYRUN (would run task build)")
    else:
        ok, reason = run_build(project_root)
        if ok:
            _emit(6, label, f"OK ({reason})")
        else:
            _emit(6, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 7: commit release artifacts (CHANGELOG + ROADMAP) before tagging
    # so the annotated tag and GitHub release anchor at the promoted commit
    # rather than the pre-release HEAD (#74 Greptile P1). Skipped together
    # with tagging when --skip-tag is set, since a committed-but-untagged
    # state would still leave the working tree dirty post-pipeline.
    label = f"Commit release artifacts ({', '.join(_RELEASE_ARTIFACTS)})"
    if config.skip_tag:
        _emit(7, label, "SKIP (--skip-tag)")
    elif config.dry_run:
        _emit(
            7,
            label,
            f"DRYRUN (would run `git add {' '.join(_RELEASE_ARTIFACTS)}` + "
            f"`git commit -m '{_release_commit_subject(version)}'`)",
        )
    else:
        ok, reason = commit_release_artifacts(project_root, version)
        if ok:
            _emit(7, label, f"OK ({reason})")
        else:
            _emit(7, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 8: git tag.
    label = f"Tag v{version}"
    if config.skip_tag:
        _emit(8, label, "SKIP (--skip-tag)")
    elif config.dry_run:
        _emit(8, label, f"DRYRUN (would run `git tag -a v{version} -m 'Release v{version}'`)")
    else:
        ok, reason = create_tag(project_root, version)
        if ok:
            _emit(8, label, f"OK ({reason})")
        else:
            _emit(8, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 9: push branch + tag atomically.
    label = f"Push {config.base_branch} + v{version} to origin (atomic)"
    if config.skip_tag:
        _emit(9, label, "SKIP (--skip-tag)")
    elif config.dry_run:
        _emit(
            9,
            label,
            f"DRYRUN (would run `git push --atomic origin {config.base_branch} v{version}`)",
        )
    else:
        ok, reason = push_release(project_root, version, config.base_branch)
        if ok:
            _emit(9, label, f"OK ({reason})")
        else:
            _emit(9, label, f"FAIL ({reason})")
            return EXIT_VIOLATION

    # Step 10: GitHub release.
    label = f"GitHub release v{version}"
    if config.skip_release:
        _emit(10, label, "SKIP (--skip-release)")
    elif config.dry_run:
        _emit(
            10,
            label,
            f"DRYRUN (would run `gh release create v{version} --repo {config.repo} ...`)",
        )
    else:
        notes = _section_for_version(promoted_changelog, version)
        ok, reason = create_github_release(project_root, version, config.repo, notes)
        if ok:
            _emit(10, label, f"OK ({reason})")
        else:
            _emit(10, label, f"FAIL ({reason})")
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
    )
    return run_pipeline(config)


if __name__ == "__main__":
    sys.exit(main())
