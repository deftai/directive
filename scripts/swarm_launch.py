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
  "allocation_context", "runtime_mode", "github_auth_mode", ...}`` where
  ``allocation_context`` is the #1378 token and ``runtime_mode`` /
  ``github_auth_mode`` (#1557c) carry worker credential policy labels
  (never secret token values).
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

# Selection ordering (#1419 Slice 2 / #987). Cohort-fill reuses the canonical
# lexicographic key from triage_queue so the queue and swarm stay in lockstep.
# Guarded so this engine + its tests build before / without that module.
try:  # pragma: no cover -- core sibling in this repo
    import triage_queue  # type: ignore  # noqa: E402
except ImportError:  # pragma: no cover
    triage_queue = None  # type: ignore[assignment]

# Judgment-gate engine (#1419 Slice 3) for the Slice-7 clearance integration:
# a gated story rides the consent token only when its block-tier gate is
# cleared. Guarded so the engine + its tests build / run when the gate module
# is unavailable -- the gate-clearance check is then skipped (advisory anyway).
try:  # pragma: no cover -- core sibling in this repo
    import verify_judgment_gates as _gates  # type: ignore  # noqa: E402
except Exception:  # noqa: BLE001
    _gates = None  # type: ignore[assignment]

# Durable authority-event audit helper (#1419 Slice 7), owned by
# preflight_story_start (Gate 0) so both surfaces write the same record shape.
try:  # pragma: no cover -- core sibling in this repo
    from preflight_story_start import append_authority_event  # type: ignore  # noqa: E402
except Exception:  # noqa: BLE001
    append_authority_event = None  # type: ignore[assignment]

# Sub-agent backend policy + probe (#1531a / #1531e). Guarded so tests can
# stub the seams when the policy module is unavailable.
try:  # pragma: no cover -- core sibling in this repo
    from policy import (  # type: ignore  # noqa: E402
        SubagentBackendDescriptor,
        probe_subagent_backends,
        resolve_swarm_subagent_backend,
    )
except Exception:  # noqa: BLE001
    SubagentBackendDescriptor = None  # type: ignore[assignment,misc]
    probe_subagent_backends = None  # type: ignore[assignment]
    resolve_swarm_subagent_backend = None  # type: ignore[assignment]

# Runtime probe + GitHub auth-mode inference (#1557a / #1557b / #1557c).
# Guarded so tests can stub ``probe_worker_runtime_auth`` when the sibling
# modules are unavailable.
try:  # pragma: no cover -- core siblings in this repo
    from github_auth_modes import infer_github_auth_mode  # type: ignore  # noqa: E402
    from platform_capabilities import get_platform_capabilities  # type: ignore  # noqa: E402
except Exception:  # noqa: BLE001
    get_platform_capabilities = None  # type: ignore[assignment]
    infer_github_auth_mode = None  # type: ignore[assignment]

EXIT_OK = 0
EXIT_GATE_FAILED = 1
EXIT_CONFIG_ERROR = 2

DEFAULT_BASE_BRANCH = "master"

#: Gate-clearance evaluation postures (mirrors preflight_story_start /
#: verify_judgment_gates). ``advise`` (DEFAULT) surfaces an uncleared block
#: gate but still emits the manifest; ``enforce`` fails closed (exit 1).
GATE_ADVISE = "advise"
GATE_ENFORCE = "enforce"

#: Durable authority-event log file (under vbrief/.audit/) -- allocation
#: approvals + consumed gate clearances per RFC #1419 Receipts & Audit.
AUTHORITY_LOG_NAME = "authority-events.jsonl"

#: Default worker role for headless coding-worker dispatch (#1531e).
LEAF_CODING_WORKER_ROLE = "leaf-implementation"

#: Recovery command surfaced when backend policy is missing or unavailable.
SUBAGENT_BACKEND_SET_CMD = "task policy:subagent-backend -- --set {backend_id}"

#: Provider-neutral dispatch routing ids keyed by backend catalog id (#1531e).
_DISPATCH_PROVIDER_BY_BACKEND: dict[str, str] = {
    "composer": "cursor",
    "grok-build": "grok",
    "cursor-cloud": "cursor",
}

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


def _file_scope(plan: dict[str, Any]) -> tuple[str, ...]:
    """Return ``plan.metadata.swarm.file_scope`` (the gate candidate paths).

    Non-raising: any missing / wrong-shape level yields an empty tuple, which
    makes the gate layer a no-op for that story.
    """
    metadata = plan.get("metadata")
    if not isinstance(metadata, dict):
        return ()
    swarm = metadata.get("swarm")
    if not isinstance(swarm, dict):
        return ()
    scope = swarm.get("file_scope")
    if not isinstance(scope, list):
        return ()
    return tuple(p for p in scope if isinstance(p, str) and p)


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
# Sub-agent backend policy (#1531e)
# ---------------------------------------------------------------------------


def _format_probed_backends(backends: list[Any]) -> str:
    """Human-readable probe listing for fail-loud stderr."""
    lines: list[str] = []
    for entry in backends:
        avail = "available" if entry.available else "unavailable"
        roles = ", ".join(entry.roles)
        lines.append(f"  {entry.backend_id} ({avail}; roles=[{roles}])")
    return "\n".join(lines)


def enforce_subagent_backend_policy(
    project_root: Path,
) -> tuple[SubagentBackendDescriptor | None, str | None]:
    """Validate ``plan.policy.swarmSubagentBackend`` before headless dispatch.

    Returns ``(descriptor, None)`` when the stored backend is present and
    probe-available, or ``(None, reason)`` on the first failure. Never
    prompts -- ``--autonomous`` and interactive launches share this path.
    """
    if resolve_swarm_subagent_backend is None or probe_subagent_backends is None:
        return None, (
            "sub-agent backend policy module is not importable "
            "(scripts/policy.py)."
        )

    result = resolve_swarm_subagent_backend(project_root)
    probed = probe_subagent_backends()

    if result.backend_id is None:
        detail = result.error or "plan.policy.swarmSubagentBackend is not set."
        listing = _format_probed_backends(probed)
        return None, (
            f"{detail}\n"
            "Select a coding sub-agent backend before headless dispatch:\n"
            f"{listing}\n"
            "Probe harness availability: task policy:subagent-backends\n"
            f"Persist a choice: {SUBAGENT_BACKEND_SET_CMD.format(backend_id='<id>')}"
        )

    selected = next((e for e in probed if e.backend_id == result.backend_id), None)
    if selected is None:
        known = ", ".join(e.backend_id for e in probed)
        return None, (
            f"plan.policy.swarmSubagentBackend={result.backend_id!r} is not a "
            f"known backend id (known: {known}).\n"
            f"Persist a valid choice: {SUBAGENT_BACKEND_SET_CMD.format(backend_id='<id>')}"
        )

    if not selected.available:
        available_ids = [e.backend_id for e in probed if e.available]
        avail_text = ", ".join(available_ids) if available_ids else "(none)"
        return None, (
            f"plan.policy.swarmSubagentBackend={result.backend_id!r} is "
            f"unavailable in the current harness.\n"
            f"Available backend ids: {avail_text}\n"
            f"Choose a different backend: "
            f"{SUBAGENT_BACKEND_SET_CMD.format(backend_id='<id>')}"
        )

    if LEAF_CODING_WORKER_ROLE not in selected.roles:
        roles_text = ", ".join(selected.roles) if selected.roles else "(none)"
        return None, (
            f"plan.policy.swarmSubagentBackend={result.backend_id!r} does not "
            f"support worker role {LEAF_CODING_WORKER_ROLE!r} "
            f"(roles=[{roles_text}]).\n"
            f"Choose a leaf-implementation backend: "
            f"{SUBAGENT_BACKEND_SET_CMD.format(backend_id='<id>')}"
        )

    return selected, None


def dispatch_provider_for(backend_id: str) -> str:
    """Map a catalog backend id to its provider-neutral dispatch provider."""
    return _DISPATCH_PROVIDER_BY_BACKEND.get(backend_id, backend_id)


# ---------------------------------------------------------------------------
# Worker runtime + GitHub auth mode labels (#1557c)
# ---------------------------------------------------------------------------


def probe_worker_runtime_auth() -> tuple[str, str]:
    """Probe the launch environment and return ``(runtime_mode, github_auth_mode)``.

    Labels are derived from the read-only runtime probe (#1557a) and auth-mode
    inference (#1557b). Secret token values are never read or emitted -- only
    mode names suitable for manifest / preamble contracts.
    """
    if get_platform_capabilities is None or infer_github_auth_mode is None:
        msg = (
            "runtime/auth mode modules are not importable "
            "(scripts/platform_capabilities.py, scripts/github_auth_modes.py)."
        )
        raise RuntimeError(msg)
    report = get_platform_capabilities()
    return report.runtime_mode, infer_github_auth_mode(report)


# ---------------------------------------------------------------------------
# Gate-clearance integration (#1419 Slice 7)
# ---------------------------------------------------------------------------


@dataclass
class StoryGateStatus:
    """Per-story block-tier judgment-gate status for the cohort."""

    story: ResolvedStory
    matched_block: tuple[str, ...]  # block-tier gate ids the file_scope matched
    fired_block: tuple[str, ...]  # subset that fired (no recorded clearance)


def evaluate_cohort_gates(
    resolved: list[ResolvedStory],
    project_root: Path,
    *,
    posture: str,
    clearances: list[dict] | None,
    now: Any | None = None,
) -> list[StoryGateStatus]:
    """Evaluate each story's file_scope against the judgment gates.

    Imports the Slice-3 engine (``verify_judgment_gates.build_report`` /
    ``Candidate``) -- the gate logic is never re-implemented here. Returns one
    :class:`StoryGateStatus` per story that matched at least one block-tier
    gate (stories with no file_scope or no block-tier match are omitted). The
    supplied clearances (from ``--gate-clearances``) are merged with any
    recorded in the durable clearance audit log. The caller decides whether a
    fired gate aborts (enforce) or is surfaced (advise).
    """
    statuses: list[StoryGateStatus] = []
    if _gates is None:
        return statuses
    records = list(clearances or [])
    records.extend(_gates.read_clearances(project_root))
    for story in resolved:
        plan = _plan(_load_json(story.path) or {})
        file_scope = _file_scope(plan)
        if not file_scope:
            continue
        report = _gates.build_report(
            project_root,
            _gates.Candidate(paths=file_scope),
            posture=posture,
            clearances=records,
            now=now,
        )
        matched = tuple(o.gate_id for o in report.block_tier_requirements)
        if not matched:
            continue
        fired = tuple(o.gate_id for o in report.blocking)
        statuses.append(
            StoryGateStatus(story=story, matched_block=matched, fired_block=fired)
        )
    return statuses


def enforce_cohort_gates(
    statuses: list[StoryGateStatus],
    *,
    posture: str,
    cohort_size: int,
) -> tuple[StoryGateStatus, str] | None:
    """Apply the gate-clearance + block-gated-solo rules; return first failure.

    Two rules (RFC #1419):

    1. An uncleared active block-tier gate cannot launch -- a gated story rides
       the consent token only when its clearance is pre-recorded.
    2. v1 ships block-gated stories SOLO -- a block-gated story may not ride a
       multi-story cohort (per-commit trailer attribution is deferred to v2).

    In ``enforce`` posture the first violation is returned as ``(status,
    reason)`` so the caller aborts naming the story. In ``advise`` posture this
    returns None (the caller surfaces the same conditions as advisory notes but
    still launches) -- the framework's own ``task swarm:launch`` stays advisory.
    """
    if posture != GATE_ENFORCE:
        return None
    for status in statuses:
        if status.fired_block:
            return status, (
                "block-gated and uncleared -- "
                f"{', '.join(status.fired_block)}. Record a clearance "
                "(--gate-clearances / `verify_judgment_gates.py clear`) before launch."
            )
    if cohort_size > 1:
        for status in statuses:
            if status.matched_block:
                return status, (
                    f"block-gated ({', '.join(status.matched_block)}); v1 ships "
                    "block-gated stories SOLO -- launch it on its own."
                )
    return None


# ---------------------------------------------------------------------------
# Selection ordering -- cohort-fill (#1419 Slice 2 / #987)
# ---------------------------------------------------------------------------


def order_cohort(resolved: list[ResolvedStory], project_root: Path) -> list[ResolvedStory]:
    """Order a resolved cohort by the RFC #1419 Layer-3 selection sort.

    Continuation work (a story whose ``planRef`` parent epic has already
    started) leads, then deficit-biased among net-new (most-under-target
    capacity bucket first), then intra-bucket ``plan.metadata.rank``, then a
    date-prefixed-filename proxy for creation date. Reuses
    :func:`triage_queue.selection_ordering_key` (the same canonical key the
    triage queue uses) so the two surfaces cannot drift.

    The urgent/blocking label tier is queue-specific (it matches GitHub
    issue labels against ``triageRankingLabels``); a swarm cohort is already
    operator-curated, so ``label_index`` is a constant ``0`` here. The sort
    is stable + best-effort: when :mod:`triage_queue` is unavailable the
    input order is preserved unchanged.
    """
    if triage_queue is None:
        return list(resolved)
    continuation_map = triage_queue.continuation_by_issue_number(project_root)
    deficit_map = triage_queue.bucket_deficit_by_issue_number(project_root)

    def _key(story: ResolvedStory) -> tuple:
        plan = _plan(_load_json(story.path) or {})
        # Match the extraction the maps were built with -- both
        # continuation_by_issue_number and bucket_deficit_by_issue_number key
        # on triage_queue._issue_numbers_from_plan (x-vbrief/github-issue refs
        # only), so the lookup must use the same narrow set rather than the
        # broader resolution-time _issue_numbers (which also scans Traces).
        issues = triage_queue._issue_numbers_from_plan(plan)
        cont_orders = [continuation_map[n] for n in issues if n in continuation_map]
        deficits = [deficit_map[n] for n in issues if n in deficit_map]
        return triage_queue.selection_ordering_key(
            label_index=0,
            is_continuation=bool(cont_orders),
            continuation_order=min(cont_orders) if cont_orders else "",
            bucket_deficit=max(deficits) if deficits else None,
            rank=triage_queue.scope_metadata_rank(plan),
            date_key=(0, story.relpath),
        )

    return sorted(resolved, key=_key)


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
    gate_clearances: list[dict] | None = None,
    subagent_backend: str | None = None,
    dispatch_provider: str | None = None,
    worker_role: str | None = None,
    runtime_mode: str | None = None,
    github_auth_mode: str | None = None,
) -> list[dict]:
    """Build the C2 launch-manifest array (one envelope per story).

    When ``gate_clearances`` is non-empty each envelope's
    ``allocation_context`` gains a 6th ``gate_clearances`` field (#1419 Slice
    7) so the dispatched worker's Gate 0 can recognise the pre-recorded
    clearance. The field is OMITTED when there are no clearances so the
    historical five-field #1378 consent token is unchanged for the common case.

    Top-level ``subagent_backend``, ``dispatch_provider``, and ``worker_role``
    fields (#1531e) carry audit-visible routing metadata without altering the
    #1378 allocation-context recognition contract.

    ``runtime_mode`` and ``github_auth_mode`` (#1557c) label the worker
    credential policy for each envelope. Mode labels only -- never secret
    token values.
    """
    cohort_vbriefs = [story.relpath for story in resolved]
    manifest: list[dict] = []
    for story in resolved:
        record = worktree_records.get(story.story_id)
        if record is not None and isinstance(record.get("worktree_path"), str):
            worktree_path = record["worktree_path"]
        else:
            worktree_path = _default_worktree(project_root, story.story_id)
        allocation_context: dict[str, Any] = {
            "dispatch_kind": dispatch_kind,
            "allocation_plan_id": allocation_plan_id,
            "batching_rationale": batching_rationale,
            "cohort_vbriefs": cohort_vbriefs,
            "operator_approval_evidence": operator_approval_evidence,
        }
        if gate_clearances:
            allocation_context["gate_clearances"] = gate_clearances
        entry: dict[str, Any] = {
            "story_id": story.story_id,
            "vbrief_path": story.relpath,
            "worktree_path": worktree_path,
            "branch": _derive_branch(group, story.story_id),
            "allocation_context": allocation_context,
        }
        if subagent_backend is not None:
            entry["subagent_backend"] = subagent_backend
        if dispatch_provider is not None:
            entry["dispatch_provider"] = dispatch_provider
        if worker_role is not None:
            entry["worker_role"] = worker_role
        if runtime_mode is not None:
            entry["runtime_mode"] = runtime_mode
        if github_auth_mode is not None:
            entry["github_auth_mode"] = github_auth_mode
        manifest.append(entry)
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
        "--gate-clearances",
        default=None,
        metavar="PATH",
        help=(
            "Path to a JSON array of pre-recorded judgment-gate clearances "
            "(#1419 Slice 7). Each entry is an object with gate_id / vbrief_path "
            "/ cleared_by / rationale / cleared_at / cleared_scope. A gated story "
            "rides the consent token only when its clearance is pre-recorded."
        ),
    )
    parser.add_argument(
        "--enforce-gates",
        action="store_true",
        help=(
            "Gate-clearance ENFORCE posture (#1419 Slice 7): abort (exit 1) when "
            "a story is block-gated and uncleared, or when a block-gated story "
            "would ride a multi-story cohort (v1 ships block-gated stories solo). "
            "DEFAULT is advisory -- such stories are surfaced but still launch."
        ),
    )
    parser.add_argument(
        "--no-audit",
        action="store_true",
        help=(
            "Suppress the durable authority-event audit append "
            "(vbrief/.audit/authority-events.jsonl). By default a successful "
            "launch records the allocation approval + each consumed clearance."
        ),
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
            "Error: no stories supplied. Pass --stories <ids|paths> and/or --paths <paths>.",
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

    # Pre-recorded gate clearances (#1419 Slice 7). A supplied-but-unreadable
    # / non-array file is a config error -- the operator asked us to consume a
    # clearance file we cannot parse.
    gate_clearances: list[dict] = []
    if args.gate_clearances:
        try:
            clearance_payload = json.loads(
                Path(args.gate_clearances).read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"Error: could not read --gate-clearances {args.gate_clearances}: {exc}",
                file=sys.stderr,
            )
            return EXIT_CONFIG_ERROR
        if not isinstance(clearance_payload, list):
            print(
                f"Error: --gate-clearances {args.gate_clearances} must be a JSON "
                "array of clearance objects.",
                file=sys.stderr,
            )
            return EXIT_CONFIG_ERROR
        gate_clearances = [e for e in clearance_payload if isinstance(e, dict)]

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
            f"Error: story {story.story_id!r} ({story.relpath}) is not launch-ready -- {reason}",
            file=sys.stderr,
        )
        return EXIT_GATE_FAILED

    backend, backend_error = enforce_subagent_backend_policy(project_root)
    if backend_error is not None:
        print(f"Error: {backend_error}", file=sys.stderr)
        return EXIT_GATE_FAILED

    # Cohort-fill ordering (#1419 Slice 2 / #987): continuation-first,
    # deficit-biased among net-new, then rank/date. Reorders the dispatch
    # manifest (and each envelope's cohort_vbriefs list) so finishing started
    # epics and under-target buckets lead.
    resolved = order_cohort(resolved, project_root)

    # Gate-clearance + block-gated-solo check (#1419 Slice 7). Evaluate each
    # story's file_scope against the judgment gates; ENFORCE aborts on an
    # uncleared block gate or a block-gated story riding a multi-story cohort,
    # while the advisory DEFAULT surfaces those conditions but still launches
    # (the framework's own swarm:launch stays advisory).
    gate_posture = GATE_ENFORCE if args.enforce_gates else GATE_ADVISE
    gate_statuses = evaluate_cohort_gates(
        resolved, project_root, posture=gate_posture, clearances=gate_clearances
    )
    gate_failure = enforce_cohort_gates(
        gate_statuses, posture=gate_posture, cohort_size=len(resolved)
    )
    if gate_failure is not None:
        status, reason = gate_failure
        print(
            f"Error: story {status.story.story_id!r} ({status.story.relpath}) "
            f"is not launch-ready -- {reason}",
            file=sys.stderr,
        )
        return EXIT_GATE_FAILED
    if gate_posture != GATE_ENFORCE:
        for status in gate_statuses:
            if status.fired_block:
                print(
                    f"Note (advisory): story {status.story.story_id!r} is "
                    f"block-gated and uncleared -- {', '.join(status.fired_block)}.",
                    file=sys.stderr,
                )
            elif status.matched_block and len(resolved) > 1:
                print(
                    f"Note (advisory): story {status.story.story_id!r} is "
                    f"block-gated ({', '.join(status.matched_block)}); v1 ships "
                    "block-gated stories solo.",
                    file=sys.stderr,
                )

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

    try:
        runtime_mode, github_auth_mode = probe_worker_runtime_auth()
    except RuntimeError as exc:
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
        gate_clearances=gate_clearances,
        subagent_backend=backend.backend_id if backend is not None else None,
        dispatch_provider=(
            dispatch_provider_for(backend.backend_id) if backend is not None else None
        ),
        worker_role=LEAF_CODING_WORKER_ROLE if backend is not None else None,
        runtime_mode=runtime_mode,
        github_auth_mode=github_auth_mode,
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

    # Authority-bearing audit (#1419 Slice 7, Receipts & Audit): a successful
    # launch IS the allocation approval, so append the approval + each consumed
    # gate clearance to the durable, committed audit log. Best-effort -- an
    # audit write failure warns but never fails an otherwise-ready launch.
    if not args.no_audit and append_authority_event is not None:
        # Only clearances actually CONSUMED this run are recorded as
        # gate:cleared -- a clearance is consumed when its gate_id matched at
        # least one story's block-tier gates AND that gate ended up cleared
        # (matched but not fired). Logging every supplied clearance would
        # over-report the durable record-of-record (Greptile review, PR #1507).
        consumed_gate_ids = {
            gate_id
            for status in gate_statuses
            for gate_id in status.matched_block
            if gate_id not in status.fired_block
        }
        try:
            append_authority_event(
                project_root,
                event_type="allocation:approved",
                payload={
                    "dispatch_kind": dispatch_kind,
                    "allocation_plan_id": allocation_plan_id,
                    "batching_rationale": batching_rationale,
                    "cohort_vbriefs": [story.relpath for story in resolved],
                    "operator_approval_evidence": operator_approval,
                    "group": args.group,
                },
                log_name=AUTHORITY_LOG_NAME,
            )
            for clearance in gate_clearances:
                if clearance.get("gate_id") not in consumed_gate_ids:
                    continue
                append_authority_event(
                    project_root,
                    event_type="gate:cleared",
                    payload={
                        "gate_id": clearance.get("gate_id"),
                        "vbrief_path": clearance.get("vbrief_path"),
                        "cleared_by": clearance.get("cleared_by"),
                        "cleared_scope": clearance.get("cleared_scope"),
                        "rationale": clearance.get("rationale"),
                        "cleared_at": clearance.get("cleared_at"),
                    },
                    log_name=AUTHORITY_LOG_NAME,
                )
        except OSError as exc:
            print(
                f"warning: could not append authority event(s): {exc}",
                file=sys.stderr,
            )

    print(rendered)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
