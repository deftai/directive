"""tests/cli/test_framework_doctor_prose.py -- doctor FAIL-prose regression (#1061).

Asserts every command string surfaced in :mod:`scripts.framework_doctor`
FAIL / REPAIR ``detail`` messages either:

(a) exists as a Taskfile target reachable from a consumer install
    (root ``Taskfile.yml`` or any ``tasks/*.yml`` fragment), or
(b) matches a documented ``run`` subcommand (registered in the ``commands``
    dispatch table at ``run::main``).

The doctor's FAIL prose is the user-facing surface for every drift report;
when it names a command that does not exist, the operator follows the
recommendation, gets a ``task: No tasks with description available`` error,
and has to grep for the real surface. This regression caught that exact
failure mode for ``task upgrade`` in #1061 -- the doctor prose cited a
Taskfile target that did not exist; the test below would have failed
fast on PR review instead of shipping the broken recommendation.

The structural contract this test enforces:

1. For every FAIL ``detail`` produced by the four core checks
   (``_check_quick_start_resolves``, ``_check_skill_paths_resolve``,
   ``_check_manifest_agreement``, ``_check_install_path_consistency``)
   AND the synthetic ``agents-md-present`` FAIL emitted by
   :func:`_run_checks_impl` when AGENTS.md is missing, EVERY ``\\`...\\```
   command surfaced MUST be either:
   (a) ``task <X>`` where ``X`` is a documented Taskfile target, or
   (b) ``.deft/core/run <X>`` (Unix) / ``.deft\\core\\run <X>`` (Windows)
       where ``<X>`` is a documented ``run`` subcommand.

2. The structured ``data.suggested_fix`` / ``data.suggested_fix_alt``
   fields added in #1061 MUST also resolve to a real command surface.

Test seam: each check is driven through ``framework_doctor.run_checks``
against a contrived drift state so we can capture the real FAIL ``detail``
strings and assert against the actual production prose.

Story: #1061.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCTOR_SCRIPT = REPO_ROOT / "scripts" / "framework_doctor.py"
RUN_SCRIPT = REPO_ROOT / "run"
TASKFILE_ROOT = REPO_ROOT / "Taskfile.yml"
TASKS_DIR = REPO_ROOT / "tasks"


def _load_module():
    spec = importlib.util.spec_from_file_location("framework_doctor", DOCTOR_SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["framework_doctor"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def fd():
    return _load_module()


# ---------------------------------------------------------------------------
# Command-surface discovery: parse Taskfile.yml + tasks/*.yml + run dispatch.
# ---------------------------------------------------------------------------


# Regex-based Taskfile parser -- avoids a PyYAML runtime dependency that the
# deft framework does not carry. go-task fragments follow a small subset of
# YAML and we only need to extract task names + include namespace keys; a
# scoped regex over the file body is sufficient and matches what the
# framework's own content tests (e.g. tests/content/test_taskfile_*.py) do.
_INCLUDE_KEY_RE = re.compile(r"^  (?P<key>[\w-]+):\s*$", re.MULTILINE)
_TASKFILE_PATH_RE = re.compile(
    r"^    taskfile:\s*['\"]?(?P<path>[^'\"\n]+?)['\"]?\s*$",
    re.MULTILINE,
)
# Generous upper bound on how far we scan past an `includes:` entry's
# namespace key to find its `taskfile:` line. Set well above any realistic
# include-entry property block (`taskfile:` + `optional:` + `vars:` +
# `env:` + `desc:`); a future include entry that exceeds this would
# silently drop its namespace from the discovered targets, so we keep
# the window generous (Greptile P2 on PR #1067).
_INCLUDE_PROPERTY_WINDOW_CHARS = 1200


def _extract_block(text: str, key: str) -> str:
    """Return the body of a top-level YAML block (e.g. ``tasks:``).

    Returns lines from the start of the block (exclusive) until the next
    top-level key (column-0, ``\\w+:``) or end-of-file.
    """
    pattern = re.compile(rf"^{re.escape(key)}:\s*$", re.MULTILINE)
    match = pattern.search(text)
    if match is None:
        return ""
    start = match.end()
    # Find next top-level key (a line starting at column 0 with `<word>:`).
    end_pattern = re.compile(r"^[\w][\w-]*:\s*$", re.MULTILINE)
    end_match = end_pattern.search(text, pos=start)
    end = end_match.start() if end_match else len(text)
    return text[start:end]


def _extract_task_names(block: str) -> set[str]:
    """Extract inner task names from a ``tasks:`` block body.

    Task names are 2-space-indented YAML keys whose values are not strings
    on the same line (i.e. they introduce a nested mapping). We match
    column-2 keys ending in `:` with no inline value.
    """
    names: set[str] = set()
    pattern = re.compile(r"^  (?P<name>[\w][\w.:-]*?):\s*$", re.MULTILINE)
    for m in pattern.finditer(block):
        names.add(m.group("name"))
    return names


def _parse_includes(text: str) -> dict[str, str]:
    """Return ``{namespace_key: taskfile_path}`` for every ``includes:`` entry."""
    block = _extract_block(text, "includes")
    result: dict[str, str] = {}
    if not block:
        return result
    # An include entry looks like:
    #   <ns>:
    #     taskfile: ./tasks/<name>.yml
    #     optional: true
    for ns_match in _INCLUDE_KEY_RE.finditer(block):
        ns_key = ns_match.group("key")
        # Search forward for the first taskfile: line within a generous
        # property-block window (see ``_INCLUDE_PROPERTY_WINDOW_CHARS``).
        local_window = block[
            ns_match.end() : ns_match.end() + _INCLUDE_PROPERTY_WINDOW_CHARS
        ]
        path_match = _TASKFILE_PATH_RE.search(local_window)
        if path_match is None:
            continue
        result[ns_key] = path_match.group("path").strip()
    return result


def _collect_taskfile_targets() -> set[str]:
    """Return every ``task <name>`` target reachable from the root Taskfile.

    Includes:
      - root-level task names (`task check`, `task upgrade`, etc.)
      - namespaced inner-task names (`task framework:doctor`,
        `task install:upgrade`, etc.) constructed by go-task's
        ``includes:`` mechanism.

    The doctor prose may cite either form, so the lookup MUST cover both.
    """
    targets: set[str] = set()
    # Root Taskfile.yml: top-level `tasks:` keys are reachable directly.
    root_text = TASKFILE_ROOT.read_text(encoding="utf-8")
    root_tasks_block = _extract_block(root_text, "tasks")
    targets |= _extract_task_names(root_tasks_block)
    # Include namespaces -> inner-task -> namespaced target name.
    for ns_key, taskfile_rel in _parse_includes(root_text).items():
        fragment_path = (REPO_ROOT / taskfile_rel).resolve()
        if not fragment_path.is_file():
            continue
        fragment_text = fragment_path.read_text(encoding="utf-8")
        fragment_tasks_block = _extract_block(fragment_text, "tasks")
        for inner_name in _extract_task_names(fragment_tasks_block):
            # Namespaced form: `<ns>:<inner>`. Root-level alias may also
            # exist (see `task upgrade` -> `install:upgrade`) but the
            # namespaced form is always reachable.
            targets.add(f"{ns_key}:{inner_name}")
    return targets


def _collect_run_subcommands() -> set[str]:
    """Return every ``run <X>`` subcommand registered in ``run::main``.

    Pattern: a literal-string dict entry like ``'agents:refresh': cmd_agents_refresh``
    inside the ``commands = { ... }`` block at the end of ``run::main``.
    """
    text = RUN_SCRIPT.read_text(encoding="utf-8")
    # Bracket the commands-dict block so we do not pick up unrelated
    # string literals elsewhere in the file. The block is recognisable by
    # the unique opening literal ``commands = {`` and a matching close.
    start = text.find("commands = {")
    assert start >= 0, "expected `commands = {` dispatch block in run script"
    # Find the closing brace at the same nesting depth.
    depth = 0
    end = start
    for i, ch in enumerate(text[start:], start=start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = text[start : end + 1]
    # Capture keys: 'name' or "name" -> cmd_*.
    pattern = re.compile(r"['\"]([\w\-:]+)['\"]\s*:\s*(?:cmd_\w+|lambda)")
    return {m.group(1) for m in pattern.finditer(block)}


# ---------------------------------------------------------------------------
# Doctor-state fixtures -- produce contrived drift states so we capture the
# actual FAIL `detail` strings the doctor emits in production.
# ---------------------------------------------------------------------------


def _write_agents_md(project_root: Path, install_root: str = ".deft/core") -> None:
    body = (
        "# Project AGENTS.md\n"
        f"Deft is installed in {install_root}/.\n"
        f"Full guidelines: {install_root}/main.md\n"
        "<!-- deft:managed-section v3 -->\n"
        "# Deft\n"
        f"Deft is installed in {install_root}/.\n"
        f"Full guidelines: {install_root}/main.md\n"
        f"See {install_root}/skills/deft-directive-setup/SKILL.md for setup.\n"
        "<!-- /deft:managed-section -->\n"
    )
    (project_root / "AGENTS.md").write_text(body, encoding="utf-8")


def _write_bare_marker(project_root: Path, value: str = "0.27.1") -> None:
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)
    (project_root / "vbrief" / ".deft-version").write_text(value + "\n", encoding="utf-8")


def _drift_state_quick_start_missing(tmp_path: Path) -> Path:
    _write_agents_md(tmp_path)
    # No install dir -> QUICK-START missing + install-path-consistency FAIL.
    return tmp_path


def _drift_state_manifest_missing(tmp_path: Path) -> Path:
    _write_agents_md(tmp_path)
    install = tmp_path / ".deft" / "core"
    install.mkdir(parents=True, exist_ok=True)
    (install / "QUICK-START.md").write_text("# QUICK-START\n", encoding="utf-8")
    (install / "skills" / "deft-directive-setup").mkdir(parents=True, exist_ok=True)
    (install / "skills" / "deft-directive-setup" / "SKILL.md").write_text(
        "# SKILL\n", encoding="utf-8"
    )
    _write_bare_marker(tmp_path)
    # Bare marker present, manifest absent -> manifest-agreement FAIL.
    return tmp_path


def _drift_state_manifest_disagrees(tmp_path: Path) -> Path:
    _write_agents_md(tmp_path)
    install = tmp_path / ".deft" / "core"
    install.mkdir(parents=True, exist_ok=True)
    (install / "QUICK-START.md").write_text("# QUICK-START\n", encoding="utf-8")
    (install / "skills" / "deft-directive-setup").mkdir(parents=True, exist_ok=True)
    (install / "skills" / "deft-directive-setup" / "SKILL.md").write_text(
        "# SKILL\n", encoding="utf-8"
    )
    (install / "VERSION").write_text(
        "ref: 'v0.27.1'\n"
        "sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'\n"
        "tag: 'v0.27.1'\n"
        "fetched_at: '2026-05-11T15:30:52Z'\n"
        "fetched_by: 'run-install'\n",
        encoding="utf-8",
    )
    # Bare disagrees with manifest tag.
    _write_bare_marker(tmp_path, "0.26.0")
    return tmp_path


def _drift_state_skill_missing(tmp_path: Path) -> Path:
    _write_agents_md(tmp_path)
    install = tmp_path / ".deft" / "core"
    install.mkdir(parents=True, exist_ok=True)
    (install / "QUICK-START.md").write_text("# QUICK-START\n", encoding="utf-8")
    # Intentionally NOT writing the skill file -> skill-paths-resolve FAIL.
    return tmp_path


def _drift_state_no_agents_md(tmp_path: Path) -> Path:
    # No AGENTS.md at all -> synthetic agents-md-present FAIL.
    return tmp_path


# ---------------------------------------------------------------------------
# Command extraction from prose
# ---------------------------------------------------------------------------


# Captures every ``backticked-command`` substring in a detail message. The
# pattern is lenient on quoting so ``Run `task upgrade` to ...`` and
# ``Run `.deft/core/run agents:refresh` (Unix) / `.deft\\core\\run agents:refresh`
# (Windows)`` both match.
_BACKTICK_CMD_RE = re.compile(r"`([^`]+)`")


def _extract_commands_from_detail(detail: str) -> list[str]:
    """Return every backticked command from a doctor `detail` string."""
    return [m.group(1).strip() for m in _BACKTICK_CMD_RE.finditer(detail)]


def _classify_command(
    cmd: str, *, taskfile_targets: set[str], run_subcommands: set[str]
) -> tuple[bool, str]:
    """Classify a backticked command and return (is_recognised, reason).

    Recognised shapes:
      - ``task <name>`` (with optional ``-- <flags>``) where ``<name>``
        is in ``taskfile_targets``.
      - ``.deft/core/run <subcmd>`` (Unix path-sep) where ``<subcmd>``
        is in ``run_subcommands``.
      - ``.deft\\core\\run <subcmd>`` (Windows path-sep, escaped backslash).
      - ``run <subcmd>`` (project-root invocation when the consumer
        worktree IS the framework checkout) where ``<subcmd>`` is in
        ``run_subcommands``.

    Strings that look like absolute paths (``/some/file``) or quoted
    literals (``v0.27.1``) are intentionally NOT classified as commands;
    the regex captures them but the caller filters via a leading-token
    inspection here.
    """
    tokens = cmd.split()
    if not tokens:
        return False, "empty command"
    head = tokens[0]

    # `task <name>` form (the most common doctor prose form).
    if head == "task":
        if len(tokens) < 2:
            return False, "bare `task` with no target"
        target = tokens[1]
        if target in taskfile_targets:
            return True, f"taskfile target `{target}`"
        return False, f"unknown taskfile target `{target}`"

    # `.deft/core/run <subcmd>` or `.deft\core\run <subcmd>` form.
    run_prefixes = (".deft/core/run", ".deft\\core\\run")
    for prefix in run_prefixes:
        if cmd.startswith(prefix):
            rest = cmd[len(prefix):].strip().split()
            if not rest:
                return False, "bare run-prefix with no subcommand"
            subcmd = rest[0]
            if subcmd in run_subcommands:
                return True, f"run subcommand `{subcmd}` (prefix {prefix})"
            return False, f"unknown run subcommand `{subcmd}` (prefix {prefix})"

    # Bare `run <subcmd>` form (the consumer-worktree-IS-framework case).
    if head == "run":
        if len(tokens) < 2:
            return False, "bare `run` with no subcommand"
        subcmd = tokens[1]
        if subcmd in run_subcommands:
            return True, f"run subcommand `{subcmd}`"
        return False, f"unknown run subcommand `{subcmd}`"

    # Not a command shape we recognise -- the regex picked up something
    # else (an inline-code literal like `v0.27.1` or a file path). The
    # caller filters these out via the explicit-command-prefixes check.
    return False, f"not a command shape (head token: {head!r})"


def _looks_like_command(cmd: str) -> bool:
    """Heuristic: does this backticked literal LOOK like a command vs a value?

    Commands always start with ``task ``, ``.deft/core/run ``,
    ``.deft\\core\\run ``, or ``run ``. Anything else (e.g. inline-code
    literals citing a version string, a file path, or a YAML field name)
    is excluded from the command-string contract.
    """
    return cmd.startswith((
        "task ",
        ".deft/core/run ",
        ".deft\\core\\run ",
        "run ",
    ))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def taskfile_targets() -> set[str]:
    return _collect_taskfile_targets()


@pytest.fixture(scope="module")
def run_subcommands() -> set[str]:
    return _collect_run_subcommands()


def test_command_surface_discovery_finds_canonical_anchors(
    taskfile_targets, run_subcommands
):
    """Sanity: the discovery helpers MUST find well-known surfaces.

    If this regresses, every downstream test silently passes against a
    smaller surface than it should -- so we pin a handful of canonical
    anchors that any healthy deft checkout MUST surface. Specifically
    ``task upgrade`` is the named command the doctor prose now cites
    (#1061); ``task install:upgrade`` is the namespaced inner; and
    ``agents:refresh`` / ``upgrade`` are the canonical ``run``
    subcommands the doctor prose references.
    """
    assert "upgrade" in taskfile_targets, taskfile_targets
    assert "install:upgrade" in taskfile_targets, taskfile_targets
    assert "framework:doctor" in taskfile_targets, taskfile_targets
    # `relocate:relocate` is the doubled-namespace form (include `relocate:`
    # + inner task `relocate:`); no root-level `relocate` alias exists
    # today so the canonical target is the doubled form.
    assert "relocate:relocate" in taskfile_targets, taskfile_targets
    assert "agents:refresh" in run_subcommands, run_subcommands
    assert "upgrade" in run_subcommands, run_subcommands


@pytest.mark.parametrize(
    "drift_state_builder",
    [
        _drift_state_quick_start_missing,
        _drift_state_manifest_missing,
        _drift_state_manifest_disagrees,
        _drift_state_skill_missing,
        _drift_state_no_agents_md,
    ],
)
def test_every_fail_detail_command_resolves_to_real_surface(
    drift_state_builder, fd, tmp_path, taskfile_targets, run_subcommands
):
    """Every backticked command in a FAIL ``detail`` MUST resolve.

    Drives the doctor against a contrived drift state and inspects each
    FAIL check's ``detail`` string. Every command-shaped backtick literal
    in the prose MUST either resolve to a Taskfile target or a documented
    ``run`` subcommand. Non-command backtick literals (version strings,
    file paths, YAML keys) are filtered out via the
    :func:`_looks_like_command` heuristic.

    This is the load-bearing #1061 regression: before the fix, the
    doctor cited ``task upgrade`` which was not a real target -- this
    test would have failed fast.
    """
    project_root = drift_state_builder(tmp_path)
    result = fd.run_checks(project_root)
    fail_checks = [c for c in result["checks"] if c["status"] == "fail"]
    assert fail_checks, (
        f"drift_state_builder={drift_state_builder.__name__} produced no FAIL "
        f"checks; cannot assert on FAIL prose. result={result}"
    )
    failures: list[str] = []
    for check in fail_checks:
        detail = check["detail"]
        commands = _extract_commands_from_detail(detail)
        for cmd in commands:
            if not _looks_like_command(cmd):
                continue
            ok, reason = _classify_command(
                cmd,
                taskfile_targets=taskfile_targets,
                run_subcommands=run_subcommands,
            )
            if not ok:
                failures.append(
                    f"check={check['name']!r} cmd=`{cmd}` reason={reason}"
                )
    assert not failures, (
        "FAIL `detail` strings cite commands that do not resolve to a "
        "Taskfile target or a documented `run` subcommand (#1061):\n"
        + "\n".join(failures)
    )


@pytest.mark.parametrize(
    "drift_state_builder",
    [
        _drift_state_quick_start_missing,
        _drift_state_manifest_missing,
        _drift_state_manifest_disagrees,
        _drift_state_skill_missing,
    ],
)
def test_fail_detail_carries_named_command_recommendation(
    drift_state_builder, fd, tmp_path
):
    """Every FAIL ``detail`` MUST name AT LEAST ONE concrete command.

    Pre-#1061 the FAIL prose for three of the four checks was the
    unactionable ``Reinstall the framework or update AGENTS.md to match
    the on-disk install path.`` -- no concrete command, just a research
    problem. This test asserts the prose carries at least one
    command-shaped backtick literal so a future regression that drops
    the named command (without dropping the entire prose) fails fast.
    """
    project_root = drift_state_builder(tmp_path)
    result = fd.run_checks(project_root)
    fail_checks = [c for c in result["checks"] if c["status"] == "fail"]
    assert fail_checks, (
        f"drift_state_builder={drift_state_builder.__name__} produced no FAIL "
        "checks; cannot assert on FAIL prose."
    )
    missing_named_command: list[str] = []
    for check in fail_checks:
        detail = check["detail"]
        commands = [
            c for c in _extract_commands_from_detail(detail) if _looks_like_command(c)
        ]
        if not commands:
            missing_named_command.append(
                f"check={check['name']!r} detail={detail!r}"
            )
    assert not missing_named_command, (
        "FAIL `detail` strings missing a named command recommendation (#1061):\n"
        + "\n".join(missing_named_command)
    )


def test_dual_recommendation_checks_carry_both_structured_fields(
    fd, tmp_path
):
    """Pin the dual-recommendation symmetry contract (SLizard P1 PR #1067).

    Every check whose ``detail`` cites TWO alternative repair commands
    MUST surface BOTH commands in the structured ``data`` block so
    programmatic consumers (the agentic-sync skill, CI assertions) see
    the same dual surface as humans. The three dual-recommendation
    checks are: ``quick-start-resolves`` (agents:refresh OR task
    upgrade), ``skill-paths-resolve`` (same pair), and
    ``install-path-consistency`` (agents:refresh OR task
    relocate:relocate). Each MUST carry BOTH ``suggested_fix`` AND
    ``suggested_fix_alt`` -- a future regression that drops one breaks
    the API contract documented in the PR description.
    """
    builders_and_dual_check_names = [
        (_drift_state_quick_start_missing, "quick-start-resolves"),
        (_drift_state_quick_start_missing, "install-path-consistency"),
        (_drift_state_skill_missing, "skill-paths-resolve"),
    ]
    missing: list[str] = []
    for builder, check_name in builders_and_dual_check_names:
        sub = tmp_path / f"{builder.__name__}_{check_name}"
        sub.mkdir()
        project_root = builder(sub)
        result = fd.run_checks(project_root)
        check = next(
            (c for c in result["checks"] if c["name"] == check_name), None
        )
        if check is None or check["status"] != "fail":
            missing.append(f"check={check_name!r} did not surface as FAIL")
            continue
        data = check.get("data") or {}
        for key in ("suggested_fix", "suggested_fix_alt"):
            if not data.get(key):
                missing.append(
                    f"check={check_name!r} missing data.{key}"
                )
    assert not missing, (
        "Dual-recommendation checks MUST carry BOTH suggested_fix and "
        "suggested_fix_alt fields (SLizard P1 PR #1067):\n" + "\n".join(missing)
    )


def test_structured_suggested_fix_field_resolves(
    fd, tmp_path, taskfile_targets, run_subcommands
):
    """Structured ``data.suggested_fix`` / ``suggested_fix_alt`` MUST resolve.

    #1061 added structured fix-recommendation fields alongside the prose
    so programmatic consumers (e.g. the agentic-sync skill) can act
    without parsing prose. These structured fields MUST resolve to the
    same command surfaces as the prose -- they are the canonical form
    that downstream automation reads, so a typo in the structured field
    is a silent regression in any caller that consumes it.
    """
    # Drive across all four check FAIL paths to surface every structured
    # field the prose adds in #1061.
    builders = [
        _drift_state_quick_start_missing,
        _drift_state_manifest_missing,
        _drift_state_manifest_disagrees,
        _drift_state_skill_missing,
    ]
    failures: list[str] = []
    for builder in builders:
        # Isolate each builder in its own subdirectory so they do not
        # interfere with each other on disk.
        sub = tmp_path / builder.__name__
        sub.mkdir()
        project_root = builder(sub)
        result = fd.run_checks(project_root)
        for check in result["checks"]:
            if check["status"] != "fail":
                continue
            data = check.get("data") or {}
            for key in ("suggested_fix", "suggested_fix_alt"):
                cmd = data.get(key)
                if not cmd:
                    continue
                ok, reason = _classify_command(
                    cmd,
                    taskfile_targets=taskfile_targets,
                    run_subcommands=run_subcommands,
                )
                if not ok:
                    failures.append(
                        f"builder={builder.__name__} check={check['name']!r} "
                        f"{key}=`{cmd}` reason={reason}"
                    )
    assert not failures, (
        "Structured `data.suggested_fix*` fields cite commands that do not "
        "resolve to a Taskfile target or a documented `run` subcommand "
        "(#1061):\n" + "\n".join(failures)
    )


def test_quick_start_fail_recommends_both_task_upgrade_and_agents_refresh(
    fd, tmp_path
):
    """Pin the per-check recommendation contract from the #1061 vBRIEF.

    The vBRIEF specifies that ``_check_quick_start_resolves`` FAIL prose
    MUST name BOTH the ``.deft/core/run agents:refresh`` (AGENTS.md
    realignment) AND ``task upgrade`` (re-pull framework) paths so the
    operator picks the right one. This test pins the contract so a future
    edit that drops either recommendation fails fast.
    """
    project_root = _drift_state_quick_start_missing(tmp_path)
    result = fd.run_checks(project_root)
    qs = next(c for c in result["checks"] if c["name"] == "quick-start-resolves")
    assert qs["status"] == "fail"
    assert "agents:refresh" in qs["detail"], qs["detail"]
    assert "task upgrade" in qs["detail"], qs["detail"]


def test_install_path_consistency_fail_recommends_both_repair_paths(fd, tmp_path):
    """Pin the dual-recommendation contract from the #1061 vBRIEF.

    The vBRIEF specifies that ``_check_install_path_consistency`` FAIL
    prose MUST name BOTH legitimate repair paths explicitly:
    (a) ``agents:refresh`` (rewrite AGENTS.md to match on-disk framework),
    (b) ``task relocate:relocate -- --confirm`` (move framework to AGENTS.md's path).
    The doubled-namespace form is the actual go-task target name -- the
    include namespace ``relocate:`` and the inner task ``relocate:`` carry
    the same key in ``tasks/relocate.yml`` and no root-level alias is
    wired in ``Taskfile.yml``.
    """
    project_root = _drift_state_quick_start_missing(tmp_path)
    result = fd.run_checks(project_root)
    ipc = next(
        c for c in result["checks"] if c["name"] == "install-path-consistency"
    )
    assert ipc["status"] == "fail"
    assert "agents:refresh" in ipc["detail"], ipc["detail"]
    assert "task relocate:relocate" in ipc["detail"], ipc["detail"]
