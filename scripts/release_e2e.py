#!/usr/bin/env python3
"""release_e2e.py -- Auto-create + auto-destroy temp-repo release rehearsal (#716, #720).

Companion to ``scripts/release.py`` per the #716 safety hardening Q1
decision (auto-create + auto-destroy temp repo). ``task release:e2e``
provisions a private GitHub repo named
``deftai-release-test-<timestamp>-<uuid6>``, runs the full release
pipeline against it, then destroys the repo via ``gh repo delete --yes``
in a ``try/finally`` so cleanup runs even when the test fails.

Pipeline (#720 deepening) and env hygiene (#728 cycle 2)
--------------------------------------------------------
The rehearsal step was previously a smoke-test existence check
(``gh repo view``); per #720 it now mirrors the directive repo into
the temp remote and exercises the actual ``task release`` pipeline
end-to-end. Per the #728 cycle-2 Greptile review, every subprocess
that could resolve a project root (``clone_repo_to_temp``,
``dispatch_task_release``, ``dispatch_task_release_rollback``) must
also pin ``DEFT_PROJECT_ROOT=<clone_dir>`` so an operator with that
environment variable already exported in their shell does NOT have
``task release`` resolve back to the real directive repo and push
spurious ``v0.0.1`` artefacts to ``deftai/directive``.

1. Generate a unique repo slug (``deftai-release-test-<timestamp>-<uuid6>``)
2. ``gh repo create --private deftai/<slug> --description "..."``
3. Mirror the current directive repo into the temp remote and exercise
   the release pipeline:

   a. ``git clone <project_root> <tmpdir>`` -- shallow-style local clone
      (operates on the on-disk repo so we do not depend on network).
   b. ``git -C <tmpdir> remote set-url origin <temp-repo-url>`` -- point
      origin at the auto-created temp remote.
   c. ``git -C <tmpdir> push origin refs/heads/*:refs/heads/*
      refs/tags/*:refs/tags/*`` -- populate the temp remote with every
      branch and tag using explicit refspecs. We deliberately avoid
      ``git push --mirror`` here because ``--mirror`` also pushes
      ``refs/remotes/*`` (the local clone's remote-tracking refs);
      GitHub's receive-pack rejects writes to that namespace and the
      whole rehearsal would fail at the push step. Explicit refspecs
      cover the two namespaces we actually care about (heads + tags)
      without leaking remote-tracking refs.
   d. ``task release -- 0.0.1 --repo deftai/<slug> --skip-ci --skip-build``
      -- run the full 10-step pipeline against the temp repo. ``--skip-ci``
      and ``--skip-build`` (#720, see ``scripts/release.py``) keep the
      wall-clock manageable; CI / build semantics are covered by the
      unit-test suite at every commit on master.
   e. ``gh release view v0.0.1 --repo deftai/<slug>`` -- assert
      ``isDraft=true`` and ``tagName == v0.0.1`` (the production draft
      lifecycle, #716).
   f. ``git -C <tmpdir> ls-remote --tags origin v0.0.1`` -- assert the
      tag exists on the temp remote.
   g. ``rehearse_npm_publish`` (#1910) -- mirror ``npm-publish.yml`` against
      the clone: ``pnpm install`` + ``pnpm -w run build``, align the four
      ``@deftai/directive*`` ``package.json`` versions + resolve the
      ``workspace:`` protocol, then ``npm publish --dry-run --access public``
      per package in dependency order (types -> core -> content -> cli). This
      catches a broken ``files`` allowlist, version drift, or dependency-order
      bug BEFORE a real ``v*`` tag fires the publish workflow, without ever
      touching the real registry. Soft-skips when ``npm`` is absent from PATH;
      suppressed entirely by ``--skip-npm`` (install+build exceed the <90s
      fast budget that ``--skip-ci``/``--skip-build`` protect).
   h. ``task release:rollback -- 0.0.1 --repo deftai/<slug>`` -- exercise
      the rollback path against a known-state release (#725 forward-revert
      flow on a protected default branch).

4. ``gh repo delete deftai/<slug> --yes`` -- ALWAYS in a finally clause
5. If delete fails, surface a one-line manual cleanup hint and continue
   so the test result still reaches stdout

Wall-clock (#720)
-----------------
``--skip-ci`` and ``--skip-build`` keep the rehearsal wall-clock under
90 seconds on a typical operator machine. Skipping these is safe inside
the rehearsal because (a) CI runs at every commit on master via
``.github/workflows/ci.yml``; (b) build artefacts are not needed for
the draft-release verification step; (c) the unit-test suite covers
both paths in isolation.

Exit codes
----------
    0 -- rehearsal succeeded; cleanup succeeded (or surfaced as a warning)
    1 -- rehearsal failed; cleanup ran regardless
    2 -- config / argument error (gh missing, owner unset, ...)

Mockability
-----------
Every side-effecting step (``provision_temp_repo`` / ``destroy_temp_repo``
/ ``clone_repo_to_temp`` / ``set_origin_to_temp_repo`` / ``push_mirror``
/ ``dispatch_task_release`` / ``verify_draft_release`` / ``verify_tag``
/ ``rehearse_npm_publish`` / ``dispatch_task_release_rollback``) is an
isolated function so tests can replace it with a mock; CI exercises the
orchestration without ever cloning, pushing, or hitting real GitHub.

Refs #720 (pipeline-mirror deepening), #716 (canonical spec; safety
hardening Item 4 of 7), #722 (subprocess PATHEXT fix; release._resolve_gh
helper re-used here), #725 (forward-revert + normal push in rollback),
#74 (foundation), #233, #642, #635, #709, #710.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import io
import json
import os
import shutil  # noqa: F401  -- kept for tests that monkeypatch release_e2e.shutil.which
import subprocess
import sys
import tempfile
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

import release  # noqa: E402
import release_rollback  # noqa: E402

EXIT_OK = release.EXIT_OK
EXIT_VIOLATION = release.EXIT_VIOLATION
EXIT_CONFIG_ERROR = release.EXIT_CONFIG_ERROR

DEFAULT_OWNER = "deftai"
REPO_SLUG_PREFIX = "deftai-release-test-"

# #720: the rehearsal version is a fixed sentinel rather than a real
# release version. ``0.0.1`` is far enough below any real deft release
# that an operator scrolling release notes can immediately recognise it
# as a rehearsal artefact -- and ``X.Y.Z`` matches the strict semver
# regex enforced by ``release._validate_version``.
REHEARSAL_VERSION = "0.0.1"

# #1910: dependency order for the npm publish dry-run rehearsal, mirroring
# .github/workflows/npm-publish.yml (types -> core -> content -> cli).
NPM_PUBLISH_PACKAGES = ("types", "core", "content", "cli")
NPM_INSTALL_TIMEOUT_SECONDS = 600
NPM_BUILD_TIMEOUT_SECONDS = 600
NPM_PUBLISH_DRYRUN_TIMEOUT_SECONDS = 180

RELEASE_ENTRYPOINT_TIMEOUT_SECONDS = 600.0
ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS = 300.0
ENTRYPOINT_TIMEOUT_EXIT_CODE = 124
_ENTRYPOINT_PROCESS_STATE_LOCK = threading.Lock()
_ENTRYPOINT_ACTIVE_RESTORE_OWNER: object | None = None


# ---- Data classes -----------------------------------------------------------


@dataclass
class E2EConfig:
    owner: str
    project_root: Path
    dry_run: bool
    keep_repo: bool  # When True, skip cleanup (manual debugging only)
    skip_npm: bool = False  # When True, skip the npm publish dry-run step (#1910)
    # Optional override slug (test injection). If None, a fresh slug is
    # generated per run.
    repo_slug: str | None = None


# ---- argument parsing -------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="release_e2e",
        description=(
            "End-to-end release rehearsal against an auto-created+destroyed "
            "temp GitHub repo (#716 safety hardening Q1)."
        ),
    )
    parser.add_argument(
        "--owner",
        default=DEFAULT_OWNER,
        metavar="OWNER",
        help=f"GitHub owner under which to create the temp repo (default: {DEFAULT_OWNER}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the pipeline plan without invoking gh.",
    )
    parser.add_argument(
        "--keep-repo",
        action="store_true",
        help=(
            "Skip destroying the temp repo at the end (use only when "
            "manually debugging a failed rehearsal; remember to clean "
            "up by hand)."
        ),
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=None,
        metavar="PATH",
        help="Repository root (default: $DEFT_PROJECT_ROOT or scripts/.. ).",
    )
    parser.add_argument(
        "--skip-npm",
        action="store_true",
        help=(
            "Skip the npm publish dry-run rehearsal step (#1910). The step "
            "installs + builds the workspace, which exceeds the <90s fast "
            "budget that --skip-ci/--skip-build protect; use this to keep the "
            "rehearsal fast. The step also soft-skips on its own when npm is "
            "absent from PATH."
        ),
    )
    return parser


# ---- helpers ----------------------------------------------------------------


def _emit(label: str, status: str) -> None:
    print(f"[e2e] {label}... {status}", file=sys.stderr)


def generate_repo_slug() -> str:
    """Generate a unique temp repo slug.

    Format: ``deftai-release-test-<YYYYMMDDHHMMSS>-<uuid6>``.
    The timestamp aids visual sorting in `gh repo list` if cleanup ever
    fails; the uuid6 suffix ensures uniqueness across rapid re-runs.
    """
    timestamp = _dt.datetime.now(_dt.UTC).strftime("%Y%m%d%H%M%S")
    suffix = uuid.uuid4().hex[:6]
    return f"{REPO_SLUG_PREFIX}{timestamp}-{suffix}"


def provision_temp_repo(owner: str, slug: str) -> tuple[bool, str]:
    """Invoke ``gh repo create --private <owner>/<slug>``.

    Returns ``(ok, reason)``. The remote is created empty; downstream
    pipeline steps (clone, push, etc.) are responsible for populating
    it.
    """
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = [
        gh_path, "repo", "create", full,
        "--private",
        "--description", "Auto-generated release-rehearsal repo (deft #716); safe to delete.",
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh repo create failed: {result.stderr.strip()}"
    return True, f"created {full} (private)"


def destroy_temp_repo(owner: str, slug: str) -> tuple[bool, str]:
    """Invoke ``gh repo delete <owner>/<slug> --yes``.

    Best-effort: returns False with a diagnostic if the delete fails so
    the caller can surface a manual cleanup hint without crashing the
    overall pipeline.
    """
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    full = f"{owner}/{slug}"
    cmd = [gh_path, "repo", "delete", full, "--yes"]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh repo delete failed: {result.stderr.strip()}"
    return True, f"deleted {full}"


# ---- Rehearsal step helpers (#720) -----------------------------------------


def clone_repo_to_temp(
    project_root: Path, target_dir: Path
) -> tuple[bool, str]:
    """Clone the local directive repo into ``target_dir`` (#720, #728).

    Uses ``git clone <project_root> <target_dir>`` so the rehearsal does
    not depend on network access during the clone step (the temp remote
    is populated via the explicit-refspec push in ``push_mirror``
    afterwards). The clone produces a normal working tree with a
    populated ``refs/remotes/origin/*``; that is intentional -- the
    rehearsal needs a working tree to run ``task release`` against, and
    the remote-tracking refs do NOT leak to the GitHub temp repo because
    ``push_mirror`` uses explicit ``refs/heads/*`` + ``refs/tags/*``
    refspecs (see ``push_mirror``'s docstring for the receive-pack
    rationale).

    Per #728 cycle 2 we also pin ``DEFT_PROJECT_ROOT=<target_dir>`` in
    the subprocess env so an operator with that variable already
    exported in their shell cannot accidentally cause helpers further
    down the rehearsal pipeline to resolve back to the real directive
    repo.
    """
    env = os.environ.copy()
    env["DEFT_PROJECT_ROOT"] = str(target_dir)
    result = subprocess.run(
        ["git", "clone", str(project_root), str(target_dir)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        return False, f"git clone failed: {result.stderr.strip()}"
    return True, f"cloned {project_root} -> {target_dir}"


def set_origin_to_temp_repo(
    clone_dir: Path, owner: str, slug: str
) -> tuple[bool, str]:
    """Point the clone's origin at the auto-created temp repo (#720).

    Uses the canonical https URL shape so the rehearsal works on hosts
    that lack an SSH key registered with GitHub (which is the typical
    Windows operator environment for this project).
    """
    url = f"https://github.com/{owner}/{slug}.git"
    result = release._run_git(clone_dir, "remote", "set-url", "origin", url)
    if result.returncode != 0:
        return False, (
            f"git remote set-url failed: {result.stderr.strip()}"
        )
    return True, f"origin -> {url}"


def push_mirror(clone_dir: Path) -> tuple[bool, str]:
    """Populate the temp remote with branches and tags from the clone (#720).

    Pushes every branch and every tag from the local clone to the
    auto-created temp remote using two explicit refspecs:
    ``refs/heads/*:refs/heads/*`` and ``refs/tags/*:refs/tags/*``.

    The function name retains the historical ``push_mirror`` label so
    callers and tests stay stable, but the implementation deliberately
    avoids ``git push --mirror``. ``--mirror`` is documented to push
    every ref under ``refs/`` -- including ``refs/remotes/*``, the
    local clone's remote-tracking refs. GitHub's receive-pack rejects
    writes to that namespace, so a real ``--mirror`` push from a
    non-bare clone (which is what we have here -- ``git clone
    <project_root> <clone_dir>`` produces a normal working clone with
    a populated ``refs/remotes/origin/*``) would fail every real
    ``task release:e2e`` run at this step. Explicit refspecs cover
    the two namespaces the subsequent rehearsal cares about (branches
    + tags) without leaking remote-tracking refs.
    """
    result = release._run_git(
        clone_dir,
        "push",
        "origin",
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
    )
    if result.returncode != 0:
        return False, f"git push (heads+tags refspecs) failed: {result.stderr.strip()}"
    return True, "pushed heads + tags to temp origin"


def _call_release_entrypoint(
    entrypoint: Callable[[list[str] | None], int],
    argv: list[str],
    *,
    clone_dir: Path,
    timeout: float | None = None,
) -> tuple[int, str]:
    """Run a release entrypoint in-process with subprocess-style bounds.

    The original task-backed dispatch capped release at 600s and rollback at
    300s. In-process calls need the same fail-closed behavior so a hung release
    command cannot block the e2e rehearsal forever.
    """
    if timeout is None:
        timeout = RELEASE_ENTRYPOINT_TIMEOUT_SECONDS
    old_cwd = Path.cwd()
    old_project_root = os.environ.get("DEFT_PROJECT_ROOT")
    real_stdout, real_stderr = sys.stdout, sys.stderr
    result: dict[str, tuple[int, str]] = {}
    restore_owner = object()
    timed_out = threading.Event()

    def _activate_process_state() -> bool:
        global _ENTRYPOINT_ACTIVE_RESTORE_OWNER  # noqa: PLW0603

        with _ENTRYPOINT_PROCESS_STATE_LOCK:
            if timed_out.is_set():
                return False
            _ENTRYPOINT_ACTIVE_RESTORE_OWNER = restore_owner
            os.environ["DEFT_PROJECT_ROOT"] = str(clone_dir)
            os.chdir(clone_dir)
            return True

    def _restore_process_state() -> None:
        global _ENTRYPOINT_ACTIVE_RESTORE_OWNER  # noqa: PLW0603

        with _ENTRYPOINT_PROCESS_STATE_LOCK:
            if _ENTRYPOINT_ACTIVE_RESTORE_OWNER is not restore_owner:
                return
            _ENTRYPOINT_ACTIVE_RESTORE_OWNER = None
            os.chdir(old_cwd)
            if old_project_root is None:
                os.environ.pop("DEFT_PROJECT_ROOT", None)
            else:
                os.environ["DEFT_PROJECT_ROOT"] = old_project_root

    @contextlib.contextmanager
    def _redirect_entrypoint_stdio(stdout: io.StringIO, stderr: io.StringIO):
        previous_stdout: TextIO | None = None
        previous_stderr: TextIO | None = None
        active = False
        with _ENTRYPOINT_PROCESS_STATE_LOCK:
            if _ENTRYPOINT_ACTIVE_RESTORE_OWNER is restore_owner:
                previous_stdout = sys.stdout
                previous_stderr = sys.stderr
                sys.stdout, sys.stderr = stdout, stderr
                active = True
        try:
            yield active
        finally:
            if active:
                with _ENTRYPOINT_PROCESS_STATE_LOCK:
                    if (
                        _ENTRYPOINT_ACTIVE_RESTORE_OWNER is restore_owner
                        and previous_stdout is not None
                        and previous_stderr is not None
                    ):
                        sys.stdout, sys.stderr = previous_stdout, previous_stderr

    def _timeout_process_state() -> None:
        global _ENTRYPOINT_ACTIVE_RESTORE_OWNER  # noqa: PLW0603

        with _ENTRYPOINT_PROCESS_STATE_LOCK:
            timed_out.set()
            if _ENTRYPOINT_ACTIVE_RESTORE_OWNER is not restore_owner:
                return
            _ENTRYPOINT_ACTIVE_RESTORE_OWNER = None
            # Own cleanup after timeout; the daemon's later finally block must
            # not restore over any subsequent release entrypoint or capture.
            sys.stdout, sys.stderr = real_stdout, real_stderr
            os.chdir(old_cwd)
            if old_project_root is None:
                os.environ.pop("DEFT_PROJECT_ROOT", None)
            else:
                os.environ["DEFT_PROJECT_ROOT"] = old_project_root

    def _worker() -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        try:
            if not _activate_process_state():
                return
            with _redirect_entrypoint_stdio(stdout, stderr) as stdio_active:
                if not stdio_active:
                    return
                code = entrypoint(argv)
        except SystemExit as exc:
            raw = exc.code
            code = raw if isinstance(raw, int) else (0 if raw is None else 1)
        except Exception as exc:  # noqa: BLE001 -- e2e diagnostics must record failures
            message = f"{type(exc).__name__}: {exc}"
            captured_stderr = stderr.getvalue()
            stderr_value = f"{captured_stderr}\n{message}" if captured_stderr else message
            result["value"] = (EXIT_VIOLATION, stderr_value or stdout.getvalue())
            return
        finally:
            _restore_process_state()
        output = stderr.getvalue() or stdout.getvalue()
        result["value"] = (int(code or 0), output)

    worker = threading.Thread(target=_worker, name="deft-release-entrypoint", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        # A hung worker may still hold process-global stdout/stderr redirects.
        # Claim cleanup before fail-closed; the daemon's later context exit is
        # owner-aware and will not restore over a subsequent capture.
        _timeout_process_state()
        label = getattr(entrypoint, "__name__", "entrypoint")
        return ENTRYPOINT_TIMEOUT_EXIT_CODE, f"{label} timed out after {timeout:g}s"
    return result.get("value", (EXIT_VIOLATION, "entrypoint produced no result"))


def dispatch_task_release(
    clone_dir: Path, version: str, repo: str
) -> tuple[bool, str]:
    """Invoke release.py inside the clone with skip flags and the
    vBRIEF-drift override (#720, #728, post-#754 harness fix).

    The full dispatched argv is
    ``release.py <version> --repo <repo> --skip-ci --skip-build --allow-vbrief-drift``.

    Skipping CI + build keeps the rehearsal wall-clock manageable; both
    are covered by the unit-test suite. The 10-step pipeline still
    exercises CHANGELOG promotion, ROADMAP refresh, commit, tag, atomic
    push, and ``gh release create --draft``.

    #728 cycle 2: ``env["DEFT_PROJECT_ROOT"] = str(clone_dir)`` is
    explicitly pinned BEFORE invoking ``task release``. The release CLI
    resolves its repository root via ``DEFT_PROJECT_ROOT`` (when set) ->
    ``--project-root`` -> the script's own parent. If the operator's
    shell already exported ``DEFT_PROJECT_ROOT`` (a common pattern
    when running deft itself out of a worktree), the rehearsal
    subprocess would resolve back to the REAL directive repo and the
    rest of the pipeline (CHANGELOG promotion, commit, tag, ``git push
    --atomic origin master v0.0.1``) would mutate ``deftai/directive``
    instead of the temp clone. Pinning the env var to ``clone_dir``
    eliminates that ambient-state hazard regardless of the operator's
    shell setup.

    Post-#754 harness fix: ``--allow-vbrief-drift`` is passed because
    the temp rehearsal repo is auto-created empty (zero issues) and
    the inverted-lookup vBRIEF-lifecycle-sync gate (#754) classifies
    every referenced issue number as NOT_FOUND -> Section (c) mismatch
    against an empty target. The gate has no meaningful signal in the
    rehearsal context, so the explicit-acknowledgment escape hatch is
    the correct surface to bypass it. The production cut path (against
    the real repo with real issues) does NOT pass this flag and remains
    fully gated. Without this flag, every ``task release:e2e`` invocation
    since #734 landed has failed at the inner Step 3 lifecycle gate.
    """
    argv = [
        version,
        "--repo", repo,
        "--skip-ci",
        "--skip-build",
        "--allow-vbrief-drift",
    ]
    code, output = _call_release_entrypoint(
        release.main,
        argv,
        clone_dir=clone_dir,
        timeout=RELEASE_ENTRYPOINT_TIMEOUT_SECONDS,
    )
    if code != 0:
        return False, (
            f"release.py failed (exit {code}): "
            f"{output.strip()}"
        )
    return True, f"release.py {version} --repo {repo} (draft) ran clean"


def verify_draft_release(
    owner: str, slug: str, version: str
) -> tuple[bool, str]:
    """Assert ``gh release view`` reports the draft for ``v<version>`` (#720).

    Verifies (a) the release exists, (b) ``isDraft == true``, (c)
    ``tagName == v<version>``. Anything else returns False so the
    rehearsal fails loudly.
    """
    gh_path = release._resolve_gh()
    if gh_path is None:
        return False, "gh CLI not found on PATH"
    tag = f"v{version}"
    full = f"{owner}/{slug}"
    cmd = [
        gh_path, "release", "view", tag,
        "--repo", full,
        "--json", "isDraft,tagName,name,url",
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
            env=os.environ.copy(),
        )
    except FileNotFoundError:
        return False, "gh CLI not found on PATH"
    if result.returncode != 0:
        return False, f"gh release view failed: {result.stderr.strip()}"
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return False, f"gh release view returned non-JSON: {exc}"
    if not payload.get("isDraft"):
        return False, (
            f"draft verify FAIL: expected isDraft=true on {full} {tag}, "
            f"got {payload!r}"
        )
    if payload.get("tagName") != tag:
        return False, (
            f"draft verify FAIL: expected tagName={tag!r} on {full}, "
            f"got tagName={payload.get('tagName')!r}"
        )
    return True, f"verified draft {tag} on {full}"


def verify_tag(clone_dir: Path, version: str) -> tuple[bool, str]:
    """Assert the tag ``v<version>`` exists on the temp remote (#720).

    Uses ``git ls-remote --tags origin`` so the assertion is independent
    of the local tag database (the local clone may have already pushed +
    cleaned up; what matters is the remote ref).
    """
    tag = f"v{version}"
    result = release._run_git(
        clone_dir, "ls-remote", "--tags", "origin", f"refs/tags/{tag}"
    )
    if result.returncode != 0:
        return False, f"git ls-remote failed: {result.stderr.strip()}"
    if not result.stdout.strip():
        return False, f"tag verify FAIL: {tag} not present on temp origin"
    return True, f"verified tag {tag} present on temp origin"


# ---- npm publish dry-run rehearsal (#1910) ---------------------------------


def _resolve_pnpm() -> list[str] | None:
    """Resolve a pnpm invocation prefix for the clone build (#1910).

    Prefers a ``pnpm`` binary on PATH; falls back to ``corepack pnpm`` so a
    Node install that ships corepack (the npm-publish.yml path) works without
    a globally-installed pnpm. Returns ``None`` when neither is available.
    """
    pnpm = shutil.which("pnpm")
    if pnpm:
        return [pnpm]
    corepack = shutil.which("corepack")
    if corepack:
        return [corepack, "pnpm"]
    return None


def _run_npm_step(
    cmd: list[str], cwd: Path, env: dict[str, str], label: str, timeout: int
) -> tuple[bool, str]:
    """Run one npm/pnpm subprocess step and normalise it to ``(ok, reason)``.

    Uses ``encoding="utf-8", errors="replace"`` per the #1366 safe-capture
    rule so an undecodable byte in npm/pnpm output cannot crash the reader.
    """
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=env,
        )
    except FileNotFoundError:
        return False, f"{label}: command not found ({cmd[0]})"
    except subprocess.TimeoutExpired:
        return False, f"{label}: timed out after {timeout}s"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        return False, f"{label} failed (exit {result.returncode}): {detail[-500:]}"
    return True, f"{label} OK"


def align_npm_package_versions(clone_dir: Path, version: str) -> tuple[bool, str]:
    """Bump the four published package versions + resolve workspace deps (#1910).

    Mirrors the npm-publish.yml "Align package versions with release tag" and
    "Resolve workspace protocol for npm publish" steps: every published
    ``package.json`` is set to ``<version>`` and any ``workspace:`` dependency
    spec is rewritten to ``^<version>`` (npm cannot publish the pnpm
    ``workspace:`` protocol verbatim).

    Folds in the scope item-4 version-alignment assertion: after writing,
    each manifest is read back and must report exactly ``<version>`` so a
    drift / malformed-manifest bug surfaces in the rehearsal rather than at
    real tag time.
    """
    for pkg in NPM_PUBLISH_PACKAGES:
        manifest = clone_dir / "packages" / pkg / "package.json"
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return False, f"version-align FAIL: cannot read packages/{pkg}/package.json: {exc}"
        data["version"] = version
        deps = data.get("dependencies")
        if isinstance(deps, dict):
            for name, spec in list(deps.items()):
                if isinstance(spec, str) and spec.startswith("workspace:"):
                    deps[name] = f"^{version}"
        try:
            manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            readback = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return False, f"version-align FAIL: cannot write packages/{pkg}/package.json: {exc}"
        if readback.get("version") != version:
            return False, (
                f"version-align FAIL: packages/{pkg} version="
                f"{readback.get('version')!r} != {version!r}"
            )
    return True, f"aligned 4 package versions to {version} (+ resolved workspace protocol)"


def rehearse_npm_publish(clone_dir: Path, version: str) -> tuple[bool, str]:
    """Dry-run the npm publish for the four @deftai/directive* packages (#1910).

    Mirrors ``.github/workflows/npm-publish.yml`` so a broken ``files``
    allowlist, version drift, or dependency-order bug surfaces in
    ``task release:e2e`` BEFORE a real ``v*`` tag fires the publish
    workflow -- without ever touching the real registry (every package is
    published with ``--dry-run``).

    Steps, all inside the throwaway clone:

    1. Resolve ``npm``. SOFT-SKIP (returns ``ok=True``) when npm is absent so
       Node-less operators are not blocked -- symmetric to ``--skip-npm``.
    2. Resolve pnpm (or ``corepack pnpm``) and ``pnpm install
       --frozen-lockfile``; the fresh ``git clone`` has no ``node_modules``.
    3. ``pnpm -w run build``; ``dist/`` must exist for the dist-only ``files``
       allowlist to produce a meaningful tarball.
    4. Align the four ``package.json`` versions to ``<version>`` and resolve
       the ``workspace:`` protocol (folds in the item-4 version assertion).
    5. ``npm publish --dry-run --access public`` per package in dependency
       order (types -> core -> content -> cli).

    Returns ``(ok, reason)`` like ``verify_draft_release`` / ``verify_tag`` so
    the orchestrator and tests treat it uniformly. Because installing +
    building the workspace blows the <90s rehearsal budget, the orchestrator
    only runs this step when ``--skip-npm`` is NOT set.
    """
    npm_path = shutil.which("npm")
    if npm_path is None:
        return True, "SKIP (npm not on PATH; Node-less operator)"
    pnpm_cmd = _resolve_pnpm()
    if pnpm_cmd is None:
        return False, (
            "npm present but neither pnpm nor corepack is on PATH -- "
            "cannot build the workspace for the dry-run"
        )

    env = os.environ.copy()
    env["DEFT_PROJECT_ROOT"] = str(clone_dir)

    ok, reason = _run_npm_step(
        [*pnpm_cmd, "install", "--frozen-lockfile"],
        clone_dir, env, "pnpm install", NPM_INSTALL_TIMEOUT_SECONDS,
    )
    if not ok:
        return False, reason
    ok, reason = _run_npm_step(
        [*pnpm_cmd, "-w", "run", "build"],
        clone_dir, env, "pnpm build", NPM_BUILD_TIMEOUT_SECONDS,
    )
    if not ok:
        return False, reason
    ok, reason = align_npm_package_versions(clone_dir, version)
    if not ok:
        return False, reason
    for pkg in NPM_PUBLISH_PACKAGES:
        pkg_dir = clone_dir / "packages" / pkg
        ok, reason = _run_npm_step(
            [npm_path, "publish", "--dry-run", "--access", "public"],
            pkg_dir, env, f"npm publish --dry-run packages/{pkg}",
            NPM_PUBLISH_DRYRUN_TIMEOUT_SECONDS,
        )
        if not ok:
            return False, reason
    return True, (
        "npm publish --dry-run clean for 4 packages "
        f"(types -> core -> content -> cli) at v{version}"
    )


def dispatch_task_release_rollback(
    clone_dir: Path, version: str, repo: str
) -> tuple[bool, str]:
    """Invoke release_rollback.py ``<version> --repo <repo>`` (#720, #728).

    Exercises the rollback path against the temp repo so a regression in
    the state-aware unwind (states 1-3) surfaces in the e2e job rather
    than during a real production rollback.

    #728 cycle 2: same ``DEFT_PROJECT_ROOT`` pinning rationale as
    ``dispatch_task_release`` -- without the override, an operator with
    ``DEFT_PROJECT_ROOT`` exported in their shell would have the
    rollback subprocess resolve to the real directive repo, producing
    either a false VIOLATION (release-prep SHA cannot be resolved) or
    -- worse -- mutating the real repo's history.
    """
    argv = [version, "--repo", repo]
    code, output = _call_release_entrypoint(
        release_rollback.main,
        argv,
        clone_dir=clone_dir,
        timeout=ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS,
    )
    if code != 0:
        return False, (
            f"release_rollback.py failed (exit {code}): "
            f"{output.strip()}"
        )
    return True, f"release_rollback.py {version} --repo {repo} ran clean"


def run_rehearsal(
    owner: str, slug: str, project_root: Path,
    version: str = REHEARSAL_VERSION,
    *,
    skip_npm: bool = False,
) -> tuple[bool, str]:
    """Execute the full pipeline-mirror rehearsal (#720, #1910).

    Orchestrates the rehearsal steps inside a
    ``tempfile.TemporaryDirectory``: clone -> set-origin -> push-mirror ->
    task release -> verify draft -> verify tag -> (npm publish dry-run) ->
    task release:rollback. On the first step failure, short-circuits and
    returns the diagnostic; the caller is responsible for cleanup of the
    temp GitHub repo (run_e2e wraps this in ``try/finally``).

    Per #1910 the npm publish dry-run step is inserted after ``verify tag``
    and before ``task release:rollback`` unless ``skip_npm`` is set; it
    soft-skips internally when ``npm`` is absent from PATH so Node-less
    operators are not blocked.

    Pre-#720 this function was a smoke-test ``gh repo view`` (existence
    check only). The deeper flow surfaces real regressions in the
    release pipeline before they hit master.
    """
    repo_full = f"{owner}/{slug}"
    with tempfile.TemporaryDirectory(prefix="deft-e2e-") as tmpdir:
        clone_dir = Path(tmpdir) / "clone"
        steps: list[tuple[str, Callable[[], tuple[bool, str]]]] = [
            ("clone", lambda: clone_repo_to_temp(project_root, clone_dir)),
            ("set-origin", lambda: set_origin_to_temp_repo(clone_dir, owner, slug)),
            ("push-mirror", lambda: push_mirror(clone_dir)),
            ("task release", lambda: dispatch_task_release(clone_dir, version, repo_full)),
            ("verify draft", lambda: verify_draft_release(owner, slug, version)),
            ("verify tag", lambda: verify_tag(clone_dir, version)),
        ]
        if not skip_npm:
            steps.append(
                ("npm publish dry-run", lambda: rehearse_npm_publish(clone_dir, version))
            )
        steps.append(
            (
                "task release:rollback",
                lambda: dispatch_task_release_rollback(clone_dir, version, repo_full),
            )
        )
        for label, step in steps:
            ok, reason = step()
            _emit(f"  rehearsal step: {label}", f"{'OK' if ok else 'FAIL'} ({reason})")
            if not ok:
                return False, f"{label}: {reason}"
    npm_note = " (npm dry-run skipped)" if skip_npm else " -> npm publish dry-run"
    return True, (
        f"pipeline-mirror rehearsal succeeded against {repo_full} "
        f"({len(steps)} steps; clone -> push heads+tags -> task release -> "
        f"verify draft+tag{npm_note} -> rollback)"
    )


# ---- pipeline ---------------------------------------------------------------


def run_e2e(config: E2EConfig) -> int:
    """Execute the e2e rehearsal pipeline; returns the process exit code.

    The function is intentionally structured as ``provision -> rehearse
    -> destroy`` with the cleanup in a ``finally`` block so a failed
    rehearsal still triggers ``gh repo delete``. If the cleanup itself
    fails, a warning is printed but the rehearsal's own exit code wins
    so the operator does not see "rehearsal failed" reported as
    "cleanup failed".
    """
    slug = config.repo_slug or generate_repo_slug()
    owner = config.owner

    if config.dry_run:
        _emit(
            "Provision temp repo",
            f"DRYRUN (would run `gh repo create --private {owner}/{slug}`)",
        )
        npm_plan = (
            "task release:rollback"
            if config.skip_npm
            else "npm publish dry-run (4 packages) -> task release:rollback"
        )
        _emit(
            "Rehearsal",
            (
                "DRYRUN (would run pipeline-mirror rehearsal: clone -> "
                "push heads+tags -> task release -> verify draft + tag -> "
                f"{npm_plan} against temp repo)"
            ),
        )
        _emit(
            "Destroy temp repo",
            f"DRYRUN (would run `gh repo delete {owner}/{slug} --yes`)",
        )
        return EXIT_OK

    # Provision.
    ok, reason = provision_temp_repo(owner, slug)
    if not ok:
        _emit(f"Provision {owner}/{slug}", f"FAIL ({reason})")
        return EXIT_VIOLATION
    _emit(f"Provision {owner}/{slug}", f"OK ({reason})")

    rehearsal_rc = EXIT_OK
    try:
        ok, reason = run_rehearsal(
            owner, slug, config.project_root, skip_npm=config.skip_npm
        )
        if ok:
            _emit("Rehearsal", f"OK ({reason})")
        else:
            _emit("Rehearsal", f"FAIL ({reason})")
            rehearsal_rc = EXIT_VIOLATION
    finally:
        if config.keep_repo:
            _emit(
                f"Destroy {owner}/{slug}",
                "SKIP (--keep-repo set; manual cleanup required: "
                f"gh repo delete {owner}/{slug} --yes)",
            )
        else:
            ok, reason = destroy_temp_repo(owner, slug)
            if ok:
                _emit(f"Destroy {owner}/{slug}", f"OK ({reason})")
            else:
                # Cleanup failure does NOT override the rehearsal exit
                # code; we surface a warning + manual cleanup hint and
                # let the rehearsal's status stand.
                _emit(
                    f"Destroy {owner}/{slug}",
                    f"WARN ({reason}); manual cleanup hint: "
                    f"gh repo delete {owner}/{slug} --yes",
                )

    return rehearsal_rc


# ---- main -------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if not args.owner:
        print("Error: --owner must be a non-empty string.", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    project_root = release._resolve_project_root(args.project_root)

    config = E2EConfig(
        owner=args.owner,
        project_root=project_root,
        dry_run=args.dry_run,
        keep_repo=args.keep_repo,
        skip_npm=args.skip_npm,
    )
    return run_e2e(config)


if __name__ == "__main__":
    sys.exit(main())
