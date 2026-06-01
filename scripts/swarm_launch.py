#!/usr/bin/env python3
"""swarm_launch.py -- deterministic headless swarm launch engine (#1387).

Turns an operator-supplied, pre-approved cohort into a ready-to-spawn
**launch manifest** so the monitor can dispatch implementation agents
without re-running Phase 0 swarm ceremony. The engine:

1. Resolves ``--stories`` (comma-separated GitHub issue numbers, story
   ids, or vBRIEF paths) and explicit ``--paths`` against ``vbrief/active``.
2. Runs the #810 implementation-intent preflight gate and the
   ``task swarm:readiness`` gate per story, exiting non-zero and naming
   the FIRST failing story.
3. Generates one per-agent dispatch envelope per story, each carrying the
   #1378 allocation-context consent token (the exact five fields defined
   in ``templates/agent-prompt-preamble.md`` section 2.5).
4. Emits the launch-manifest JSON (the frozen C2 contract) to stdout and,
   when ``--output`` is supplied, to a file.

Frozen contracts implemented here
---------------------------------
- **C1** -- the ``task swarm:launch`` CLI signature
  (``--stories <ids|paths> [--group <label>] [--worktree-map <path>]
  [--base-branch <branch>] [--autonomous]``).
- **C2** -- the launch-manifest JSON: a JSON array of objects
  ``{"story_id", "vbrief_path", "worktree_path", "branch",
  "allocation_context"}`` where ``allocation_context`` is the #1378 token.
- **C3** -- consumed via ``from swarm_worktrees import resolve_worktree_map``
  (delivered by a sibling story; the import is guarded so this engine and
  its tests build independently and the resolver is wired at integration).

Exit codes
----------
- ``0`` -- every story resolved and passed both gates; manifest emitted.
- ``1`` -- a story could not be resolved OR a story failed a gate; the
  first failing story is named on stderr. No manifest is emitted.
- ``2`` -- config / usage error (no stories supplied, malformed
  ``--worktree-map`` JSON, the C3 resolver is unavailable while a
  ``--worktree-map`` was supplied, or the ``--output`` write failed).

Pure stdlib. The two gate calls and the C3 resolver are exposed as
module-level seams (``run_preflight_gate``, ``run_readiness_gate``,
``resolve_worktree_map``) so the test suite can stub them without shelling
out to ``task`` or depending on the sibling story's delivery.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Make sibling scripts importable both when run as __main__ and when the
# module is loaded directly by the test suite.
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from _stdio_utf8 import reconfigure_stdio  # noqa: E402

    reconfigure_stdio()
except ImportError:  # pragma: no cover -- optional belt-and-suspenders guard
    pass

# C3 resolver (frozen signature:
#   resolve_worktree_map(mapping, base_branch, create_missing=True) -> list[dict]).
# Delivered by the sibling swarm-worktree-map story and wired at integration.
# Guarded so this engine and its tests build before that story lands; tests
# inject a fake by assigning ``swarm_launch.resolve_worktree_map``.
try:  # pragma: no cover -- exercised at integration, stubbed in tests
    from swarm_worktrees import resolve_worktree_map  # type: ignore  # noqa: E402
except ImportError:  # pragma: no cover
    resolve_worktree_map = None  # type: ignore[assignment]

EXIT_OK = 0
EXIT_GATE_FAILED = 1
EXIT_CONFIG_ERROR = 2

DEFAULT_BASE_BRANCH = "master"

# An x-vbrief/github-issue URI of the form
# ``https://github.com/<owner>/<repo>/issues/<N>``.
_ISSUE_URI_RE = re.compile(r"/issues/(\d+)")
# A ``Traces`` style ``#<N>`` reference.
_TRACE_HASH_RE = re.compile(r"#(\d+)")
# Characters not safe in a git branch segment.
_BRANCH_UNSAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


# ---------------------------------------------------------------------------
# Gate seams (default implementations delegate to the canonical gate scripts)
# ---------------------------------------------------------------------------


def run_preflight_gate(vbrief_path: Path) -> tuple[int, str]:
    """Run the #810 implementation-intent preflight gate for one vBRIEF.

    Returns ``(exit_code, message)`` where exit_code 0 means ready. The
    import is lazy so the test suite can stub this seam without importing
    the gate script at all.
    """
    from preflight_implementation import evaluate  # lazy import

    return evaluate(Path(vbrief_path))


def run_readiness_gate(vbrief_path: Path, project_root: Path) -> tuple[int, str]:
    """Run the ``task swarm:readiness`` gate for one story vBRIEF.

    Returns ``(exit_code, report)`` where exit_code 0 means ready. The
    import is lazy so the test suite can stub this seam.
    """
    from swarm_readiness import readiness_report  # lazy import

    return readiness_report(Path(project_root), [Path(vbrief_path)])


# ---------------------------------------------------------------------------
# Story resolution
# ---------------------------------------------------------------------------


@dataclass
class ResolvedStory:
    """A cohort story resolved to a concrete active vBRIEF file."""

    token: str
    story_id: str
    path: Path
    relpath: str


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _plan(data: dict[str, Any]) -> dict[str, Any]:
    plan = data.get("plan")
    return plan if isinstance(plan, dict) else {}


def _story_id(path: Path, plan: dict[str, Any]) -> str:
    value = plan.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    name = path.name
    return name[: -len(".vbrief.json")] if name.endswith(".vbrief.json") else path.stem


def _issue_numbers(plan: dict[str, Any]) -> set[int]:
    """Collect every GitHub issue number a story references.

    Scans ``plan.references[].uri`` for ``/issues/<N>`` and both the
    plan-level and item-level ``narratives.Traces`` strings for ``#<N>``.
    """
    out: set[int] = set()
    refs = plan.get("references")
    if isinstance(refs, list):
        for ref in refs:
            if isinstance(ref, dict):
                uri = ref.get("uri")
                if isinstance(uri, str):
                    out.update(int(m) for m in _ISSUE_URI_RE.findall(uri))
    narratives = plan.get("narratives")
    if isinstance(narratives, dict):
        traces = narratives.get("Traces")
        if isinstance(traces, str):
            out.update(int(m) for m in _TRACE_HASH_RE.findall(traces))
    items = plan.get("items")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict):
                narrative = item.get("narrative")
                if isinstance(narrative, dict):
                    traces = narrative.get("Traces")
                    if isinstance(traces, str):
                        out.update(int(m) for m in _TRACE_HASH_RE.findall(traces))
    return out


@dataclass
class _ActiveStory:
    path: Path
    story_id: str
    issues: set[int]


def _index_active_stories(project_root: Path) -> list[_ActiveStory]:
    """Index every ``vbrief/active/*.vbrief.json`` story for resolution."""
    active_dir = project_root / "vbrief" / "active"
    index: list[_ActiveStory] = []
    # Guard against an absent directory: Path.glob short-circuits to empty on
    # Python >= 3.12 but raises FileNotFoundError on < 3.12. main() surfaces
    # the friendly EXIT_CONFIG_ERROR; this keeps the indexer non-raising.
    if not active_dir.is_dir():
        return index
    for path in sorted(active_dir.glob("*.vbrief.json")):
        data = _load_json(path)
        if data is None:
            continue
        plan = _plan(data)
        index.append(
            _ActiveStory(path=path, story_id=_story_id(path, plan), issues=_issue_numbers(plan))
        )
    return index


def _project_rel(project_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _looks_like_path(token: str) -> bool:
    # The bare ``.exists()`` fallback is CWD-relative; restrict it to
    # ``*.vbrief.json`` names so a stray file named e.g. "1234" in the
    # working directory cannot shadow a numeric issue-number lookup.
    return (
        token.endswith(".json")
        or "/" in token
        or "\\" in token
        or (Path(token).exists() and Path(token).name.endswith(".vbrief.json"))
    )


def _resolve_one(
    token: str,
    project_root: Path,
    id_map: dict[str, list[_ActiveStory]],
    issue_map: dict[int, list[_ActiveStory]],
) -> tuple[ResolvedStory | None, str | None]:
    """Resolve a single token. Returns ``(story, None)`` or ``(None, error)``."""
    if _looks_like_path(token):
        candidate = Path(token)
        if not candidate.is_absolute():
            candidate = project_root / token
        if not candidate.is_file():
            return None, f"{token!r}: vBRIEF path not found ({candidate})."
        data = _load_json(candidate)
        if data is None:
            return None, f"{token!r}: vBRIEF is unreadable or not valid JSON."
        story_id = _story_id(candidate, _plan(data))
        return (
            ResolvedStory(
                token=token,
                story_id=story_id,
                path=candidate,
                relpath=_project_rel(project_root, candidate),
            ),
            None,
        )

    if token.isdigit():
        matches = issue_map.get(int(token), [])
        if len(matches) == 1:
            match = matches[0]
            return (
                ResolvedStory(
                    token=token,
                    story_id=match.story_id,
                    path=match.path,
                    relpath=_project_rel(project_root, match.path),
                ),
                None,
            )
        if not matches:
            return None, f"#{token}: no active story references this issue."
        ids = ", ".join(sorted(m.story_id for m in matches))
        return None, f"#{token}: ambiguous -- {len(matches)} active stories match ({ids})."

    id_matches = id_map.get(token, [])
    if len(id_matches) == 1:
        match = id_matches[0]
        return (
            ResolvedStory(
                token=token,
                story_id=match.story_id,
                path=match.path,
                relpath=_project_rel(project_root, match.path),
            ),
            None,
        )
    if not id_matches:
        return None, f"{token!r}: no active story with this id."
    # Two+ active vBRIEFs share this plan.id. Fail loud (mirrors the
    # issue-number ambiguity path) rather than silently last-wins, which
    # would dispatch the wrong agent with no diagnostic.
    paths = ", ".join(sorted(_project_rel(project_root, m.path) for m in id_matches))
    return (
        None,
        f"{token!r}: ambiguous -- {len(id_matches)} active stories share this id ({paths}).",
    )


def resolve_stories(project_root: Path, tokens: list[str]) -> tuple[list[ResolvedStory], list[str]]:
    """Resolve cohort tokens against ``vbrief/active``.

    Each token may be a GitHub issue number, a story id, or a vBRIEF path.
    Returns the resolved stories (de-duplicated by path, input order
    preserved) and a list of human-readable errors for unresolved tokens.
    """
    index = _index_active_stories(project_root)
    id_map: dict[str, list[_ActiveStory]] = defaultdict(list)
    issue_map: dict[int, list[_ActiveStory]] = defaultdict(list)
    for story in index:
        id_map[story.story_id].append(story)
        for issue in story.issues:
            issue_map[issue].append(story)

    resolved: list[ResolvedStory] = []
    errors: list[str] = []
    seen_paths: set[Path] = set()
    for raw in tokens:
        token = raw.strip()
        if not token:
            continue
        story, error = _resolve_one(token, project_root, id_map, issue_map)
        if error is not None or story is None:
            errors.append(error or f"{token!r}: could not resolve.")
            continue
        resolved_path = story.path.resolve()
        if resolved_path in seen_paths:
            continue
        seen_paths.add(resolved_path)
        resolved.append(story)
    return resolved, errors


# ---------------------------------------------------------------------------
# Gate enforcement
# ---------------------------------------------------------------------------


def enforce_gates(
    resolved: list[ResolvedStory],
    project_root: Path,
) -> tuple[ResolvedStory, str] | None:
    """Run both gates per story in order; return the FIRST failure, or None.

    A failure is returned as ``(story, reason)`` so the caller can name
    the first failing story. Both gates run through the module-level
    seams so the test suite can stub pass / fail outcomes.
    """
    for story in resolved:
        code, message = run_preflight_gate(story.path)
        if code != 0:
            return story, f"preflight gate failed: {message.strip()}"
        code, report = run_readiness_gate(story.path, project_root)
        if code != 0:
            return story, f"swarm:readiness gate failed:\n{report.strip()}"
    return None


# ---------------------------------------------------------------------------
# Manifest construction (C2)
# ---------------------------------------------------------------------------


def _safe_segment(text: str) -> str:
    cleaned = _BRANCH_UNSAFE_RE.sub("-", text.strip()).strip("-.")
    return cleaned or "story"


def _derive_branch(group: str | None, story_id: str) -> str:
    leaf = _safe_segment(story_id)
    if group:
        return f"swarm/{_safe_segment(group)}/{leaf}"
    return f"swarm/{leaf}"


def _default_worktree(project_root: Path, story_id: str) -> str:
    return (project_root / ".deft-scratch" / "worktrees" / _safe_segment(story_id)).as_posix()


def _resolve_worktree_records(
    worktree_map_path: Path,
    base_branch: str,
    create_missing: bool,
    resolver: Callable[..., list[dict]] | None,
) -> dict[str, dict]:
    """Load + resolve the C3 worktree map; return a story_id -> record map.

    Raises ``ValueError`` on any config error (missing resolver, unreadable
    map, non-list payload, or a resolver-raised collision / mismatch) so
    the caller can map it to EXIT_CONFIG_ERROR.
    """
    if resolver is None:
        raise ValueError(
            "--worktree-map supplied but the C3 resolver (swarm_worktrees."
            "resolve_worktree_map) is not importable. It is delivered by the "
            "swarm-worktree-map story and wired at integration."
        )
    try:
        payload = json.loads(worktree_map_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read --worktree-map {worktree_map_path}: {exc}") from exc
    if not isinstance(payload, list):
        raise ValueError(
            f"--worktree-map {worktree_map_path} must contain a JSON array of records."
        )
    try:
        records = resolver(payload, base_branch, create_missing=create_missing)
    except Exception as exc:  # noqa: BLE001 -- resolver raises on collisions / mismatches
        raise ValueError(f"worktree map resolution failed: {exc}") from exc
    out: dict[str, dict] = {}
    for record in records:
        if isinstance(record, dict) and isinstance(record.get("story_id"), str):
            sid = record["story_id"]
            # Self-defend against a defective resolver: the C3 contract says
            # it raises on collisions, but until that sibling story ships a
            # duplicate here would silently record the wrong worktree path.
            if sid in out:
                raise ValueError(f"worktree map resolver returned duplicate story_id {sid!r}")
            out[sid] = record
    return out


def build_manifest(
    resolved: list[ResolvedStory],
    *,
    project_root: Path,
    group: str | None,
    base_branch: str,
    worktree_records: dict[str, dict],
    dispatch_kind: str,
    allocation_plan_id: str | None,
    batching_rationale: str | None,
    operator_approval_evidence: str | None,
) -> list[dict]:
    """Build the C2 launch-manifest array (one envelope per story)."""
    cohort_vbriefs = [story.relpath for story in resolved]
    manifest: list[dict] = []
    for story in resolved:
        record = worktree_records.get(story.story_id)
        if record is not None and isinstance(record.get("worktree_path"), str):
            worktree_path = record["worktree_path"]
        else:
            worktree_path = _default_worktree(project_root, story.story_id)
        manifest.append(
            {
                "story_id": story.story_id,
                "vbrief_path": story.relpath,
                "worktree_path": worktree_path,
                "branch": _derive_branch(group, story.story_id),
                "allocation_context": {
                    "dispatch_kind": dispatch_kind,
                    "allocation_plan_id": allocation_plan_id,
                    "batching_rationale": batching_rationale,
                    "cohort_vbriefs": cohort_vbriefs,
                    "operator_approval_evidence": operator_approval_evidence,
                },
            }
        )
    return manifest


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _split_csv(values: list[str] | None) -> list[str]:
    """Flatten repeated and comma-separated option values into a token list."""
    out: list[str] = []
    for value in values or []:
        out.extend(piece for piece in value.split(",") if piece.strip())
    return out


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="swarm_launch",
        description=(
            "Deterministic headless swarm launch engine (#1387). Resolves a "
            "pre-approved cohort, enforces the #810 preflight and "
            "swarm:readiness gates per story, and emits the launch-manifest "
            "JSON (the C2 contract) carrying the #1378 allocation-context "
            "consent token for each agent."
        ),
    )
    parser.add_argument(
        "--stories",
        action="append",
        default=[],
        metavar="IDS|PATHS",
        help=(
            "Comma-separated cohort members. Each token is a GitHub issue "
            "number, a story id, or a vBRIEF path resolved against "
            "vbrief/active. May be passed multiple times."
        ),
    )
    parser.add_argument(
        "--paths",
        action="append",
        default=[],
        metavar="PATHS",
        help="Comma-separated explicit vBRIEF paths (joined with --stories).",
    )
    parser.add_argument(
        "--group",
        default=None,
        metavar="LABEL",
        help="Cohort label; used to derive per-agent branch names.",
    )
    parser.add_argument(
        "--worktree-map",
        default=None,
        metavar="PATH",
        help="Path to a C3 worktree-map JSON array (resolved via swarm_worktrees).",
    )
    parser.add_argument(
        "--base-branch",
        default=DEFAULT_BASE_BRANCH,
        metavar="BRANCH",
        help=f"Base branch the per-agent worktrees fork from (default: {DEFAULT_BASE_BRANCH}).",
    )
    parser.add_argument(
        "--autonomous",
        action="store_true",
        help=(
            "Headless pre-approved mode: emit the manifest without prompting "
            "and record the batching rationale in each envelope."
        ),
    )
    parser.add_argument(
        "--allocation-plan-id",
        default=None,
        metavar="ID",
        help="Allocation-plan handle recorded in each allocation-context token.",
    )
    parser.add_argument(
        "--batching-rationale",
        default=None,
        metavar="TEXT",
        help="One-line batching rationale recorded in each allocation-context token.",
    )
    parser.add_argument(
        "--operator-approval",
        default=None,
        metavar="EVIDENCE",
        help="Operator-approval evidence recorded in each allocation-context token.",
    )
    parser.add_argument(
        "--no-create-worktrees",
        action="store_true",
        help="Pass create_missing=False to the C3 worktree resolver.",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="PATH",
        help="Also write the launch-manifest JSON to this file.",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing vbrief/ (default: current directory).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    project_root = Path(args.project_root).resolve()

    tokens = _split_csv(args.stories) + _split_csv(args.paths)
    if not tokens:
        print(
            "Error: no stories supplied. Pass --stories <ids|paths> " "and/or --paths <paths>.",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    if not (project_root / "vbrief" / "active").is_dir():
        print(
            f"Error: no vbrief/active directory under --project-root {project_root}. "
            "Point --project-root at a deft project with activated stories.",
            file=sys.stderr,
        )
        return EXIT_CONFIG_ERROR

    resolved, errors = resolve_stories(project_root, tokens)
    if errors:
        print("Error: could not resolve every cohort member:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return EXIT_GATE_FAILED

    failure = enforce_gates(resolved, project_root)
    if failure is not None:
        story, reason = failure
        print(
            f"Error: story {story.story_id!r} ({story.relpath}) is not "
            f"launch-ready -- {reason}",
            file=sys.stderr,
        )
        return EXIT_GATE_FAILED

    # Allocation-context token (#1378). A multi-story launch (or any
    # --group launch) is a swarm-cohort; a lone story is solo.
    dispatch_kind = "swarm-cohort" if (len(resolved) > 1 or args.group) else "solo"
    allocation_plan_id = args.allocation_plan_id or args.group
    batching_rationale = args.batching_rationale
    if batching_rationale is None and args.autonomous:
        plural = "story" if len(resolved) == 1 else "stories"
        suffix = f" (group {args.group})" if args.group else ""
        batching_rationale = (
            f"Headless launch of {len(resolved)} pre-approved cohort {plural}{suffix}."
        )
    operator_approval = args.operator_approval or (
        f"task swarm:launch ({'autonomous' if args.autonomous else 'interactive'})"
    )

    try:
        if args.worktree_map:
            worktree_records = _resolve_worktree_records(
                Path(args.worktree_map),
                args.base_branch,
                create_missing=not args.no_create_worktrees,
                resolver=resolve_worktree_map,
            )
        else:
            worktree_records = {}
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR

    manifest = build_manifest(
        resolved,
        project_root=project_root,
        group=args.group,
        base_branch=args.base_branch,
        worktree_records=worktree_records,
        dispatch_kind=dispatch_kind,
        allocation_plan_id=allocation_plan_id,
        batching_rationale=batching_rationale,
        operator_approval_evidence=operator_approval,
    )

    rendered = json.dumps(manifest, indent=2)

    # Write the --output file BEFORE emitting to stdout so a write failure
    # aborts cleanly instead of leaving a manifest on stdout paired with a
    # non-zero exit (Greptile review on PR #1407).
    if args.output:
        try:
            Path(args.output).write_text(rendered + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"Error: could not write --output {args.output}: {exc}", file=sys.stderr)
            return EXIT_CONFIG_ERROR

    print(rendered)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
