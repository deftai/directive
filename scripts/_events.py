"""_events.py -- behavioral-event emit helper for framework events (#635).

Lands the 4 behavioral events from ``events/registry.json`` (the unified
registry, post-#706 unification per the Repair Authority [AXIOM] proposal
in #709 + the data-file-convention follow-up in #710): paired
``session:interrupted`` / ``session:resumed``, ``plan:approved``, and
``legacy:detected``. The 5 sibling detection-bound events live in the
same registry under ``category: detection-bound`` and are emitted via
``scripts/_event_detect.py`` instead -- both helpers consume the same
data file but enforce different category boundaries so behavioral and
detection-bound emission paths remain semantically distinct.

Why a structural helper: per the canonical #642 workflow comment locked
decisions and the Rule Authority [AXIOM] block in ``main.md``, framework
events are a STRUCTURAL artifact, not prose. The emit helper + JSONL
append-only log are the deterministic encoding form; ``events/registry.json``
describes the contract.

Storage
-------
Events are appended to ``.deft/events.jsonl`` under the project root.
``.deft/`` is gitignored as "Generated Deft exports" (#401 trim arc); the
file is project-local and ephemeral. Tests inject a temp path to keep
tests hermetic.

Pairing
-------
``session:interrupted`` / ``session:resumed`` MUST be co-emitted: every
resumed event carries an ``interrupted_id`` referencing the open
interrupt. ``validate_pairing`` returns the list of orphan resumed
records; an empty list means the pair invariant holds. The vBRIEF
acceptance criterion (3) is enforced via this helper.

CLI
---
Agents emit by invoking::

    python -m scripts._events emit <name> --payload '<json>'
    python -m scripts._events emit session:interrupted \
        --session-id <s> --reason context-window-shift
    python -m scripts._events emit session:resumed \
        --session-id <s> --interrupted-id <id>
    python -m scripts._events emit plan:approved \
        --plan-ref <url> --approver <login> --approval-phrase yes
    python -m scripts._events validate-pairing

Handlers
--------
v0 of this surface is emit-only. The behavioral vBRIEF explicitly defers
downstream consumer effects (what plan:approved triggers, what action
legacy:detected drives) to follow-up work. This module exposes
``read_events`` so consumers can be written in subsequent PRs without
churning the emit contract.

Issue: #635 (epic), #642 (workflow umbrella), #634 (determinism ladder),
#709 (Repair Authority [AXIOM] -- the rule motivating the registry
unification), #710 (data-file-convention check follow-up).
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from collections.abc import Iterable
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

# Default event log location (project-local, gitignored).
DEFAULT_EVENT_LOG: Path = Path(".deft") / "events.jsonl"

# Path to the unified events registry (data file). Resolved relative to
# this module so tests and direct script invocations both find it without
# depending on cwd.
_REGISTRY_PATH: Path = (
    Path(__file__).resolve().parent.parent / "events" / "registry.json"
)

# Behavioral event category enum value -- this helper only emits events
# that carry ``category: "behavioral"`` in the unified registry. Sibling
# detection-bound events are emitted via ``scripts/_event_detect.py``.
_BEHAVIORAL_CATEGORY: str = "behavioral"


@lru_cache(maxsize=1)
def _load_behavioral_registry() -> tuple[
    frozenset[str], dict[str, tuple[str, ...]]
]:
    """Return ``(KNOWN_EVENTS, REQUIRED_PAYLOAD)`` from the unified registry.

    Reads ``events/registry.json`` once per process and filters to events
    whose ``category`` matches ``_BEHAVIORAL_CATEGORY``. Required payload
    fields are derived from a hard-coded contract (per-event tuples below)
    rather than the registry's free-form payload-description map -- the
    registry's payload field describes shape and intent for humans/schema
    consumers, but the emit-time required-field gate is a code contract
    that the unified registry's free-form descriptions don't encode
    losslessly. The hard-coded ``_REQUIRED_BEHAVIORAL_PAYLOAD`` below is
    the single source of truth for emit-time payload validation.
    """
    data = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
    behavioral_names = frozenset(
        event["name"]
        for event in data.get("events", [])
        if isinstance(event, dict)
        and event.get("category") == _BEHAVIORAL_CATEGORY
        and "name" in event
    )
    return behavioral_names, dict(_REQUIRED_BEHAVIORAL_PAYLOAD)


# Per-event required payload fields. Single source of truth for the
# emit-time required-field gate. Mirrors the canonical payload contracts
# documented in events/registry.json under category=behavioral.
_REQUIRED_BEHAVIORAL_PAYLOAD: dict[str, tuple[str, ...]] = {
    "session:interrupted": ("session_id", "reason"),
    "session:resumed": ("session_id", "interrupted_id"),
    "plan:approved": ("plan_ref", "approver"),
    "legacy:detected": ("title", "source", "range", "size_bytes"),
}


def _registered_behavioral_names() -> frozenset[str]:
    return _load_behavioral_registry()[0]


def _required_payload_map() -> dict[str, tuple[str, ...]]:
    return _load_behavioral_registry()[1]


def clear_registry_cache() -> None:
    """Reset the in-process registry cache. Used by tests."""
    _load_behavioral_registry.cache_clear()


class _LazyKnownEvents:
    """Lazy proxy for ``KNOWN_EVENTS`` that hits the unified registry.

    Read-only ``frozenset``-compatible accessor so existing test code
    using ``KNOWN_EVENTS == frozenset({...})`` and ``name in KNOWN_EVENTS``
    continues to work unchanged. Resolves on every access so a test that
    points the registry at a fixture path can still re-read after
    ``clear_registry_cache()``.
    """

    def _resolved(self) -> frozenset[str]:
        return _registered_behavioral_names()

    def __contains__(self, item: object) -> bool:
        return item in self._resolved()

    def __iter__(self):
        return iter(self._resolved())

    def __len__(self) -> int:
        return len(self._resolved())

    def __eq__(self, other: object) -> bool:
        return self._resolved() == other

    def __hash__(self) -> int:
        return hash(self._resolved())

    def __repr__(self) -> str:
        return repr(self._resolved())


class _LazyRequiredPayload:
    """Lazy proxy for ``REQUIRED_PAYLOAD`` -- behaves like a read-only dict."""

    def _resolved(self) -> dict[str, tuple[str, ...]]:
        return _required_payload_map()

    def __contains__(self, item: object) -> bool:
        return item in self._resolved()

    def __getitem__(self, key: str) -> tuple[str, ...]:
        return self._resolved()[key]

    def get(
        self, key: str, default: tuple[str, ...] = ()
    ) -> tuple[str, ...]:
        return self._resolved().get(key, default)

    def __iter__(self):
        return iter(self._resolved())

    def __len__(self) -> int:
        return len(self._resolved())

    def items(self):
        return self._resolved().items()

    def keys(self):
        return self._resolved().keys()

    def values(self):
        return self._resolved().values()

    def __eq__(self, other: object) -> bool:
        return self._resolved() == other

    def __repr__(self) -> str:
        return repr(self._resolved())


# Public lazy module-level constants. Existing callers (tests, CLI, the
# migrator's _legacy_event_emitter) keep their existing import shape:
#   from _events import KNOWN_EVENTS, REQUIRED_PAYLOAD
# but the values now resolve from events/registry.json on each access
# rather than a hard-coded frozenset.
KNOWN_EVENTS: _LazyKnownEvents = _LazyKnownEvents()
REQUIRED_PAYLOAD: _LazyRequiredPayload = _LazyRequiredPayload()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _resolve_log_path(log_path: Path | str | None) -> Path:
    if log_path is not None:
        return Path(log_path)
    env_path = os.environ.get("DEFT_EVENT_LOG")
    if env_path:
        return Path(env_path)
    return DEFAULT_EVENT_LOG


def _new_event_id() -> str:
    """Return a sortable, collision-resistant event id.

    Format: ``<unix-ns>-<8-hex-rand>``. Sortable by emission time so the
    log can be diffed cleanly; rand suffix prevents collision when two
    emissions land in the same nanosecond (rare but possible on Windows).
    """
    return f"{time.time_ns()}-{secrets.token_hex(4)}"


def emit(
    name: str,
    payload: dict[str, Any],
    *,
    log_path: Path | str | None = None,
    detected_at: str | None = None,
) -> dict[str, Any]:
    """Append an event record to the JSONL log and return it.

    ``name`` MUST be a registered event from ``KNOWN_EVENTS``. ``payload``
    MUST contain the required fields for that event per
    ``REQUIRED_PAYLOAD``. ``detected_at`` defaults to the current UTC
    timestamp (ISO 8601, second precision).

    Raises ``ValueError`` for an unknown event name or a missing required
    payload field.
    """
    behavioral_names = _registered_behavioral_names()
    if name not in behavioral_names:
        raise ValueError(
            f"unknown event {name!r}; expected one of "
            f"{sorted(behavioral_names)}"
        )
    required = _required_payload_map().get(name, ())
    missing = [k for k in required if k not in payload]
    if missing:
        raise ValueError(
            f"event {name!r} payload missing required fields: {missing}"
        )

    record: dict[str, Any] = {
        "event": name,
        "id": _new_event_id(),
        "detected_at": detected_at
        or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "payload": dict(payload),
    }

    target = _resolve_log_path(log_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)
    with target.open("a", encoding="utf-8") as fh:
        fh.write(line)
        fh.write("\n")
    return record


def read_events(
    log_path: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Return all events from the log in emission order.

    Missing log returns an empty list. Malformed lines are skipped (the
    log is append-only; a partial last line could survive a crash).
    """
    target = _resolve_log_path(log_path)
    if not target.exists():
        return []
    out: list[dict[str, Any]] = []
    with target.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def validate_pairing(
    events: Iterable[dict[str, Any]] | None = None,
    *,
    log_path: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Return the list of orphan ``session:resumed`` records.

    A ``session:resumed`` is an orphan if its ``interrupted_id`` does not
    match the ``id`` of any prior, *unconsumed* ``session:interrupted``
    in the same log. Each interrupt id satisfies at most one resumed
    event -- a second ``session:resumed`` referencing the same
    ``interrupted_id`` is treated as an orphan (1:1 pairing per the
    vBRIEF "co-emitted" semantics, Greptile #706 P2).

    Pass ``events`` explicitly to validate an in-memory stream; otherwise
    the helper reads the configured log path.
    """
    if events is None:
        events = read_events(log_path=log_path)
    open_interrupts: set[str] = set()
    orphans: list[dict[str, Any]] = []
    for record in events:
        name = record.get("event")
        if name == "session:interrupted":
            event_id = record.get("id")
            if isinstance(event_id, str):
                open_interrupts.add(event_id)
        elif name == "session:resumed":
            payload = record.get("payload") or {}
            ref = payload.get("interrupted_id")
            if isinstance(ref, str) and ref in open_interrupts:
                # 1:1 pairing: consume the interrupt id so a second
                # session:resumed referencing the same id is reported
                # as an orphan.
                open_interrupts.discard(ref)
            else:
                orphans.append(record)
    return orphans


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_payload_args(args: argparse.Namespace) -> dict[str, Any]:
    """Build the payload dict from the parsed CLI args.

    The ``--payload`` JSON arg, when present, is the seed; named flags
    overlay on top so agents can mix structured input with one-off
    fields.
    """
    payload: dict[str, Any] = {}
    if args.payload:
        try:
            data = json.loads(args.payload)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--payload is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise SystemExit("--payload must be a JSON object")
        payload.update(data)

    # Named overlays (only set if provided).
    name_to_field = {
        "session_id": args.session_id,
        "reason": args.reason,
        "interrupted_id": args.interrupted_id,
        "plan_ref": args.plan_ref,
        "approver": args.approver,
        "approval_phrase": args.approval_phrase,
        "pr_number": args.pr_number,
        "detail": args.detail,
        "title": args.title,
        "source": args.source,
        "range": args.range_,
        "size_bytes": args.size_bytes,
        "inline": args.inline,
        "sidecar": args.sidecar,
        "flagged": args.flagged,
    }
    for k, v in name_to_field.items():
        if v is not None:
            payload[k] = v
    return payload


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scripts._events",
        description="Emit and inspect structural framework events.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    emit_p = sub.add_parser("emit", help="Append an event to the log.")
    emit_p.add_argument("name", choices=sorted(_registered_behavioral_names()))
    emit_p.add_argument("--payload", help="JSON object with the payload.")
    emit_p.add_argument("--log", dest="log", help="Override event log path.")
    # Convenience flags. Using --range- on the dest avoids shadowing the
    # builtin ``range``.
    emit_p.add_argument("--session-id")
    emit_p.add_argument("--reason")
    emit_p.add_argument("--interrupted-id")
    emit_p.add_argument("--plan-ref")
    emit_p.add_argument("--approver")
    emit_p.add_argument("--approval-phrase")
    emit_p.add_argument("--pr-number", type=int)
    emit_p.add_argument("--detail")
    emit_p.add_argument("--title")
    emit_p.add_argument("--source")
    emit_p.add_argument("--range", dest="range_")
    emit_p.add_argument("--size-bytes", type=int)
    emit_p.add_argument(
        "--inline",
        type=lambda s: s.lower() in {"1", "true", "yes"},
        default=None,
    )
    emit_p.add_argument("--sidecar")
    emit_p.add_argument(
        "--flagged",
        type=lambda s: s.lower() in {"1", "true", "yes"},
        default=None,
    )

    list_p = sub.add_parser("list", help="Print events as JSON lines.")
    list_p.add_argument("--log", dest="log", help="Override event log path.")

    pair_p = sub.add_parser(
        "validate-pairing",
        help="Exit non-zero if any session:resumed is orphan.",
    )
    pair_p.add_argument("--log", dest="log", help="Override event log path.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    if args.cmd == "emit":
        payload = _parse_payload_args(args)
        try:
            record = emit(args.name, payload, log_path=args.log)
        except ValueError as exc:
            sys.stderr.write(f"emit failed: {exc}\n")
            return 2
        sys.stdout.write(json.dumps(record, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0

    if args.cmd == "list":
        for record in read_events(log_path=args.log):
            sys.stdout.write(
                json.dumps(record, ensure_ascii=False, sort_keys=True)
            )
            sys.stdout.write("\n")
        return 0

    if args.cmd == "validate-pairing":
        orphans = validate_pairing(log_path=args.log)
        if orphans:
            sys.stderr.write(
                f"orphan session:resumed records ({len(orphans)}): "
                f"{[r.get('id') for r in orphans]}\n"
            )
            return 1
        sys.stdout.write("ok\n")
        return 0

    parser.print_help()
    return 2


__all__ = [
    "DEFAULT_EVENT_LOG",
    "KNOWN_EVENTS",
    "REQUIRED_PAYLOAD",
    "clear_registry_cache",
    "emit",
    "main",
    "read_events",
    "validate_pairing",
]


if __name__ == "__main__":  # pragma: no cover - thin CLI shim
    raise SystemExit(main())
