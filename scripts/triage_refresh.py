#!/usr/bin/env python3
"""triage_refresh.py -- Story 4 pre-swarm freshness gate (#883 Story 3 rebind).

Implements ``task triage:refresh-active``:

1. Walks ``vbrief/active/*.vbrief.json`` and extracts
   ``x-vbrief/github-issue`` references.
2. For every (repo, issue) pair, reads the cached ``meta.json.fetched_at``
   via :func:`scripts.cache.cache_get` (#883 Story 2) and compares it to a
   live ``gh issue view <N> --json updatedAt``. Drift exists when the
   upstream ``updatedAt`` is newer than the cached ``fetched_at`` (the
   issue moved after we mirrored it) OR when the cache has no entry for
   the issue at all.
3. Surfaces drifted items via a three-way prompt:

   - ``proceed-with-stale``       -- record an audit annotation via Story 2.
   - ``refresh-and-update-local`` -- call ``cache_put`` with a fresh
     ``gh issue view`` payload to re-cache the issue.
   - ``defer-from-this-batch``    -- skip the issue; caller decides later.

Empty ``vbrief/active/`` is a no-op (clean exit). The freshness primitive
introduced here is consumed by ``#868`` (lock-comment protocol).
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import re
import subprocess
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Pre-compiled regex used for both repo + issue extraction.
_ISSUE_URL_RE = re.compile(
    r"github\.com/(?P<repo>[^/]+/[^/]+)/issues/(?P<num>\d+)",
    re.IGNORECASE,
)

#: Cache source consumed by triage v1 (only github-issue is supported).
_CACHE_SOURCE: str = "github-issue"


# ---------------------------------------------------------------------------
# vBRIEF discovery + reference extraction
# ---------------------------------------------------------------------------


def _iter_active_vbriefs(active_dir: Path) -> list[Path]:
    """Return active vBRIEFs sorted by filename. Missing dir returns ``[]``."""

    if not active_dir.is_dir():
        return []
    return sorted(active_dir.glob("*.vbrief.json"))


def _extract_issue_refs(vbrief_path: Path) -> list[tuple[str, int]]:
    """Return ``(repo, issue_number)`` tuples extracted from references."""

    try:
        data = json.loads(vbrief_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    if not isinstance(data, dict):
        return []
    plan = data.get("plan", {})
    if not isinstance(plan, dict):
        return []

    out: list[tuple[str, int]] = []
    for ref in plan.get("references", []) or []:
        if not isinstance(ref, dict):
            continue
        if ref.get("type") != "x-vbrief/github-issue":
            continue
        uri = str(ref.get("uri", ""))
        match = _ISSUE_URL_RE.search(uri)
        if not match:
            continue
        out.append((match.group("repo"), int(match.group("num"))))
    return out


# ---------------------------------------------------------------------------
# Cache module loader + drift primitives
# ---------------------------------------------------------------------------


def _load_cache_module() -> Any | None:
    """Return the unified cache module, or ``None`` if not importable."""

    for candidate in ("cache", "scripts.cache"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    return None


@dataclass(frozen=True)
class DriftRecord:
    """A single (repo, issue) drift observation."""

    repo: str
    issue_number: int
    cached_fetched_at: str | None
    live_updated_at: str
    vbrief_path: Path


def _fetch_live_updated_at(repo: str, issue_number: int) -> str:
    """Live fetch via ``gh issue view`` -- returns empty string on missing field."""

    cmd = [
        "gh",
        "issue",
        "view",
        str(issue_number),
        "--repo",
        repo,
        "--json",
        "updatedAt",
    ]
    completed = subprocess.run(  # noqa: S603
        cmd, capture_output=True, text=True, check=True
    )
    payload = json.loads(completed.stdout or "{}")
    return str(payload.get("updatedAt") or "")


def _load_cached_fetched_at(
    repo: str,
    issue_number: int,
    project_root: Path,
    *,
    cache_module: Any | None = None,
) -> str | None:
    """Read cached ``meta.json.fetched_at`` via :func:`scripts.cache.cache_get`.

    Returns ``None`` when the cache entry is missing, when the cache module
    is not importable, or when the entry's meta.json fails schema
    validation. Callers treat ``None`` as "drift" (the cache cannot vouch
    for the issue's current state).
    """

    cache_mod = cache_module if cache_module is not None else _load_cache_module()
    if cache_mod is None:
        return None
    cache_get = getattr(cache_mod, "cache_get", None)
    if not callable(cache_get):
        return None
    not_found_exc = getattr(cache_mod, "CacheNotFoundError", LookupError)
    validation_exc = getattr(cache_mod, "CacheValidationError", ValueError)
    cache_error_exc = getattr(cache_mod, "CacheError", RuntimeError)
    key = f"{repo}/{int(issue_number)}"
    try:
        result = cache_get(
            _CACHE_SOURCE,
            key,
            cache_root=project_root / ".deft-cache",
            allow_stale=True,
        )
    except not_found_exc:  # type: ignore[misc]
        return None
    except (validation_exc, cache_error_exc):  # type: ignore[misc]
        return None
    meta = getattr(result, "meta", None)
    if not isinstance(meta, dict):
        return None
    value = meta.get("fetched_at")
    return str(value) if value is not None else None


FetchLive = Callable[[str, int], str]
CacheLoader = Callable[[str, int, Path], str | None]


def _is_drift(cached_fetched_at: str | None, live_updated_at: str) -> bool:
    """Return True iff the live timestamp postdates the cached fetch.

    Missing-cache (``cached_fetched_at`` is None) is always drift -- the
    cache has nothing to vouch for. Empty live timestamps short-circuit to
    no-drift so a malformed gh response cannot fabricate a drift signal.
    """

    if not live_updated_at:
        return False
    if cached_fetched_at is None:
        return True
    # ISO-8601 strings sort lexicographically when both carry the canonical
    # ``Z`` suffix. cache.py's ``_utc_iso`` and gh's ``updatedAt`` both emit
    # the Z form, so a string comparison is correct.
    return live_updated_at > cached_fetched_at


def detect_drift(
    active_dir: Path,
    project_root: Path,
    *,
    fetch_live: FetchLive | None = None,
    cache_loader: CacheLoader | None = None,
    skipped_out: list[tuple[str, int, str]] | None = None,
    checked_out: list[tuple[str, int]] | None = None,
    out: Any | None = None,
) -> list[DriftRecord]:
    """Walk active vBRIEFs and return drifted (repo, issue) records.

    Drift is computed against ``meta.json.fetched_at`` -- the issue's
    upstream ``updatedAt`` is compared against the cache's record of when
    we last mirrored it. A live-fetch failure (network / auth / malformed
    gh response) is logged on ``out`` and recorded in ``skipped_out``;
    callers treat skips as ``unverified`` rather than ``fresh`` so an
    outage cannot masquerade as freshness.
    """

    fetch_live = fetch_live or _fetch_live_updated_at
    cache_loader = cache_loader or _load_cached_fetched_at
    sink = out or sys.stderr

    drifts: list[DriftRecord] = []
    seen: set[tuple[str, int]] = set()

    for vbrief in _iter_active_vbriefs(active_dir):
        for repo, num in _extract_issue_refs(vbrief):
            key = (repo, num)
            if key in seen:
                continue
            seen.add(key)
            if checked_out is not None:
                checked_out.append(key)
            cached = cache_loader(repo, num, project_root)
            try:
                live = fetch_live(repo, num)
            except (subprocess.CalledProcessError, json.JSONDecodeError, OSError) as exc:
                reason = f"{type(exc).__name__}: {exc}"
                print(
                    f"[triage:refresh-active] WARN: live fetch skipped for "
                    f"{repo}#{num} ({reason})",
                    file=sink,
                )
                if skipped_out is not None:
                    skipped_out.append((repo, num, reason))
                continue
            if _is_drift(cached, live):
                drifts.append(
                    DriftRecord(
                        repo=repo,
                        issue_number=num,
                        cached_fetched_at=cached,
                        live_updated_at=live,
                        vbrief_path=vbrief,
                    )
                )
    return drifts


# ---------------------------------------------------------------------------
# Three-way prompt + side-effect surfaces
# ---------------------------------------------------------------------------


PROMPT_OPTIONS: dict[str, str] = {
    "1": "proceed-with-stale",
    "2": "refresh-and-update-local",
    "3": "defer-from-this-batch",
}


def _prompt_user(
    drift: DriftRecord,
    *,
    input_fn: Callable[[str], str] = input,
    out: Any | None = None,
) -> str:
    """Render the three-way prompt and return the canonical choice keyword."""

    sink = out or sys.stdout
    print(f"\nDrift detected for {drift.repo}#{drift.issue_number}:", file=sink)
    print(f"  cached fetched_at: {drift.cached_fetched_at!r}", file=sink)
    print(f"  live   updatedAt:  {drift.live_updated_at!r}", file=sink)
    print(f"  vBRIEF: {drift.vbrief_path}", file=sink)
    print("  1) proceed-with-stale", file=sink)
    print("  2) refresh-and-update-local", file=sink)
    print("  3) defer-from-this-batch", file=sink)
    raw = input_fn("Choose [1/2/3]: ").strip()
    return PROMPT_OPTIONS.get(raw, "defer-from-this-batch")


def _refresh_and_update_local(
    repo: str,
    issue_number: int,
    project_root: Path,
    *,
    cache_module: Any | None = None,
) -> None:
    """Re-cache ``repo#issue_number`` via :func:`scripts.cache.cache_put`.

    Fetches a fresh ``gh issue view`` payload and writes it through the
    unified cache so the next freshness pass observes the up-to-date
    ``meta.json.fetched_at``. Tolerates an absent cache module (Story 2
    not yet on the branch); the caller logs the refreshed status from
    the surrounding context.
    """

    cache_mod = cache_module if cache_module is not None else _load_cache_module()
    if cache_mod is None:
        return
    cache_put = getattr(cache_mod, "cache_put", None)
    if not callable(cache_put):
        return

    cmd = [
        "gh",
        "issue",
        "view",
        str(issue_number),
        "--repo",
        repo,
        "--json",
        "number,title,body,state,labels,author,createdAt,updatedAt,url",
    ]
    try:
        completed = subprocess.run(  # noqa: S603
            cmd, capture_output=True, text=True, check=True
        )
    except (subprocess.SubprocessError, OSError):
        return
    try:
        raw = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return
    if not isinstance(raw, dict):
        return
    if "number" not in raw or not isinstance(raw["number"], int):
        raw["number"] = int(issue_number)

    key = f"{repo}/{int(issue_number)}"
    try:
        cache_put(
            _CACHE_SOURCE,
            key,
            raw,
            cache_root=project_root / ".deft-cache",
        )
    except Exception:  # noqa: BLE001 -- best-effort refresh
        return


def _record_audit_annotation(
    repo: str,
    issue_number: int,
    annotation: str,
    *,
    actor: str = "agent:freshness-gate",
    log_module: Any | None = None,
    out: Any | None = None,
) -> None:
    """Append a ``freshness-annotation`` entry via Story 2's ``candidates_log``.

    No-op if Story 2 isn't on the import path. Story 2 ships a FROZEN
    decision vocabulary so the schema rejects the ``freshness-annotation``
    decision; the rejection is degraded to a stderr WARN rather than a
    fatal exception (Greptile P1, PR #875).
    """

    sink = out or sys.stderr
    if log_module is None:
        for candidate in ("candidates_log", "scripts.candidates_log"):
            try:
                log_module = importlib.import_module(candidate)
                break
            except ModuleNotFoundError:
                continue
    if log_module is None:
        return
    append = getattr(log_module, "append", None)
    if not callable(append):
        return

    new_id = getattr(log_module, "new_decision_id", None)
    decision_id = str(new_id()) if callable(new_id) else str(uuid.uuid4())

    entry = {
        "decision_id": decision_id,
        "decision": "freshness-annotation",
        "repo": repo,
        "issue_number": issue_number,
        "actor": actor,
        "reason": annotation,
        "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    try:
        append(entry)
    except ValueError as exc:
        print(
            f"[triage:refresh-active] WARN: audit annotation for "
            f"{repo}#{issue_number} not persisted -- candidates_log "
            f"rejected the entry ({type(exc).__name__}: {exc}). The "
            f"proceed-with-stale choice has been logged to stdout but "
            f"the JSONL trail does not yet recognize 'freshness-"
            f"annotation'; extend the Story 2 schema to capture it.",
            file=sink,
        )


# ---------------------------------------------------------------------------
# High-level orchestration
# ---------------------------------------------------------------------------


@dataclass
class FreshnessSummary:
    """Aggregate result of a ``refresh_active`` call."""

    total_active: int
    drifts_detected: int
    proceeded: list[tuple[str, int]] = field(default_factory=list)
    refreshed: list[tuple[str, int]] = field(default_factory=list)
    deferred: list[tuple[str, int]] = field(default_factory=list)
    skipped: list[tuple[str, int]] = field(default_factory=list)


RefreshLocal = Callable[[str, int, Path], None]
AuditWriter = Callable[[str, int, str], None]


def _evaluate_resume_step(project_root: Path, *, out: Any) -> None:
    """Best-effort resume-condition evaluation hook (#1123 / D3).

    Runs after the freshness pass so any defer entries whose ``resume_on``
    condition fires get a ``resume-eligible`` audit-log marker before the
    operator next consults the queue. Tolerates absence of the
    ``resume_conditions`` module on slim test checkouts.
    """
    try:
        rc = importlib.import_module("resume_conditions")
    except ModuleNotFoundError:
        try:
            rc = importlib.import_module("scripts.resume_conditions")
        except ModuleNotFoundError:
            return
    try:
        appended = rc.evaluate_resume_eligibility(project_root)
    except Exception as exc:  # noqa: BLE001 -- best-effort; surface failure
        print(
            f"[triage:refresh-active] WARN: resume-condition eval failed: "
            f"{type(exc).__name__}: {exc}",
            file=out,
        )
        return
    if appended:
        print(
            f"[triage:refresh-active] resume-eligible: {len(appended)} "
            "defer entr(ies) fired",
            file=out,
        )


def refresh_active(
    project_root: Path,
    *,
    active_dir: Path | None = None,
    input_fn: Callable[[str], str] = input,
    fetch_live: FetchLive | None = None,
    cache_loader: CacheLoader | None = None,
    refresh_local: RefreshLocal | None = None,
    audit_writer: AuditWriter | None = None,
    out: Any | None = None,
) -> FreshnessSummary:
    """Run the freshness gate end-to-end. Returns a :class:`FreshnessSummary`.

    Side effect (#1123 / D3): after the freshness pass, walks open
    ``defer`` audit entries with non-null ``resume_on`` and appends a
    ``resume-eligible`` audit row for each condition that fires. The
    evaluation is idempotent so repeated invocations do NOT duplicate
    markers.
    """

    sink = out or sys.stdout
    active_dir = active_dir or (project_root / "vbrief" / "active")
    refresh_local = refresh_local or _refresh_and_update_local
    audit_writer = audit_writer or _record_audit_annotation

    active_files = _iter_active_vbriefs(active_dir)
    if not active_files:
        print("[triage:refresh-active] vbrief/active/ is empty -- no-op", file=sink)
        # Still run the resume-eligible pass: a maintainer can keep a defer
        # queue going while having no active scope, and a fired resume
        # condition should surface even then.
        _evaluate_resume_step(project_root, out=sink)
        return FreshnessSummary(0, 0)

    skipped_records: list[tuple[str, int, str]] = []
    checked_pairs: list[tuple[str, int]] = []
    drifts = detect_drift(
        active_dir,
        project_root,
        fetch_live=fetch_live,
        cache_loader=cache_loader,
        skipped_out=skipped_records,
        checked_out=checked_pairs,
        out=sink,
    )
    skipped_pairs = [(repo, num) for (repo, num, _reason) in skipped_records]
    if not drifts:
        if skipped_pairs:
            print(
                f"[triage:refresh-active] WARN: no drift detected, but "
                f"{len(skipped_pairs)} of {len(checked_pairs)} "
                f"(repo, issue) fetch(es) were skipped (treat freshness "
                f"signal as unverified)",
                file=sink,
            )
        else:
            print(
                f"[triage:refresh-active] all {len(active_files)} active vBRIEFs fresh",
                file=sink,
            )
        summary = FreshnessSummary(len(active_files), 0)
        summary.skipped = skipped_pairs
        return summary

    summary = FreshnessSummary(len(active_files), len(drifts))
    summary.skipped = skipped_pairs
    for drift in drifts:
        choice = _prompt_user(drift, input_fn=input_fn, out=sink)
        if choice == "proceed-with-stale":
            audit_writer(
                drift.repo,
                drift.issue_number,
                f"proceed-with-stale: cached_fetched_at={drift.cached_fetched_at} "
                f"live_updated_at={drift.live_updated_at}",
            )
            summary.proceeded.append((drift.repo, drift.issue_number))
            print(
                f"[triage:refresh-active] {drift.repo}#{drift.issue_number} "
                "proceed-with-stale (audit recorded)",
                file=sink,
            )
        elif choice == "refresh-and-update-local":
            refresh_local(drift.repo, drift.issue_number, project_root)
            summary.refreshed.append((drift.repo, drift.issue_number))
            print(
                f"[triage:refresh-active] {drift.repo}#{drift.issue_number} "
                "refreshed-and-updated-local",
                file=sink,
            )
        else:
            summary.deferred.append((drift.repo, drift.issue_number))
            print(
                f"[triage:refresh-active] {drift.repo}#{drift.issue_number} "
                "deferred-from-this-batch",
                file=sink,
            )
    # #1123 / D3: emit resume-eligible markers for any open defer whose
    # condition has fired since the last evaluation pass.
    _evaluate_resume_step(project_root, out=sink)
    return summary


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_refresh",
        description=(
            "Pre-swarm freshness gate for vbrief/active/ "
            "(#845 Story 4 / #883 Story 3 rebind)"
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="project root containing vbrief/active/ (default: cwd)",
    )
    return parser


def _reconfigure_utf8() -> None:
    """Best-effort UTF-8 stdout/stderr on Windows hosts (mirrors #814)."""

    if sys.platform != "win32":
        return
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            with contextlib.suppress(Exception):
                reconfigure(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    _reconfigure_utf8()
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_refresh", argv)
    if rc is not None:
        return rc
    args = _build_parser().parse_args(argv)
    project_root = Path(args.project_root).resolve()
    refresh_active(project_root)
    return 0


# Re-exported helper aliases so tests can monkeypatch a single seam without
# reaching into private names. They are intentionally identifier-only -- the
# implementations live above.
fetch_live_updated_at: FetchLive = _fetch_live_updated_at
load_cached_fetched_at: CacheLoader = _load_cached_fetched_at
iter_active_vbriefs: Callable[[Path], list[Path]] = _iter_active_vbriefs
extract_issue_refs: Callable[[Path], list[tuple[str, int]]] = _extract_issue_refs
record_audit_annotation: Callable[..., None] = _record_audit_annotation


__all__ = [
    "DriftRecord",
    "FreshnessSummary",
    "PROMPT_OPTIONS",
    "detect_drift",
    "extract_issue_refs",
    "fetch_live_updated_at",
    "iter_active_vbriefs",
    "load_cached_fetched_at",
    "main",
    "record_audit_annotation",
    "refresh_active",
]


if __name__ == "__main__":
    sys.exit(main())
