#!/usr/bin/env python3
"""triage_summary.py -- D2 (#1122) ``task triage:summary`` one-liner.

Status surface for the session-start ritual (N9 / #1149). Reads the
existing unified ``.deft-cache/github-issue/<owner>/<repo>/`` cache
layout (`#883 Story 2`) and the operator-private ``candidates.jsonl``
audit log (`#845 Story 2`), derives four counts (untriaged, stale-defer,
in-flight, WIP-vs-cap), and prints ONE bounded (<=120 char) line in the
documented format::

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
TRIAGED_DECISIONS: frozenset[str] = frozenset(
    {"accept", "reject", "defer", "needs-ac", "mark-duplicate"}
)


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
            "wip_count": self.wip_count,
            "wip_cap": self.wip_cap,
            "repos": list(self.repos),
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

    if not cached:
        # Cache empty -- ALL numeric fields are zero, the discriminator
        # is the boolean. Callers MUST render the empty-cache prompt.
        return SummaryResult(
            cache_empty=True,
            untriaged=0,
            stale_defer=0,
            in_flight=0,
            wip_count=wip_count,
            wip_cap=wip_cap,
            repos=tuple(repos[:8]),
        )

    entries = read_audit_log(resolved_log_path)
    decisions = latest_decisions(entries)

    untriaged = 0
    in_flight = 0
    for repo, issue_number in cached:
        decision = decisions.get((repo, issue_number))
        if decision is None or decision == "reset" or decision not in TRIAGED_DECISIONS:
            # ``reset`` is non-skipping by design (see candidates_log
            # docstring) so a reset-back-to-untriaged is correctly
            # counted in the untriaged bucket.
            untriaged += 1
        elif decision in IN_FLIGHT_DECISIONS:
            in_flight += 1

    # D3 (#1123) will introduce defer-resume conditions; until then the
    # stale-defer count is always 0 per the issue body's explicit
    # "Until then, stale-defer always reads 0 -- that's correct, not a
    # bug." clause. The field is suppressed in the one-liner whenever
    # the count is 0.
    stale_defer = 0

    return SummaryResult(
        cache_empty=False,
        untriaged=untriaged,
        stale_defer=stale_defer,
        in_flight=in_flight,
        wip_count=wip_count,
        wip_cap=wip_cap,
        repos=tuple(repos[:8]),
    )


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
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = _resolve_project_root(args.project_root)
    cache_root = Path(args.cache_root).resolve() if args.cache_root else None

    result = compute_summary(project_root, cache_root=cache_root)
    line = format_one_liner(result)
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
