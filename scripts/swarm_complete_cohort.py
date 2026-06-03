#!/usr/bin/env python3
"""swarm_complete_cohort.py -- Deterministic cohort completion sweep (#1487).

When a ``deft-directive-swarm`` cohort finishes (all worker PRs merged), the
cohort's story vBRIEFs are left stranded in ``vbrief/active/`` and their
decompose-created epic parents linger in ``vbrief/pending/``. Nothing in the
swarm flow swept them to ``completed/``. This helper IS that sweep: it is the
durable mechanism the swarm skill's Phase 6 invokes so a finished swarm leaves
no stranded vBRIEFs.

What it does
------------
Stage 1 -- Complete cohort stories: for each cohort story vBRIEF currently in
``vbrief/active/``, run the ``complete`` lifecycle transition (``active/`` ->
``completed/``, status ``completed``). A story already in ``completed/`` /
``cancelled/`` is a no-op.

Stage 2 -- Complete epic parents: discover the decompose-created epic parents
from the cohort stories' ``planRef`` back-pointers and complete each parent
once ALL of its ``x-vbrief/plan`` children are settled (in ``completed/`` or
``cancelled/``). A parent in ``pending/`` is bridged ``activate`` ->
``complete``; a parent in ``active/`` is completed directly; a parent already
terminal is a no-op. The sweep iterates to a fixpoint so nested decomposition
(phase -> epic -> story) collapses bottom-up: completing the leaf stories makes
their epics completable, which in turn makes a parent phase completable.

D4 linkage stays green automatically
------------------------------------
Every move routes through ``scripts/scope_lifecycle.py``. Child moves keep the
parent's forward ``x-vbrief/plan`` references fresh (#1485); parent moves keep
each child's ``planRef`` back-pointer fresh (#1487, the symmetric complement).
So ``task vbrief:validate`` stays green after the sweep with NO manual
reference repair in this script.

Usage
-----
    # Explicit cohort story paths
    task swarm:complete-cohort -- vbrief/active/2026-06-03-a.vbrief.json \
        vbrief/active/2026-06-03-b.vbrief.json

    # Or a glob over the cohort's active stories
    task swarm:complete-cohort -- --cohort 'vbrief/active/*.vbrief.json'

    # Preview without mutating anything
    task swarm:complete-cohort -- --cohort 'vbrief/active/*.vbrief.json' --dry-run

    # JSON output for a parent monitor agent
    task swarm:complete-cohort -- --cohort 'vbrief/active/*.vbrief.json' --json

Exit codes
----------
    0 -- sweep completed; every eligible transition succeeded (no-ops are fine)
    1 -- one or more lifecycle transitions failed (per-item diagnostics printed)
    2 -- config error (empty cohort, missing project root / vbrief dir)

Pure stdlib. The lifecycle state machine and its reference-maintenance helpers
are imported from ``scripts/scope_lifecycle.py`` so this sweep and the
canonical lifecycle verbs share one source of truth.
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported
# by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from _stdio_utf8 import reconfigure_stdio  # noqa: E402

    reconfigure_stdio()
except ImportError:  # pragma: no cover -- optional in some test contexts
    pass

# Single source of truth for the lifecycle state machine + the #1485 / #1487
# decomposed reference-maintenance helpers. Importing the module (rather than
# duplicating the move logic) keeps the sweep in lockstep with the canonical
# verbs -- a fix to reference maintenance lands in both surfaces at once.
import scope_lifecycle as _sl  # noqa: E402

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG_ERROR = 2

# A child is "settled" (does not block its parent's completion) when it has
# reached a terminal lifecycle folder.
TERMINAL_FOLDERS = ("completed", "cancelled")

# Bound the parent fixpoint so a malformed planRef cycle cannot loop forever.
# The bound is generous: real decomposition nests at most a handful of levels.
_MAX_FIXPOINT_PASSES = 50


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------


@dataclass
class TransitionRecord:
    """One vBRIEF the sweep acted on (or decided to skip)."""

    kind: str  # "story" | "epic"
    path: str  # original (pre-sweep) path, relative to project root when possible
    action: str  # "complete" | "activate+complete" | "noop" | "skip" | "failed"
    ok: bool
    detail: str = ""


@dataclass
class SweepResult:
    """Aggregate sweep verdict."""

    project_root: str
    dry_run: bool
    stories: list[TransitionRecord] = field(default_factory=list)
    parents: list[TransitionRecord] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors and all(
            r.ok for r in (*self.stories, *self.parents)
        )

    def to_dict(self) -> dict:
        return {
            "project_root": self.project_root,
            "dry_run": self.dry_run,
            "ok": self.ok,
            "stories": [asdict(r) for r in self.stories],
            "parents": [asdict(r) for r in self.parents],
            "errors": list(self.errors),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def resolve_cohort_paths(
    positional: list[str],
    cohort_globs: list[str],
    project_root: Path,
) -> tuple[list[Path], list[str]]:
    """Resolve cohort story paths from positional args + ``--cohort`` globs.

    Relative paths/globs resolve against *project_root*. Returns a
    de-duplicated, order-preserving list of resolved ``.vbrief.json`` paths
    AND a list of soft errors (a glob that matched nothing, a path that does
    not exist) so the caller can surface partial-resolution problems.
    """
    resolved: list[Path] = []
    seen: set[Path] = set()
    errors: list[str] = []

    def _add(path: Path) -> None:
        rp = path.resolve()
        if rp in seen:
            return
        seen.add(rp)
        resolved.append(rp)

    for raw in positional:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = project_root / raw
        if not candidate.is_file():
            errors.append(f"path does not exist: {raw}")
            continue
        _add(candidate)

    for pattern in cohort_globs:
        abs_pattern = pattern
        if not Path(pattern).is_absolute():
            abs_pattern = str(project_root / pattern)
        matched = sorted(Path(p) for p in glob.glob(abs_pattern, recursive=True))
        if not matched:
            errors.append(f"glob matched no files: {pattern!r}")
            continue
        for p in matched:
            if p.is_file():
                _add(p)

    return resolved, errors


def _rel(path: Path, project_root: Path) -> str:
    """Display path relative to project root when possible."""
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _load_plan(path: Path) -> dict | None:
    """Load a vBRIEF's ``plan`` object, or None if unreadable/malformed."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    plan = data.get("plan")
    return plan if isinstance(plan, dict) else None


