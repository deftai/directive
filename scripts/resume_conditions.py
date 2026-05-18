"""resume_conditions.py -- defer ``--resume-on`` grammar + evaluator (#1123 / D3 of #1119).

Public surface
--------------

* :func:`parse` -- structurally validate a resume-condition expression and
  return an :class:`Expression` AST. Raises :class:`ResumeGrammarError`
  with a human-readable message on the first malformed atom / composition.
* :func:`evaluate` -- evaluate a parsed AST against a :class:`ResumeContext`
  snapshot and return a bool.
* :func:`build_context` -- derive a :class:`ResumeContext` from the
  framework's on-disk state (unified ``.deft-cache/github-issue/`` cache
  for closed/merged refs, ``vbrief/pending/`` for the count, ``today`` for
  the date comparison). Pure-stdlib; no live ``gh`` calls.
* :func:`evaluate_resume_eligibility` -- the orchestration entry point
  consumed by ``task triage:audit --evaluate-resume`` and
  ``task triage:refresh-active``. Walks the audit log, identifies open
  ``defer`` entries with a non-null ``resume_on``, evaluates each against
  the provided context, and APPENDS a new ``resume-eligible`` audit entry
  (with ``prior_decision_id`` pointing at the original ``defer``) for
  each condition that fires. Idempotent: re-running the evaluation does
  NOT duplicate ``resume-eligible`` entries.

Grammar (minimal viable v1, per issue #1123)
-------------------------------------------

Atomic conditions::

    ref:closed:#N                  -- fires when issue/PR N is closed in the cache
    ref:merged:#N                  -- fires when PR N is merged in the cache
    date:>=YYYY-MM-DD              -- fires when current date is at or past target
    pending-count:>=N              -- fires when len(vbrief/pending/) >= N
    pending-count:<=N              -- fires when len(vbrief/pending/) <= N
    slice-wave-ready:<slice_id>:<wave>
                                   -- fires when every child of <slice_id>
                                      in an earlier wave is closed (#1132 /
                                      D13). ``<slice_id>`` is a UUID; ``<wave>``
                                      is a positive int. Sourced from
                                      vbrief/.eval/slices.jsonl.

Top-level composition (no nested parens / NOT in v1)::

    <atomic> AND <atomic>   -- fires when both atomics fire
    <atomic> OR  <atomic>   -- fires when either atomic fires

Anything else is a grammar error and rejected at write time by
:func:`scripts.triage_actions.defer` and at evaluation time by
:func:`parse`. Whitespace around ``AND`` / ``OR`` is required; the
parser does not collapse arbitrary spacing into the operator token.

Design notes
------------

* The framework MUST NOT auto-un-defer. ``resume-eligible`` is a marker
  that surfaces the item at the top of D11's ``[RESUME]`` group; the
  operator still decides whether to re-triage with current data.
* Closed / merged signals come from the existing unified-cache
  ``state`` field (``"open" | "closed"``). The cache writer is owned
  by ``scripts/cache.py`` (#883 Story 2); this module is read-only.
* ``ref:closed:#N`` fires for BOTH issues and PRs that have transitioned
  to ``closed``; ``ref:merged:#N`` is stricter and requires the cached
  payload to carry ``"merged": true`` (PRs only). A PR that is closed
  without merging fires ``ref:closed`` but NOT ``ref:merged``.
* Re-evaluation idempotency is enforced by scanning prior audit entries:
  if a ``resume-eligible`` row already exists for the defer's
  ``decision_id``, no new row is appended. A subsequent ``reset`` /
  re-defer wipes the marker and allows the next evaluation pass to
  surface the item again.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, cast

# Make sibling scripts importable when invoked as ``python scripts/resume_conditions.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Optional dependency: ``candidates_log`` is the canonical append-only
# audit-log writer (#845 Story 2). Guarded so this module imports cleanly
# on a checkout that has not yet rebased onto Story 2 (tests substitute a
# fake via ``monkeypatch.setattr``).
try:  # pragma: no cover -- exercised once #845 Story 2 lands.
    import candidates_log  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    candidates_log = None  # type: ignore[assignment]

# Optional dependency: ``slice_record`` is the slicing-cohort writer
# introduced alongside this grammar extension (#1132 / D13). The
# ``slice-wave-ready:<slice_id>:<wave>`` atomic reads slices.jsonl via
# this module. Guarded so the grammar still loads on pre-D13 checkouts.
try:  # pragma: no cover -- exercised once #1132 lands.
    import slice_record  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    slice_record = None  # type: ignore[assignment]

LOG = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Audit-log decision tag emitted when a resume condition fires. Mirrors
#: the addition to ``vbrief/schemas/candidates.schema.json``'s ``decision``
#: enum (the schema and this constant MUST stay in lockstep).
RESUME_ELIGIBLE_DECISION: str = "resume-eligible"

#: Audit-log actor tag for evaluator-driven appends.
EVALUATOR_ACTOR: str = "agent:resume-evaluator"

#: Filesystem-relative location of the unified content cache root.
CACHE_DIR_NAME: str = ".deft-cache"

#: Cache source layer the resume evaluator reads.
CACHE_SOURCE_GITHUB_ISSUE: str = "github-issue"

#: vBRIEF lifecycle folder counted by ``pending-count:`` atoms. Mirrors
#: the D4 (#1124) cap target; D3 uses ``pending/`` ONLY (NOT ``active/``)
#: because the issue body's example
#: ``ref:closed:#1121 AND pending-count:>=18`` describes the operator's
#: "should I revisit this defer now that pending has accumulated?" intent,
#: which is about the proposed-but-not-yet-active backlog.
PENDING_LIFECYCLE_DIR: str = "pending"


class ResumeGrammarError(ValueError):
    """Raised when a resume-condition expression fails to parse."""


# ---------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Atomic:
    """One atomic resume condition.

    ``kind`` is one of:

    * ``"ref-closed"`` -- ``value`` is the int issue / PR number.
    * ``"ref-merged"`` -- ``value`` is the int PR number.
    * ``"date-ge"``    -- ``value`` is a :class:`datetime.date`.
    * ``"pending-count-ge"`` -- ``value`` is the int threshold.
    * ``"pending-count-le"`` -- ``value`` is the int threshold.
    * ``"slice-wave-ready"`` -- ``value`` is the int wave threshold;
      :attr:`slice_id` carries the cohort identifier (#1132 / D13).

    The dataclass is intentionally simple -- the renderer round-trips
    via :attr:`raw` so the original operator-supplied text is preserved
    in error messages and audit-log debugging.
    """

    kind: str
    value: int | date
    raw: str
    #: Slice identifier carried by ``slice-wave-ready`` atoms (#1132). UUID
    #: string; empty for every other atomic kind.
    slice_id: str = ""


@dataclass(frozen=True)
class Expression:
    """Top-level resume-condition expression.

    ``op`` is one of ``"ATOM" | "AND" | "OR"``. For ``"ATOM"``, ``left``
    holds the only atomic and ``right`` is ``None``. For ``"AND"`` /
    ``"OR"``, both ``left`` and ``right`` are :class:`Atomic` instances
    (nesting is intentionally not supported in v1 per the issue body).
    """

    op: str
    left: Atomic
    right: Atomic | None = None
    raw: str = ""


@dataclass(frozen=True)
class ResumeContext:
    """Snapshot of on-disk state the evaluator compares atomic conditions against.

    Attributes:
        today: Current calendar date in UTC. Compared against
            ``date:>=YYYY-MM-DD`` atoms.
        closed_refs: Set of issue / PR numbers whose cached ``state``
            is ``"closed"``.
        merged_refs: Set of PR numbers whose cached payload carries
            ``"merged": true``. A closed-without-merge PR is in
            ``closed_refs`` but NOT in ``merged_refs``.
        pending_count: Number of ``*.vbrief.json`` files in
            ``vbrief/pending/``.
        slices: Cohort records from ``vbrief/.eval/slices.jsonl`` (#1132 /
            D13). Consulted by ``slice-wave-ready:<slice_id>:<wave>``
            atoms; empty tuple for back-compat with pre-D13 callers.
    """

    today: date
    closed_refs: frozenset[int] = field(default_factory=frozenset)
    merged_refs: frozenset[int] = field(default_factory=frozenset)
    pending_count: int = 0
    slices: tuple[dict[str, Any], ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

_REF_CLOSED_RE = re.compile(r"^ref:closed:#(\d+)$")
_REF_MERGED_RE = re.compile(r"^ref:merged:#(\d+)$")
_DATE_GE_RE = re.compile(r"^date:>=(\d{4}-\d{2}-\d{2})$")
_PENDING_GE_RE = re.compile(r"^pending-count:>=(\d+)$")
_PENDING_LE_RE = re.compile(r"^pending-count:<=(\d+)$")
# slice-wave-ready:<uuid>:<wave>. UUID regex matches any RFC 4122 variant
# (any version). Wave is a positive int.
_SLICE_WAVE_READY_RE = re.compile(
    r"^slice-wave-ready:"
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    r":(\d+)$"
)

# AND / OR splitter -- whitespace-required so a value like "ANDREW" in a
# free-text field could never be misparsed as a composition operator. The
# split is non-greedy on the first occurrence; nested forms (more than one
# operator at the top level) are rejected explicitly by :func:`parse`.
_COMPOSITION_RE = re.compile(r"\s+(AND|OR)\s+")


def _parse_atomic(raw: str) -> Atomic:
    """Parse a single atomic-condition string. Raises :class:`ResumeGrammarError`."""
    text = raw.strip()
    if not text:
        raise ResumeGrammarError("empty atomic condition")

    if (m := _REF_CLOSED_RE.match(text)) is not None:
        return Atomic(kind="ref-closed", value=int(m.group(1)), raw=text)
    if (m := _REF_MERGED_RE.match(text)) is not None:
        return Atomic(kind="ref-merged", value=int(m.group(1)), raw=text)
    if (m := _DATE_GE_RE.match(text)) is not None:
        try:
            parsed = date.fromisoformat(m.group(1))
        except ValueError as exc:
            raise ResumeGrammarError(
                f"invalid date in {text!r}: {exc}"
            ) from exc
        return Atomic(kind="date-ge", value=parsed, raw=text)
    if (m := _PENDING_GE_RE.match(text)) is not None:
        return Atomic(kind="pending-count-ge", value=int(m.group(1)), raw=text)
    if (m := _PENDING_LE_RE.match(text)) is not None:
        return Atomic(kind="pending-count-le", value=int(m.group(1)), raw=text)
    if (m := _SLICE_WAVE_READY_RE.match(text)) is not None:
        wave = int(m.group(2))
        if wave < 1:
            raise ResumeGrammarError(
                f"slice-wave-ready wave must be a positive int, got {wave}"
            )
        return Atomic(
            kind="slice-wave-ready",
            value=wave,
            raw=text,
            slice_id=m.group(1).lower(),
        )

    raise ResumeGrammarError(
        f"unrecognised atomic condition {text!r}; "
        "expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, "
        "pending-count:>=N, pending-count:<=N, "
        "slice-wave-ready:<slice_id>:<wave>"
    )


def parse(expr: str) -> Expression:
    """Parse ``expr`` and return an :class:`Expression` AST.

    Composition rules (v1):

    * Whitespace-surrounded ``AND`` or ``OR`` joins exactly two atomics.
    * Mixing operators (``A AND B OR C``) is rejected -- v1 does not
      define operator precedence; the operator MUST be uniform.
    * More than one operator at the top level (``A AND B AND C``) is
      rejected -- nested / multi-arity composition is deferred to v2.

    Raises:
        ResumeGrammarError: with an actionable message on any violation.
    """
    if not isinstance(expr, str):
        raise ResumeGrammarError(
            f"resume_on must be a string, got {type(expr).__name__}"
        )
    text = expr.strip()
    if not text:
        raise ResumeGrammarError("resume_on must be a non-empty string")

    parts = _COMPOSITION_RE.split(text)
    if len(parts) == 1:
        atom = _parse_atomic(parts[0])
        return Expression(op="ATOM", left=atom, right=None, raw=text)
    if len(parts) == 3:
        left_raw, op, right_raw = parts
        if op not in {"AND", "OR"}:  # pragma: no cover -- regex guards this
            raise ResumeGrammarError(
                f"unknown composition operator {op!r}; expected AND or OR"
            )
        left = _parse_atomic(left_raw)
        right = _parse_atomic(right_raw)
        return Expression(op=op, left=left, right=right, raw=text)
    # 5+ parts means at least two operators (regex split yields
    # ``[lhs, op, mid, op, rhs, ...]``). v1 forbids this.
    raise ResumeGrammarError(
        f"resume_on supports a single top-level AND/OR in v1; got {text!r}"
    )


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


def _eval_atomic(atom: Atomic, ctx: ResumeContext) -> bool:
    # ``atom.value`` is typed as ``int | date`` to accommodate both shapes the
    # parser produces; each branch below knows the actual concrete type from
    # the ``kind`` discriminator and casts via ``cast`` so the static type
    # checker can see the narrowing.
    if atom.kind == "ref-closed":
        return cast(int, atom.value) in ctx.closed_refs
    if atom.kind == "ref-merged":
        return cast(int, atom.value) in ctx.merged_refs
    if atom.kind == "date-ge":
        return ctx.today >= cast(date, atom.value)
    if atom.kind == "pending-count-ge":
        return ctx.pending_count >= cast(int, atom.value)
    if atom.kind == "pending-count-le":
        return ctx.pending_count <= cast(int, atom.value)
    if atom.kind == "slice-wave-ready":
        wave = cast(int, atom.value)
        return _slice_wave_ready(ctx, atom.slice_id, wave)
    # Unreachable: parse() rejects unknown kinds. Defensive: a future
    # additive atomic that lands without an evaluator branch should be a
    # loud failure, not a silent ``False``.
    raise ResumeGrammarError(  # pragma: no cover -- defensive
        f"evaluator missing branch for atomic kind {atom.kind!r}"
    )


def _slice_wave_ready(ctx: ResumeContext, slice_id: str, wave: int) -> bool:
    """Return True when every child of ``slice_id`` in an earlier wave is closed.

    Semantics (per #1132 issue body):

    * Looks up the slice record by ``slice_id`` in ``ctx.slices``.
    * Considers only children whose ``wave`` is < ``wave``.
    * Fires when EVERY earlier-wave child's number is in
      ``ctx.closed_refs``.
    * If the slice record is absent, or there are no earlier-wave
      children (e.g. ``wave == 1``, which has no Wave-0 to gate on),
      the atomic does NOT fire -- the resume condition is meaningless
      and should be revised by the operator rather than silently
      passing.
    """
    sid_norm = slice_id.lower()
    record: dict[str, Any] | None = None
    for entry in ctx.slices:
        if not isinstance(entry, dict):
            continue
        candidate = entry.get("slice_id")
        if isinstance(candidate, str) and candidate.lower() == sid_norm:
            record = entry
            break
    if record is None:
        return False
    children = record.get("children")
    if not isinstance(children, list):
        return False
    earlier: list[int] = []
    for child in children:
        if not isinstance(child, dict):
            continue
        cwave = child.get("wave")
        cn = child.get("n")
        if not isinstance(cwave, int) or not isinstance(cn, int):
            continue
        if cwave < wave:
            earlier.append(cn)
    if not earlier:
        return False
    return all(n in ctx.closed_refs for n in earlier)


def evaluate(expr: Expression, ctx: ResumeContext) -> bool:
    """Evaluate ``expr`` against ``ctx`` and return whether the condition fires."""
    if expr.op == "ATOM":
        return _eval_atomic(expr.left, ctx)
    if expr.op == "AND":
        if expr.right is None:  # pragma: no cover -- parse guards
            raise ResumeGrammarError("AND expression missing right-hand atom")
        return _eval_atomic(expr.left, ctx) and _eval_atomic(expr.right, ctx)
    if expr.op == "OR":
        if expr.right is None:  # pragma: no cover -- parse guards
            raise ResumeGrammarError("OR expression missing right-hand atom")
        return _eval_atomic(expr.left, ctx) or _eval_atomic(expr.right, ctx)
    raise ResumeGrammarError(  # pragma: no cover -- defensive
        f"unknown composition op {expr.op!r}"
    )


# ---------------------------------------------------------------------------
# Context builder
# ---------------------------------------------------------------------------


def _count_pending(project_root: Path) -> int:
    folder = project_root / "vbrief" / PENDING_LIFECYCLE_DIR
    if not folder.is_dir():
        return 0
    return sum(
        1
        for child in folder.iterdir()
        if child.is_file() and child.name.endswith(".vbrief.json")
    )


def _iter_cached_payloads(
    project_root: Path,
    *,
    cache_root: Path | None = None,
    repo: str | None = None,
) -> Iterable[tuple[str, int, dict[str, Any]]]:
    """Yield ``(repo, number, payload)`` for every cached issue/PR.

    Walks ``<cache>/github-issue/<owner>/<repo>/<N>/raw.json``. The
    ``repo`` filter is optional; when set, restricts to a single
    ``owner/name`` slug (used by tests + the CLI when --repo is passed).
    """
    base = (cache_root or (project_root / CACHE_DIR_NAME)) / CACHE_SOURCE_GITHUB_ISSUE
    if not base.is_dir():
        return
    target_owner: str | None = None
    target_name: str | None = None
    if repo and "/" in repo:
        target_owner, target_name = repo.split("/", 1)
    for owner_dir in base.iterdir():
        if not owner_dir.is_dir():
            continue
        if target_owner is not None and owner_dir.name != target_owner:
            continue
        for repo_dir in owner_dir.iterdir():
            if not repo_dir.is_dir():
                continue
            if target_name is not None and repo_dir.name != target_name:
                continue
            slug = f"{owner_dir.name}/{repo_dir.name}"
            for issue_dir in repo_dir.iterdir():
                if not issue_dir.is_dir() or not issue_dir.name.isdecimal():
                    continue
                raw_path = issue_dir / "raw.json"
                if not raw_path.is_file():
                    continue
                try:
                    payload = json.loads(raw_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(payload, dict):
                    continue
                try:
                    n = int(issue_dir.name)
                except ValueError:
                    continue
                yield slug, n, payload


def build_context(
    project_root: Path,
    *,
    cache_root: Path | None = None,
    today: date | None = None,
    repo: str | None = None,
    slices_log_path: Path | None = None,
) -> ResumeContext:
    """Derive a :class:`ResumeContext` from on-disk state.

    Pure-stdlib reader -- no live ``gh`` calls. ``today`` defaults to the
    UTC calendar date (so a midnight-boundary cron run on a UTC host
    evaluates ``date:>=`` consistently). ``slices_log_path`` overrides
    the default ``vbrief/.eval/slices.jsonl`` location for tests; the
    canonical path is used otherwise. When :mod:`slice_record` is not
    importable (pre-D13 slim checkout) the slices tuple is empty and
    ``slice-wave-ready`` atoms cannot fire.
    """
    today_resolved = today or datetime.now(UTC).date()
    closed: set[int] = set()
    merged: set[int] = set()
    for _slug, n, payload in _iter_cached_payloads(
        project_root, cache_root=cache_root, repo=repo
    ):
        state = payload.get("state")
        if isinstance(state, str) and state.lower() == "closed":
            closed.add(n)
        # ``merged`` is a PR-only field; ``"mergedAt"`` is the canonical
        # marker emitted by ``gh pr view --json``, but plain GitHub REST
        # uses ``"merged": true``. Accept both so the evaluator works
        # against either cache writer.
        if payload.get("merged") is True or payload.get("mergedAt"):
            merged.add(n)
    slices: tuple[dict[str, Any], ...] = ()
    if slice_record is not None:
        try:
            records = slice_record.read_all(path=slices_log_path)
        except Exception as exc:  # noqa: BLE001 -- best-effort; pre-D13 fallback
            LOG.warning("slice_record.read_all failed: %s", exc)
            records = []
        slices = tuple(r for r in records if isinstance(r, dict))
    return ResumeContext(
        today=today_resolved,
        closed_refs=frozenset(closed),
        merged_refs=frozenset(merged),
        pending_count=_count_pending(project_root),
        slices=slices,
    )


# ---------------------------------------------------------------------------
# Evaluator orchestration -- the audit-log writer
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _open_defer_entries(
    entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return the open ``defer`` entries -- those not yet superseded.

    An entry is "open" when:

    * It is a ``defer`` decision with a non-null ``resume_on`` field, AND
    * No later (timestamp >) entry for the same ``(repo, issue_number)``
      has ``decision`` in ``{accept, reject, mark-duplicate, reset,
      resume-eligible}``.

    The ``resume-eligible`` self-supersession is what guarantees
    idempotency: once we've emitted a ``resume-eligible`` row for a
    defer, the defer is no longer "open" from this function's
    perspective and a re-evaluation skips it.
    """
    # Group by (repo, issue_number) so we can pick the latest entry per
    # issue and decide supersession.
    by_issue: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        repo = entry.get("repo")
        number = entry.get("issue_number")
        if not isinstance(repo, str) or not isinstance(number, int):
            continue
        by_issue.setdefault((repo, number), []).append(entry)

    superseding = {"accept", "reject", "mark-duplicate", "reset", RESUME_ELIGIBLE_DECISION}
    open_defers: list[dict[str, Any]] = []
    for rows in by_issue.values():
        # Sort by timestamp ascending so the last entry is most recent.
        rows.sort(key=lambda r: str(r.get("timestamp", "")))
        target_defer: dict[str, Any] | None = None
        superseded = False
        for row in rows:
            decision = row.get("decision")
            if decision == "defer":
                target_defer = row
                superseded = False
            elif decision in superseding and target_defer is not None:
                # Same-issue successor wipes the open-defer candidacy.
                # ``reset`` re-opens to untriaged (handled by the
                # decision != "defer" branch -- target_defer stays None
                # until a new defer lands).
                superseded = True
                target_defer = None
        if target_defer is None or superseded:
            continue
        if not target_defer.get("resume_on"):
            continue
        open_defers.append(target_defer)
    return open_defers


def evaluate_resume_eligibility(
    project_root: Path,
    *,
    cache_root: Path | None = None,
    audit_log_path: Path | None = None,
    today: date | None = None,
    repo: str | None = None,
    log_module: Any | None = None,
    new_id: Any | None = None,
    now_iso: Any | None = None,
) -> list[dict[str, Any]]:
    """Evaluate every open defer with ``resume_on`` and append firings.

    Returns the list of newly-appended ``resume-eligible`` entries (may
    be empty). Skipping conditions:

    * No ``resume_on`` field on the defer -- pre-D3 entries pass through.
    * Condition does not fire against the current :class:`ResumeContext`.
    * A ``resume-eligible`` entry already exists referencing the defer's
      ``decision_id`` -- the marker is idempotent.

    The ``log_module`` / ``new_id`` / ``now_iso`` hooks let tests inject
    fakes without monkeypatching module-level state. Production callers
    leave them as ``None`` so the canonical ``candidates_log.append``
    seam is used.
    """
    log = log_module if log_module is not None else candidates_log
    if log is None:
        # No audit-log writer available -- nothing to do. Production
        # bootstrap lands the writer; this branch is for slim test
        # checkouts (mirrors the pattern in scripts/triage_actions.py).
        return []
    new_decision_id = new_id or getattr(log, "new_decision_id", None)
    if not callable(new_decision_id):  # pragma: no cover -- defensive
        import uuid as _uuid

        new_decision_id = lambda: str(_uuid.uuid4())  # noqa: E731
    timestamp_fn = now_iso or _now_iso

    entries = list(log.read_all(repo=repo, path=audit_log_path))
    open_defers = _open_defer_entries(entries)
    if not open_defers:
        return []

    ctx = build_context(
        project_root, cache_root=cache_root, today=today, repo=repo
    )

    appended: list[dict[str, Any]] = []
    for defer_entry in open_defers:
        expression_text = defer_entry.get("resume_on")
        if not isinstance(expression_text, str):
            continue
        try:
            ast = parse(expression_text)
        except ResumeGrammarError as exc:
            LOG.warning(
                "skipping defer #%s (%s): malformed resume_on %r (%s)",
                defer_entry.get("issue_number"),
                defer_entry.get("repo"),
                expression_text,
                exc,
            )
            continue
        if not evaluate(ast, ctx):
            continue
        new_entry: dict[str, Any] = {
            "decision_id": str(new_decision_id()),
            "timestamp": timestamp_fn(),
            "repo": str(defer_entry["repo"]),
            "issue_number": int(defer_entry["issue_number"]),
            "decision": RESUME_ELIGIBLE_DECISION,
            "actor": EVALUATOR_ACTOR,
            "prior_decision_id": str(defer_entry["decision_id"]),
            "reason": f"resume_on fired: {expression_text}",
        }
        try:
            log.append(new_entry, path=audit_log_path) if audit_log_path else log.append(new_entry)
        except TypeError:
            # Older test fakes accept (entry) only -- fall back without path kw.
            log.append(new_entry)
        except Exception as exc:  # noqa: BLE001 -- best-effort; surface failure
            LOG.warning(
                "candidates_log.append failed for defer #%s: %s",
                defer_entry.get("issue_number"),
                exc,
            )
            continue
        appended.append(new_entry)
    return appended


# ---------------------------------------------------------------------------
# Best-effort UTF-8 stdout (CLI consumers print expressions verbatim)
# ---------------------------------------------------------------------------

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):  # pragma: no cover -- env hook
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


__all__ = [
    "Atomic",
    "EVALUATOR_ACTOR",
    "Expression",
    "RESUME_ELIGIBLE_DECISION",
    "ResumeContext",
    "ResumeGrammarError",
    "build_context",
    "evaluate",
    "evaluate_resume_eligibility",
    "parse",
]
