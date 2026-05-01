"""_event_detect.py -- Detection-bound emission helper for the Deft framework.

Wires the 5 detection-bound events documented in ``events/registry.json`` to a
uniform record shape (``event``, ``detected_at``, ``payload``). Detectors live
in their existing call sites (``scripts/vbrief_validate.py``,
``scripts/_vbrief_safety.py``, ``run::_check_upgrade_gate``,
``run::_detect_pre_cutover_legacy``); this module provides:

- :func:`emit` -- build a uniform event record and optionally append it to a
  log file pointed at by ``DEFT_EVENT_LOG``.
- :func:`detect_agents_md_stale` -- codifies the QUICK-START.md Step 2b
  detection logic (referenced skill paths missing or carrying the
  ``<!-- deft:deprecated-skill-redirect -->`` sentinel) so the event has a
  Python detection point alongside the prose-encoded version.

Default behavior is silent: ``emit`` returns the record and does NOT print or
write unless ``DEFT_EVENT_LOG`` is set. Existing CLI output of the wrapped
detectors is preserved verbatim.

Filename note (#635): this file is intentionally NOT named ``_events.py`` to
avoid file-level merge conflicts with the sibling events-behavioral vBRIEF
that owns ``scripts/_events.py`` for behavioral-event emission. Post-merge
consolidation may unify both helpers under one canonical name.

Issue: #635 (epic), authority: #642 canonical workflow comment.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Path to the registry, resolved relative to this file so tests and direct
# script invocations both find it without depending on cwd.
_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "events" / "registry.json"

# Sentinel used by SKILL.md redirect stubs (see QUICK-START.md Step 2b and
# tests/content/test_deprecated_skill_redirects.py). Kept in sync with the
# stub-emission sites.
DEPRECATED_SKILL_REDIRECT_SENTINEL = "<!-- deft:deprecated-skill-redirect -->"

# 200-character window used by QUICK-START.md Step 2b to bound the sentinel
# scan. Matches the test_deprecated_skill_redirects.py::test_stub_has_sentinel
# guarantee that every stub places the sentinel within this window.
_SKILL_SENTINEL_WINDOW = 200

# Token shape extracted from AGENTS.md: ``deft/skills/<name>/SKILL.md`` where
# ``<name>`` is the slug between ``deft/skills/`` and ``/SKILL.md``. Anchored
# with a non-word boundary on the leading edge so adjacent backticks/list
# bullets do not break the match. The slug allows lowercase, digits, dashes,
# and underscores so any future skill naming convention still matches.
_SKILL_PATH_RE = re.compile(r"deft/skills/(?P<slug>[a-z0-9_-]+)/SKILL\.md")

# Bound payload list lengths so a pathological detector run cannot produce a
# multi-megabyte event record.
_MAX_PAYLOAD_LIST_LEN = 50

# Cached registry parsed lazily on first emit() call; resets on
# clear_registry_cache() in tests.
_REGISTRY_CACHE: dict[str, Any] | None = None


class EventEmissionError(Exception):
    """Raised when emit() is called with an unregistered event name.

    Surfaces as a hard error so detectors cannot silently emit a typo'd or
    unregistered event name; the registry is the single source of truth.
    """


def clear_registry_cache() -> None:
    """Reset the in-process registry cache. Used by tests."""
    global _REGISTRY_CACHE
    _REGISTRY_CACHE = None


def load_registry(registry_path: Path | None = None) -> dict[str, Any]:
    """Return the parsed event registry. Cached after first call.

    ``registry_path`` is mainly for tests that want to point at a fixture;
    production callers should pass nothing and let the module-level default
    resolve.
    """
    global _REGISTRY_CACHE
    path = registry_path or _REGISTRY_PATH
    if registry_path is None and _REGISTRY_CACHE is not None:
        return _REGISTRY_CACHE
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if registry_path is None:
        _REGISTRY_CACHE = data
    return data


def registered_event_names(registry_path: Path | None = None) -> set[str]:
    """Return the set of canonical event names in the registry."""
    registry = load_registry(registry_path)
    events = registry.get("events", [])
    return {evt["name"] for evt in events if isinstance(evt, dict) and "name" in evt}


def now_utc_iso() -> str:
    """UTC ISO-8601 timestamp at seconds precision (matches event-record schema)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _coerce_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Cap list-shaped payload values so emitted records stay bounded.

    Each list value is truncated to ``_MAX_PAYLOAD_LIST_LEN`` entries; non-list
    values pass through unchanged. The cap matches the documented payload
    contracts (e.g. ``vbrief:invalid`` ``errors``/``warnings`` arrays).
    """
    coerced: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, list) and len(value) > _MAX_PAYLOAD_LIST_LEN:
            coerced[key] = list(value[:_MAX_PAYLOAD_LIST_LEN])
        else:
            coerced[key] = value
    return coerced


def emit(
    name: str,
    payload: dict[str, Any] | None = None,
    *,
    registry_path: Path | None = None,
    log_path_env: str = "DEFT_EVENT_LOG",
) -> dict[str, Any]:
    """Build a uniform event record and (optionally) append it to a log file.

    Returns the record so in-process consumers can inspect it directly.
    Raises :class:`EventEmissionError` if ``name`` is not in the registry.

    When the environment variable named by ``log_path_env`` (default
    ``DEFT_EVENT_LOG``) is set to a writable path, each emission is appended
    as a single JSON line. Failures to write the log are swallowed so the
    detector's primary CLI behavior is never disrupted by the events surface.
    """
    if payload is None:
        payload = {}
    if name not in registered_event_names(registry_path):
        raise EventEmissionError(
            f"Event {name!r} is not registered in events/registry.json. "
            "Add it to the registry before emitting."
        )
    record: dict[str, Any] = {
        "event": name,
        "detected_at": now_utc_iso(),
        "payload": _coerce_payload(payload),
    }

    log_target = os.environ.get(log_path_env)
    if log_target:
        try:
            log_path = Path(log_target)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            # The events surface MUST NOT break the wrapped CLI; swallow
            # log-write failures (disk full, permission denied, etc.).
            pass

    return record


# ---------------------------------------------------------------------------
# detect_agents_md_stale -- codifies QUICK-START.md Step 2b
# ---------------------------------------------------------------------------


def detect_agents_md_stale(
    project_root: Path,
    *,
    framework_root: Path | None = None,
) -> dict[str, list[str] | str] | None:
    """Return an ``agents-md:stale`` payload if AGENTS.md references stale paths.

    Implements QUICK-START.md Step 2b deterministically: parses
    ``project_root/AGENTS.md`` for ``deft/skills/<name>/SKILL.md`` tokens and
    checks each path's existence and the first
    :data:`_SKILL_SENTINEL_WINDOW` characters for the
    :data:`DEPRECATED_SKILL_REDIRECT_SENTINEL` sentinel.

    Returns ``None`` when AGENTS.md is absent OR when no referenced skill
    paths are stale. Returns the event payload (``agents_md_path``,
    ``missing_paths``, ``redirect_paths``) when at least one stale or
    redirect path is found.

    ``framework_root`` defaults to ``project_root / "deft"`` (the consumer
    layout). Pass an explicit path for the deft-itself layout (where this
    repo IS the framework root) so the test suite can exercise both.
    """
    agents_md = project_root / "AGENTS.md"
    if not agents_md.is_file():
        return None
    try:
        content = agents_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    framework = framework_root if framework_root is not None else project_root / "deft"
    missing_paths: list[str] = []
    redirect_paths: list[str] = []
    seen: set[str] = set()
    for match in _SKILL_PATH_RE.finditer(content):
        token = match.group(0)  # full deft/skills/<name>/SKILL.md
        if token in seen:
            continue
        seen.add(token)
        slug = match.group("slug")
        candidate = framework / "skills" / slug / "SKILL.md"
        if not candidate.is_file():
            missing_paths.append(token)
            continue
        try:
            head = candidate.read_text(encoding="utf-8", errors="replace")[
                :_SKILL_SENTINEL_WINDOW
            ]
        except OSError:
            # Treat unreadable files as missing rather than silently passing.
            missing_paths.append(token)
            continue
        if DEPRECATED_SKILL_REDIRECT_SENTINEL in head:
            redirect_paths.append(token)

    if not missing_paths and not redirect_paths:
        return None

    return {
        "agents_md_path": str(agents_md.resolve()),
        "missing_paths": missing_paths,
        "redirect_paths": redirect_paths,
    }


# ---------------------------------------------------------------------------
# detect_remote_drift -- payload builder for run::cmd_check_updates (#801)
# ---------------------------------------------------------------------------


def detect_remote_drift(
    project_root: Path,
    *,
    probe_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Build a ``framework:remote-drift`` payload from a probe result.

    Mirrors :func:`detect_agents_md_stale` in shape: returns ``None`` when no
    drift is observed, returns the structured payload when ``probe_result``
    indicates BEHIND. The actual ``git ls-remote`` probe lives in
    ``run::_run_remote_probe`` (kept there so the bootstrap entry point is
    not coupled to the events surface at import time, mirroring why
    ``run::_emit_event_safe`` lazy-imports ``emit`` rather than depending on
    it directly). This helper is the structural payload constructor: tests
    can pass canned probe results to assert the registry-conformant shape
    without monkeypatching subprocess.

    Returns the canonical payload dict::

        {
            "project_root": <abs>,
            "current_version": <run.VERSION>,
            "remote_version": <vX.Y.Z tag>,
            "upstream_url": <git-remote-url>,
            "commits_behind": <int|null>,
        }

    when ``probe_result.get("status") == "behind"``; otherwise returns None.
    """
    if probe_result is None:
        return None
    if probe_result.get("status") != "behind":
        return None
    return {
        "project_root": str(Path(project_root).resolve()),
        "current_version": probe_result.get("current"),
        "remote_version": probe_result.get("remote"),
        "upstream_url": probe_result.get("upstream_url", ""),
        "commits_behind": probe_result.get("commits_behind", None),
    }


__all__ = [
    "DEPRECATED_SKILL_REDIRECT_SENTINEL",
    "EventEmissionError",
    "clear_registry_cache",
    "detect_agents_md_stale",
    "detect_remote_drift",
    "emit",
    "load_registry",
    "now_utc_iso",
    "registered_event_names",
]