def _child_is_settled(
    child_resolved: Path,
    settled: set[Path],
    dry_run: bool,
) -> bool:
    """Return whether a child vBRIEF is terminal (does not block the parent).

    In real mode the filesystem is ground truth: the child is settled when it
    lives in a terminal lifecycle folder. In dry-run nothing has moved, so we
    consult the virtual *settled* set the sweep accumulates (current
    terminal files + the stories/epics this run would complete).
    """
    if dry_run:
        return child_resolved in settled
    folder = _sl.detect_lifecycle_folder(child_resolved)
    return child_resolved.is_file() and folder in TERMINAL_FOLDERS


def _all_children_settled(
    parent_plan: dict,
    vbrief_dir: Path,
    settled: set[Path],
    dry_run: bool,
) -> bool:
    """True when the parent has >=1 child ref and every child is settled."""
    child_uris = _sl.collect_child_uris(parent_plan)
    if not child_uris:
        return False
    for uri in child_uris:
        child_path = _sl.resolve_vbrief_ref(uri, vbrief_dir)
        if child_path is None:
            return False
        if not _child_is_settled(child_path, settled, dry_run):
            return False
    return True


def _parent_candidates_from(
    plan: dict,
    vbrief_dir: Path,
) -> list[Path]:
    """Resolve a vBRIEF's planRef back-pointers to existing parent paths."""
    out: list[Path] = []
    for plan_ref in _sl.collect_plan_refs(plan):
        parent = _sl.resolve_vbrief_ref(plan_ref, vbrief_dir)
        if parent is not None and parent.is_file():
            out.append(parent.resolve())
    return out


# ---------------------------------------------------------------------------
# Sweep stages
# ---------------------------------------------------------------------------


def _complete_story(
    story_path: Path,
    vbrief_dir: Path,
    project_root: Path,
    settled: set[Path],
    dry_run: bool,
) -> TransitionRecord:
    """Stage 1: complete one cohort story (active/ -> completed/)."""
    folder = _sl.detect_lifecycle_folder(story_path)
    rel = _rel(story_path, project_root)

    if folder in TERMINAL_FOLDERS:
        settled.add(story_path.resolve())
        return TransitionRecord(
            kind="story",
            path=rel,
            action="noop",
            ok=True,
            detail=f"already in {folder}/",
        )
    if folder != "active":
        return TransitionRecord(
            kind="story",
            path=rel,
            action="skip",
            ok=True,
            detail=(
                f"not in active/ (in {folder}/); cohort completion only "
                "sweeps active stories"
            ),
        )

    if dry_run:
        settled.add(story_path.resolve())
        return TransitionRecord(
            kind="story",
            path=rel,
            action="complete",
            ok=True,
            detail="would complete active/ -> completed/",
        )

    ok, message = _sl.run_transition("complete", story_path)
    if ok:
        completed_path = (vbrief_dir / "completed" / story_path.name).resolve()
        settled.add(completed_path)
    return TransitionRecord(
        kind="story",
        path=rel,
        action="complete" if ok else "failed",
        ok=ok,
        detail=message,
    )


