#!/usr/bin/env python3
"""triage_queue.py -- ranked triage queue + per-item show + audit surface (#1128 / D11).

Wave-1 D11 ships three read-only triage surfaces against the unified
cache layer (#883 Story 2) and the append-only audit log (#845 Story 2):

* ``task triage:queue [--limit N]`` -- hybrid ranked work selection.
  Groups (display order): ``[RESUME]`` -> ``[URGENT]`` -> untriaged
  -> other. Within-group framework default = ``updated_at`` descending;
  consumer-supplied ``plan.policy.triageRankingLabels[]`` (typed; framework
  default empty per umbrella section 12 framework-vs-consumer boundary)
  re-orders within-group by matched-label declared order, then
  ``updated_at`` desc.
* ``task triage:show <N>`` -- per-item read-only detail (cached
  upstream payload + latest triage decision + audit timeline).
* ``task triage:audit [--format=json] [--vbrief-staleness]`` -- audit-log
  surface used by D2 (#1122) for triage:summary integration and by D4
  (#1124) for cap-reached error message integration.

The framework default for ``--explain <N>`` and weighted multi-signal
ranking are explicitly DEFERRED to follow-up children per the
Current Shape v2 amendment (comment 4471272093 on #1128).

Per ``conventions/task-caching.md`` the Taskfile fragment must NOT cache
the ``cmds:`` block: every subcommand accepts user-facing flags via
``{{.CLI_ARGS}}``.

Programmatic API
----------------

* :func:`resolve_ranking_labels` -- read effective ``plan.policy.triageRankingLabels[]``
  (default: ``[]``).
* :func:`validate_ranking_labels` -- structural validation of the typed
  value. Returns ``(errors, warnings)``.
* :func:`validate_triage_ranking_labels_on_plan` -- ``vbrief_validate``
  hook used from :mod:`vbrief_validate`.
* :func:`derive_group` -- map ``(latest_decision, in_active_vbrief)`` to
  one of ``"RESUME" | "URGENT" | "untriaged" | "other"``.
* :func:`load_cached_issues` -- walk
  ``.deft-cache/github-issue/<owner>/<repo>/<N>/raw.json`` and yield the
  cached issue payloads. Closed issues are excluded by default.
* :func:`build_queue` -- compose the grouped + within-group-ranked queue.
* :func:`render_queue` / :func:`render_show` / :func:`render_audit` --
  pure text renderers consumed by the CLI shim below.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked as ``python scripts/triage_queue.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the queue renderer prints group markers and
# arrow glyphs that cp1252 cannot encode (#814).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")

# Public, frozen interfaces -- guarded so this module imports cleanly on
# checkouts that have not yet rebased onto the upstream PRs.
try:  # pragma: no cover -- exercised once #845 Story 2 lands.
    import candidates_log  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    candidates_log = None  # type: ignore[assignment]

try:  # pragma: no cover -- exercised once D12 (#1131) lands.
    import triage_scope  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    triage_scope = None  # type: ignore[assignment]

# Optional dep: resume-condition evaluator (#1123 / D3). When importable,
# ``task triage:audit --evaluate-resume`` invokes the evaluator before
# rendering the audit dump so any fired ``resume_on`` conditions surface
# in the same call.
try:  # pragma: no cover -- exercised once #1123 lands.
    import resume_conditions  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    resume_conditions = None  # type: ignore[assignment]

# Optional dep: slice-cohort writer (#1132 / D13). When importable, the
# slice operation flags on the ``audit`` subcommand (``--orphans``,
# ``--slice-stalled``, ``--slice-coverage``) read ``vbrief/.eval/slices.jsonl``
# via this module. Slim test checkouts that have not yet rebased onto D13
# get a no-op fallback (empty result + informational stderr).
try:  # pragma: no cover -- exercised once #1132 lands.
    import slice_record  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    slice_record = None  # type: ignore[assignment]

# Optional dep: cache-freshness predicate (#1127 / #1476). Supplies the
# shared ``is_fetched_at_stale`` window used by the defensive stale-state
# re-resolution in :func:`load_cached_issues`. When absent the defensive
# path is disabled (entries are treated as fresh) so the queue still
# walks the cache on a partial / pre-#1127 checkout.
try:  # pragma: no cover -- preflight_cache is a sibling in this repo.
    import preflight_cache  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    preflight_cache = None  # type: ignore[assignment]

# Spec-readiness contract (#1419 Slice 1 / #987). Reuse the shared
# swarm-readiness / story-quality checks rather than inventing a parallel
# field set. Guarded for slim checkouts so the queue still imports if the
# helper is absent (the predicate then degrades to the readiness gate).
try:  # pragma: no cover -- core sibling in this repo.
    import _vbrief_story_quality  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    _vbrief_story_quality = None  # type: ignore[assignment]

# Capacity-allocation accounting (#1419 Slice 4). Slice 2 (#987) READS the
# Slice-4 per-bucket deficit tallies to bias net-new selection toward the
# most-under-target bucket. IMPORT-ONLY -- this module never edits the
# capacity engine. Guarded so the queue still imports on a slim checkout.
try:  # pragma: no cover -- core sibling in this repo.
    import capacity_show  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    capacity_show = None  # type: ignore[assignment]

# Typed-policy surface (#746 / #1124 / #1419). Slice 2 reads ``wipCap`` and
# ``capacityAllocation`` for the optional ``finishBeforeStart`` eligibility
# policy. Guarded for slim checkouts (the finishBeforeStart gate then stays
# inert rather than raising).
try:  # pragma: no cover -- core sibling in this repo.
    import policy as _policy  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    _policy = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Filesystem-relative location of the unified cache root (#883 Story 2).
CACHE_DIR_NAME = ".deft-cache"

#: Cache source layer for upstream GitHub issues. v1 ships github-issue only.
CACHE_SOURCE_GITHUB_ISSUE = "github-issue"

#: Env var honoured for repo inference when ``--repo`` is absent (#1238).
#: Mirrors ``scripts/preflight_cache.py::ENV_TRIAGE_REPO`` and
#: ``scripts/triage_bootstrap.py`` so every triage verb shares one
#: resolution chain (flag > env > git origin).
ENV_TRIAGE_REPO = "DEFT_TRIAGE_REPO"

#: PROJECT-DEFINITION vBRIEF location for typed-policy lookup.
PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"

#: Default queue limit when ``--limit`` is omitted on the CLI surface.
DEFAULT_QUEUE_LIMIT: int = 25

#: Default stalled-cohort window in days for ``task triage:audit --slice-stalled``
#: (#1132 / D13). Selectable per-invocation via ``--days N``. 30 days matches
#: the issue body's example fixture and the umbrella amendment timeframe.
DEFAULT_SLICE_STALLED_DAYS: int = 30

#: Group display order. Mirrors Current Shape v2 Decision 1 plus the D13
#: (#1132) ``ORPHAN`` insertion ABOVE ``RESUME``. The strings themselves
#: are also the user-visible markers in :func:`render_queue`. ``ORPHAN``
#: sits above ``RESUME`` because the orphan signal indicates work the
#: framework already committed to and risks losing (issue #1132 spec:
#: ``+8`` rank > resume-eligible ``+5``, below ``breaking-change`` ``+10``).
#: Within-group ranking labels (e.g. ``breaking-change``) still apply, so
#: a ``breaking-change``-labelled orphan tops the queue while a plain
#: orphan still sits above a resume-eligible item.
#:
#: ``BLOCKED`` sits at the BOTTOM (#1286): an item whose linked vBRIEF has
#: ``plan.status == "blocked"`` or an unresolved
#: ``plan.metadata.swarm.depends_on`` is demoted there by default so the
#: ranked list surfaces only grabbable work. The ``--include-blocked``
#: opt-in re-surfaces such items into their natural group instead.
GROUP_ORDER: tuple[str, ...] = (
    "ORPHAN",
    "RESUME",
    "URGENT",
    "untriaged",
    "other",
    "BLOCKED",
)

#: Display labels per group (left-of-issue marker).
GROUP_DISPLAY: dict[str, str] = {
    "ORPHAN": "[ORPHAN]    ",
    "RESUME": "[RESUME]    ",
    "URGENT": "[URGENT]    ",
    "untriaged": "[untriaged] ",
    "other": "[other]     ",
    "BLOCKED": "[BLOCKED]   ",
}

#: Framework default for ``plan.policy.triageRankingLabels[]``. EMPTY per
#: the umbrella section 12 framework-vs-consumer-config boundary (see
#: Current Shape v2 amendment on #1128). Deft's specific ranking labels
#: ship in the consumer-example child of #1119 (#1186), NOT here.
DEFAULT_TRIAGE_RANKING_LABELS: list[str] = []


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class QueueItem:
    """One ranked row in :func:`build_queue`.

    ``group`` is one of :data:`GROUP_ORDER`.  ``latest_decision`` is the
    most-recent audit-log decision string (or ``None`` for untriaged
    issues).  ``matched_label`` is the ranking-label that placed the item
    above its peers within the same group (or ``None`` when the framework
    default ``updated_at``-desc ordering applies).
    """

    number: int
    title: str
    state: str
    labels: tuple[str, ...]
    updated_at: str
    group: str
    latest_decision: str | None
    matched_label: str | None
    repo: str


@dataclass(frozen=True)
class QueueBuildOptions:
    """Bundled options for :func:`build_queue`.

    Splitting these out keeps the function signature short and avoids the
    multi-positional drift that PEP 8 / ruff would otherwise flag.
    """

    ranking_labels: tuple[str, ...] = ()
    active_referenced: frozenset[int] = field(default_factory=frozenset)
    #: Issue numbers in the ``ORPHAN`` group per D13 (#1132): open
    #: children whose umbrella has closed. Routed above ``RESUME`` in
    #: :data:`GROUP_ORDER`. Empty by default for back-compat with
    #: callers that have not yet rebased onto D13.
    orphan_issue_numbers: frozenset[int] = field(default_factory=frozenset)
    #: Maps GitHub issue number -> the scope vBRIEF's ``plan.metadata.rank``
    #: (#1419 Slice 1 / #987). Used as the intra-bucket tiebreaker applied
    #: AFTER the consumer priority-label ordering and BEFORE the creation-
    #: date fallback. Empty by default; the CLI path instead reads the
    #: per-issue ``_metadata_rank`` annotation stamped by
    #: :func:`load_cached_issues`, so both surfaces honour rank.
    rank_by_number: Mapping[int, int] = field(default_factory=dict)
    #: Issue numbers whose scope is *continuation* work (#1419 Slice 2 /
    #: #987): a story whose ``plan.planRef`` parent epic has already
    #: started (>=1 child completed OR a sibling active). Continuation
    #: outranks net-new single-issue work ("stop starting, start
    #: finishing"). Empty by default; the CLI path instead reads the
    #: per-issue ``_continuation`` annotation stamped by
    #: :func:`load_cached_issues`.
    continuation_numbers: frozenset[int] = field(default_factory=frozenset)
    #: Maps issue number -> a stable "epic started-at" ordering key used to
    #: surface the OLDEST-started epic's continuation work first. Compared
    #: lexicographically ascending. CLI path reads the per-issue
    #: ``_continuation_order`` annotation instead.
    continuation_order_by_number: Mapping[int, str] = field(default_factory=dict)
    #: Maps issue number -> its capacity-bucket deficit (target-vs-actual;
    #: positive == under target) from the Slice-4 accounting engine
    #: (#1419 Slice 2). Among NET-NEW work the most-under-target bucket
    #: (highest deficit) sorts first. Empty by default; the CLI path reads
    #: the per-issue ``_bucket_deficit`` annotation.
    deficit_by_number: Mapping[int, float] = field(default_factory=dict)
    #: Optional ``finishBeforeStart`` policy (#1419 Slice 2). When True AND
    #: :attr:`wip_at_cap` is True, the queue drops net-new scopes entirely
    #: -- at/near ``wipCap`` only continuation work is promotable.
    finish_before_start: bool = False
    #: True when the in-flight WIP set is at/over ``plan.policy.wipCap``.
    #: Gates the :attr:`finish_before_start` net-new filter above.
    wip_at_cap: bool = False
    #: Issue numbers whose linked vBRIEF is blocked (#1286): ``plan.status
    #: == "blocked"`` OR an unresolved ``plan.metadata.swarm.depends_on``.
    #: Demoted into the ``BLOCKED`` group by default unless
    #: :attr:`include_blocked` is True. Empty by default; the CLI path
    #: instead reads the per-issue ``_blocked`` annotation stamped by
    #: :func:`load_cached_issues`.
    blocked_issue_numbers: frozenset[int] = field(default_factory=frozenset)
    #: When True, blocked items (#1286) are re-surfaced into their natural
    #: group instead of being demoted into the ``BLOCKED`` group. Wired to
    #: the ``--include-blocked`` CLI opt-in.
    include_blocked: bool = False
    limit: int | None = None


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or _utc_now()).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Repo resolution (#1238)
# ---------------------------------------------------------------------------
#
# ``task triage:queue`` used to exit 2 demanding ``--repo`` even from inside
# a clone whose ``git origin`` would resolve the repo, while sibling tools
# (``triage:bootstrap``, ``preflight_cache``) already inferred it. These
# helpers give ``triage_queue`` the same resolution chain so ``--repo``
# becomes optional when origin is set. The chain mirrors
# ``scripts/preflight_cache.py::_infer_repo_from_git`` /
# ``_resolve_repo`` so the framework keeps one grammar.


def _infer_repo_from_git(project_root: Path | None) -> str | None:
    """Best-effort: read ``git remote get-url origin`` inside ``project_root``.

    Returns ``"owner/name"`` on success, ``None`` otherwise. Mirrors
    :func:`scripts.preflight_cache._infer_repo_from_git`: a stuck git proxy
    (corporate VPN re-auth) is bounded by a 10s timeout so the resolver
    never hangs the CLI, and ``git`` missing from PATH degrades to ``None``
    rather than raising. The capture forces ``encoding="utf-8",
    errors="replace"`` per the #1366 safe-subprocess rule so a non-UTF-8
    locale codepage cannot crash the read.
    """
    cwd = str(project_root) if project_root is not None else None
    try:
        proc = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    url = (proc.stdout or "").strip()
    if not url:
        return None
    # github.com/owner/name(.git) -- accepts ssh / https / git protocol.
    cleaned = url.rstrip("/")
    if cleaned.endswith(".git"):
        cleaned = cleaned[: -len(".git")]
    if "github.com" not in cleaned:
        return None
    tail = cleaned.split("github.com", 1)[1].lstrip(":/")
    parts = tail.split("/")
    if len(parts) >= 2 and parts[0] and parts[1]:
        return f"{parts[0]}/{parts[1]}"
    return None


def _resolve_repo(explicit: str | None, project_root: Path | None = None) -> str | None:
    """Resolve the effective ``owner/name`` repo slug for triage verbs (#1238).

    Resolution order, highest precedence first:

    1. ``explicit`` -- the ``--repo`` flag value. A cross-repo invocation
       always wins.
    2. ``$DEFT_TRIAGE_REPO`` -- the environment override, mirroring
       ``preflight_cache`` / ``triage_bootstrap``.
    3. ``git remote get-url origin`` parsed from inside ``project_root``
       (or the current working directory) -- the common-case dev
       experience that removes the papercut where an operator inside an
       unambiguous clone had to repeat the slug on every call.

    Returns ``None`` when none of the three sources resolve so the caller
    can emit the canonical ``--repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is
    required.`` error (exit 2) with an actionable next step.
    """
    if explicit:
        return explicit
    env_repo = os.environ.get(ENV_TRIAGE_REPO, "").strip()
    if env_repo:
        return env_repo
    return _infer_repo_from_git(project_root)


# ---------------------------------------------------------------------------
# Typed-policy resolver + validator (plan.policy.triageRankingLabels[])
# ---------------------------------------------------------------------------


def _load_project_definition(project_root: Path | None = None) -> dict[str, Any] | None:
    """Read ``vbrief/PROJECT-DEFINITION.vbrief.json``. Returns ``None`` if absent."""
    root = project_root or Path.cwd()
    path = root / PROJECT_DEFINITION_REL_PATH
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def resolve_ranking_labels(
    project_root: Path | None = None,
    *,
    project_definition: dict[str, Any] | None = None,
) -> list[str]:
    """Resolve the effective ``plan.policy.triageRankingLabels`` list.

    Resolution order:

    1. If a non-empty list of strings is set on
       ``plan.policy.triageRankingLabels``, return its filtered copy.
    2. Otherwise (unset / missing / non-list / empty), return the
       framework default (an empty list).

    Per the umbrella section 12 framework-vs-consumer-config boundary
    the framework MUST NOT ship label values here. Consumer-specific
    labels (`urgent`, `breaking-change`, `blocks-merge`,
    `adoption-blocker`) live in the deft consumer-example child of
    #1119 (#1186), which loads on top of the framework default at
    runtime.
    """
    data = (
        project_definition
        if project_definition is not None
        else _load_project_definition(project_root)
    )
    if not isinstance(data, dict):
        return list(DEFAULT_TRIAGE_RANKING_LABELS)
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return list(DEFAULT_TRIAGE_RANKING_LABELS)
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return list(DEFAULT_TRIAGE_RANKING_LABELS)
    value = policy.get("triageRankingLabels")
    if not isinstance(value, list) or not value:
        return list(DEFAULT_TRIAGE_RANKING_LABELS)
    return [s for s in value if isinstance(s, str) and s]


def validate_ranking_labels(value: Any) -> tuple[list[str], list[str]]:
    """Validate a ``plan.policy.triageRankingLabels`` payload.

    Returns ``(errors, warnings)``. ``errors`` is empty on success.

    Validation rules:

    * Unset / ``None`` is fine (handled by :func:`resolve_ranking_labels`
      with the empty framework default).
    * The top-level value MUST be a list when set.
    * Empty list is accepted (equivalent to unset).
    * Every entry MUST be a non-empty string.
    * Duplicate labels surface as a warning so consumers see the typo
      without rejecting an otherwise-valid configuration.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if value is None:
        return errors, warnings
    if not isinstance(value, list):
        errors.append(
            f"plan.policy.triageRankingLabels must be a list of strings; got {type(value).__name__}"
        )
        return errors, warnings
    seen: set[str] = set()
    for i, entry in enumerate(value):
        prefix = f"plan.policy.triageRankingLabels[{i}]"
        if not isinstance(entry, str):
            errors.append(f"{prefix} must be a string, got {type(entry).__name__}")
            continue
        if not entry.strip():
            errors.append(f"{prefix} must be a non-empty string")
            continue
        if entry in seen:
            warnings.append(f"{prefix} duplicate label {entry!r}; only the first occurrence ranks")
        seen.add(entry)
    return errors, warnings


def validate_triage_ranking_labels_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.triageRankingLabels`` (#1128).

    Returns formatted error strings prefixed with ``<filepath>:`` so
    ``vbrief_validate.validate_project_definition`` can splice them into
    its existing error list without re-formatting. Unset / missing is
    treated as the framework default and returns an empty list.
    """
    out: list[str] = []
    if not isinstance(plan, dict):
        return out
    policy = plan.get("policy")
    raw = policy.get("triageRankingLabels") if isinstance(policy, dict) else None
    if raw is None:
        return out
    errors, _warnings = validate_ranking_labels(raw)
    for err in errors:
        out.append(f"{filepath}: {err} (#1128)")
    return out


# ---------------------------------------------------------------------------
# Group derivation
# ---------------------------------------------------------------------------


def derive_group(latest_decision: str | None, in_active_vbrief: bool) -> str:
    """Map ``(latest_decision, in_active_vbrief)`` to a group bucket.

    Rules (framework-universal; no consumer labels involved):

    * ``in_active_vbrief`` -> ``"RESUME"``: there is an active vBRIEF
      referencing this issue, so the operator already declared an
      implementation intent against it; the queue surfaces it first so
      the operator can resume the running work.
    * ``latest_decision == "resume-eligible"`` -> ``"RESUME"``: D3
      (#1123) appended a ``resume-eligible`` marker because the prior
      ``defer``'s ``resume_on`` condition fired. The operator should
      revisit the defer with current data; the queue surfaces it in
      the same bucket as active-vBRIEF resumes.
    * ``latest_decision == "needs-ac"`` -> ``"URGENT"``: the operator
      previously asked the reporter for acceptance criteria; the issue
      is in a holding pattern that requires attention.
    * ``latest_decision is None`` -> ``"untriaged"``: no decision has
      been recorded for this issue yet -- it needs an initial triage
      pass.
    * Otherwise -> ``"other"``: a terminal decision (accept / reject /
      defer / mark-duplicate / reset) is recorded but no active vBRIEF
      links to it.

    The order matters: ``RESUME`` takes priority over ``URGENT`` so
    an issue that was once flagged ``needs-ac`` and has since been
    re-accepted into an active vBRIEF (or had a resume condition fire)
    surfaces in the resumable bucket, not the holding-pattern bucket.
    """
    if in_active_vbrief:
        return "RESUME"
    if latest_decision == "resume-eligible":
        return "RESUME"
    if latest_decision == "needs-ac":
        return "URGENT"
    if latest_decision is None:
        return "untriaged"
    return "other"


# ---------------------------------------------------------------------------
# plan.metadata.rank ordering + spec-readiness (#1419 Slice 1 / #987)
# ---------------------------------------------------------------------------


def scope_metadata_rank(plan: Any) -> int | None:
    """Return ``plan.metadata.rank`` as an int, or ``None`` when absent/invalid.

    Accepts a real integer or an integer-valued string (tolerating the
    JSON-as-string shape some hand-authored vBRIEFs use, including a
    leading-minus negative). ``bool`` is rejected even though it subclasses
    ``int`` -- a ``true`` rank is meaningless. Any other non-integer string
    (e.g. ``"--3"``, ``"x"``, ``""``) returns ``None`` rather than raising:
    ``int()`` inside a ``try`` is the correct guard, since a prefix check
    like ``lstrip("-").isdigit()`` wrongly admits ``"--3"``.

    ``scripts/roadmap_render._scope_metadata_rank`` is a deliberate mirror
    of this function: the renderer keeps its own tiny pure copy so it stays
    decoupled from this module's triage-cache dependency surface. Both are
    covered by tests (including the malformed-string edge case) so the
    shared semantics cannot silently drift.
    """
    if not isinstance(plan, dict):
        return None
    metadata = plan.get("metadata")
    if not isinstance(metadata, dict):
        return None
    rank = metadata.get("rank")
    if isinstance(rank, bool):
        return None
    if isinstance(rank, int):
        return rank
    if isinstance(rank, str):
        try:
            return int(rank.strip())
        except ValueError:
            return None
    return None


def _issue_numbers_from_plan(plan: dict[str, Any]) -> set[int]:
    """Extract issue numbers from a plan's ``x-vbrief/github-issue`` references."""
    out: set[int] = set()
    refs = plan.get("references") if isinstance(plan, dict) else None
    if not isinstance(refs, list):
        return out
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("type") != "x-vbrief/github-issue":
            continue
        uri = ref.get("uri", "")
        if not isinstance(uri, str):
            continue
        tail = uri.rstrip("/").rsplit("/", 1)[-1]
        if tail.isdigit():
            out.add(int(tail))
    return out


def _rank_by_issue_number(
    project_root: Path | None,
    *,
    folders: tuple[str, ...] = ("pending", "active"),
) -> dict[int, int]:
    """Map referenced issue numbers to their scope vBRIEF ``plan.metadata.rank``.

    Walks ``vbrief/<folder>/*.vbrief.json`` for each folder in ``folders``
    (default: the in-flight ``pending`` + ``active`` scopes the queue
    ranks), reads ``plan.metadata.rank`` (#1419 Slice 1 / #987) and maps
    every GitHub issue number that scope references to the rank. Files are
    visited in sorted filename order and the first rank seen for an issue
    wins, so the mapping is deterministic. Scopes without an integer rank
    contribute nothing -- those issues tail-sort after ranked ones.
    """
    out: dict[int, int] = {}
    base = (project_root or Path.cwd()) / "vbrief"
    for folder in folders:
        folder_dir = base / folder
        if not folder_dir.is_dir():
            continue
        for path in sorted(folder_dir.glob("*.vbrief.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            plan = data.get("plan") if isinstance(data, dict) else None
            if not isinstance(plan, dict):
                continue
            rank = scope_metadata_rank(plan)
            if rank is None:
                continue
            for number in _issue_numbers_from_plan(plan):
                out.setdefault(number, rank)
    return out


# ---------------------------------------------------------------------------
# Continuation precedence + deficit-biased selection (#1419 Slice 2 / #987)
# ---------------------------------------------------------------------------


def _load_plan(path: Path) -> dict[str, Any] | None:
    """Read a vBRIEF file and return its ``plan`` block, or ``None``."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    plan = data.get("plan")
    return plan if isinstance(plan, dict) else None


def _epic_child_refs(epic_path: Path) -> list[tuple[str, str]]:
    """Return ``[(folder, basename), ...]`` for an epic's ``x-vbrief/plan`` children.

    Reads the parent epic's ``plan.references[]`` (the canonical
    parent->child link, e.g. ``"completed/<slug>.vbrief.json"``) and yields
    the lifecycle folder + filename of each child so the caller can decide
    whether the epic has started.
    """
    plan = _load_plan(epic_path)
    if plan is None:
        return []
    refs = plan.get("references")
    if not isinstance(refs, list):
        return []
    out: list[tuple[str, str]] = []
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("type") != "x-vbrief/plan":
            continue
        uri = ref.get("uri")
        if not isinstance(uri, str) or not uri.strip():
            continue
        rel = uri.replace("\\", "/")
        folder = rel.split("/", 1)[0] if "/" in rel else ""
        basename = rel.rsplit("/", 1)[-1]
        out.append((folder, basename))
    return out


def _epic_started(child_refs: list[tuple[str, str]], *, exclude_name: str) -> bool:
    """True when an epic has STARTED: >=1 child completed OR a sibling active.

    ``exclude_name`` is the candidate scope's filename so a single active
    child that IS the candidate itself does not make the candidate count as
    its own continuation -- a sibling active child (a different filename) or
    any completed child is required.
    """
    for folder, basename in child_refs:
        if folder == "completed":
            return True
        if folder == "active" and basename != exclude_name:
            return True
    return False


def continuation_by_issue_number(
    project_root: Path | None,
    *,
    folders: tuple[str, ...] = ("pending", "active"),
) -> dict[int, str]:
    """Map referenced issue numbers -> a continuation ordering key (#1419 Slice 2).

    A scope is *continuation* work when its ``plan.planRef`` parent epic has
    already STARTED (>=1 child completed OR a sibling active per
    :func:`_epic_started`). Walks the in-flight ``pending`` + ``active``
    scopes, resolves each one's parent epic, and maps every GitHub issue a
    continuation scope references to a stable ordering key -- the parent
    epic's date-prefixed filename -- so the OLDEST-started epic's work sorts
    first. Net-new scopes (no started parent epic) contribute nothing.
    """
    out: dict[int, str] = {}
    base = (project_root or Path.cwd()) / "vbrief"
    child_refs_cache: dict[Path, list[tuple[str, str]]] = {}
    for folder in folders:
        folder_dir = base / folder
        if not folder_dir.is_dir():
            continue
        for path in sorted(folder_dir.glob("*.vbrief.json")):
            plan = _load_plan(path)
            if plan is None:
                continue
            plan_ref = plan.get("planRef")
            if not isinstance(plan_ref, str) or not plan_ref.strip():
                continue
            epic_path = (base / plan_ref).resolve()
            if epic_path not in child_refs_cache:
                child_refs_cache[epic_path] = _epic_child_refs(epic_path)
            if not _epic_started(child_refs_cache[epic_path], exclude_name=path.name):
                continue
            order_key = epic_path.name
            for number in _issue_numbers_from_plan(plan):
                out.setdefault(number, order_key)
    return out


def bucket_deficit_by_issue_number(
    project_root: Path | None,
    *,
    folders: tuple[str, ...] = ("pending", "active"),
) -> dict[int, float]:
    """Map referenced issue numbers -> their capacity-bucket deficit (#1419 Slice 2).

    Reads the per-bucket target-vs-actual deficit from the Slice-4 capacity
    accounting engine (:func:`capacity_show.compute_report`; IMPORT-ONLY,
    never edited) and maps each in-flight scope to its bucket's deficit via
    ``plan.metadata.capacityBucket`` (falling back to the policy
    ``defaultBucket``). A positive deficit means the bucket is UNDER target,
    so the most-under-target bucket sorts first among net-new work.
    Best-effort: returns ``{}`` when the capacity engine / policy module is
    unavailable or errors so an advisory signal never breaks the queue.
    """
    if capacity_show is None:
        return {}
    root = project_root or Path.cwd()
    try:
        report = capacity_show.compute_report(root)
    except Exception:  # noqa: BLE001 -- advisory signal must not break the queue
        return {}
    deficits = {tally.bucket_id: report.bucket_deficit(tally) for tally in report.buckets}
    if not deficits:
        return {}
    default_bucket = ""
    if _policy is not None:
        try:
            default_bucket = _policy.resolve_capacity_allocation(root).default_bucket
        except Exception:  # noqa: BLE001 -- advisory; fall back to no default bucket
            default_bucket = ""
    out: dict[int, float] = {}
    base = root / "vbrief"
    for folder in folders:
        folder_dir = base / folder
        if not folder_dir.is_dir():
            continue
        for path in sorted(folder_dir.glob("*.vbrief.json")):
            plan = _load_plan(path)
            if plan is None:
                continue
            raw_metadata = plan.get("metadata")
            metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
            raw_bucket = metadata.get("capacityBucket")
            bucket = (
                raw_bucket.strip()
                if isinstance(raw_bucket, str) and raw_bucket.strip()
                else default_bucket
            )
            if bucket not in deficits:
                continue
            for number in _issue_numbers_from_plan(plan):
                out.setdefault(number, deficits[bucket])
    return out


def resolve_finish_before_start(project_root: Path | None = None) -> bool:
    """Read the optional ``capacityAllocation.finishBeforeStart`` policy (#1419 Slice 2).

    Read directly from PROJECT-DEFINITION because the typed ``policy.py``
    surface does not expose this advisory field. Defaults to ``False`` -- the
    hard finish-before-start variant is opt-in. Callers pair this with
    :func:`wip_at_cap` to set :attr:`QueueBuildOptions.finish_before_start`
    and :attr:`QueueBuildOptions.wip_at_cap`.
    """
    data = _load_project_definition(project_root)
    if not isinstance(data, dict):
        return False
    plan = data.get("plan")
    policy = plan.get("policy") if isinstance(plan, dict) else None
    cap = policy.get("capacityAllocation") if isinstance(policy, dict) else None
    return isinstance(cap, dict) and cap.get("finishBeforeStart") is True


def wip_at_cap(project_root: Path | None = None) -> bool:
    """True when the in-flight WIP set is at/over ``plan.policy.wipCap`` (#1419 Slice 2).

    Reuses the ``scripts/policy.py`` WIP-cap surface (IMPORT-ONLY). Returns
    ``False`` when the policy module is unavailable so the finishBeforeStart
    gate stays inert on a slim checkout.
    """
    if _policy is None:
        return False
    root = project_root or Path.cwd()
    try:
        cap = _policy.resolve_wip_cap(root).cap
        count = _policy.count_vbrief_wip(root)
    except Exception:  # noqa: BLE001 -- advisory gate must not break the queue
        return False
    return count >= cap


# ---------------------------------------------------------------------------
# Blocked / unresolved-dependency demotion (#1286)
# ---------------------------------------------------------------------------


def _depends_on_ids(plan: dict[str, Any]) -> list[str]:
    """Return the non-empty string ids in ``plan.metadata.swarm.depends_on``.

    Tolerant of the absent / non-list / non-string shapes so a malformed
    swarm block never raises -- it simply contributes no dependency ids.
    """
    metadata = plan.get("metadata") if isinstance(plan, dict) else None
    swarm = metadata.get("swarm") if isinstance(metadata, dict) else None
    raw = swarm.get("depends_on") if isinstance(swarm, dict) else None
    if not isinstance(raw, list):
        return []
    return [dep.strip() for dep in raw if isinstance(dep, str) and dep.strip()]


def _completed_plan_ids(project_root: Path | None) -> set[str]:
    """Return the set of ``plan.id`` values from ``vbrief/completed/``.

    Used to decide whether a scope's ``depends_on`` entries are resolved:
    a dependency id is resolved when a completed scope carries that id.
    """
    out: set[str] = set()
    base = (project_root or Path.cwd()) / "vbrief" / "completed"
    if not base.is_dir():
        return out
    for path in sorted(base.glob("*.vbrief.json")):
        plan = _load_plan(path)
        if plan is None:
            continue
        pid = plan.get("id")
        if isinstance(pid, str) and pid.strip():
            out.add(pid.strip())
    return out


def scope_is_blocked(plan: Any, *, completed_ids: set[str]) -> bool:
    """Return True when a scope's linked vBRIEF is blocked (#1286).

    A scope is blocked when EITHER:

    * ``plan.status == "blocked"`` -- the operator explicitly parked it, OR
    * ``plan.metadata.swarm.depends_on`` is non-empty and at least one
      dependency id is unresolved (no completed scope carries that id).

    ``completed_ids`` is the set of ``plan.id`` values from completed
    scopes (see :func:`_completed_plan_ids`); an empty set treats every
    declared dependency as unresolved, which is the safe default when the
    completed lifecycle folder is unavailable.
    """
    if not isinstance(plan, dict):
        return False
    if plan.get("status") == "blocked":
        return True
    deps = _depends_on_ids(plan)
    return bool(deps) and any(dep not in completed_ids for dep in deps)


def blocked_by_issue_number(
    project_root: Path | None,
    *,
    folders: tuple[str, ...] = ("pending", "active"),
) -> set[int]:
    """Map referenced issue numbers -> blocked state (#1286).

    Walks the in-flight ``pending`` + ``active`` scopes (the folders the
    queue ranks), flags each one via :func:`scope_is_blocked`, and returns
    the set of GitHub issue numbers a blocked scope references. The
    ``vbrief/completed/`` plan ids are read once up front so unresolved-
    dependency detection is consistent across the walk.
    """
    out: set[int] = set()
    root = project_root or Path.cwd()
    completed_ids = _completed_plan_ids(root)
    base = root / "vbrief"
    for folder in folders:
        folder_dir = base / folder
        if not folder_dir.is_dir():
            continue
        for path in sorted(folder_dir.glob("*.vbrief.json")):
            plan = _load_plan(path)
            if plan is None:
                continue
            if not scope_is_blocked(plan, completed_ids=completed_ids):
                continue
            out |= _issue_numbers_from_plan(plan)
    return out


#: Operator-facing pointer surfaced when a scope is refused as under-specified
#: (#1419 Slice 1 / #987). Names refinement as the canonical next step.
SPEC_READINESS_REFINEMENT_HINT = (
    "refine the scope via skills/deft-directive-refinement "
    "(`task triage:welcome --onboard`) before promotion/selection"
)


def scope_spec_readiness(plan: Any) -> tuple[bool, list[str]]:
    """Return ``(eligible, reasons)`` for a scope's spec-readiness (#987 / #1419).

    Reuses the existing swarm-readiness / story-quality contract
    (:mod:`_vbrief_story_quality`) instead of inventing a parallel field
    set: a scope is eligible for promotion/selection only when it declares
    ``plan.metadata.swarm.readiness == "ready"``, carries the required
    swarm fields, the three required narratives, and at least one
    acceptance criterion. ``reasons`` lists the missing fields when
    ineligible and is empty when eligible. On a slim checkout where
    :mod:`_vbrief_story_quality` is unimportable the check degrades to the
    ``swarm.readiness`` gate alone so an unmarked scope is still refused.
    """
    if not isinstance(plan, dict):
        return False, ["plan is not an object"]
    raw_metadata = plan.get("metadata")
    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
    raw_swarm = metadata.get("swarm")
    swarm = raw_swarm if isinstance(raw_swarm, dict) else {}
    reasons: list[str] = []
    if swarm.get("readiness") != "ready":
        reasons.append("plan.metadata.swarm.readiness=ready")
    if _vbrief_story_quality is not None:
        reasons.extend(_vbrief_story_quality.missing_required_swarm_fields(swarm))
        raw_narratives = plan.get("narratives")
        narratives = raw_narratives if isinstance(raw_narratives, dict) else {}
        for key in ("Description", "ImplementationPlan", "UserStory"):
            value = narratives.get(key)
            if not (isinstance(value, str) and value.strip()):
                reasons.append(f"plan.narratives.{key}")
        if not _vbrief_story_quality.items_have_acceptance(plan.get("items")):
            reasons.append("plan.items[].narrative.Acceptance")
    return (not reasons), reasons


def spec_readiness_refusal(plan: Any, *, scope_label: str = "scope") -> str | None:
    """Return a refusal message when ``plan`` is under-specified, else ``None``.

    The message names the missing spec-readiness fields and points the
    operator at refinement (#987 / #1419). Returns ``None`` when the scope
    is eligible so callers can guard with
    ``if (msg := spec_readiness_refusal(plan)): refuse(msg)``.
    """
    eligible, reasons = scope_spec_readiness(plan)
    if eligible:
        return None
    detail = ", ".join(reasons)
    return (
        f"{scope_label}: refusing promotion/selection -- under-specified "
        f"(missing: {detail}); {SPEC_READINESS_REFINEMENT_HINT}"
    )


# ---------------------------------------------------------------------------
# Cache walk
# ---------------------------------------------------------------------------


def cache_root_for(project_root: Path | None = None) -> Path:
    root = project_root or Path.cwd()
    return root / CACHE_DIR_NAME


def repo_cache_path(
    repo: str,
    *,
    project_root: Path | None = None,
    source: str = CACHE_SOURCE_GITHUB_ISSUE,
) -> Path:
    """Return ``<cache>/<source>/<owner>/<name>/`` for ``repo='owner/name'``."""
    if "/" not in repo:
        raise ValueError(f"repo must be 'owner/name'; got {repo!r}")
    owner, name = repo.split("/", 1)
    return cache_root_for(project_root) / source / owner / name


def _read_meta_fetched_at(entry_dir: Path) -> str | None:
    """Return the sibling ``meta.json``'s ``fetched_at`` string, or ``None``.

    Used by the #1476 defensive stale-state path to date a cached entry
    without importing the cache layer's validator (pure read).
    """
    meta_path = entry_dir / "meta.json"
    if not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(meta, dict):
        return None
    fetched = meta.get("fetched_at")
    return fetched if isinstance(fetched, str) else None


def _entry_is_stale(
    entry_dir: Path,
    *,
    max_age_hours: int | None,
    now: datetime | None,
) -> bool:
    """True when ``entry_dir``'s cached ``fetched_at`` is past the freshness window.

    Delegates the window resolution to :func:`preflight_cache.is_fetched_at_stale`
    so #1127 / #1476 share one definition. When :mod:`preflight_cache` is
    not importable the defensive path is disabled (returns ``False``) so
    the queue never mass-re-resolves on a partial checkout.
    """
    if preflight_cache is None:
        return False
    fetched_at = _read_meta_fetched_at(entry_dir)
    return preflight_cache.is_fetched_at_stale(fetched_at, max_age_hours=max_age_hours, now=now)


def _resolve_live_state(
    state_resolver: Callable[[str, int], str | None],
    repo: str,
    number: int,
) -> str | None:
    """Call ``state_resolver`` and normalise its result to a lowercase state.

    A resolver failure returns ``None`` (unknown) so a transient network
    error never drops a genuinely-open entry from the queue.
    """
    try:
        result = state_resolver(repo, number)
    except Exception:  # noqa: BLE001 -- resolver failure must not drop the entry
        return None
    return result.lower() if isinstance(result, str) else None


def load_cached_issues(
    repo: str,
    *,
    project_root: Path | None = None,
    source: str = CACHE_SOURCE_GITHUB_ISSUE,
    include_closed: bool = False,
    state_resolver: Callable[[str, int], str | None] | None = None,
    max_age_hours: int | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Walk the cache and return one dict per cached issue.

    Each dict carries at least: ``number``, ``title``, ``state``,
    ``labels`` (list of strings), ``updated_at``, ``created_at``, and
    ``_metadata_rank`` -- the scope vBRIEF ``plan.metadata.rank`` for this
    issue (or ``None``), threaded as the intra-bucket tiebreaker by #1419
    Slice 1 (#987). Missing fields are filled with empty / sentinel values
    rather than raising so a partially-populated cache (mid-fetch) still
    produces a usable queue.

    Closed issues are excluded by default; pass ``include_closed=True``
    to surface them too (used by :func:`audit` callers that need full
    history).

    Defensive stale-state handling (#1476): ``cache:fetch-all`` defaults
    to ``state=open`` and never rewrites a cached entry that closed
    upstream within its TTL, so a closed issue can keep saying
    ``state=open`` on disk and surface as actionable ``triage:queue``
    work (the #1322 shape). When an optional ``state_resolver`` callable
    is supplied, a cached-open entry whose ``meta.json`` ``fetched_at``
    is older than the freshness window (``max_age_hours`` / the
    ``DEFT_CACHE_MAX_AGE_HOURS`` env / 24h default) is re-resolved
    against it; a ``closed`` result is honoured so the entry is excluded
    (unless ``include_closed``). The resolver is OFF by default -- the
    cache-side reconciliation (``cache:fetch-all --refresh-closed``) is
    the primary fix and this is the read-side belt-and-suspenders.
    """
    base = repo_cache_path(repo, project_root=project_root, source=source)
    if not base.is_dir():
        return []
    # #1419 Slice 1 (#987): resolve plan.metadata.rank per referenced issue
    # from the in-flight scope vBRIEFs so the CLI path orders by rank
    # without _triage_queue_cli.py needing to thread an extra argument.
    rank_map = _rank_by_issue_number(project_root)
    # #1419 Slice 2 (#987): annotate continuation precedence + bucket deficit
    # from filesystem-truth so the CLI ordering matches the programmatic
    # surface without the cli shim threading extra arguments.
    continuation_map = continuation_by_issue_number(project_root)
    deficit_map = bucket_deficit_by_issue_number(project_root)
    # #1286: flag issues whose linked vBRIEF is blocked (status:blocked or an
    # unresolved swarm.depends_on) so build_queue can demote them.
    blocked_set = blocked_by_issue_number(project_root)
    issues: list[dict[str, Any]] = []
    for entry in base.iterdir():
        if not entry.is_dir() or not entry.name.isdigit():
            continue
        raw_path = entry / "raw.json"
        if not raw_path.is_file():
            continue
        try:
            payload = json.loads(raw_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(payload, dict):
            continue
        n = payload.get("number")
        if not isinstance(n, int):
            with contextlib.suppress(ValueError, TypeError):
                n = int(entry.name)
        if not isinstance(n, int):
            continue
        # #1236 defensive normalisation: pre-#1239 cached payloads carry
        # GraphQL-shape uppercase ``"state": "OPEN"``; post-#1239 the REST
        # writer canonicalises to lowercase. The reader MUST treat both
        # as equivalent so any existing cache populated before the
        # writer migration still surfaces open issues.
        state_raw = payload.get("state") or "open"
        state = state_raw.lower() if isinstance(state_raw, str) else "open"
        # #1476 defensive stale-state re-resolution (opt-in via state_resolver).
        if (
            state == "open"
            and state_resolver is not None
            and _entry_is_stale(entry, max_age_hours=max_age_hours, now=now)
        ):
            resolved = _resolve_live_state(state_resolver, repo, int(n))
            if resolved is not None:
                state = resolved
        if state != "open" and not include_closed:
            continue
        title = payload.get("title") or ""
        updated_at = payload.get("updated_at") or ""
        created_at = payload.get("created_at") or ""
        labels_raw = payload.get("labels", [])
        labels: list[str] = []
        if isinstance(labels_raw, list):
            for item in labels_raw:
                if isinstance(item, dict):
                    name = item.get("name")
                    if isinstance(name, str):
                        labels.append(name)
                elif isinstance(item, str):
                    labels.append(item)
        issues.append(
            {
                "number": int(n),
                "title": title,
                "state": state,
                "labels": labels,
                "updated_at": updated_at,
                "created_at": created_at,
                "_metadata_rank": rank_map.get(int(n)),
                "_continuation": int(n) in continuation_map,
                "_continuation_order": continuation_map.get(int(n), ""),
                "_bucket_deficit": deficit_map.get(int(n)),
                "_blocked": int(n) in blocked_set,
            }
        )
    return issues


# ---------------------------------------------------------------------------
# Audit-log helpers
# ---------------------------------------------------------------------------


def _resolve_audit_log(audit_path: Path | str | None) -> Any:
    """Resolve the ``candidates_log`` module + path the CLI uses.

    Returns the (module, path) pair the read helpers below pass through.
    The path is forwarded to :func:`candidates_log.read_all`'s ``path=``
    parameter so tests can route reads to a tmp log without monkeypatching
    a constant.
    """
    return candidates_log, audit_path


def read_audit_entries(
    repo: str | None,
    *,
    audit_path: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Return all audit entries (optionally filtered by ``repo``)."""
    mod, path = _resolve_audit_log(audit_path)
    if mod is None:
        return []
    return list(mod.read_all(repo=repo, path=path))


def latest_decisions_by_issue(
    entries: Iterable[dict[str, Any]],
) -> dict[int, dict[str, Any]]:
    """Reduce ``entries`` to ``{issue_number: latest_entry}``.

    Sort key is the entry's ``timestamp`` field. ISO-8601 ``Z``-suffixed
    timestamps sort lexicographically in chronological order; mirrors
    :func:`candidates_log.latest_decision` for the per-issue case.
    """
    out: dict[int, dict[str, Any]] = {}
    for entry in entries:
        n = entry.get("issue_number")
        if not isinstance(n, int):
            continue
        cur = out.get(n)
        if cur is None or entry.get("timestamp", "") > cur.get("timestamp", ""):
            out[n] = entry
    return out


# ---------------------------------------------------------------------------
# Build queue
# ---------------------------------------------------------------------------


def _date_sort_key(issue: dict[str, Any]) -> tuple[int, str]:
    """Return ``(date_bucket, date_value)`` for the within-group date tiebreak.

    A non-empty ``created_at`` sorts ascending (oldest first) in bucket 0
    -- the #1419 Slice 1 (#987) creation-date tiebreaker the rank ordering
    falls back to. When no ``created_at`` is present (a synthetic fixture
    or a pre-creation-field cache entry) the legacy ``updated_at``-
    descending order is preserved in bucket 1 so the #1128 within-group
    behaviour is unchanged. An empty ``updated_at`` maps to ``chr(0)`` so
    it tail-sorts; a non-empty stamp is character-wise complemented so a
    more-recent timestamp sorts earlier.
    """
    created_at = issue.get("created_at") or ""
    if created_at:
        return (0, created_at)
    updated_at = issue.get("updated_at") or ""
    # ``max(0, ...)`` keeps the complement non-negative so a stray non-ASCII
    # char in a malformed timestamp (ord > 0x7F) maps to chr(0) instead of
    # raising ValueError; valid ASCII ISO-8601 stamps are unaffected.
    inv = chr(0) if not updated_at else "".join(chr(max(0, 0x7F - ord(c))) for c in updated_at)
    return (1, inv)


def selection_ordering_key(
    *,
    label_index: int,
    is_continuation: bool,
    continuation_order: str = "",
    bucket_deficit: float | None = None,
    rank: int | None = None,
    date_key: tuple[int, str] = (1, ""),
) -> tuple[int, int, tuple[float, str], int, int, tuple[int, str]]:
    """Build the canonical RFC #1419 Layer-3 lexicographic selection key.

    The RFC order is ``(urgent/blocking down, continuation down,
    bucket-deficit down, intra-bucket rank down, date up)``. This helper is
    the single source of truth for that order so the queue
    (:func:`_within_group_sort_key`) and the swarm cohort-fill
    (``swarm_launch.order_cohort``) cannot drift. ``sorted`` is ascending,
    so every "down" dimension is encoded as a value that is *smaller* for
    the higher-priority item:

    1. ``label_index`` -- urgent/blocking: the consumer priority-label rank
       (lower index = higher priority). Preempts continuation.
    2. ``continuation_bucket`` -- ``0`` for continuation work, ``1`` for
       net-new. Continuation outranks net-new single-issue work.
    3. ``secondary`` -- a ``(float, str)`` whose meaning depends on the
       partition above (the two partitions never interleave because
       ``continuation_bucket`` already differs): for continuation work it
       surfaces the OLDEST-started epic first (``continuation_order``
       ascending, unknown-start last); for net-new work it surfaces the
       most-under-target bucket first (highest ``bucket_deficit``, negated
       for ascending sort).
    4. ``(rank_bucket, rank_value)`` -- ``plan.metadata.rank``: ranked rows
       sort ahead of un-ranked ones, lower value first.
    5. ``date_key`` -- ``(date_bucket, date_value)`` from
       :func:`_date_sort_key`: ascending creation date when available.
    """
    continuation_bucket = 0 if is_continuation else 1
    if is_continuation:
        # Oldest-started epic first: known order keys sort ascending in
        # bucket 0.0; an unknown start tail-sorts in bucket 1.0.
        secondary = (0.0, continuation_order) if continuation_order else (1.0, "")
    elif isinstance(bucket_deficit, int | float) and not isinstance(bucket_deficit, bool):
        # Most-under-target (highest deficit) first -> negate for ascending.
        secondary = (-float(bucket_deficit), "")
    else:
        secondary = (0.0, "")
    if isinstance(rank, int) and not isinstance(rank, bool):
        rank_bucket, rank_value = 0, rank
    else:
        rank_bucket, rank_value = 1, 0
    return (label_index, continuation_bucket, secondary, rank_bucket, rank_value, date_key)


def _within_group_sort_key(
    issue: dict[str, Any],
    ranking_labels: tuple[str, ...],
) -> tuple[int, int, tuple[float, str], int, int, tuple[int, str]]:
    """Return the intra-bucket sort key for a cached-issue row.

    Resolves the five RFC #1419 Layer-3 selection dimensions from the
    annotations :func:`build_queue` stamps on each issue, then delegates to
    :func:`selection_ordering_key` (the canonical key shared with swarm
    cohort-fill):

    1. ``rank_index`` -- the consumer priority-label rank (#1128).
    2. ``_continuation`` / ``_continuation_order`` -- continuation
       precedence (#1419 Slice 2 / #987): started-epic work first, oldest
       epic first.
    3. ``_bucket_deficit`` -- deficit-biased net-new selection (#1419
       Slice 2): most-under-target bucket first.
    4. ``_resolved_rank`` -- the vBRIEF-canonical intra-bucket rank
       (#1419 Slice 1 / #987).
    5. ``(date_bucket, date_value)`` from :func:`_date_sort_key`.
    """
    rank_index = len(ranking_labels)
    if ranking_labels:
        labels = issue.get("labels", []) or []
        for i, candidate in enumerate(ranking_labels):
            if candidate in labels:
                rank_index = i
                break
    resolved_rank = issue.get("_resolved_rank")
    rank = (
        resolved_rank
        if isinstance(resolved_rank, int) and not isinstance(resolved_rank, bool)
        else None
    )
    return selection_ordering_key(
        label_index=rank_index,
        is_continuation=bool(issue.get("_continuation")),
        continuation_order=str(issue.get("_continuation_order") or ""),
        bucket_deficit=issue.get("_bucket_deficit"),
        rank=rank,
        date_key=_date_sort_key(issue),
    )


def matched_label_for(
    issue: dict[str, Any],
    ranking_labels: tuple[str, ...],
) -> str | None:
    """Return the first ranking-label the issue matches, or ``None``."""
    if not ranking_labels:
        return None
    labels = issue.get("labels", []) or []
    for candidate in ranking_labels:
        if candidate in labels:
            return candidate
    return None


def _resolve_rank(
    issue: dict[str, Any],
    number: int,
    rank_by_number: dict[int, int],
) -> int | None:
    """Resolve a queue row's effective ``plan.metadata.rank`` (#1419 / #987).

    Precedence: an explicit :attr:`QueueBuildOptions.rank_by_number` entry
    (the programmatic surface) wins; otherwise the ``_metadata_rank``
    annotation that :func:`load_cached_issues` stamps from the scope
    vBRIEFs (the CLI surface) is used. Returns ``None`` -- so the row
    tail-sorts after ranked peers -- when neither supplies an int rank.
    """
    candidate = rank_by_number.get(number)
    if candidate is None:
        candidate = issue.get("_metadata_rank")
    if isinstance(candidate, bool) or not isinstance(candidate, int):
        return None
    return candidate


def _resolve_continuation(
    issue: dict[str, Any],
    number: int,
    continuation_numbers: frozenset[int] | set[int],
) -> bool:
    """Resolve whether a queue row is continuation work (#1419 Slice 2 / #987).

    Precedence mirrors :func:`_resolve_rank`: an explicit
    :attr:`QueueBuildOptions.continuation_numbers` membership (programmatic
    surface) wins; otherwise the ``_continuation`` annotation that
    :func:`load_cached_issues` stamps from the scope vBRIEFs (CLI surface)
    is used.
    """
    if number in continuation_numbers:
        return True
    return bool(issue.get("_continuation"))


def _resolve_continuation_order(
    issue: dict[str, Any],
    number: int,
    order_by_number: Mapping[int, str],
) -> str:
    """Resolve a continuation row's "oldest-started epic" ordering key.

    The programmatic ``continuation_order_by_number`` entry wins; otherwise
    the ``_continuation_order`` annotation stamped by
    :func:`load_cached_issues` is used. Returns ``""`` (unknown -- tail
    sorts among continuation work) when neither supplies a string.
    """
    candidate = order_by_number.get(number)
    if candidate is None:
        candidate = issue.get("_continuation_order")
    return candidate if isinstance(candidate, str) else ""


def _resolve_deficit(
    issue: dict[str, Any],
    number: int,
    deficit_by_number: Mapping[int, float],
) -> float | None:
    """Resolve a queue row's capacity-bucket deficit (#1419 Slice 2).

    The programmatic ``deficit_by_number`` entry wins; otherwise the
    ``_bucket_deficit`` annotation stamped by :func:`load_cached_issues`
    from the Slice-4 accounting engine is used. Returns ``None`` (no
    deficit signal -- neutral among net-new peers) when neither supplies a
    real number.
    """
    candidate = deficit_by_number.get(number)
    if candidate is None:
        candidate = issue.get("_bucket_deficit")
    if isinstance(candidate, bool) or not isinstance(candidate, int | float):
        return None
    return float(candidate)


def _resolve_blocked(
    issue: dict[str, Any],
    number: int,
    blocked_numbers: frozenset[int] | set[int],
) -> bool:
    """Resolve whether a queue row is blocked (#1286).

    Precedence mirrors :func:`_resolve_continuation`: an explicit
    :attr:`QueueBuildOptions.blocked_issue_numbers` membership (the
    programmatic surface) wins; otherwise the ``_blocked`` annotation that
    :func:`load_cached_issues` stamps from the in-flight scope vBRIEFs (the
    CLI surface) is used.
    """
    if number in blocked_numbers:
        return True
    return bool(issue.get("_blocked"))


def build_queue(
    issues: Iterable[dict[str, Any]],
    audit_entries: Iterable[dict[str, Any]],
    *,
    repo: str,
    options: QueueBuildOptions | None = None,
) -> list[QueueItem]:
    """Compose the ranked queue.

    ``issues`` and ``audit_entries`` are typically produced by
    :func:`load_cached_issues` and :func:`read_audit_entries` but tests
    can pass synthetic fixtures directly.
    """
    opts = options or QueueBuildOptions()
    issue_list = list(issues)
    decisions = latest_decisions_by_issue(audit_entries)
    rank_by_number = dict(opts.rank_by_number)
    # finishBeforeStart (#1419 Slice 2): at/near wipCap only continuation
    # work is promotable, so net-new scopes are dropped from the queue.
    drop_net_new = opts.finish_before_start and opts.wip_at_cap

    grouped: dict[str, list[dict[str, Any]]] = {g: [] for g in GROUP_ORDER}
    for issue in issue_list:
        n = issue.get("number")
        if not isinstance(n, int):
            continue
        is_continuation = _resolve_continuation(issue, n, opts.continuation_numbers)
        is_orphan = n in opts.orphan_issue_numbers
        # finishBeforeStart drops NET-NEW work only. ORPHAN items (D13 /
        # #1132 -- committed work the framework risks losing) and
        # continuation work survive, so the policy never hides an orphan the
        # operator must still see.
        if drop_net_new and not is_continuation and not is_orphan:
            continue
        is_blocked = _resolve_blocked(issue, n, opts.blocked_issue_numbers)
        latest = decisions.get(n)
        latest_decision = latest.get("decision") if isinstance(latest, dict) else None
        # #1286: a blocked item (status:blocked / unresolved depends_on) is
        # demoted into the BLOCKED group (bottom of GROUP_ORDER) by default
        # so the queue surfaces only grabbable work. The --include-blocked
        # opt-in (opts.include_blocked) re-surfaces it into its natural
        # group instead, so the demotion check runs FIRST.
        if is_blocked and not opts.include_blocked:
            group = "BLOCKED"
        # D13 (#1132): ORPHAN takes precedence over every other group --
        # an orphan is work the framework already committed to and risks
        # losing, so it surfaces above RESUME / URGENT / untriaged.
        elif is_orphan:
            group = "ORPHAN"
        else:
            group = derive_group(latest_decision, n in opts.active_referenced)
        issue["_latest_decision"] = latest_decision
        issue["_blocked"] = is_blocked
        issue["_resolved_rank"] = _resolve_rank(issue, n, rank_by_number)
        issue["_continuation"] = is_continuation
        issue["_continuation_order"] = _resolve_continuation_order(
            issue, n, opts.continuation_order_by_number
        )
        issue["_bucket_deficit"] = _resolve_deficit(issue, n, opts.deficit_by_number)
        grouped[group].append(issue)

    out: list[QueueItem] = []
    for group in GROUP_ORDER:
        bucket = sorted(
            grouped[group],
            key=lambda i: _within_group_sort_key(i, opts.ranking_labels),
        )
        for issue in bucket:
            out.append(
                QueueItem(
                    number=int(issue["number"]),
                    title=str(issue.get("title", "")),
                    state=str(issue.get("state", "open")),
                    labels=tuple(issue.get("labels", []) or []),
                    updated_at=str(issue.get("updated_at", "")),
                    group=group,
                    latest_decision=issue.get("_latest_decision"),
                    matched_label=matched_label_for(issue, opts.ranking_labels),
                    repo=repo,
                )
            )
            if opts.limit is not None and len(out) >= opts.limit:
                return out
    return out


# ---------------------------------------------------------------------------
# Audit date / action filters (#1180 -- lightweight triage metrics)
# ---------------------------------------------------------------------------


#: Decision verbs accepted by ``--action=<verb>``.
#:
#: Sourced from :mod:`candidates_log`'s frozen vocabulary when the module
#: is importable; falls back to the literal set so a slim test checkout
#: still gets a useful error message.
_AUDIT_ACTION_FALLBACK: frozenset[str] = frozenset(
    {
        "accept",
        "reject",
        "defer",
        "needs-ac",
        "mark-duplicate",
        "reset",
        "resume-eligible",
    }
)


def valid_audit_actions() -> frozenset[str]:
    """Return the valid set of ``--action=<verb>`` values.

    Prefers :data:`candidates_log._VALID_DECISIONS` (the canonical
    vocabulary frozen by ``vbrief/schemas/candidates.schema.json``);
    falls back to a private mirror so the CLI still surfaces a useful
    error message on a checkout where the audit-log module has not been
    imported yet.
    """
    if candidates_log is not None:
        decisions = getattr(candidates_log, "_VALID_DECISIONS", None)
        if isinstance(decisions, frozenset):
            return decisions
    return _AUDIT_ACTION_FALLBACK


def parse_audit_window(raw: str) -> timedelta:
    """Parse a ``--since=<window>`` duration into a :class:`timedelta`.

    Delegates to :func:`triage_scope.parse_duration` when importable so
    the framework keeps a single duration grammar across D12 / #1131 +
    #1180. Falls back to an inline ``N(s|m|h|d|w)`` parser for slim test
    checkouts that have not rebased onto D12 yet.

    Raises :class:`ValueError` on malformed input; the error message is
    suitable for direct surfacing to stderr by the CLI shim.
    """
    if triage_scope is not None and hasattr(triage_scope, "parse_duration"):
        return triage_scope.parse_duration(raw)  # type: ignore[no-any-return]
    # Slim-checkout fallback. Mirrors the compact form documented by
    # triage_scope.parse_duration so the grammar stays consistent.
    if not isinstance(raw, str):
        raise ValueError(f"duration must be a string, got {type(raw).__name__}")
    text = raw.strip()
    if not text:
        raise ValueError("duration must be a non-empty string")
    if len(text) < 2 or not text[:-1].isdigit():
        raise ValueError(f"invalid duration {raw!r}: expected '<N>(s|m|h|d|w)' (e.g. '7d', '24h')")
    n = int(text[:-1])
    unit = text[-1].lower()
    if unit == "s":
        return timedelta(seconds=n)
    if unit == "m":
        return timedelta(minutes=n)
    if unit == "h":
        return timedelta(hours=n)
    if unit == "d":
        return timedelta(days=n)
    if unit == "w":
        return timedelta(weeks=n)
    raise ValueError(f"invalid duration {raw!r}: expected '<N>(s|m|h|d|w)' (e.g. '7d', '24h')")


def filter_by_since(
    entries: Iterable[dict[str, Any]],
    window: timedelta,
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return entries whose ``timestamp`` is at-or-after ``now - window``.

    Entries with a missing / malformed timestamp are dropped (they cannot
    be placed on the time axis). ``window`` is interpreted inclusively
    (``ts >= cutoff``) so ``--since=0s`` returns every still-valid entry.
    """
    cutoff = (now or _utc_now()) - window
    out: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        stamp = entry.get("timestamp")
        if not isinstance(stamp, str) or not stamp:
            continue
        try:
            text = stamp
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            ts = datetime.fromisoformat(text)
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        if ts >= cutoff:
            out.append(entry)
    return out


def filter_by_action(
    entries: Iterable[dict[str, Any]],
    action: str,
) -> list[dict[str, Any]]:
    """Return entries whose ``decision`` equals ``action``.

    The caller is responsible for validating ``action`` against
    :func:`valid_audit_actions` before invoking this helper -- a typo
    here would silently return an empty list, which is the wrong UX for
    a CLI flag. Validation lives in the argparse shim.
    """
    return [e for e in entries if isinstance(e, dict) and e.get("decision") == action]


# ---------------------------------------------------------------------------
# vBRIEF-staleness predicate (used by --vbrief-staleness on audit)
# ---------------------------------------------------------------------------


def is_stale_acceptance(
    entry: dict[str, Any],
    active_referenced: frozenset[int] | set[int],
) -> bool:
    """Return True if ``entry`` is an ``accept`` decision whose issue is no
    longer referenced by any ``vbrief/active/`` plan.

    The framework treats "stale acceptance" as the load-bearing failure
    mode for D4's cap-reached error message (#1124): an accepted issue
    that has no active vBRIEF is one of two things, both of which the
    operator should see:

    * the operator accepted but never authored an active vBRIEF (the
      ingest never landed), OR
    * the vBRIEF lifecycle moved (completed / cancelled) without the
      audit log being reset back to a terminal state.
    """
    if not isinstance(entry, dict):
        return False
    if entry.get("decision") != "accept":
        return False
    n = entry.get("issue_number")
    if not isinstance(n, int):
        return False
    return n not in active_referenced


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------


def _truncate(text: str, width: int) -> str:
    if width <= 1 or len(text) <= width:
        return text
    return text[: width - 1] + "..."


def render_queue(
    items: Iterable[QueueItem],
    *,
    repo: str,
    limit: int | None = None,
    ranking_labels: tuple[str, ...] = (),
) -> str:
    """Pretty-print the ranked queue.

    Header line names the repo + (when applicable) the consumer ranking
    labels in declared order so an operator reading the output can tell
    at a glance whether the framework default or consumer config is in
    force.
    """
    rows = list(items)
    lines: list[str] = []
    lines.append(f"triage:queue -- {repo}")
    if ranking_labels:
        lines.append("  consumer ranking labels (in declared order): " + ", ".join(ranking_labels))
    else:
        lines.append(
            "  consumer ranking labels: <empty> (framework default; within-group = updated_at desc)"
        )
    if limit is not None:
        lines.append(f"  limit: {limit}")
    lines.append("")
    if not rows:
        lines.append("  (no cached issues -- run `task triage:bootstrap` first)")
        return "\n".join(lines)
    for item in rows:
        marker = GROUP_DISPLAY.get(item.group, f"[{item.group}] ")
        label_hint = ""
        if item.matched_label:
            label_hint = f" (label: {item.matched_label})"
        title = _truncate(item.title, 72)
        lines.append(f"  {marker}#{item.number}  {title}  -- updated {item.updated_at}{label_hint}")
    return "\n".join(lines)


def render_show(
    issue: dict[str, Any] | None,
    *,
    repo: str,
    number: int,
    latest_decision: dict[str, Any] | None,
    history: list[dict[str, Any]],
    in_active_vbrief: bool,
) -> str:
    """Pretty-print one issue + its triage state."""
    lines: list[str] = []
    lines.append(f"triage:show -- {repo}#{number}")
    if issue is None:
        lines.append("")
        lines.append("  (issue not present in local cache)")
        lines.append("  Run `task triage:bootstrap` to populate, or check the repo slug.")
        return "\n".join(lines)
    title = issue.get("title", "")
    state = issue.get("state", "open")
    labels = issue.get("labels", []) or []
    updated_at = issue.get("updated_at", "")
    lines.append(f"  title:      {title}")
    lines.append(f"  state:      {state}")
    lines.append(f"  labels:     {', '.join(labels) if labels else '<none>'}")
    lines.append(f"  updated_at: {updated_at}")
    lines.append("")
    lines.append(f"  active vBRIEF reference: {'yes' if in_active_vbrief else 'no'}")
    if latest_decision:
        lines.append(
            "  latest decision: "
            f"{latest_decision.get('decision')} "
            f"at {latest_decision.get('timestamp')} "
            f"by {latest_decision.get('actor')}"
        )
        reason = latest_decision.get("reason")
        if reason:
            lines.append(f"    reason: {reason}")
    else:
        lines.append("  latest decision: <none -- untriaged>")
    if history:
        lines.append("")
        lines.append(f"  history ({len(history)} entries, oldest first):")
        for entry in history:
            lines.append(
                f"    - {entry.get('timestamp')} "
                f"{entry.get('decision'):<14} "
                f"by {entry.get('actor')}"
            )
    return "\n".join(lines)


def render_audit_plain(
    entries: list[dict[str, Any]],
    *,
    repo: str | None,
    vbrief_staleness: bool,
) -> str:
    """Plain-text audit-log dump consumed by humans."""
    lines: list[str] = []
    header = "triage:audit"
    if repo:
        header += f" -- {repo}"
    if vbrief_staleness:
        header += "  [--vbrief-staleness: accepted issues without active vBRIEF]"
    lines.append(header)
    lines.append("")
    if not entries:
        lines.append("  (no matching audit entries)")
        return "\n".join(lines)
    for entry in entries:
        lines.append(
            f"  {entry.get('timestamp')}  "
            f"{(entry.get('decision') or '?'): <14} "
            f"#{entry.get('issue_number')}  "
            f"by {entry.get('actor', '?')}"
        )
        reason = entry.get("reason")
        if reason:
            lines.append(f"      reason: {reason}")
    return "\n".join(lines)


def render_audit_json(
    entries: list[dict[str, Any]],
    *,
    repo: str | None,
    vbrief_staleness: bool,
    generated_at: datetime | None = None,
) -> str:
    """Stable-schema JSON audit dump consumed by D2 (#1122) / D4 (#1124).

    The schema is the dict::

        {
          "generated_at": "<ISO-8601 UTC, Z-suffixed>",
          "repo": "<owner/name>" | null,
          "vbrief_staleness": <bool>,
          "entry_count": <int>,
          "entries": [
            {... candidates_log entry passthrough ...},
            ...
          ]
        }

    The ``entries`` array is verbatim ``candidates_log`` records; we do
    not reshape them so downstream consumers can rely on
    ``vbrief/schemas/candidates.schema.json`` as the per-row contract.
    """
    payload = {
        "generated_at": _utc_iso(generated_at),
        "repo": repo,
        "vbrief_staleness": bool(vbrief_staleness),
        "entry_count": len(entries),
        "entries": list(entries),
    }
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------------------
# Active-vBRIEF reference set
# ---------------------------------------------------------------------------


def _active_referenced_issue_numbers(project_root: Path | None) -> set[int]:
    """Return issue numbers referenced by any ``vbrief/active/*.vbrief.json``.

    Delegates to ``triage_scope.extract_referenced_issues`` when the
    upstream D12 module is importable (the canonical reader); falls back
    to a small inline reader so this module remains usable on checkouts
    that have not yet rebased onto D12 (#1131).
    """
    if triage_scope is not None and hasattr(triage_scope, "extract_referenced_issues"):
        refs = triage_scope.extract_referenced_issues(project_root)
        active = refs.get("active") if isinstance(refs, dict) else None
        if isinstance(active, set):
            return set(active)
    root = (project_root or Path.cwd()) / "vbrief" / "active"
    if not root.is_dir():
        return set()
    out: set[int] = set()
    for path in root.glob("*.vbrief.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        plan = data.get("plan") if isinstance(data, dict) else None
        if not isinstance(plan, dict):
            continue
        out |= _issue_numbers_from_plan(plan)
    return out


# ---------------------------------------------------------------------------
# CLI entry point. Argparse + subcommand dispatch live in
# ``scripts/_triage_queue_cli.py`` so this module stays under the
# 1000-line MUST cap documented in ``coding/coding.md``.
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Delegates to :mod:`_triage_queue_cli`."""
    import sys as _sys

    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_queue", argv)
    if rc is not None:
        return rc

    from _triage_queue_cli import run_cli  # local import: 1000-line cap

    return run_cli(argv, _sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
