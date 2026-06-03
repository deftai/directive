#!/usr/bin/env python3
"""triage_summary.py -- D2 (#1122) ``task triage:summary`` one-liner.

Status surface for the session-start ritual (N9 / #1149). Reads the
existing unified ``.deft-cache/github-issue/<owner>/<repo>/`` cache
layout (`#883 Story 2`) and the operator-private ``candidates.jsonl``
audit log (`#845 Story 2`), derives four counts (untriaged, stale-defer,
in-flight, WIP-vs-cap), and prints ONE bounded (<=120 char) line in the
documented format. D14 (#1133) adds an optional ``[scope-drift] N``
segment when subscription drift is detected against the active
``plan.policy.triageScope[]``; suppressed at zero.

    [triage] 12 untriaged ┬╖ 5 stale-defer (resume condition met) ┬╖ 8 in-flight ┬╖ WIP 12/12 ΓÜá

Behaviour contract (issue body of #1122):

- Always exits 0 -- this is a status surface, not a gate. Gates live in
  D5 (#1127, ``task verify:cache-fresh``) and D4 (#1124, WIP cap).
- ``[triage] cache empty -- run task triage:bootstrap`` is emitted
  instead of zeros when the cache directory is missing/empty, so a fresh
  consumer install is unambiguous.
- Threshold-aware: the WIP warning glyph (`⚠`) only appears at-or-above
  the cap; the ``stale-defer (resume condition met)`` field only appears
  when at least one resume condition has fired (>=1 -- D3 / #1123 will
  ship the resume conditions; until then the count is always 0 and the
  field is suppressed).
- Truncates gracefully at 120 chars (last-field-first; never emits a
  multi-line summary).

Every emission appends a JSONL record to
``vbrief/.eval/summary-history.jsonl`` (gitignored per N4 / #1144). The
record carries ``{schema, emitted_at, line, ...computed_fields}`` so
future operators can replay drift offline without re-reading the cache.

D11 follow-up (#1128): once ``task triage:audit --format=json`` ships,
``compute_summary`` will switch to consuming that surface verbatim. The
v1 reader is hand-rolled (walk the cache + read candidates.jsonl) per
the issue body's "v1 ships hand-rolled, D11 wrap-up is a follow-up"
explicit non-blocker note.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked as ``python scripts/triage_summary.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the one-liner emits middle-dot (·) and the
# warning glyph (⚠), which cp1252 (the Windows default stdout codepage)
# cannot encode. Mirrors the pattern in triage_scope.py / cache.py.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Public constants -- documented invariants for downstream consumers.
# ---------------------------------------------------------------------------

#: Maximum width of the one-liner, including the leading ``[triage]``
#: tag. Issue #1122 freezes this at 120; truncation below this cap is
#: graceful (last-field-first) rather than multi-line.
MAX_LINE_CHARS: int = 120

# Default ``plan.policy.wipCap`` fallback when the typed field is
# absent / missing / non-int. **Imported** from ``scripts.policy``
# (#1124 / D4) -- the single source of truth so D2 and D4 cannot
# drift again. The shared constant resolves to ``10`` per umbrella
# #1119 Current Shape v3 (comment 4471269010); the value used to
# duplicate-literal at 12 here, matching the now-superseded D4
# issue-body default. Re-exported as a module attribute so existing
# callers / tests that reference ``triage_summary.DEFAULT_WIP_CAP``
# keep working without import-site churn.
from policy import DEFAULT_WIP_CAP as _POLICY_DEFAULT_WIP_CAP  # noqa: E402

#: Re-exported alias of :data:`scripts.policy.DEFAULT_WIP_CAP` (10
#: per umbrella #1119 Current Shape v3). Kept as a module-level name
#: for callers / tests that already import it from this module.
DEFAULT_WIP_CAP: int = _POLICY_DEFAULT_WIP_CAP

#: Filesystem-relative location of the PROJECT-DEFINITION vBRIEF
#: (mirrors ``scripts/policy.py`` / ``scripts/triage_scope.py``).
PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"

#: Cache root + source under it that triage v1 consumes. Mirrors the
#: layout walker in ``scripts/triage_bulk.py``.
CACHE_DIR_NAME: str = ".deft-cache"
CACHE_SOURCE: str = "github-issue"

#: Append-only audit log written by ``scripts/candidates_log.py``.
CANDIDATES_LOG_REL_PATH: str = "vbrief/.eval/candidates.jsonl"

#: Append-only emission history written by *this* module. Operator-private
#: (gitignored via N4 / #1144); used for offline replay / drift dashboards.
SUMMARY_HISTORY_REL_PATH: str = "vbrief/.eval/summary-history.jsonl"

#: Schema marker on every summary-history JSONL record. Bumped if the
#: record shape ever changes so a downstream replay tool can refuse a
#: shape it does not understand instead of mis-rendering.
SUMMARY_HISTORY_SCHEMA: str = "deft.triage.summary.v1"

#: Canonical empty-cache prompt. Emitted verbatim when the cache root
#: is missing or contains no ``<source>/<owner>/<repo>/<N>/`` entries.
EMPTY_CACHE_LINE: str = "[triage] cache empty -- run task triage:bootstrap"

#: vBRIEF lifecycle folders that count toward the WIP set. Mirrors
#: D4 / #1124's `pending/ + active/` cap target.
WIP_LIFECYCLE_DIRS: tuple[str, ...] = ("pending", "active")

#: Lifecycle folder whose ``plan.status == "running"`` vBRIEFs are
#: counted as the *filesystem-truth* in-flight set (#1270). The active/
#: folder is the single source of truth for activated work; the
#: audit-log decision count (``IN_FLIGHT_DECISIONS``) below is retained
#: only for divergence detection vs. the cache-scoped view.
FILESYSTEM_IN_FLIGHT_FOLDER: str = "active"

#: ``plan.status`` value that classifies an active/ vBRIEF as in-flight
#: under the #1270 filesystem-truth contract. The activation verb
#: (``task vbrief:activate``) flips this field to ``running`` when it
#: moves a scope into ``vbrief/active/``; any other status (``done``,
#: ``cancelled``, ``blocked``) MUST NOT count toward the headline.
FILESYSTEM_IN_FLIGHT_STATUS: str = "running"

#: Glyph appended when the WIP count meets-or-exceeds the cap. Plain
#: U+26A0 (no variation selector) so the byte width matches the
#: 120-char contract on every renderer.
WIP_WARN_GLYPH: str = "\u26a0"

#: Audit-log decisions that classify a cached issue as ``in-flight``.
#: ``accept`` is the canonical signal: the issue has entered the swarm
#: pipeline but is not yet rejected / closed / duplicated.
IN_FLIGHT_DECISIONS: frozenset[str] = frozenset({"accept"})

#: Decisions that exclude the cached issue from the ``untriaged`` count
#: (the issue HAS been triaged). ``reset`` is INCLUDED in untriaged
#: because a reset returns the issue to the unclassified state by
#: design (`scripts/candidates_log.py::_VALID_DECISIONS`).
#: ``resume-eligible`` (#1123 / D3) is a triaged state too -- the
#: original defer's record still stands; the marker just routes the
#: item into the [RESUME] queue bucket for operator review.
TRIAGED_DECISIONS: frozenset[str] = frozenset(
    {
        "accept",
        "reject",
        "defer",
        "needs-ac",
        "mark-duplicate",
        "resume-eligible",
    }
)

#: Decisions that count toward the ``stale-defer (resume condition
#: met)`` field on the one-liner. D3 (#1123) emits ``resume-eligible``
#: whenever a prior ``defer``'s ``resume_on`` expression fires -- the
#: number of cached issues whose latest decision matches IS the count.
STALE_DEFER_DECISIONS: frozenset[str] = frozenset({"resume-eligible"})


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SummaryResult:
    """Structured triage summary -- the source of truth the one-liner renders.

    A ``cache_empty`` summary carries all-zero numeric fields by
    convention; renderers MUST treat the boolean as the discriminator
    (the all-zero shape on an empty cache MUST emit the empty-cache
    prompt, never zeros).

    ``scope_drift`` (D14 / #1133) is the distinct-issue count that
    would join the cache if every currently-detected unsubscribed
    label/milestone were opted into. Suppressed from the one-liner
    when zero; surfaced as ``[scope-drift] N`` when positive.

    ``in_flight`` (#1270) is the *filesystem-truth* count: live
    ``vbrief/active/*.vbrief.json`` files with ``plan.status ==
    "running"``. It mirrors :attr:`in_flight_filesystem` and is kept
    under the historical name so existing call-sites / history
    records / tests stay green.  :attr:`in_flight_cache_scoped` carries
    the legacy audit-log-derived count (cached issues whose latest
    decision is ``accept``) -- retained only so the renderer can
    detect divergence between the cache view and the filesystem and
    surface a ``[triage:scope]`` line. :attr:`triage_scope_configured`
    discriminates the two discrepancy-line variants -- ``True`` means
    the operator has set a non-empty ``plan.policy.triageScope[]``;
    ``False`` means the framework default (``[{"rule":"all-open"}]``)
    is in effect (or no PROJECT-DEFINITION exists).
    """

    cache_empty: bool
    untriaged: int
    stale_defer: int
    in_flight: int
    wip_count: int
    wip_cap: int
    #: Sample of cached repos -- used in observability records; capped
    #: at 8 entries so the JSONL line never blows past the
    #: ``vbrief/.eval/summary-history.jsonl`` rolling-tail tolerance.
    repos: tuple[str, ...] = field(default_factory=tuple)
    #: D14 / #1133: subscription-drift count (distinct open cached
    #: issues that would join the subscription if every surfaced
    #: label/milestone signal were opted into). Defaults to 0 for
    #: backward compatibility with pre-D14 callers / tests that
    #: construct :class:`SummaryResult` directly.
    scope_drift: int = 0
    #: #1270: filesystem-truth in-flight count (live
    #: ``vbrief/active/*.vbrief.json`` with ``plan.status == "running"``).
    #: Defaults to 0 so pre-#1270 :class:`SummaryResult` constructors
    #: in existing tests continue to work; production callers go
    #: through :func:`compute_summary` which always sets this.
    in_flight_filesystem: int = 0
    #: #1270: legacy audit-log-derived in-flight count (cached issues
    #: with latest decision ``accept``). Used only for divergence
    #: detection against :attr:`in_flight_filesystem`.
    in_flight_cache_scoped: int = 0
    #: #1270: True iff ``plan.policy.triageScope`` is a non-empty list
    #: of dict rules on PROJECT-DEFINITION (i.e. the consumer has
    #: opted past the framework ``all-open`` default). Discriminates
    #: the ``outside scope`` vs ``not configured`` discrepancy-line
    #: variant.
    triage_scope_configured: bool = False
    #: #1468: count of cached issues currently counted ``untriaged``
    #: (no audit decision at all) that have a matching
    #: ``proposed/`` / ``pending/`` / ``active/`` vBRIEF carrying an
    #: ``x-vbrief/github-issue`` reference -- i.e. the issues a
    #: ``task triage:reconcile`` run would heal. Suppressed from the
    #: one-liner; surfaced as a second-line ``[triage:reconcile] N``
    #: hint (mirrors the ``[triage:scope]`` divergence line). Defaults
    #: to 0 for pre-#1468 callers / tests that construct
    #: :class:`SummaryResult` directly.
    reconcilable: int = 0

    def to_record(self, *, emitted_at: str, line: str) -> dict[str, Any]:
        """Render as the ``summary-history.jsonl`` record shape."""
        return {
            "schema": SUMMARY_HISTORY_SCHEMA,
            "emitted_at": emitted_at,
            "line": line,
            "cache_empty": self.cache_empty,
            "untriaged": self.untriaged,
            "stale_defer": self.stale_defer,
            "in_flight": self.in_flight,
            "in_flight_filesystem": self.in_flight_filesystem,
            "in_flight_cache_scoped": self.in_flight_cache_scoped,
            "triage_scope_configured": self.triage_scope_configured,
            "wip_count": self.wip_count,
            "wip_cap": self.wip_cap,
            "repos": list(self.repos),
            "scope_drift": self.scope_drift,
            "reconcilable": self.reconcilable,
        }


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _utc_iso(dt: datetime | None = None) -> str:
    """ISO-8601 UTC with explicit ``Z`` suffix (`candidates.jsonl`-compatible)."""
    moment = (dt or datetime.now(UTC)).astimezone(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Filesystem walkers (pure-stdlib; no live gh / cache_get calls)
# ---------------------------------------------------------------------------


def _is_pos_int_dir(p: Path) -> bool:
    # ``isdecimal`` (not ``isdigit``) -- ``isdigit`` accepts the Unicode
    # ``Numeric_Type=Digit`` class which includes superscript digits
    # (``²`` / ``³``) and circled digits; ``int(name)`` raises
    # ``ValueError`` on those, breaking the walker. ``isdecimal`` is the
    # stricter ``Nd`` (Decimal_Number) match -- ASCII ``0-9`` plus other
    # genuine decimal-class digits whose ``int()`` round-trip is total.
    return p.is_dir() and p.name.isdecimal()


def iter_cached_issues(cache_root: Path) -> list[tuple[str, int]]:
    """Walk ``<cache_root>/github-issue/<owner>/<repo>/<N>/`` cache entries.

    Returns a list of ``(repo, issue_number)`` tuples where ``repo`` is
    the canonical ``owner/name`` shape. Order is deterministic
    (lexicographic by owner, repo, then numeric issue). Missing cache
    root returns ``[]`` -- callers MUST treat that as the empty-cache
    sentinel (the empty-cache prompt is owned by ``format_one_liner``).

    Hardened against stray non-numeric directories under ``<repo>/``
    (the unified cache writer never creates them but operators may
    sometimes drop ad-hoc artefacts during debugging -- skipping them
    keeps the count honest).
    """
    base = cache_root / CACHE_SOURCE
    if not base.is_dir():
        return []
    out: list[tuple[str, int]] = []
    for owner_dir in sorted(base.iterdir(), key=lambda p: p.name):
        if not owner_dir.is_dir():
            continue
        for repo_dir in sorted(owner_dir.iterdir(), key=lambda p: p.name):
            if not repo_dir.is_dir():
                continue
            repo = f"{owner_dir.name}/{repo_dir.name}"
            for issue_dir in sorted(
                (p for p in repo_dir.iterdir() if _is_pos_int_dir(p)),
                key=lambda p: int(p.name),
            ):
                with contextlib.suppress(ValueError):
                    out.append((repo, int(issue_dir.name)))
    return out


def read_audit_log(log_path: Path) -> list[dict[str, Any]]:
    """Return well-formed audit-log entries in insertion order.

    Tolerant reader: malformed JSON lines are skipped silently because
    the summary surface MUST NOT crash on a torn tail from a crashed
    appender (the same tolerance contract ``candidates_log.read_all``
    exposes). Missing log returns ``[]``.
    """
    if not log_path.is_file():
        return []
    out: list[dict[str, Any]] = []
    try:
        text = log_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def latest_decisions(entries: Iterable[Mapping[str, Any]]) -> dict[tuple[str, int], str]:
    """Collapse audit-log entries to ``{(repo, issue_number): decision}``.

    Sort key is the entry's ``timestamp`` field -- ISO-8601 UTC with the
    ``Z`` suffix sorts lexicographically in chronological order, so a
    string sort is correct for every compliant timestamp produced by
    ``candidates_log.append``. Entries missing ``repo`` /
    ``issue_number`` / ``decision`` are skipped (tolerance contract).
    """
    rows: list[tuple[str, str, int, str]] = []
    for entry in entries:
        repo = entry.get("repo")
        issue_number = entry.get("issue_number")
        decision = entry.get("decision")
        timestamp = entry.get("timestamp", "")
        if (
            not isinstance(repo, str)
            or not isinstance(issue_number, int)
            or isinstance(issue_number, bool)
            or not isinstance(decision, str)
            or not isinstance(timestamp, str)
        ):
            continue
        rows.append((timestamp, repo, issue_number, decision))
    rows.sort(key=lambda r: r[0])
    out: dict[tuple[str, int], str] = {}
    for _ts, repo, n, decision in rows:
        out[(repo, n)] = decision
    return out


# ---------------------------------------------------------------------------
# vBRIEF WIP counters + typed-cap reader
# ---------------------------------------------------------------------------


def count_vbrief_wip(project_root: Path) -> int:
    """Count vBRIEFs in ``vbrief/pending/`` + ``vbrief/active/``.

    Files are filtered by ``.vbrief.json`` suffix so non-vBRIEF
    artefacts dropped into the lifecycle folders by accident (README
    scratch, hand-authored notes) do not pollute the count. Missing
    folders contribute 0. Mirrors the D4 / #1124 cap target.
    """
    total = 0
    vbrief_root = project_root / "vbrief"
    for sub in WIP_LIFECYCLE_DIRS:
        folder = vbrief_root / sub
        if not folder.is_dir():
            continue
        total += sum(
            1
            for child in folder.iterdir()
            if child.is_file() and child.name.endswith(".vbrief.json")
        )
    return total


def count_filesystem_in_flight(project_root: Path) -> int:
    """Count *filesystem-truth* in-flight vBRIEFs (#1270).

    Walks ``vbrief/active/*.vbrief.json``, parses each, and counts
    those whose ``plan.status`` equals
    :data:`FILESYSTEM_IN_FLIGHT_STATUS` (``"running"``). Tolerant of:

    * Missing ``vbrief/active/`` folder -- contributes 0.
    * Malformed JSON files -- skipped (per the D2 "never crash the
      ritual" contract; mirrors :func:`read_audit_log`).
    * Files where ``plan`` / ``plan.status`` is absent or a non-string
      -- counted as NOT running (excluded from the total).
    * Non-``.vbrief.json`` files in the folder -- ignored (same
      sidecar-tolerance as :func:`count_vbrief_wip`).

    This is the new primary source of truth for the ritual's
    ``in-flight`` headline. The legacy audit-log-derived count
    (cached issues with latest decision ``accept``) is retained in
    :func:`compute_summary` for divergence detection only.
    """
    folder = project_root / "vbrief" / FILESYSTEM_IN_FLIGHT_FOLDER
    if not folder.is_dir():
        return 0
    total = 0
    for child in folder.iterdir():
        if not (child.is_file() and child.name.endswith(".vbrief.json")):
            continue
        # The whole parse is wrapped so a corrupt vBRIEF (torn write,
        # bad encoding, OS-level read refusal) does not crash the
        # ritual. The cost of a missed count is far less than the cost
        # of a session-start exception.
        with contextlib.suppress(Exception):
            data = json.loads(child.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                continue
            plan = data.get("plan")
            if not isinstance(plan, dict):
                continue
            status = plan.get("status")
            if isinstance(status, str) and status == FILESYSTEM_IN_FLIGHT_STATUS:
                total += 1
    return total


def _is_triage_scope_explicitly_configured(project_root: Path) -> bool:
    """Return ``True`` iff ``plan.policy.triageScope`` is a non-empty
    list of dict rules on PROJECT-DEFINITION.

    Discriminator for the #1270 discrepancy-line variant:

    * ``True``  -> ``[triage:scope] N in-flight outside
      plan.policy.triageScope[] (uncounted in queue ranking)``.
    * ``False`` -> ``[triage:scope] N in-flight; plan.policy.triageScope[]
      not configured (uncounted in queue ranking)``.

    The framework default (``[{"rule": "all-open"}]``) and the absent /
    empty / malformed cases all surface as "not configured" -- the
    operator hasn't tightened scope, so the discrepancy line nudges
    them toward configuring it rather than implying their explicit
    config is wrong.

    Tolerant of every failure mode (missing file, malformed JSON,
    non-dict shapes) -- a config-read failure must NOT crash the
    ritual; we fall back to ``False`` so the "not configured" wording
    fires (the conservative reading).
    """
    path = project_root / PROJECT_DEFINITION_REL_PATH
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(data, dict):
        return False
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return False
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return False
    scope = policy.get("triageScope")
    if not isinstance(scope, list) or not scope:
        return False
    # At least one rule must be a dict for the field to count as
    # "configured" -- a list of non-dicts is malformed config and
    # collapses to the same "not configured" path.
    return any(isinstance(rule, dict) for rule in scope)


def resolve_wip_cap(project_root: Path) -> int:
    """Read ``plan.policy.wipCap`` from PROJECT-DEFINITION; fall back to the framework default.

    D4 (#1124) ships the canonical resolver as
    :func:`scripts.policy.resolve_wip_cap` (returns a ``WipCapResult``).
    D2's surface here is a thin shim that returns the integer cap only,
    preserving the original :func:`triage_summary.resolve_wip_cap`
    return contract -- existing call-sites continue to work without
    pattern-matching on ``source``. The shared constant
    :data:`DEFAULT_WIP_CAP` is imported from ``scripts.policy`` (D4)
    so D2 and D4 cannot drift again -- the post-#1119 Current Shape
    v3 override (10) lives in ONE place. Defers to D4's resolver for
    the actual read so all the malformed-JSON / non-int /
    missing-PROJECT-DEFINITION tolerance lives in one place too.
    """
    # Lazy-import the D4 resolver under ``contextlib.suppress`` so a
    # partial install (D4 not present on a pre-#1124 branch) still
    # produces a sensible default. Mirrors the lazy-hook pattern in
    # scripts/vbrief_validate.py.
    try:
        from policy import resolve_wip_cap as _resolve_wip_cap_d4  # noqa: I001
        result = _resolve_wip_cap_d4(project_root)
        return int(result.cap)
    except ImportError:  # pragma: no cover -- D4 not present on rolling-merge tolerance branch
        return DEFAULT_WIP_CAP


# ---------------------------------------------------------------------------
# compute / format / persist
# ---------------------------------------------------------------------------


def compute_summary(
    project_root: Path,
    *,
    cache_root: Path | None = None,
    audit_log_path: Path | None = None,
) -> SummaryResult:
    """Derive the structured triage summary from on-disk state.

    Hand-rolled reader per the issue body's D11-soft-dependency clause.
    Switch to ``task triage:audit --format=json`` (#1128) once D11
    lands -- the function signature is the contract, the internals are
    free to change.
    """
    resolved_cache_root = cache_root or (project_root / CACHE_DIR_NAME)
    resolved_log_path = audit_log_path or (project_root / CANDIDATES_LOG_REL_PATH)

    cached = iter_cached_issues(resolved_cache_root)
    repos = sorted({repo for repo, _n in cached})
    wip_cap = resolve_wip_cap(project_root)
    wip_count = count_vbrief_wip(project_root)
    # #1270: the filesystem-truth in-flight count is the new headline
    # source. Computed unconditionally (even on empty cache) so a
    # consumer who has activated work before bootstrapping the cache
    # still sees their actual WIP reflected in observability records.
    in_flight_filesystem = count_filesystem_in_flight(project_root)
    triage_scope_configured = _is_triage_scope_explicitly_configured(project_root)

    if not cached:
        # Cache empty -- the renderer emits the canonical empty-cache
        # prompt regardless of the numeric counts. We still surface
        # the filesystem count via :attr:`in_flight_filesystem` and
        # :attr:`in_flight` so downstream observability / JSON
        # consumers see truthful values; ``in_flight_cache_scoped``
        # stays at 0 because there's no cache view to disagree with.
        return SummaryResult(
            cache_empty=True,
            untriaged=0,
            stale_defer=0,
            in_flight=in_flight_filesystem,
            wip_count=wip_count,
            wip_cap=wip_cap,
            repos=tuple(repos[:8]),
            scope_drift=0,
            in_flight_filesystem=in_flight_filesystem,
            in_flight_cache_scoped=0,
            triage_scope_configured=triage_scope_configured,
        )

    entries = read_audit_log(resolved_log_path)
    decisions = latest_decisions(entries)

    untriaged = 0
    in_flight_cache_scoped = 0
    stale_defer = 0
    # #1468: cached issues with NO audit decision at all -- the subset of
    # ``untriaged`` that ``task triage:reconcile`` can heal when a
    # matching on-disk vBRIEF exists. ``reset`` / other non-triaged
    # decisions are deliberate operator actions and are NOT collected
    # here (reconcile never overrides a real decision).
    no_decision_keys: list[tuple[str, int]] = []
    for repo, issue_number in cached:
        decision = decisions.get((repo, issue_number))
        if decision is None or decision == "reset" or decision not in TRIAGED_DECISIONS:
            # ``reset`` is non-skipping by design (see candidates_log
            # docstring) so a reset-back-to-untriaged is correctly
            # counted in the untriaged bucket.
            untriaged += 1
        if decision is None:
            no_decision_keys.append((repo, issue_number))
        elif decision in IN_FLIGHT_DECISIONS:
            # #1270: this count is now the *cache-scoped* view, used
            # only for divergence detection against the
            # filesystem-truth count above. The headline
            # :attr:`in_flight` is filesystem-truth.
            in_flight_cache_scoped += 1
        if decision in STALE_DEFER_DECISIONS:
            # D3 (#1123): cached issues whose latest decision is
            # ``resume-eligible`` ARE the count the one-liner surfaces.
            # Pre-D3 audit logs cannot emit ``resume-eligible`` so the
            # count stays at zero on a checkout that has not yet rebased
            # onto D3 -- back-compat preserved.
            stale_defer += 1

    scope_drift = _read_scope_drift_total(project_root, resolved_cache_root)
    reconcilable = _read_reconcilable_total(
        project_root, resolved_log_path, no_decision_keys
    )

    return SummaryResult(
        cache_empty=False,
        untriaged=untriaged,
        stale_defer=stale_defer,
        # #1270: ``in_flight`` is now an alias for the filesystem-truth
        # count. The cache-scoped count surfaces only via
        # :attr:`in_flight_cache_scoped` and the discrepancy line.
        in_flight=in_flight_filesystem,
        wip_count=wip_count,
        wip_cap=wip_cap,
        repos=tuple(repos[:8]),
        scope_drift=scope_drift,
        in_flight_filesystem=in_flight_filesystem,
        in_flight_cache_scoped=in_flight_cache_scoped,
        triage_scope_configured=triage_scope_configured,
        reconcilable=reconcilable,
    )


def _read_reconcilable_total(
    project_root: Path,
    audit_log_path: Path,
    no_decision_keys: list[tuple[str, int]],
) -> int:
    """Return the #1468 reconcilable count -- 0 on any import / runtime failure.

    Intersects the cached, currently-untriaged-because-no-decision issues
    (``no_decision_keys``) with the set ``task triage:reconcile`` would
    heal (proposed/pending/active vBRIEFs carrying an
    ``x-vbrief/github-issue`` reference with no audit entry). The reconcile
    detector lives at ``scripts/triage_reconcile.py`` and is read-only.
    Failures (missing module, malformed vBRIEFs, etc.) silently degrade to
    0 so the one-liner contract (always exits 0) is preserved -- mirrors
    :func:`_read_scope_drift_total`.
    """
    if not no_decision_keys:
        return 0
    # Derive the fallback repo from the cached keys themselves so the hint
    # stays in sync with what ``task triage:reconcile`` would restore for a
    # bare-URI vBRIEF (one whose github-issue reference omits owner/repo).
    # When every cached untriaged issue shares one repo we pass it as the
    # default; a mixed-repo cache passes ``None`` (the rare bare-URI case
    # is then conservatively skipped). Using the cache's authoritative repo
    # avoids a git-remote subprocess on the session-start hot path.
    repos = {repo for repo, _n in no_decision_keys}
    default_repo = next(iter(repos)) if len(repos) == 1 else None
    try:
        from triage_reconcile import count_reconcilable  # noqa: I001
        return int(
            count_reconcilable(
                project_root,
                default_repo=default_repo,
                audit_log_path=audit_log_path,
                restrict_to=no_decision_keys,
            )
        )
    except Exception:  # pragma: no cover -- broad on purpose; status surface
        return 0


def _read_scope_drift_total(project_root: Path, cache_root: Path) -> int:
    """Return the D14 (#1133) drift total -- 0 on any import / runtime failure.

    The drift detector lives at ``scripts/triage_scope_drift.py`` and
    is read-only; computing the total here is a cheap re-walk of the
    same cache the summary already touched. Failures (missing module,
    malformed PROJECT-DEFINITION, etc.) silently degrade to 0 so the
    one-liner contract (always exits 0) is preserved.
    """
    try:
        from triage_scope_drift import compute_drift  # noqa: I001
        report = compute_drift(project_root, cache_root=cache_root)
        return int(report.total)
    except Exception:  # pragma: no cover -- broad on purpose; status surface
        return 0


def _truncate(text: str, max_chars: int) -> str:
    """Hard truncate ``text`` to at most ``max_chars`` glyphs.

    Cuts on a character boundary; appends ``...`` only when there is
    room for the ellipsis without exceeding the cap. The output is
    guaranteed to be a single line (no embedded newlines) and at most
    ``max_chars`` Python characters wide. Falls back to a bare slice
    when the cap is too small for the ellipsis (we never lose the
    leading ``[triage]`` tag).
    """
    if len(text) <= max_chars:
        return text
    if max_chars <= 3:
        return text[:max_chars]
    return text[: max_chars - 3] + "..."


def format_one_liner(result: SummaryResult, *, max_chars: int = MAX_LINE_CHARS) -> str:
    """Render the structured summary as the documented one-liner.

    Format (#1122)::

        [triage] N untriaged [· S stale-defer (resume condition met)] · M in-flight · WIP X/Y [⚠]

    Rules:

    * Empty cache emits the canonical empty-cache prompt verbatim,
      ignoring numeric fields entirely.
    * The stale-defer block appears only when ``stale_defer >= 1``.
    * The WIP warning glyph appears only when ``wip_count >= wip_cap``.
    * ``0 untriaged`` STILL prints (zero is a healthy signal, not
      silence -- issue body).
    * Truncation drops the lowest-impact bits first (warning glyph,
      then stale-defer block) before resorting to a hard ellipsis cut.
    """
    if result.cache_empty:
        return _truncate(EMPTY_CACHE_LINE, max_chars)

    parts = [f"[triage] {result.untriaged} untriaged"]
    if result.stale_defer >= 1:
        parts.append(f"{result.stale_defer} stale-defer (resume condition met)")
    parts.append(f"{result.in_flight} in-flight")
    wip_field = f"WIP {result.wip_count}/{result.wip_cap}"
    if result.wip_count >= result.wip_cap:
        wip_field = f"{wip_field} {WIP_WARN_GLYPH}"
    parts.append(wip_field)
    # D14 / #1133: `[scope-drift] N` is suppressed at 0; surfaced last
    # so truncation drops it BEFORE the WIP cap field (the cap is a
    # gate signal; drift is informational).
    if result.scope_drift > 0:
        parts.append(f"[scope-drift] {result.scope_drift}")

    candidate = " \u00b7 ".join(parts)
    if len(candidate) <= max_chars:
        return candidate

    # Graceful field-by-field shedding before falling back to a hard
    # truncate. Last-impact-first: drop the warning glyph, then the
    # stale-defer block, then truncate.
    if WIP_WARN_GLYPH in wip_field:
        wip_field_no_warn = f"WIP {result.wip_count}/{result.wip_cap}"
        rebuilt = list(parts)
        rebuilt[-1] = wip_field_no_warn
        candidate = " \u00b7 ".join(rebuilt)
        if len(candidate) <= max_chars:
            return candidate

    if result.stale_defer >= 1:
        rebuilt = [
            parts[0],
            f"{result.in_flight} in-flight",
            f"WIP {result.wip_count}/{result.wip_cap}",
        ]
        candidate = " \u00b7 ".join(rebuilt)
        if len(candidate) <= max_chars:
            return candidate

    return _truncate(candidate, max_chars)


def format_scope_discrepancy_line(result: SummaryResult) -> str | None:
    """Return the ``[triage:scope]`` discrepancy line, or ``None`` if aligned.

    Emitted when the filesystem-truth in-flight count diverges from the
    cache-scoped audit-log count (#1270). Two wording variants -- the
    canonical strings are defined inline in the function body below:

    * ``triage_scope_configured = True`` -> ``outside
      plan.policy.triageScope[]`` wording (operator has set a non-empty
      ``plan.policy.triageScope[]``).
    * ``triage_scope_configured = False`` -> ``not configured`` wording
      (framework default ``all-open`` OR absent / empty / malformed
      config).

    ``N`` is the *absolute* delta between the two counts. Returns
    ``None`` (no second line) when the counts agree -- the common case
    when scope is aligned. Cache-empty summaries also return ``None``
    because the headline switches to ``EMPTY_CACHE_LINE`` and the
    discrepancy semantics no longer apply.
    """
    if result.cache_empty:
        return None
    delta = abs(result.in_flight_filesystem - result.in_flight_cache_scoped)
    if delta == 0:
        return None
    if result.triage_scope_configured:
        return (
            f"[triage:scope] {delta} in-flight outside "
            "plan.policy.triageScope[] (uncounted in queue ranking)"
        )
    return (
        f"[triage:scope] {delta} in-flight; "
        "plan.policy.triageScope[] not configured "
        "(uncounted in queue ranking)"
    )


def format_reconcile_hint_line(result: SummaryResult) -> str | None:
    """Return the ``[triage:reconcile]`` hint line, or ``None`` if aligned.

    Emitted (#1468) when ``result.reconcilable`` is positive -- i.e. one
    or more cached issues are counted as ``untriaged`` (no audit
    decision) yet a matching ``proposed/`` / ``pending/`` / ``active/``
    vBRIEF carrying an ``x-vbrief/github-issue`` reference exists on
    disk. Those issues were accepted (the surviving vBRIEF is the proof)
    but their audit-log decision was lost; the line points the operator
    at the discoverable repair verb. Mirrors the
    :func:`format_scope_discrepancy_line` second-line pattern.

    Returns ``None`` (no line) when ``reconcilable == 0`` -- the common
    case once the audit log and the on-disk inventory agree, and always
    on a cache-empty summary (the headline switches to
    ``EMPTY_CACHE_LINE`` and there is nothing cached to reconcile).
    """
    if result.cache_empty or result.reconcilable <= 0:
        return None
    return (
        f"[triage:reconcile] {result.reconcilable} accepted on disk but "
        "missing from the audit log -- run `task triage:reconcile` to restore"
    )


def format_summary(result: SummaryResult, *, max_chars: int = MAX_LINE_CHARS) -> str:
    """Render the full (possibly multi-line) summary string.

    Composes the headline one-liner (delegated to
    :func:`format_one_liner`, which retains the original
    single-physical-line + 120-char-cap contract from #1122) plus,
    when applicable, a second physical line produced by
    :func:`format_scope_discrepancy_line` (#1270).

    The 120-char cap is applied per physical line, not to the combined
    string -- the discrepancy / reconcile lines are informational and
    intentionally longer than the cap would allow when collapsed into
    one line. CLI callers print this verbatim; the history-JSONL
    ``line`` field also receives the full multi-line content so offline
    replay sees the same view the operator did.

    Line order (when present): headline, then the #1270
    ``[triage:scope]`` divergence line, then the #1468
    ``[triage:reconcile]`` hint line.
    """
    lines = [format_one_liner(result, max_chars=max_chars)]
    scope_line = format_scope_discrepancy_line(result)
    if scope_line is not None:
        lines.append(scope_line)
    reconcile_line = format_reconcile_hint_line(result)
    if reconcile_line is not None:
        lines.append(reconcile_line)
    return "\n".join(lines)


def append_history(
    history_path: Path,
    result: SummaryResult,
    line: str,
    *,
    emitted_at: str | None = None,
) -> Path:
    """Append a single JSONL record to ``summary-history.jsonl``.

    Pure-stdlib write through ``open(..., "a", encoding="utf-8")`` so
    the append is atomic on standard filesystems (no read-modify-write
    -- aligns with ``scripts/policy.py::append_audit_log``). Parent
    directory is created if missing (fresh consumer installs).
    Failures are silenced via :func:`contextlib.suppress` because the
    history sidecar is observability, not load-bearing for the summary
    surface itself; a corrupt sidecar MUST NOT crash session start.
    """
    record = result.to_record(
        emitted_at=emitted_at or _utc_iso(),
        line=line,
    )
    payload = json.dumps(record, sort_keys=True, ensure_ascii=False)
    # Greptile P1 fix: ``mkdir`` is INSIDE the suppress block so a
    # permission-denied / read-only-fs / SELinux refusal on the parent
    # ``vbrief/.eval/`` directory never propagates out of the helper.
    # ``append_history`` MUST never raise -- the sidecar is observability
    # only, the issue body freezes the verb's exit code at 0 in every
    # scenario.
    with contextlib.suppress(OSError):
        history_path.parent.mkdir(parents=True, exist_ok=True)
        with open(history_path, "a", encoding="utf-8", newline="") as handle:
            handle.write(payload + "\n")
            handle.flush()
            with contextlib.suppress(OSError):
                os.fsync(handle.fileno())
    return history_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _resolve_project_root(raw: str | None) -> Path:
    if raw:
        return Path(raw).resolve()
    return Path.cwd().resolve()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_summary",
        description=(
            "Emit the D2 (#1122) `task triage:summary` one-liner. Always "
            "exits 0; appends a JSONL record to "
            "vbrief/.eval/summary-history.jsonl as a side effect."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help=(
            "Project root to inspect (defaults to the current working "
            "directory). The Taskfile dispatch threads "
            "{{.USER_WORKING_DIR}} through here so the verb works in "
            "consumer worktrees regardless of where the framework is "
            "installed."
        ),
    )
    parser.add_argument(
        "--cache-root",
        default=None,
        help=(
            "Override the cache root location (default: "
            "<project-root>/.deft-cache). Used by tests; production "
            "callers MUST NOT pass this."
        ),
    )
    parser.add_argument(
        "--no-history",
        action="store_true",
        help=(
            "Suppress the summary-history.jsonl append (read-only "
            "rendering). Used by tests; production callers SHOULD NOT "
            "pass this -- the history sidecar is the observability "
            "surface."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help=(
            "Emit the structured summary record as JSON on stdout "
            "instead of the human-readable one-liner. The history "
            "sidecar still receives a record (unless --no-history)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint -- always returns 0 (status surface, not a gate)."""
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_summary", argv)
    if rc is not None:
        return rc
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = _resolve_project_root(args.project_root)
    cache_root = Path(args.cache_root).resolve() if args.cache_root else None

    result = compute_summary(project_root, cache_root=cache_root)
    # #1270: ``format_summary`` returns the headline plus, when
    # filesystem-vs-cache counts diverge, a second ``[triage:scope]``
    # line. The headline retains the #1122 single-line + 120-char-cap
    # contract via :func:`format_one_liner`.
    line = format_summary(result)
    emitted_at = _utc_iso()

    if args.json:
        record = result.to_record(emitted_at=emitted_at, line=line)
        print(json.dumps(record, sort_keys=True, ensure_ascii=False))
    else:
        print(line)

    if not args.no_history:
        history_path = project_root / SUMMARY_HISTORY_REL_PATH
        append_history(history_path, result, line, emitted_at=emitted_at)

    # Issue #1122 freezes the exit code at 0 for every scenario. The
    # verb is a status surface, not a gate; downstream gates own their
    # own exit-code contracts (D5 verify:cache-fresh, D4 WIP cap).
    return 0


if __name__ == "__main__":  # pragma: no cover -- thin shim
    raise SystemExit(main())