def _complete_parent(
    parent_path: Path,
    vbrief_dir: Path,
    project_root: Path,
    settled: set[Path],
    dry_run: bool,
) -> TransitionRecord:
    """Stage 2: complete one epic parent, bridging pending/ via activate.

    Caller guarantees the parent's children are all settled. Returns a record
    describing the action taken (or skipped).
    """
    folder = _sl.detect_lifecycle_folder(parent_path)
    rel = _rel(parent_path, project_root)

    if folder in TERMINAL_FOLDERS:
        settled.add(parent_path.resolve())
        return TransitionRecord(
            kind="epic",
            path=rel,
            action="noop",
            ok=True,
            detail=f"already in {folder}/",
        )
    if folder == "proposed":
        return TransitionRecord(
            kind="epic",
            path=rel,
            action="skip",
            ok=True,
            detail=(
                "parent in proposed/; promote it before the sweep can "
                "complete it"
            ),
        )
    if folder not in ("pending", "active"):
        return TransitionRecord(
            kind="epic",
            path=rel,
            action="skip",
            ok=True,
            detail=f"unexpected folder {folder}/",
        )

    if dry_run:
        settled.add(parent_path.resolve())
        action = "activate+complete" if folder == "pending" else "complete"
        return TransitionRecord(
            kind="epic",
            path=rel,
            action=action,
            ok=True,
            detail=f"would complete {folder}/ -> completed/",
        )

    # Real mode: bridge pending/ -> active/ first, then complete.
    current = parent_path
    action = "complete"
    if folder == "pending":
        action = "activate+complete"
        ok, message = _sl.run_transition("activate", current)
        if not ok:
            return TransitionRecord(
                kind="epic",
                path=rel,
                action="failed",
                ok=False,
                detail=f"activate failed: {message}",
            )
        current = vbrief_dir / "active" / parent_path.name

    ok, message = _sl.run_transition("complete", current)
    if ok:
        settled.add((vbrief_dir / "completed" / parent_path.name).resolve())
    return TransitionRecord(
        kind="epic",
        path=rel,
        action=action if ok else "failed",
        ok=ok,
        detail=message,
    )


