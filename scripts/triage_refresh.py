#!/usr/bin/env python3
"""triage_refresh.py -- Story 4 pre-swarm freshness gate (#845).

Implements ``task triage:refresh-active``:

1. Walks ``vbrief/active/*.vbrief.json`` and extracts ``x-vbrief/github-issue``
   references.
2. For every (repo, issue) pair, compares the cached ``updatedAt`` (Story 1
   ``triage_cache``) against a live ``gh issue view <N> --json updatedAt``.
3. Surfaces drifted items via a three-way prompt:

   - ``proceed-with-stale``       -- record an audit annotation via Story 2.
   - ``refresh-and-update-local`` -- call Story 1 ``populate`` for the issue.
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

# Pre-compiled regex used for both repo + issue extraction. ``re.IGNORECASE``
# tolerates camelcase URIs that occasionally show up in older vBRIEFs.
_ISSUE_URL_RE = re.compile(
    r"github\.com/(?P<repo>[^/]+/[^/]+)/issues/(?P<num>\d+)",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# vBRIEF discovery + reference extraction
# ---------------------------------------------------------------------------


def _iter_active_vbriefs(active_dir: Path) -> list[Path]:
    """Return active vBRIEFs sorted by filename. Missing dir returns ``[]``."""

    if not active_dir.is_dir():
        return []
    return sorted(active_dir.glob("*.vbrief.json"))


def _extract_issue_refs(vbrief_path: Path) -> list[tuple[str, int]]:
    """Return ``(repo, issue_number)`` tuples extracted from references.

    Only ``x-vbrief/github-issue`` references whose ``uri`` parses as a
    GitHub issue URL are emitted; everything else is silently ignored so a
    malformed vBRIEF does not stall the gate.
    """

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
# Drift detection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DriftRecord:
    """A single (repo, issue) drift observation."""

    repo: str
    issue_number: int
    cached_updated_at: str | None
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
    completed = subprocess.run(cmd, capture_output=True, text=True, check=True)  # noqa: S603
    payload = json.loads(completed.stdout or "{}")
    return str(payload.get("updatedAt") or "")


def _load_cached_updated_at(
    repo: str,
    issue_number: int,
    project_root: Path,
) -> str | None:
    """Read cached ``updatedAt`` from the Story 1 cache layout.

    Story 1 writes ``.deft-cache/issues/<owner>-<repo>/<N>.json`` -- mirrored
    here so this gate can run before Story 1's reader API stabilises.
    Returns ``None`` if the cache file is missing or unreadable.
    """

    owner_repo = repo.replace("/", "-")
    cache_path = project_root / ".deft-cache" / "issues" / owner_repo / f"{issue_number}.json"
    if not cache_path.is_file():
        return None
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    value = data.get("updatedAt")
    return str(value) if value is not None else None


FetchLive = Callable[[str, int], str]
CacheLoader = Callable[[str, int, Path], str | None]


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

    Repo+issue pairs are deduplicated -- the same issue referenced from two
    vBRIEFs surfaces only once (the first encountered ``vbrief_path`` wins).

    Live-fetch failures (network / auth / malformed gh response) DO NOT
    silently disappear: every skip is logged to ``out`` and (when supplied)
    appended to ``skipped_out`` as ``(repo, issue, reason)``. This closes the
    Greptile P1 on PR #875 where a wholesale fetch outage masqueraded as
    ``all N fresh``.

    When ``checked_out`` is supplied, every unique ``(repo, issue)`` pair the
    detector visited is appended to it. Callers use this to denominate the
    skipped-fetch warning in ``(issue-pairs, issue-pairs)`` units rather than
    against the vBRIEF file count -- the latter would render nonsensical
    fractions when one vBRIEF carries multiple issue references (Greptile P1
    on PR #875 second pass).
    """

    fetch_live = fetch_live or _fetch_live_updated_at
    cache_loader = cache_loader or _load_cached_updated_at
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
                # Surface the skip explicitly -- a silent skip would let a
                # wholesale outage masquerade as freshness (Greptile P1).
                reason = f"{type(exc).__name__}: {exc}"
                print(
                    (
                        f"[triage:refresh-active] WARN: live fetch skipped for "
                        f"{repo}#{num} ({reason})"
                    ),
                    file=sink,
                )
                if skipped_out is not None:
                    skipped_out.append((repo, num, reason))
                continue
            if cached != live:
                drifts.append(
                    DriftRecord(
                        repo=repo,
                        issue_number=num,
                        cached_updated_at=cached,
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
    print(f"  cached updatedAt: {drift.cached_updated_at!r}", file=sink)
    print(f"  live   updatedAt: {drift.live_updated_at!r}", file=sink)
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
) -> None:
    """Invoke Story 1 ``triage_cache.populate`` for a single issue.

    Tolerates an absent module (Story 1 not yet landed); the caller logs the
    refreshed status from the surrounding context.
    """

    cache_mod: Any | None = None
    for candidate in ("triage_cache", "scripts.triage_cache"):
        try:
            cache_mod = importlib.import_module(candidate)
            break
        except ModuleNotFoundError:
            continue
    if cache_mod is None:
        return
    populate = getattr(cache_mod, "populate", None)
    if not callable(populate):
        return
    # Story 1 contracted signature is ``populate(repo, force=False)`` -- this
    # call narrows to a single issue via kwargs. If the signature is stricter,
    # fall back to a whole-repo refresh so the operator gets *some* freshness
    # signal rather than a silent failure.
    try:
        populate(repo, issue_number=issue_number, project_root=project_root)
    except TypeError:
        try:
            populate(repo, force=True)
        except TypeError:
            populate(repo)


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

    No-op if Story 2 isn't on the import path (the surrounding stdout line is
    still the user-visible signal).

    Story 2 (``candidates_log``) ships a FROZEN decision vocabulary --
    ``{accept, reject, defer, needs-ac, mark-duplicate, reset}`` -- and a
    hand-rolled ``_validate_entry`` that raises ``CandidatesLogError`` (a
    ``ValueError`` subclass) when an entry's ``decision`` falls outside that
    set or required fields are missing. ``freshness-annotation`` is a
    deliberate Story 4 extension that Story 2 does not yet recognize. Pre-
    rebase this code stubbed ``candidates_log`` so the schema mismatch never
    surfaced; post-rebase the real Story 2 module catches it and would
    propagate the exception through ``refresh_active`` and crash the CLI on
    every ``proceed-with-stale`` choice (Greptile P1, PR #875).

    Defensive contract:

    - Generate a UUID4 ``decision_id`` (using Story 2's ``new_decision_id`` if
      exposed) so the entry satisfies the required-fields portion of the
      schema even when the decision-enum portion will reject it.
    - Wrap ``append`` in ``try/except`` catching ``ValueError`` (the parent of
      ``CandidatesLogError``) so a schema mismatch degrades to a stderr
      warning rather than a fatal exception. The user-visible stdout line in
      :func:`refresh_active` (``proceed-with-stale (audit recorded)``) is
      still emitted by the caller; the operator now sees a clear ``WARN``
      explaining the annotation was not persisted.
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
        # ``candidates_log.CandidatesLogError`` is a ``ValueError`` subclass.
        # Catching the parent class keeps us decoupled from importing the
        # exception type and survives a future enum extension that drops the
        # subclass alias.
        print(
            (
                f"[triage:refresh-active] WARN: audit annotation for "
                f"{repo}#{issue_number} not persisted -- candidates_log "
                f"rejected the entry ({type(exc).__name__}: {exc}). The "
                f"proceed-with-stale choice has been logged to stdout but "
                f"the JSONL trail does not yet recognize 'freshness-"
                f"annotation'; extend the Story 2 schema to capture it."
            ),
            file=sink,
        )


# ---------------------------------------------------------------------------
# High-level orchestration
# ---------------------------------------------------------------------------


@dataclass
class FreshnessSummary:
    """Aggregate result of a ``refresh_active`` call.

    ``skipped`` (added per Greptile review on PR #875): records every (repo,
    issue) pair whose live ``gh issue view`` fetch errored out. Surfacing the
    count prevents the false ``all N fresh`` signal that would otherwise fire
    when a network/auth outage zeroes out the drift list.
    """

    total_active: int
    drifts_detected: int
    proceeded: list[tuple[str, int]] = field(default_factory=list)
    refreshed: list[tuple[str, int]] = field(default_factory=list)
    deferred: list[tuple[str, int]] = field(default_factory=list)
    skipped: list[tuple[str, int]] = field(default_factory=list)


RefreshLocal = Callable[[str, int, Path], None]
AuditWriter = Callable[[str, int, str], None]


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

    Empty ``vbrief/active/`` is a no-op. Each drift surface routes through the
    three-way prompt; ``proceed-with-stale`` records an audit annotation via
    Story 2.
    """

    sink = out or sys.stdout
    active_dir = active_dir or (project_root / "vbrief" / "active")
    refresh_local = refresh_local or _refresh_and_update_local
    audit_writer = audit_writer or _record_audit_annotation

    active_files = _iter_active_vbriefs(active_dir)
    if not active_files:
        print("[triage:refresh-active] vbrief/active/ is empty -- no-op", file=sink)
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
            # Greptile P1 fix on PR #875: never claim ``all fresh`` when one
            # or more live fetches errored -- the cached state is unverified.
            # Greptile P1 second pass: denominate against checked (repo, issue)
            # pair count, NOT vBRIEF file count, so a single vBRIEF with three
            # failing refs reads as ``3 of 3 ... skipped`` instead of the
            # nonsensical ``3 of 1``.
            print(
                (
                    f"[triage:refresh-active] WARN: no drift detected, but "
                    f"{len(skipped_pairs)} of {len(checked_pairs)} "
                    f"(repo, issue) fetch(es) were skipped (treat freshness "
                    f"signal as unverified)"
                ),
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
                (
                    f"proceed-with-stale: cached={drift.cached_updated_at} "
                    f"live={drift.live_updated_at}"
                ),
            )
            summary.proceeded.append((drift.repo, drift.issue_number))
            print(
                (
                    f"[triage:refresh-active] {drift.repo}#{drift.issue_number} "
                    "proceed-with-stale (audit recorded)"
                ),
                file=sink,
            )
        elif choice == "refresh-and-update-local":
            refresh_local(drift.repo, drift.issue_number, project_root)
            summary.refreshed.append((drift.repo, drift.issue_number))
            print(
                (
                    f"[triage:refresh-active] {drift.repo}#{drift.issue_number} "
                    "refreshed-and-updated-local"
                ),
                file=sink,
            )
        else:
            summary.deferred.append((drift.repo, drift.issue_number))
            print(
                (
                    f"[triage:refresh-active] {drift.repo}#{drift.issue_number} "
                    "deferred-from-this-batch"
                ),
                file=sink,
            )
    return summary


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_refresh",
        description="Pre-swarm freshness gate for vbrief/active/ (#845 Story 4)",
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
    args = _build_parser().parse_args(argv)
    project_root = Path(args.project_root).resolve()
    refresh_active(project_root)
    return 0


# Re-exported helper aliases so tests can monkeypatch a single seam without
# reaching into private names. They are intentionally identifier-only -- the
# implementations live above.
fetch_live_updated_at: FetchLive = _fetch_live_updated_at
load_cached_updated_at: CacheLoader = _load_cached_updated_at
iter_active_vbriefs: Callable[[Path], list[Path]] = _iter_active_vbriefs
extract_issue_refs: Callable[[Path], list[tuple[str, int]]] = _extract_issue_refs
record_audit_annotation: Callable[..., None] = _record_audit_annotation


# Avoid the "unused import" warning for re-exported types in static analysers.
__all__ = [
    "DriftRecord",
    "FreshnessSummary",
    "PROMPT_OPTIONS",
    "detect_drift",
    "extract_issue_refs",
    "fetch_live_updated_at",
    "iter_active_vbriefs",
    "load_cached_updated_at",
    "main",
    "record_audit_annotation",
    "refresh_active",
]


if __name__ == "__main__":
    sys.exit(main())
