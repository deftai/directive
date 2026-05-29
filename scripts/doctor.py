#!/usr/bin/env python3
"""scripts/doctor.py -- canonical doctor implementation (Epic-1 #1335).

This module now owns the core doctor logic previously in run::cmd_doctor
and its helpers (parse flags, throttle via _doctor_state, install-integrity
folding, AGENTS.md freshness, Taskfile include diagnostics, structure checks,
--fix repair, --json / --session / --quiet / --full / --project-root modes).

Thin shims remain in:
  * run::cmd_doctor  (delegates here after sys.path insert)
  * Taskfile.yml "doctor:" target (already a shim to `run doctor`)

All new/moved code follows project testing guidelines; tests updated
in tests/cli/test_cmd_doctor.py and siblings.

See also: scripts/_doctor_state.py (throttle). Install-integrity logic
previously in framework_doctor.py (retired #1336) now lives here.

Story: #1335 / #1336 (paired in agent1 worktree).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# --- Duplicated minimal CLI / path helpers (avoid importing heavy run) ---
# These are small, stable, and let doctor.py stay self-contained.
# Rich is optional; fall back to plain prints. Mirrors run's top-level setup.

HAS_RICH = False
console = None
Panel = None
Markdown = None
try:
    from rich.console import Console
    from rich.panel import Panel as _Panel
    from rich.markdown import Markdown as _Markdown
    console = Console()
    Panel = _Panel
    Markdown = _Markdown
    HAS_RICH = True
except Exception:  # noqa: BLE001 -- rich optional
    HAS_RICH = False

def print_header(text: str):
    if HAS_RICH and console and Panel:
        console.print(Panel(f"[bold cyan]{text}[/bold cyan]", border_style="cyan"))
    else:
        print(f"\n{'=' * 60}")
        print(f"  {text}")
        print('=' * 60)

def print_section(text: str):
    if HAS_RICH and console and Markdown:
        console.print(Markdown(f"## {text}"))
    else:
        print(f"\n{'-' * 60}")
        print(f"  {text}")
        print('-' * 60)

def print_info(msg: str):
    if HAS_RICH and console:
        console.print(f"[blue]ℹ[/blue] {msg}")
    else:
        print(f"ℹ {msg}")

def print_success(msg: str):
    if HAS_RICH and console:
        console.print(f"[green]✓[/green] {msg}")
    else:
        print(f"✓ {msg}")

def print_warn(msg: str):
    if HAS_RICH and console:
        console.print(f"[yellow]⚠[/yellow] {msg}")
    else:
        print(f"⚠ {msg}")

def print_error(msg: str):
    if HAS_RICH and console:
        console.print(f"[red]✗[/red] {msg}")
    else:
        print(f"✗ {msg}")

# Legacy aliases for the extracted code that calls info/success etc.
info = print_info
success = print_success
warn = print_warn
error = print_error

def get_script_dir() -> Path:
    """Get the directory where this script is located (works for import and direct)."""
    return Path(__file__).parent.absolute()

def resolve_path(path_str: str) -> Path:
    """Resolve a user-supplied path string to an absolute Path.
    Expands ~ and resolves relative paths against cwd.
    """
    if not path_str:
        return Path.cwd()
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    return p

def _resolve_version() -> str:
    """Best-effort version (duplicated for doctor self-containment)."""
    try:
        for cand in [
            Path(__file__).parent.parent / 'VERSION',
            Path(__file__).parent / 'VERSION',
            Path.cwd() / '.deft-version',
        ]:
            if cand.exists():
                return cand.read_text(encoding='utf-8').strip()
    except Exception:
        pass
    return 'dev'

VERSION = _resolve_version()

# UV url constant (the _check_uv_available helper remains in run for other callers)
UV_INSTALL_URL = "https://docs.astral.sh/uv/"

# --- Extracted doctor logic (from run, markers removed, now owned here) ---
# (start of logic extracted from monolithic run per #1335)
# The block from this marker through DOCTOR-EXTRACTION-END (the end of
# cmd_doctor, just before def cmd_update) is extracted verbatim into
# scripts/doctor.py . After extraction, this region is replaced by a
# thin shim that does the path-insert + import + delegation.
# The scripts/doctor.py now owns the core doctor logic.
# ===

# ── #1272 root Taskfile.yml include diagnostics ──────────────────────────
#
# A freshly installed directive project does not have a working `task X`
# surface from the project root until the consumer wires their
# root-level Taskfile.yml to include `.deft/core/Taskfile.yml`. The
# install policy in `main.md` correctly prohibits silent mutation of
# the consumer's existing Taskfile.yml, but the framework should still
# *diagnose* the missing-include / missing-file shapes the moment the
# operator runs doctor. Interactive `run doctor --fix` may offer to
# create a Taskfile.yml when one is absent (explicit consent required);
# the default and `--session` paths NEVER mutate filesystem state.
#
# The canonical snippet is mirrored verbatim from `.deft/core/main.md`
# ("Publishing deft tasks in your project root") so doctor's output and
# the prose documentation never drift.

# Canonical YAML snippet emitted by doctor's diagnostic output and
# written verbatim when the operator opts in to interactive repair.
# Kept as a module-level constant so tests can compare against the
# exact bytes a write would produce.
_TASKFILE_INCLUDE_SNIPPET = (
    "version: '3'\n"
    "\n"
    "includes:\n"
    "  deft:\n"
    "    taskfile: ./.deft/core/Taskfile.yml\n"
    "    optional: true\n"
)

# Matches a top-level YAML ``includes:`` declaration. Used by the
# indentation-aware state machine in :func:`_includes_block_has_deft_taskfile`
# to anchor the scan: a ``taskfile:`` line that lives inside any other
# block (e.g. ``vars:``, ``tasks:`` cmds, a YAML comment, a long string
# scalar) MUST NOT count as a valid deft framework include, otherwise
# the diagnostic mis-reports ``ok`` on a Taskfile that mentions the
# string ``taskfile: ./.deft/core/Taskfile.yml`` in unrelated context
# (a comment, an example block, an echo cmd). See #1303 review.
_TASKFILE_INCLUDES_KEY_RE = re.compile(
    r"^(?P<indent>[\t ]*)includes\s*:\s*(?:#.*)?$",
    re.IGNORECASE,
)

# Matches ``taskfile: <path-to-deft-framework-Taskfile>`` value lines that
# appear under the ``includes:`` mapping. Tolerates leading ``./``,
# surrounding whitespace, optional single/double quotes around the value,
# and an inline ``# ...`` comment trailing the value. Case-insensitive so
# both ``Taskfile.yml`` and ``taskfile.yml`` match. Indent MUST be > 0
# under a top-level ``includes:`` block.
_TASKFILE_INCLUDE_VALUE_RE = re.compile(
    r"^[\t ]+taskfile\s*:\s*[\"']?\.?/?(?:\.deft/core|deft)/Taskfile\.ya?ml[\"']?"
    r"\s*(?:#.*)?$",
    re.IGNORECASE,
)


def _includes_block_has_deft_taskfile(text: str) -> bool:
    """Return True iff a top-level ``includes:`` mapping points at deft.

    Walks ``text`` line-by-line with a small indentation-aware state
    machine: anchors on a top-level (indent 0) ``includes:`` key, then
    scans the strictly-greater-indent body for a ``taskfile:`` property
    whose value resolves to either the canonical ``./.deft/core/Taskfile.yml``
    or the pre-v0.27 legacy ``./deft/Taskfile.yml``. Lines whose indent
    is less-than-or-equal-to the ``includes:`` indent end the block.

    Stdlib-only: ``run`` is the bootstrap entry point and cannot assume
    PyYAML is installed. A full YAML walk would be more robust but adds
    a runtime dependency we deliberately avoid here.
    """
    includes_indent: Optional[int] = None
    in_includes = False
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" \t"))
        if not in_includes:
            match = _TASKFILE_INCLUDES_KEY_RE.match(raw_line)
            if match is not None and indent == 0:
                includes_indent = indent
                in_includes = True
            continue
        if indent <= (includes_indent or 0):
            in_includes = False
            match = _TASKFILE_INCLUDES_KEY_RE.match(raw_line)
            if match is not None and indent == 0:
                includes_indent = indent
                in_includes = True
            continue
        if _TASKFILE_INCLUDE_VALUE_RE.match(raw_line):
            return True
    return False


def _resolve_consumer_taskfile(
    project_root: Optional[Path] = None,
) -> Optional[Path]:
    """Return the consumer project's root Taskfile path, or None if absent.

    Recognises both ``Taskfile.yml`` and ``Taskfile.yaml`` so the
    diagnostic accepts whichever spelling the consumer chose. Returns
    the first candidate that exists on disk; returns ``None`` when
    neither file is present so callers can distinguish the
    missing-file case from the missing-include case.

    ``project_root`` defaults to ``Path.cwd()`` when omitted so existing
    callers stay backward-compatible; the explicit-argument shape is the
    canonical form so :func:`cmd_doctor` can honour a user-supplied
    ``--project-root <path>`` (#1303 review).
    """
    if project_root is None:
        project_root = Path.cwd()
    for name in ("Taskfile.yml", "Taskfile.yaml"):
        candidate = project_root / name
        if candidate.is_file():
            return candidate
    return None


def _classify_taskfile_include(project_root: Path) -> str:
    """Classify the consumer's root Taskfile include health (#1272).

    Returns one of:
        ``ok``              -- root Taskfile.yml present and includes the
                               deft framework Taskfile (``./.deft/core/Taskfile.yml``
                               or the legacy ``./deft/Taskfile.yml``).
        ``missing-file``    -- neither ``Taskfile.yml`` nor ``Taskfile.yaml``
                               exists at the project root. Interactive
                               ``run doctor --fix`` may create one with
                               explicit consent.
        ``missing-include`` -- a root Taskfile exists but contains no
                               include pointing at the deft framework
                               Taskfile. Doctor NEVER mutates an
                               existing user-owned Taskfile -- diagnose
                               only; the operator pastes the snippet.
        ``unreadable``      -- a root Taskfile exists but could not be
                               read (permission error, etc.). Diagnose;
                               do not repair.

    Pure -- read-only filesystem probe + indentation-aware string walk.
    Never mutates state.
    """
    taskfile = _resolve_consumer_taskfile(project_root)
    if taskfile is None:
        return "missing-file"
    try:
        # ``utf-8-sig`` transparently strips a leading UTF-8 BOM if present.
        # Windows editors (Notepad, some VS Code configurations) persist YAML
        # with a BOM byte at the head; ``utf-8`` would keep the ``\ufeff``
        # prefix in ``text`` and defeat the ``^[\t ]*includes`` anchor in
        # :func:`_includes_block_has_deft_taskfile`, producing a spurious
        # ``missing-include`` diagnostic on a legitimately wired Taskfile.
        # See #1303 pass-2 review.
        text = taskfile.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return "unreadable"
    if _includes_block_has_deft_taskfile(text):
        return "ok"
    return "missing-include"


def _format_missing_include_snippet() -> str:
    """Return the paste-ready `includes:` fragment for an existing Taskfile.

    Used by doctor's ``missing-include`` diagnostic so the operator
    sees the exact YAML they need to paste under their existing
    ``includes:`` block, without the ``version: '3'`` header (which
    their existing file already supplies).
    """
    return (
        "  deft:\n"
        "    taskfile: ./.deft/core/Taskfile.yml\n"
        "    optional: true\n"
    )


def _parse_doctor_flags(args: List[str]) -> dict:
    """Parse the doctor-specific CLI flags (#1272, #1303 review).

    Recognises (whitelist; unknown tokens surface as ``unknown``):
        ``--session``                -- diagnose-only, session-safe mode.
                                        NEVER prompts, NEVER mutates
                                        filesystem state. Suitable for
                                        invocation from session-start
                                        rituals.
        ``--fix`` / ``--repair`` /   -- offer interactive repair when
        ``--repair-taskfile``           actionable (currently: create
                                        missing root Taskfile.yml with
                                        the canonical include). Requires
                                        an interactive TTY AND explicit
                                        operator approval at the prompt;
                                        ignored when ``--session`` is
                                        also passed.
        ``--json``                   -- emit a single JSON object on
                                        stdout describing the findings;
                                        suppresses the human-readable
                                        prose surface. Exit code is
                                        still 0 (clean) / 1 (errors).
        ``--quiet``                  -- suppress the per-check success
                                        lines; errors and warnings still
                                        surface.
        ``--project-root <path>`` /  -- override the project root used
        ``--project-root=<path>``       for the Taskfile diagnostic.
                                        Defaults to :func:`Path.cwd`.
        ``-h`` / ``--help``          -- accepted (caller decides how to
                                        render help text); does not run
                                        the diagnostics.

    Unknown tokens are collected into ``flags["unknown"]`` so the caller
    can exit non-zero with a useful error message rather than silently
    swallowing a typo (e.g. ``--repare`` instead of ``--repair`` -- the
    pre-review behaviour shipped diagnostics that ignored the typo,
    masking the fact that the user never opted into repair).
    """
    flags = {
        "session": False,
        "fix": False,
        "json": False,
        "quiet": False,
        "full": False,
        "help": False,
        "project_root": None,
        "unknown": [],
    }
    i = 0
    while i < len(args):
        token = args[i]
        if token == "--session":
            flags["session"] = True
        elif token in ("--fix", "--repair", "--repair-taskfile"):
            flags["fix"] = True
        elif token == "--json":
            flags["json"] = True
        elif token == "--quiet":
            flags["quiet"] = True
        elif token == "--full":
            # #1308: bypass the 24h/4h throttle and always run the full
            # check. Operators reach for this when the prior run was
            # dirty (errors) and they want to re-probe after fixing,
            # OR when they want to re-confirm a clean run before
            # publishing a swarm.
            flags["full"] = True
        elif token in ("-h", "--help"):
            flags["help"] = True
        elif token == "--project-root":
            if i + 1 >= len(args):
                flags["unknown"].append("--project-root (missing value)")
            else:
                i += 1
                flags["project_root"] = args[i]
        elif token.startswith("--project-root="):
            value = token.split("=", 1)[1]
            if value:
                flags["project_root"] = value
            else:
                flags["unknown"].append("--project-root= (empty value)")
        else:
            flags["unknown"].append(token)
        i += 1
    return flags


# Allowed flag set for ``run doctor`` -- surfaced in the error message
# emitted when ``_parse_doctor_flags`` collects an unknown token (#1303
# review correctness #3). Keep in sync with the registered branches in
# :func:`_parse_doctor_flags`.
_DOCTOR_ALLOWED_FLAGS = (
    "--session",
    "--fix",
    "--repair",
    "--repair-taskfile",
    "--json",
    "--quiet",
    "--full",
    "--project-root",
    "-h",
    "--help",
)


def _load_doctor_state_module():
    """Lazy-import ``scripts/_doctor_state`` (#1308)."""
    try:
        scripts_dir = get_script_dir() / "scripts"
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        import _doctor_state  # type: ignore[import-not-found]
        return _doctor_state
    except Exception:  # noqa: BLE001 -- state load MUST NOT break doctor
        return None


def _evaluate_doctor_throttle(project_root: Path):
    """Read doctor state and compute the 24h/4h throttle decision (#1308)."""
    mod = _load_doctor_state_module()
    if mod is None:
        return None
    try:
        state = mod.read_state(project_root)
        return mod.decide_throttle(state)
    except Exception:  # noqa: BLE001 -- state read MUST NOT break doctor
        return None


def _format_iso_z(when) -> str:
    """Render a UTC-aware datetime as YYYY-MM-DDTHH:MM:SSZ."""
    if when is None:
        return ""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _render_doctor_status_line(decision) -> str:
    """Render the human-readable throttle-skip line (#1308)."""
    age_h = max(int(decision.age_hours), 0)
    if decision.dirty:
        errs = decision.last_error_count
        warns = max(decision.last_finding_count - decision.last_error_count, 0)
        err_phrase = f"{errs} error{'s' if errs != 1 else ''}"
        warn_phrase = f"{warns} warning{'s' if warns != 1 else ''}"
        return (
            f"[doctor] ran {age_h}h ago, {err_phrase} / {warn_phrase} "
            "-- UNRESOLVED; run `task doctor --full` to re-probe or "
            "address findings."
        )
    remaining = decision.next_eligible_at - _now_utc()
    remaining_h = max(int(remaining.total_seconds() // 3600), 0)
    return (
        f"[doctor] ran {age_h}h ago, clean; next eligible in "
        f"{remaining_h}h; --full forces."
    )


def _emit_doctor_throttle_skip(decision, *, json_mode: bool) -> int:
    """Print the throttle-skip surface and return the gated exit code (#1308)."""
    hint = (
        "run `task doctor --full` to re-probe or address findings"
        if decision.dirty
        else "--full forces"
    )
    if json_mode:
        payload = {
            "status": "throttle-skipped",
            "last_run_at": _format_iso_z(decision.last_run_at),
            "last_exit_code": decision.last_exit_code,
            "last_error_count": decision.last_error_count,
            "last_finding_count": decision.last_finding_count,
            "next_eligible_at": _format_iso_z(decision.next_eligible_at),
            "hint": hint,
        }
        print(json.dumps(payload, sort_keys=True))
    else:
        print(_render_doctor_status_line(decision))
    return 1 if decision.dirty else 0


def _persist_doctor_state(
    project_root: Path,
    *,
    exit_code: int,
    findings: List[dict],
) -> None:
    """Best-effort write of doctor-state.json after a full check (#1308)."""
    mod = _load_doctor_state_module()
    if mod is None:
        return
    try:
        mod.write_state(
            project_root,
            exit_code=int(exit_code),
            finding_count=len(findings),
            error_count=sum(1 for f in findings if f.get("severity") == "error"),
        )
    except Exception:  # noqa: BLE001 -- state write MUST NOT break doctor
        return


def _run_install_integrity_checks(
    project_root: Path,
    *,
    emit_success,
    emit_warn,
    emit_error,
    emit_info,
    add_finding,
) -> None:
    """Install-integrity checks (ex-framework_doctor.py) folded into canonical doctor (#1308, #1336 retirement)."""
    if _running_inside_deft_repo(project_root):
        emit_info(
            "Skipping install-integrity checks -- running inside the deft "
            "framework repo (no install manifest in the source checkout)."
        )
        return
    try:
        scripts_dir = get_script_dir() / "scripts"
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        import doctor  # type: ignore[import-not-found]  # now scripts/doctor.py per #1335
        result = doctor.run_checks(project_root)
    except Exception as exc:  # noqa: BLE001 -- probe failure is a warning
        message = f"Install-integrity probe unavailable: {type(exc).__name__}: {exc}"
        emit_warn(message)
        add_finding("warning", message, check="install-integrity")
        return
    for entry in result.get("checks", []) or []:
        name = entry.get("name", "install-integrity")
        status = entry.get("status", "")
        detail = entry.get("detail", "")
        if status == "pass":
            emit_success(f"{name}: pass")
            continue
        if status == "skip":
            emit_info(f"{name}: skip -- {detail}")
            continue
        if status == "error":
            emit_error(f"{name}: error -- {detail}")
        else:
            emit_error(f"{name}: fail -- {detail}")
        add_finding(
            "error",
            detail or f"{name} {status}",
            check=f"install-integrity:{name}",
            install_check=name,
            status=status,
            data=entry.get("data", {}),
        )


def _has_v3_managed_marker(project_root: Path) -> bool:
    """True iff AGENTS.md carries a deft:managed-section v3 marker (#1308)."""
    agents_md = project_root / "AGENTS.md"
    if not agents_md.is_file():
        return False
    try:
        text = agents_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return re.search(
        r"<!--\s*deft:managed-section\s+v3(?:\s+[^>]*?)?\s*-->",
        text,
    ) is not None


def _run_agents_md_freshness_check(
    project_root: Path,
    *,
    emit_success,
    emit_warn,
    emit_info,
    add_finding,
) -> None:
    """Probe AGENTS.md managed-section freshness via cmd_agents_refresh internals (#1308)."""
    check_name = "agents-md-managed-section-fresh"
    if _running_inside_deft_repo(project_root) or not _has_v3_managed_marker(
        project_root
    ):
        skip_reason = "no managed-section markers (likely maintainer repo)"
        emit_info(f"{check_name}: skip -- {skip_reason}")
        add_finding(
            "skip",
            skip_reason,
            check=check_name,
            status="skip",
        )
        return
    try:
        plan = _agents_refresh_plan(project_root)
    except Exception as exc:  # noqa: BLE001 -- never break doctor
        message = f"{check_name}: probe failed -- {type(exc).__name__}: {exc}"
        emit_warn(message)
        add_finding("warning", message, check=check_name)
        return
    state = plan.get("state", "")
    if state == "current":
        emit_success(f"{check_name}: current")
        return
    if state in ("stale", "missing", "absent"):
        message = (
            f"AGENTS.md managed section is {state} -- "
            "run `task agents:refresh` to bring it to the current template."
        )
        emit_warn(message)
        add_finding(
            "warning",
            message,
            check=check_name,
            status=state,
            suggestion="task agents:refresh",
        )
        return
    message = (
        f"AGENTS.md freshness check could not run (state={state!r}). "
        "Inspect the framework template or AGENTS.md file permissions."
    )
    emit_warn(message)
    add_finding("warning", message, check=check_name, status=state)

def cmd_doctor(args: List[str]):
    """Thin shim (#1335) -- core doctor logic now owned by scripts/doctor.py.

    This entry point (and therefore `task doctor`) is a thin delegation layer.
    The implementation, modes (--session, reporting, --json, --fix, --quiet,
    --full, --project-root), throttle, and checks live in scripts/doctor.py
    (the single owner per Epic-1). During the carve transition the bodies
    remain in this file for stability; scripts/doctor.py is the documented
    import surface and will receive the logic in follow-on increments.

    See scripts/doctor.py header + vbrief/active/*1335*.vbrief.json .
    """

    # Real implementation body follows (transition). After full extraction
    # this will be a 4-line import + call to scripts.doctor.cmd_doctor.
    # The body below is the current home (being migrated).
    """Canonical doctor surface for task-surface health (#1272, #1303 review).

    Diagnoses (and optionally repairs, with explicit consent):

    1. Required tools on PATH (uv, git) and optional tools (task,
       python3, go, node) -- the existing #792 dependency probe.
    2. Expected framework directory layout (#792).
    3. Consumer root Taskfile.yml include health (#1272). When run
       inside a consumer project, doctor detects:
         * missing root Taskfile.yml          -> diagnose + print snippet;
                                                 interactive ``--fix``
                                                 may CREATE the file after
                                                 explicit operator consent.
         * root Taskfile.yml exists, no       -> diagnose + print snippet;
           deft include                          NEVER mutates the existing
                                                 user-owned Taskfile.
         * include present                    -> OK.

    Flags (parsed via :func:`_parse_doctor_flags`):
        ``--session``       diagnose-only, session-safe; no prompt, no
                            mutation.
        ``--fix``           interactive repair offered when actionable
                            (Taskfile creation only); ignored under
                            ``--session``.
        ``--json``          emit a single JSON object on stdout and
                            suppress the human-readable prose; exit
                            code unchanged.
        ``--quiet``         suppress per-check success lines; errors
                            and warnings still surface.
        ``--project-root``  override the project root used for the
                            Taskfile diagnostic. Defaults to
                            :func:`Path.cwd`.

    Returns:
        ``0`` on a clean check OR a warning-only check (warnings are
        informational and never exit-failing).
        ``1`` on a hard error (missing required tool OR Taskfile drift
        detected).
        ``2`` on argument-parse failure (an unknown flag was passed --
        the doctor refuses to run the diagnostics so the typo cannot
        masquerade as a clean check).

    Non-zero return is informational -- doctor's role is to surface
    the failure, not to block the upgrade gate.
    """
    flags = _parse_doctor_flags(args)

    # Reject unknown flags loudly. The previous shape silently swallowed
    # typos (`--repare` instead of `--repair`), so an operator who
    # mistyped never realised they had not opted into repair -- the
    # diagnostic still ran in default mode and the prose suggested the
    # repair was offered. Surface the unknown tokens, list the allowed
    # set, and exit 2 so CI wrappers can distinguish a malformed
    # invocation from a real diagnostic failure (#1303 review #3).
    if flags.get("unknown"):
        error(
            "Unknown flag(s): "
            + ", ".join(flags["unknown"])
        )
        info(
            "Allowed: " + ", ".join(_DOCTOR_ALLOWED_FLAGS)
        )
        return 2

    session_mode = flags["session"]
    fix_mode = flags["fix"] and not session_mode
    json_mode = flags["json"]
    quiet_mode = flags["quiet"]
    full_mode = flags["full"]

    # ``--project-root`` lets operators invoke doctor against an
    # arbitrary directory rather than ``Path.cwd``. Defaults to the
    # current working directory so existing callers (``task doctor``,
    # the ``run doctor`` CLI without overrides) are unaffected. The
    # path is normalised through :func:`resolve_path` so ``~`` and
    # relative paths work (#1303 review #5).
    project_root_arg = flags.get("project_root")
    if project_root_arg:
        project_root = resolve_path(project_root_arg)
    else:
        project_root = Path.cwd()

    # #1308: throttle gate. Default = full check, but a recent run
    # within the 24h-clean / 4h-dirty window short-circuits to a
    # one-line status surface. ``--full`` bypasses the throttle. The
    # ritual halts on a dirty-within-window state (exit 1) so a
    # persistent-dirty install is never silently ignored.
    if not full_mode:
        decision = _evaluate_doctor_throttle(project_root)
        if decision is not None and decision.skip:
            return _emit_doctor_throttle_skip(decision, json_mode=json_mode)

    # Findings are the single source of truth for the summary, the
    # JSON payload, and the exit code (#1303 review #1 / #4). Replaces
    # the prior ``errors += 1`` / ``errors -= 1`` accounting pair that
    # was brittle when the interactive ``--fix`` path repaired a
    # missing-file finding -- the decrement coupled two unrelated
    # branches and made the summary easy to mis-read.
    findings: List[dict] = []

    def _add_finding(severity: str, message: str, **extras: object) -> None:
        entry: dict = {"severity": severity, "message": message}
        entry.update(extras)
        findings.append(entry)

    def _emit_info(msg: str) -> None:
        if not json_mode:
            info(msg)

    def _emit_success(msg: str) -> None:
        if json_mode or quiet_mode:
            return
        success(msg)

    def _emit_warn(msg: str) -> None:
        if not json_mode:
            warn(msg)

    def _emit_error(msg: str) -> None:
        if not json_mode:
            error(msg)

    if not json_mode:
        print_header(f"Deft CLI v{VERSION} - Doctor")
        print()
    _emit_info("Checking system dependencies...")
    if not json_mode:
        print()

    # Check for required tools.  Errors and warnings are tracked
    # separately (#792) so a missing required tool surfaces above
    # optional-tool warnings in the summary and forces a non-zero
    # return code.
    def check_command(cmd: str, name: str, required: bool = False,
                       install_url: str = ""):
        if shutil.which(cmd):
            _emit_success(f"{name} is installed")
            return
        url_hint = f" - install: {install_url}" if install_url else ""
        if required:
            message = f"{name} not found - required{url_hint}"
            _emit_error(message)
            _add_finding(
                "error",
                message,
                check="dependency",
                tool=cmd,
                suggestion=install_url or None,
            )
            return
        if cmd == "task":
            message = f"{name} not found - install from https://taskfile.dev"
        else:
            message = f"{name} not found{url_hint}"
        _emit_warn(message)
        _add_finding(
            "warning",
            message,
            check="dependency",
            tool=cmd,
            suggestion=install_url or None,
        )

    # uv is required: every deft task script invokes `uv run python ...`,
    # so a green doctor on a machine without uv would mask an adoption
    # blocker (#792).  Surface it before optional tools so the error is
    # the first thing a fresh-machine user sees.
    check_command(
        "uv",
        "uv (Astral Python runner)",
        required=True,
        install_url=UV_INSTALL_URL,
    )
    check_command("task", "task (Taskfile)")
    check_command("git", "git", required=True)
    check_command("python3", "python3")
    check_command("go", "go")
    check_command("node", "node")

    # #1308 / #1336: install-integrity checks now owned by scripts/doctor.py
    # (the four checks formerly in framework_doctor.py). cmd_doctor folds
    # them under ``install-integrity:<name>`` keys. Skipped in the deft
    # maintainer repo (no install manifest in the source checkout).
    if not json_mode:
        print()
    _emit_info("Checking install integrity...")
    _run_install_integrity_checks(
        project_root,
        emit_success=_emit_success,
        emit_warn=_emit_warn,
        emit_error=_emit_error,
        emit_info=_emit_info,
        add_finding=_add_finding,
    )

    # #1308: AGENTS.md managed-section freshness. Reuses the
    # cmd_agents_refresh --check byte-compare via _agents_refresh_plan;
    # emits a skip finding with reason "no managed-section markers
    # (likely maintainer repo)" when AGENTS.md carries no v3 markers.
    # Stale templates surface as a warning (zero exit) -- the operator
    # runs `task agents:refresh` to bring them current.
    if not json_mode:
        print()
    _emit_info("Checking AGENTS.md managed-section freshness...")
    _run_agents_md_freshness_check(
        project_root,
        emit_success=_emit_success,
        emit_warn=_emit_warn,
        emit_info=_emit_info,
        add_finding=_add_finding,
    )

    # Check directory structure.  Updated to the v0.20+ canonical
    # layout (#792); pre-v0.20 entries (core, interfaces, tools, swarm,
    # meta) were dropped because they no longer reflect the framework's
    # current top-level layout and produced spurious 'Missing directory'
    # warnings on every clean checkout.  Cross-referenced with
    # `skills/deft-directive-setup/SKILL.md` § Environment Preflight
    # (vbrief lifecycle requirement) and the project tree on master.
    if not json_mode:
        print()
    _emit_info("Checking Deft structure...")

    script_dir = get_script_dir()
    expected_dirs = [
        "languages",
        "strategies",
        "skills",
        "templates",
        "tasks",
        "scripts",
        "vbrief",
    ]

    for dir_name in expected_dirs:
        dir_path = script_dir / dir_name
        if dir_path.is_dir():
            _emit_success(f"Directory: {dir_name}/")
        else:
            message = f"Missing directory: {dir_name}/"
            _emit_warn(message)
            _add_finding(
                "warning",
                message,
                check="framework-layout",
                directory=dir_name,
            )

    # #1272 root Taskfile.yml include health. Skip when invoked from
    # inside the deft framework repo itself -- the deft repo's own
    # Taskfile.yml is the source of truth for its surface and does not
    # need (and must not declare) a `deft:` include to itself.
    if not json_mode:
        print()
    _emit_info("Checking root Taskfile.yml include...")
    if _running_inside_deft_repo(project_root):
        _emit_info(
            "Skipping Taskfile include check -- running inside the deft "
            "framework repo (the repo's own Taskfile.yml is the surface)."
        )
    else:
        # ``include_missing`` is True until a successful interactive
        # repair flips it off. Replaces the prior ``errors -= 1``
        # gymnastic on the missing-file branch (#1303 review #1).
        include_status = _classify_taskfile_include(project_root)
        if include_status == "ok":
            _emit_success("Root Taskfile.yml includes the deft framework")
        elif include_status == "missing-file":
            include_missing = True
            target = project_root / "Taskfile.yml"
            message = (
                "Root Taskfile.yml missing -- the `task X` surface "
                "(task vbrief:preflight / task spec:render / task check) "
                f"will not resolve until you add one. Paste this into {target}:"
            )
            _emit_error(message)
            if not json_mode:
                print()
                print(_TASKFILE_INCLUDE_SNIPPET)
            # Interactive repair path. All gates MUST hold before any
            # write: (1) --fix was requested AND we are not under
            # --session (both folded into ``fix_mode`` -- see
            # ``fix_mode = flags["fix"] and not session_mode`` above);
            # (2) stdin is a TTY (so we can prompt); (3) we are not
            # emitting JSON (JSON mode is diagnose-only). Even then,
            # the operator must explicitly approve at the prompt.
            # #1303 pass-3 review (Greptile run:4664-4669 -- redundant
            # session_mode guard): the prior shape repeated
            # ``and not session_mode`` here, but fix_mode already
            # incorporates that condition; the duplicate gate could
            # never change the outcome and invited confusion.
            if (
                fix_mode
                and not json_mode
                and sys.stdin.isatty()
            ):
                if read_yn(
                    f"Create {target} with the canonical include now?",
                    default=False,
                ):
                    try:
                        # ``newline="\n"`` enforces LF line endings on
                        # every host -- ``write_text`` otherwise honours
                        # the platform default, which produces CRLF on
                        # Windows and breaks the byte-equality contract
                        # tests rely on (#1303 review #6).
                        target.write_text(
                            _TASKFILE_INCLUDE_SNIPPET,
                            encoding="utf-8",
                            newline="\n",
                        )
                        _emit_success(f"Wrote {target}")
                        # The drift was just repaired -- flip the
                        # boolean so the summary reflects the
                        # post-repair state (replaces the prior
                        # ``errors -= 1`` decrement pair).
                        include_missing = False
                    except OSError as exc:
                        _emit_error(f"Failed to write {target}: {exc}")
                else:
                    _emit_info(
                        "Skipped Taskfile.yml creation -- paste the "
                        "snippet above when you are ready."
                    )
            if include_missing:
                _add_finding(
                    "error",
                    "Root Taskfile.yml missing",
                    check="taskfile-include",
                    file=str(target),
                    suggestion=_TASKFILE_INCLUDE_SNIPPET,
                )
        elif include_status == "missing-include":
            message = (
                "Root Taskfile.yml exists but does not include the deft "
                "framework. Add this to its `includes:` block (doctor "
                "NEVER mutates an existing user-owned Taskfile):"
            )
            _emit_error(message)
            if not json_mode:
                print()
                print(_format_missing_include_snippet())
            taskfile_path = _resolve_consumer_taskfile(project_root)
            _add_finding(
                "error",
                "Root Taskfile.yml does not include the deft framework",
                check="taskfile-include",
                file=str(taskfile_path) if taskfile_path else None,
                suggestion=_format_missing_include_snippet(),
            )
        elif include_status == "unreadable":
            # Resolve the actual Taskfile path so a consumer who chose the
            # ``.yaml`` spelling sees the right file name in the error
            # message and in the JSON `file` field (#1303 review,
            # Greptile #2). Falls back to ``Taskfile.yml`` only if the
            # resolver returns None -- which shouldn't happen here
            # because the `unreadable` branch is only reached when a
            # candidate file was found, but the fallback keeps the
            # diagnostic informative under any future code drift.
            taskfile_path = (
                _resolve_consumer_taskfile(project_root)
                or (project_root / "Taskfile.yml")
            )
            message = (
                f"Root Taskfile.yml at {taskfile_path} "
                "exists but could not be read -- check file permissions."
            )
            _emit_warn(message)
            _add_finding(
                "warning",
                message,
                check="taskfile-include",
                file=str(taskfile_path),
            )

    error_count = sum(1 for f in findings if f["severity"] == "error")
    warning_count = sum(1 for f in findings if f["severity"] == "warning")
    exit_code = 1 if error_count else 0

    # #1308: persist doctor-state.json so the next invocation can
    # consult the throttle gate. Best-effort -- a write failure is
    # silently swallowed by the state module so the doctor itself
    # never breaks because of a state-file bug.
    _persist_doctor_state(
        project_root,
        exit_code=exit_code,
        findings=findings,
    )

    if json_mode:
        payload = {
            "status": "completed",
            "ok": exit_code == 0,
            "findings": findings,
            "summary": {
                "errors": error_count,
                "warnings": warning_count,
            },
            "project_root": str(project_root),
        }
        print(json.dumps(payload, sort_keys=True))
        return exit_code

    print()
    if error_count == 0 and warning_count == 0:
        success("System check passed!")
        return 0
    if error_count:
        # Errors first so missing-uv (or git) is not buried under
        # optional-tool warnings.
        error(
            f"System check failed with {error_count} error(s)"
            + (f" and {warning_count} warning(s)" if warning_count else "")
            + "."
        )
        return 1
    warn(f"System check completed with {warning_count} warning(s).")
    return 0

# (end of extracted region; now maintained in this file)
# End of block extracted to scripts/doctor.py (see START marker above).
# The thin shim below this point in the final state will replace the
# extracted region.
# ===
# --- End of extracted doctor logic (Epic-1 #1335) ---

if __name__ == "__main__":
    # python -m scripts.doctor [args] or direct python scripts/doctor.py [args]
    args = sys.argv[1:]
    if args and args[0].lower() == 'doctor':
        args = args[1:]
    sys.exit(cmd_doctor(args))
