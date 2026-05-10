#!/usr/bin/env python3
"""relocate.py -- wipe-and-reinstall relocator for #992 PR2.

The relocator migrates a consumer project from any of the broken-or-legacy
install states (A pure ``deft/`` / B pure ``.deft/core/`` / C hybrid both /
D AGENTS.md only) to the canonical v0.27 layout::

    <project-root>/
        .deft/core/      -- read-only packaged framework assets (per #11)
        .deft-cache/     -- gitignored runtime cache
        AGENTS.md        -- managed-section v2 (#768)
        .gitignore       -- contains `.deft-cache/` and `vbrief/.eval/`

State detection (A-G) and customization probing live in
:mod:`scripts._relocate_states`; snapshot tarball logic lives in
:mod:`scripts._relocate_snapshot`. This split keeps every module under
the deft 1000-line MUST limit (mirrors the
``cache.py`` / ``_cache_validate.py`` / ``_cache_fetch.py`` precedent
from #883).

Public CLI surface
------------------

::

    python scripts/relocate.py [--project-root PATH]
                                [--framework-source PATH]
                                [--force]
                                [--confirm | --no-confirm]
                                [--dry-run]
                                [--rollback [--snapshot PATH]]
                                [--no-snapshot]
                                [--json] [--quiet]

Three load-bearing invariants (active vBRIEF DesignChoice):

- **WIPE-NOT-DIFF-MERGE**: one code path idempotent across A/B/C/D/F.
- **BOOTSTRAP NEVER SELF-DESTRUCTIVE**: ``main()`` self-detects whether
  the running script lives inside the wipe-target tree
  (``<project-root>/deft/`` or ``<project-root>/.deft/core/``) and exits
  2 if so. The webinstaller bootstrap fetches a fresh framework copy to
  a temp dir and runs the relocator from there.
- **AUTO-PROMPT NEVER AUTO-WIPE**: bare invocation prompts ``[y/N]``;
  ``--confirm`` skips the prompt for scripted use; ``--dry-run`` reports
  the plan without I/O.

Pre-flight hard-fail (without ``--force``):

- Customized framework dir (any file diff vs ``--framework-source``).
- Active swarm (any ``vbrief/active/*.vbrief.json`` with
  ``plan.status == "running"``).

Three-state exit:

- ``0`` -- success / dry-run / no-op / rollback succeeded.
- ``1`` -- preflight refused, wipe failed, or operator declined prompt.
- ``2`` -- config error (self-detect, missing framework source).

Refs: parent issue https://github.com/deftai/directive/issues/992;
companion task ``tasks/relocate.yml``;
companion tests ``tests/relocate/test_state_matrix.py`` (states A-G)
and ``tests/relocate/test_preflight.py`` (--force gate).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

# Make sibling scripts importable when this file is dispatched via
# ``python scripts/relocate.py`` from a Taskfile or webinstaller bootstrap.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _relocate_snapshot import (  # noqa: E402  -- intentional sys.path tweak
    SnapshotError,
    create_snapshot as _create_snapshot,
    extract_snapshot as _extract_snapshot,
    snapshot_path as _snapshot_path,
)
from _relocate_states import (  # noqa: E402
    active_swarm_paths,
    advise_external_hardcodes as _advise_external_hardcodes,
    customization_paths,
    detect_active_swarm,
    detect_install_state,
    is_framework_customized,
    iter_files,
)
from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

__all__ = [
    "AGENTS_MANAGED_CLOSE",
    "AGENTS_MANAGED_OPEN",
    "CANONICAL_FRAMEWORK_DIR",
    "EXIT_CONFIG_ERROR",
    "EXIT_FAILURE",
    "EXIT_SUCCESS",
    "FRAMEWORK_DEPOSIT_EXCLUSIONS",
    "GITIGNORE_LINES",
    "LEGACY_FRAMEWORK_DIR",
    "RelocateError",
    "RelocatePlan",
    "STATE_DESCRIPTIONS",
    "VBRIEF_LIFECYCLE_DIRS",
    "active_swarm_paths",
    "advise_external_hardcodes",
    "build_relocate_plan",
    "create_snapshot",
    "customization_paths",
    "detect_active_swarm",
    "detect_install_state",
    "extract_snapshot",
    "is_framework_customized",
    "main",
    "regenerate_agents_md",
    "render_managed_section",
    "wipe_and_reinstall",
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1
EXIT_CONFIG_ERROR: int = 2

CANONICAL_FRAMEWORK_DIR: str = ".deft/core"
LEGACY_FRAMEWORK_DIR: str = "deft"

#: Managed-section markers (#768 + #992 PR1 marker bump v1 -> v2). Mirrored
#: from the in-tree ``run`` script's constants verbatim.
AGENTS_MANAGED_OPEN: str = "<!-- deft:managed-section v2 -->"
AGENTS_MANAGED_CLOSE: str = "<!-- /deft:managed-section -->"

#: Top-level entries excluded from the framework deposit.
FRAMEWORK_DEPOSIT_EXCLUSIONS: tuple[str, ...] = (
    ".git",
    ".github",
    ".githooks",
    ".venv",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
    ".deft",
    ".deft-cache",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    "session.txt",
    "session2.txt",
    "PRD.md",
    "PROJECT.md",
    "SPECIFICATION.md",
)

#: vbrief subdirs the relocator NEVER deposits (lifecycle is consumer-owned).
#: ``vbrief/schemas/`` and the ``vbrief/vbrief.md`` template ARE deposited.
VBRIEF_LIFECYCLE_DIRS: tuple[str, ...] = (
    "active",
    "pending",
    "proposed",
    "completed",
    "cancelled",
    ".eval",
)

#: ``.gitignore`` baseline the relocator ensures present after a relocate.
GITIGNORE_LINES: tuple[str, ...] = (
    ".deft-cache/",
    "vbrief/.eval/",
)

STATE_DESCRIPTIONS: dict[str, str] = {
    "A": "pure deft/ (legacy install)",
    "B": "pure .deft/core/ (current installer output, marker may be stale)",
    "C": "hybrid both deft/ and .deft/core/ (broken)",
    "D": "AGENTS.md only (broken partial install)",
    "E": "customized framework dir (preserve-and-warn)",
    "F": "missing vbrief/ (greenfield-ish)",
    "G": "active swarm worktree (running plan.status -- hard-fail without --force)",
    "CANONICAL": "no relocate needed -- canonical .deft/core/ with no legacy",
}


# ---------------------------------------------------------------------------
# Errors / dataclass
# ---------------------------------------------------------------------------


class RelocateError(RuntimeError):
    """Generic relocator failure (preflight, wipe, copy, rollback)."""

    def __init__(self, message: str, *, exit_code: int = EXIT_FAILURE) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class RelocatePlan:
    """Snapshot of what ``wipe_and_reinstall`` would do; no I/O performed."""

    project_root: Path
    framework_source: Path
    state: str
    state_description: str
    legacy_dir: Path
    canonical_dir: Path
    legacy_present: bool
    canonical_present: bool
    framework_customized: bool
    customization_paths: list[str]
    active_swarm: bool
    active_swarm_paths: list[str]
    needs_relocate: bool
    needs_force: bool
    snapshot_path: Path | None
    advisory_hits: list[tuple[str, int, str]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Re-export public helpers from the split modules
# ---------------------------------------------------------------------------


def advise_external_hardcodes(
    project_root: Path, *, token: str = "deft/run"
) -> list[tuple[str, int, str]]:
    """Pass-through to :func:`_relocate_states.advise_external_hardcodes`."""
    return _advise_external_hardcodes(project_root, token=token)


def create_snapshot(
    project_root: Path,
    *,
    snapshot_path: Path | None = None,
    timestamp: str | None = None,
) -> Path:
    """Pass-through to :func:`_relocate_snapshot.create_snapshot`."""
    return _create_snapshot(project_root, target=snapshot_path, timestamp=timestamp)


def extract_snapshot(project_root: Path, *, snapshot: Path | None = None) -> Path:
    """Pass-through to :func:`_relocate_snapshot.extract_snapshot`."""
    try:
        return _extract_snapshot(project_root, snapshot=snapshot)
    except SnapshotError as exc:
        raise RelocateError(str(exc), exit_code=exc.exit_code) from exc


# ---------------------------------------------------------------------------
# Self-detect (never wipe the framework that hosts the running script)
# ---------------------------------------------------------------------------


def _running_inside_wipe_target(
    *,
    script_path: Path,
    project_root: Path,
) -> tuple[bool, Path | None]:
    """Return ``(True, offending_dir)`` iff the script lives inside a wipe target."""
    try:
        resolved_script = script_path.resolve()
        resolved_root = project_root.resolve()
    except OSError:
        return (False, None)
    candidates = (
        (resolved_root / LEGACY_FRAMEWORK_DIR).resolve(),
        (resolved_root / CANONICAL_FRAMEWORK_DIR).resolve(),
    )
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            resolved_script.relative_to(candidate)
        except ValueError:
            continue
        return (True, candidate)
    return (False, None)


# ---------------------------------------------------------------------------
# AGENTS.md re-render (#768 marker v2)
# ---------------------------------------------------------------------------


def render_managed_section(framework_source: Path) -> str:
    """Return the rendered managed-section block from the framework template."""
    template_path = framework_source / "templates" / "agents-entry.md"
    if not template_path.is_file():
        raise RelocateError(
            f"framework source missing AGENTS.md template at {template_path}",
            exit_code=EXIT_CONFIG_ERROR,
        )
    text = template_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    open_idx = text.find(AGENTS_MANAGED_OPEN)
    close_idx = text.find(AGENTS_MANAGED_CLOSE)
    if open_idx < 0 or close_idx < 0 or close_idx <= open_idx:
        return text
    end = close_idx + len(AGENTS_MANAGED_CLOSE)
    return text[open_idx:end]


def regenerate_agents_md(project_root: Path, framework_source: Path) -> str:
    """Re-render AGENTS.md with the v2 managed-section block.

    Three cases:

    - **No AGENTS.md** -> write the rendered section as the file body.
    - **AGENTS.md exists with markers** -> byte-replace the bracketed
      block in place; content above and below is preserved verbatim.
    - **AGENTS.md exists without markers** -> wrap the existing content
      and append the rendered section beneath, mirroring
      ``_wrap_legacy_in_markers`` semantics from the in-tree ``run``
      script (#794).
    """
    rendered = render_managed_section(framework_source)
    agents_md = project_root / "AGENTS.md"
    if not agents_md.is_file():
        new_content = rendered + "\n"
        agents_md.write_text(new_content, encoding="utf-8", newline="\n")
        return new_content
    existing = agents_md.read_text(encoding="utf-8", errors="replace")
    normalised = existing.replace("\r\n", "\n")
    open_idx = normalised.find(AGENTS_MANAGED_OPEN)
    close_idx = normalised.find(AGENTS_MANAGED_CLOSE)
    if open_idx < 0 or close_idx < 0 or close_idx <= open_idx:
        body = normalised.rstrip("\n")
        new_content = (body + "\n\n" + rendered + "\n") if body else rendered + "\n"
    else:
        end = close_idx + len(AGENTS_MANAGED_CLOSE)
        existing_block = normalised[open_idx:end]
        new_content = normalised.replace(existing_block, rendered, 1)
        if not new_content.endswith("\n"):
            new_content += "\n"
    agents_md.write_text(new_content, encoding="utf-8", newline="\n")
    return new_content


# ---------------------------------------------------------------------------
# .gitignore upkeep
# ---------------------------------------------------------------------------


def _ensure_gitignore_lines(project_root: Path, lines: Iterable[str] = GITIGNORE_LINES) -> bool:
    """Append missing ``lines`` to ``<project-root>/.gitignore``. Returns True if changed."""
    gitignore = project_root / ".gitignore"
    existing = ""
    if gitignore.is_file():
        existing = gitignore.read_text(encoding="utf-8", errors="replace")
    existing_lines = {ln.strip() for ln in existing.splitlines()}
    additions = [ln for ln in lines if ln.strip() not in existing_lines]
    if not additions:
        return False
    body = existing
    if body and not body.endswith("\n"):
        body += "\n"
    if body and not body.endswith("\n\n"):
        body += "\n"
    body += "# Added by deft relocator (#992 PR2)\n"
    body += "\n".join(additions) + "\n"
    gitignore.write_text(body, encoding="utf-8", newline="\n")
    return True


# ---------------------------------------------------------------------------
# Framework deposit
# ---------------------------------------------------------------------------


def _deposit_filter(src_root: Path, candidate: Path) -> bool:
    """Return True iff ``candidate`` should be deposited under ``.deft/core/``."""
    try:
        rel = candidate.relative_to(src_root)
    except ValueError:
        return False
    parts = rel.parts
    if not parts:
        return False
    first = parts[0]
    if first in FRAMEWORK_DEPOSIT_EXCLUSIONS:
        return False
    if first == "vbrief" and len(parts) >= 2:
        second = parts[1]
        if second in VBRIEF_LIFECYCLE_DIRS:
            return False
        if second == "PROJECT-DEFINITION.vbrief.json":
            return False
    return True


def _deposit_framework(framework_source: Path, target: Path) -> int:
    """Copy ``framework_source`` -> ``target`` filtered by :func:`_deposit_filter`."""
    target.mkdir(parents=True, exist_ok=True)
    written = 0
    for src in iter_files(framework_source):
        if not _deposit_filter(framework_source, src):
            continue
        rel = src.relative_to(framework_source)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        written += 1
    return written


# ---------------------------------------------------------------------------
# Plan builder + wipe orchestrator
# ---------------------------------------------------------------------------


def build_relocate_plan(
    project_root: Path,
    *,
    framework_source: Path,
    force: bool = False,
) -> RelocatePlan:
    """Compute the full state vector + planned action without performing I/O."""
    legacy = project_root / LEGACY_FRAMEWORK_DIR
    canonical = project_root / CANONICAL_FRAMEWORK_DIR
    state = detect_install_state(project_root, framework_source=framework_source)

    custom_paths: list[str] = []
    if legacy.is_dir():
        custom_paths.extend(customization_paths(legacy, framework_source))
    if canonical.is_dir():
        custom_paths.extend(customization_paths(canonical, framework_source))
    framework_customized = bool(custom_paths)
    swarm_paths = active_swarm_paths(project_root)
    active_swarm = bool(swarm_paths)

    needs_relocate = state != "CANONICAL"
    needs_force = framework_customized or active_swarm
    snap = _snapshot_path(project_root) if needs_relocate else None

    return RelocatePlan(
        project_root=project_root,
        framework_source=framework_source,
        state=state,
        state_description=STATE_DESCRIPTIONS.get(state, "(unknown state)"),
        legacy_dir=legacy,
        canonical_dir=canonical,
        legacy_present=legacy.is_dir(),
        canonical_present=canonical.is_dir(),
        framework_customized=framework_customized,
        customization_paths=sorted(set(custom_paths)),
        active_swarm=active_swarm,
        active_swarm_paths=swarm_paths,
        needs_relocate=needs_relocate,
        needs_force=needs_force and not force,
        snapshot_path=snap,
    )


def wipe_and_reinstall(
    plan: RelocatePlan,
    *,
    skip_snapshot: bool = False,
    snapshot_override: Path | None = None,
) -> Path | None:
    """Execute the plan: snapshot -> wipe -> deposit -> AGENTS.md -> .gitignore."""
    if not plan.needs_relocate:
        return None
    snap: Path | None = None
    if not skip_snapshot:
        snap = _create_snapshot(
            plan.project_root,
            target=snapshot_override or plan.snapshot_path,
        )
    if plan.legacy_dir.is_dir():
        shutil.rmtree(plan.legacy_dir)
    if plan.canonical_dir.is_dir():
        shutil.rmtree(plan.canonical_dir)
    _deposit_framework(plan.framework_source, plan.canonical_dir)
    regenerate_agents_md(plan.project_root, plan.framework_source)
    _ensure_gitignore_lines(plan.project_root)
    return snap


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="relocate",
        description=(
            "Wipe-and-reinstall relocator (#992 PR2). Migrates a consumer "
            "project from any A/B/C/D install state to the canonical "
            ".deft/core/ layout. Snapshot-rollback path included; "
            "auto-prompt never auto-wipe; preflight hard-fails on "
            "customized framework or active swarm without --force."
        ),
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path.cwd(),
        help="Consumer project root (defaults to CWD).",
    )
    parser.add_argument(
        "--framework-source",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help=(
            "Path to a fresh framework copy (typically a temp dir created "
            "by the webinstaller bootstrap). Defaults to the deft repo "
            "root containing this script's parent."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Override the preflight hard-fail gate (customized framework "
            "or active swarm). Snapshot is still written."
        ),
    )
    confirm = parser.add_mutually_exclusive_group()
    confirm.add_argument(
        "--confirm",
        action="store_true",
        help="Skip the interactive y/N prompt before wiping.",
    )
    confirm.add_argument(
        "--no-confirm",
        action="store_true",
        help="Force the interactive y/N prompt even on non-tty stdin.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the plan without performing any I/O.",
    )
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="Extract the most recent snapshot back into project root.",
    )
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=None,
        help="Override the snapshot path used by --rollback (or by the next snapshot write).",
    )
    parser.add_argument(
        "--no-snapshot",
        action="store_true",
        help="Skip the snapshot write before wiping (not recommended).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON object on stdout.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational status lines (errors still print).",
    )
    return parser


def _emit_status(message: str, *, stream: IO[str] = sys.stdout, quiet: bool = False) -> None:
    if quiet:
        return
    print(message, file=stream)


def _print_plan(plan: RelocatePlan, *, json_mode: bool, quiet: bool) -> None:
    if json_mode:
        payload = {
            "state": plan.state,
            "state_description": plan.state_description,
            "needs_relocate": plan.needs_relocate,
            "needs_force": plan.needs_force,
            "framework_customized": plan.framework_customized,
            "active_swarm": plan.active_swarm,
            "customization_paths": plan.customization_paths,
            "active_swarm_paths": plan.active_swarm_paths,
            "legacy_present": plan.legacy_present,
            "canonical_present": plan.canonical_present,
            "snapshot_path": str(plan.snapshot_path) if plan.snapshot_path else None,
            "project_root": str(plan.project_root),
            "framework_source": str(plan.framework_source),
        }
        print(json.dumps(payload, sort_keys=True, indent=2))
        return
    if quiet:
        return
    print(f"[relocate] state            = {plan.state} ({plan.state_description})")
    print(f"[relocate] project_root     = {plan.project_root}")
    print(f"[relocate] framework_source = {plan.framework_source}")
    print(f"[relocate] legacy_present   = {plan.legacy_present}")
    print(f"[relocate] canonical_present= {plan.canonical_present}")
    print(f"[relocate] active_swarm     = {plan.active_swarm}")
    if plan.active_swarm_paths:
        print("[relocate] active_swarm_paths:")
        for p in plan.active_swarm_paths:
            print(f"  - {p}")
    print(f"[relocate] framework_customized = {plan.framework_customized}")
    if plan.customization_paths:
        print("[relocate] customization_paths (preserved-files list):")
        for p in plan.customization_paths:
            print(f"  - {p}")
    print(f"[relocate] needs_relocate   = {plan.needs_relocate}")
    print(f"[relocate] needs_force_gate = {plan.needs_force}")
    if plan.snapshot_path:
        print(f"[relocate] snapshot_target  = {plan.snapshot_path}")


def _confirm_prompt(*, no_confirm: bool, stdin: IO[str] | None = None) -> bool:
    """Ask the operator to confirm the wipe. Default *no*."""
    sin = stdin or sys.stdin
    if not no_confirm and not sin.isatty():
        # Non-interactive without --no-confirm: refuse to wipe by default
        # (mirrors #884 ghx-install consent gate's default-deny on non-tty).
        return False
    print(
        "[relocate] Wipe-and-reinstall the framework deposit into "
        ".deft/core/? This is non-reversible without the snapshot. [y/N]: ",
        end="",
        flush=True,
    )
    try:
        line = sin.readline()
    except (EOFError, KeyboardInterrupt):
        return False
    return (line or "").strip().lower() in ("y", "yes")


def _enforce_force_gate(plan: RelocatePlan) -> None:
    """Raise :class:`RelocateError` (exit 1) when the gate refuses the wipe."""
    if not plan.needs_force:
        return
    parts: list[str] = []
    if plan.framework_customized:
        parts.append(
            "framework dir is customized -- preserved-files list:\n  "
            + "\n  ".join(plan.customization_paths)
        )
    if plan.active_swarm:
        parts.append(
            "active swarm worktree -- vbrief/active/* with plan.status=running:\n  "
            + "\n  ".join(plan.active_swarm_paths)
        )
    raise RelocateError(
        "preflight hard-fail; pass --force to override:\n" + "\n".join(parts)
    )


def _run_relocate(args: argparse.Namespace) -> int:
    project_root: Path = args.project_root.resolve()
    framework_source: Path = args.framework_source.resolve()

    detected, offending = _running_inside_wipe_target(
        script_path=Path(__file__),
        project_root=project_root,
    )
    if detected:
        print(
            f"[relocate] FATAL: relocator script lives inside wipe target "
            f"{offending}. The webinstaller bootstrap fetches a fresh framework "
            "copy to a temp dir and runs the relocator from there. Do not "
            "invoke this script from the in-place framework.",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    if not framework_source.is_dir():
        print(
            f"[relocate] FATAL: --framework-source {framework_source} is not a directory.",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    if args.rollback:
        try:
            extracted = extract_snapshot(project_root, snapshot=args.snapshot)
        except RelocateError as exc:
            print(f"[relocate] FATAL: {exc}", file=sys.stderr)
            return exc.exit_code
        _emit_status(
            f"[relocate] rollback complete -- restored from {extracted}",
            quiet=args.quiet,
        )
        return EXIT_SUCCESS

    plan = build_relocate_plan(
        project_root,
        framework_source=framework_source,
        force=args.force,
    )
    _print_plan(plan, json_mode=args.json, quiet=args.quiet)

    if not plan.needs_relocate:
        _emit_status(
            "[relocate] project is already canonical -- no action needed.",
            quiet=args.quiet,
        )
        return EXIT_SUCCESS

    if args.dry_run:
        _emit_status(
            "[relocate] --dry-run: no I/O performed; re-run without --dry-run to apply.",
            quiet=args.quiet,
        )
        return EXIT_SUCCESS

    try:
        _enforce_force_gate(plan)
    except RelocateError as exc:
        print(f"[relocate] FATAL: {exc}", file=sys.stderr)
        return exc.exit_code

    if not args.confirm and not _confirm_prompt(no_confirm=args.no_confirm):
        print(
            "[relocate] aborted -- operator declined the wipe prompt.",
            file=sys.stderr,
        )
        return EXIT_FAILURE

    try:
        snap = wipe_and_reinstall(
            plan,
            skip_snapshot=args.no_snapshot,
            snapshot_override=args.snapshot,
        )
    except (RelocateError, OSError, shutil.Error) as exc:
        print(f"[relocate] FATAL: {exc}", file=sys.stderr)
        return EXIT_FAILURE

    if snap is not None:
        _emit_status(f"[relocate] snapshot written to {snap}", quiet=args.quiet)

    advisory = advise_external_hardcodes(project_root)
    if advisory:
        _emit_status(
            "[relocate] advisory -- found legacy `deft/run` references "
            "outside .deft/core/. These are NOT auto-rewritten; fix manually:",
            quiet=args.quiet,
            stream=sys.stderr,
        )
        for path, lineno, text in advisory:
            _emit_status(
                f"  {path}:{lineno}: {text}",
                quiet=args.quiet,
                stream=sys.stderr,
            )

    _emit_status(
        "[relocate] wipe-and-reinstall complete -- canonical .deft/core/ in place.",
        quiet=args.quiet,
    )
    return EXIT_SUCCESS


def main(argv: Iterable[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return _run_relocate(args)
    except KeyboardInterrupt:
        print("[relocate] interrupted by operator.", file=sys.stderr)
        return EXIT_FAILURE


if __name__ == "__main__":  # pragma: no cover -- thin CLI shim
    raise SystemExit(main())