def sweep_cohort(
    story_paths: list[Path],
    project_root: Path,
    dry_run: bool,
) -> SweepResult:
    """Run the full cohort completion sweep.

    Stage 1 completes the cohort stories; stage 2 completes their epic parents
    to a fixpoint. Returns a structured :class:`SweepResult`.
    """
    vbrief_dir = project_root / "vbrief"
    result = SweepResult(
        project_root=str(project_root.resolve()),
        dry_run=dry_run,
    )

    # ``settled`` tracks terminal child identities for the dry-run fixpoint
    # (real mode reads the filesystem directly). Seed it with everything
    # currently in a terminal folder so an idempotent re-run / partially-swept
    # cohort evaluates parents correctly.
    settled: set[Path] = set()
    for term in TERMINAL_FOLDERS:
        term_dir = vbrief_dir / term
        if term_dir.is_dir():
            for f in term_dir.glob("*.vbrief.json"):
                settled.add(f.resolve())

    # Stage 1 -- complete cohort stories. Collect parent candidates BEFORE the
    # move (the story's planRef points at the not-yet-moved parent).
    parent_candidates: list[Path] = []
    parent_seen: set[Path] = set()
    for story_path in story_paths:
        plan = _load_plan(story_path)
        if plan is not None:
            for parent in _parent_candidates_from(plan, vbrief_dir):
                if parent not in parent_seen:
                    parent_seen.add(parent)
                    parent_candidates.append(parent)
        result.stories.append(
            _complete_story(
                story_path, vbrief_dir, project_root, settled, dry_run
            )
        )

    # Stage 2 -- complete epic parents to a fixpoint. Re-evaluate every pass:
    # completing one epic can make its own parent (a phase) completable, and in
    # real mode #1487 keeps the grandparent's forward ref fresh across the move.
    finalized: set[Path] = set()
    passes = 0
    while passes < _MAX_FIXPOINT_PASSES:
        passes += 1
        progressed = False
        for candidate in list(parent_candidates):
            if candidate in finalized:
                continue
            parent_plan = _load_plan(candidate)
            if parent_plan is None:
                # Unreadable / moved-out parent: finalize so we don't spin.
                finalized.add(candidate)
                continue
            if not _all_children_settled(
                parent_plan, vbrief_dir, settled, dry_run
            ):
                continue
            record = _complete_parent(
                candidate, vbrief_dir, project_root, settled, dry_run
            )
            result.parents.append(record)
            finalized.add(candidate)
            progressed = True
            if record.ok and record.action in (
                "complete",
                "activate+complete",
            ):
                # Enqueue the grandparent (this epic's own planRef target).
                for grandparent in _parent_candidates_from(
                    parent_plan, vbrief_dir
                ):
                    if (
                        grandparent not in parent_seen
                        and grandparent not in finalized
                    ):
                        parent_seen.add(grandparent)
                        parent_candidates.append(grandparent)
        if not progressed:
            break

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="swarm_complete_cohort",
        description=(
            "Deterministic swarm cohort completion sweep (#1487). Moves each "
            "cohort story active/ -> completed/ and completes the "
            "decompose-created epic parents once all their children are "
            "settled, keeping task vbrief:validate green via scope_lifecycle "
            "reference maintenance (#1485 / #1487)."
        ),
    )
    parser.add_argument(
        "stories",
        nargs="*",
        metavar="STORY",
        help="Cohort story vBRIEF paths (relative to --project-root or absolute).",
    )
    parser.add_argument(
        "--cohort",
        dest="cohort_globs",
        action="append",
        default=[],
        metavar="GLOB",
        help=(
            "Glob over cohort story vBRIEFs (e.g. 'vbrief/active/*.vbrief.json'). "
            "May be passed multiple times. Unioned with positional STORY args."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing vbrief/ (default: current directory).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report the transitions that would run without mutating any file.",
    )
    parser.add_argument(
        "--json",
        dest="emit_json",
        action="store_true",
        help="Emit the sweep result as a single JSON object on stdout.",
    )
    return parser


def _render_text(result: SweepResult) -> None:
    mode = "DRY-RUN" if result.dry_run else "sweep"
    n_story = len(result.stories)
    n_epic = len(result.parents)
    print(
        f"Swarm cohort completion {mode} "
        f"({n_story} stor{'y' if n_story == 1 else 'ies'}, "
        f"{n_epic} epic parent{'' if n_epic == 1 else 's'})"
    )
    print(f"  Project root: {result.project_root}")
    if result.errors:
        print("  Resolution errors:")
        for err in result.errors:
            print(f"    - {err}")
    if result.stories:
        print("  Stories:")
        for r in result.stories:
            flag = "ok" if r.ok else "FAILED"
            print(f"    [{flag}] {r.action:<16} {r.path} -- {r.detail}")
    if result.parents:
        print("  Epic parents:")
        for r in result.parents:
            flag = "ok" if r.ok else "FAILED"
            print(f"    [{flag}] {r.action:<16} {r.path} -- {r.detail}")
    print()
    if result.ok:
        completed = sum(
            1
            for r in (*result.stories, *result.parents)
            if r.action in ("complete", "activate+complete")
        )
        verb = "would complete" if result.dry_run else "completed"
        print(f"Result: SWEEP CLEAN -- {verb} {completed} vBRIEF(s).")
    else:
        n_failed = sum(
            1 for r in (*result.stories, *result.parents) if not r.ok
        )
        print(
            f"Result: SWEEP INCOMPLETE -- {n_failed} transition(s) failed "
            f"and/or {len(result.errors)} resolution error(s). See above."
        )


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.is_dir():
        print(
            f"Error: project root does not exist: {project_root}",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR
    if not (project_root / "vbrief").is_dir():
        print(
            f"Error: no vbrief/ directory under project root: {project_root}",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    story_paths, resolution_errors = resolve_cohort_paths(
        args.stories, args.cohort_globs, project_root
    )

    if not story_paths:
        msg = (
            "Error: empty cohort. Pass one or more story vBRIEF paths as "
            "positional arguments and/or --cohort <glob>."
        )
        if args.emit_json:
            result = SweepResult(
                project_root=str(project_root),
                dry_run=args.dry_run,
                errors=resolution_errors or [msg],
            )
            print(json.dumps(result.to_dict(), indent=2))
        else:
            print(msg, file=sys.stderr)
            for err in resolution_errors:
                print(f"  - {err}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    result = sweep_cohort(story_paths, project_root, args.dry_run)
    result.errors.extend(resolution_errors)

    if args.emit_json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        _render_text(result)

    return EXIT_OK if result.ok else EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
