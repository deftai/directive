#!/usr/bin/env python3
"""platform_capabilities.py -- read-only worker runtime capability probe (#1557a).

Classifies the execution envelope a swarm worker will actually run in:

- ``local-unsandboxed`` -- interactive local shell without Cursor native sandbox.
- ``cursor-native-sandbox`` -- Cursor native sandbox with UID remap to the host user.
- ``cloud-headless`` -- cloud or headless agent runtimes without local host context.

The probe is intentionally read-only: it inspects environment variables,
``/proc/self/uid_map`` (when available), process identity, and basic cwd
ownership facts. It does not mutate credentials, shell out to ``gh``, or
touch vBRIEF lifecycle files.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import getpass
import json
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

RUNTIME_MODE_LOCAL_UNSANDBOXED = "local-unsandboxed"
RUNTIME_MODE_CURSOR_NATIVE_SANDBOX = "cursor-native-sandbox"
RUNTIME_MODE_CLOUD_HEADLESS = "cloud-headless"

KNOWN_RUNTIME_MODES: frozenset[str] = frozenset(
    {
        RUNTIME_MODE_LOCAL_UNSANDBOXED,
        RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        RUNTIME_MODE_CLOUD_HEADLESS,
    }
)

IDENTITY_REAL_ROOT = "real-root"
IDENTITY_SANDBOX_REMAPPED_LOCAL_USER = "sandbox-remapped-local-user"
IDENTITY_LOCAL_USER = "local-user"
IDENTITY_UNKNOWN = "unknown"

_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Env vars surfaced in the report (values only; never treated as secrets here).
_CURSOR_SIGNAL_VARS = (
    "CURSOR_SANDBOX",
    "CURSOR_SANDBOX_LANDLOCK_STATUS",
    "CURSOR_ORIG_UID",
    "CURSOR_ORIG_GID",
    "CURSOR_AGENT",
    "CURSOR_COMPOSER",
)

_CLOUD_SIGNAL_VARS = (
    "CURSOR_AGENT",
    "GROK_BUILD",
    "DEFT_AGENT_RUNTIME",
    "CI",
    "GITHUB_ACTIONS",
    "BUILDKITE",
)


@dataclass(frozen=True)
class UidMapEntry:
    """One row from ``/proc/self/uid_map``."""

    inside_id: int
    outside_id: int
    length: int


@dataclass(frozen=True)
class OwnershipFacts:
    """Basic ownership interpretation for a path (typically cwd)."""

    path: str
    uid: int
    gid: int
    interpreted_as_sandbox_view: bool


@dataclass(frozen=True)
class RuntimeCapabilityReport:
    """Structured runtime capability probe output."""

    runtime_mode: str
    identity_kind: str
    effective_uid: int | None
    effective_username: str | None
    uid_map: tuple[UidMapEntry, ...]
    cursor_orig_uid: int | None
    cursor_orig_gid: int | None
    sandbox_uid_remap: bool
    ownership: OwnershipFacts | None
    signals: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        payload = dataclasses.asdict(self)
        if self.ownership is not None:
            payload["ownership"] = dataclasses.asdict(self.ownership)
        payload["uid_map"] = [dataclasses.asdict(entry) for entry in self.uid_map]
        return payload


def _env_truthy(environ: Mapping[str, str], name: str) -> bool:
    return environ.get(name, "").strip().lower() in _TRUTHY


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def read_uid_map(path: Path) -> tuple[UidMapEntry, ...]:
    """Parse a uid_map file (typically ``/proc/self/uid_map``)."""
    if not path.is_file():
        return ()
    entries: list[UidMapEntry] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 3:
            continue
        try:
            inside_id, outside_id, length = (int(parts[0]), int(parts[1]), int(parts[2]))
        except ValueError:
            continue
        entries.append(
            UidMapEntry(inside_id=inside_id, outside_id=outside_id, length=length)
        )
    return tuple(entries)


def detect_sandbox_uid_remap(
    uid_map: Sequence[UidMapEntry],
    *,
    effective_uid: int | None,
    cursor_orig_uid: int | None,
) -> bool:
    """True when sandbox UID 0 is remapped to the host user, not real root."""
    if effective_uid != 0:
        return False
    if cursor_orig_uid is None:
        return False
    return any(
        entry.inside_id == 0 and entry.outside_id == cursor_orig_uid
        for entry in uid_map
    )


def classify_identity_kind(
    *,
    effective_uid: int | None,
    sandbox_uid_remap: bool,
) -> str:
    if effective_uid is None:
        return IDENTITY_UNKNOWN
    if effective_uid == 0:
        if sandbox_uid_remap:
            return IDENTITY_SANDBOX_REMAPPED_LOCAL_USER
        return IDENTITY_REAL_ROOT
    return IDENTITY_LOCAL_USER


def _is_cloud_headless(environ: Mapping[str, str]) -> bool:
    if _env_truthy(environ, "CURSOR_AGENT"):
        return True
    if _env_truthy(environ, "GROK_BUILD"):
        return True
    runtime = environ.get("DEFT_AGENT_RUNTIME", "").strip().lower()
    if runtime in {"grok-build", "cloud", "headless"}:
        return True
    if _env_truthy(environ, "GITHUB_ACTIONS") or _env_truthy(environ, "BUILDKITE"):
        return True
    return _env_truthy(environ, "CI") and not _env_truthy(environ, "CURSOR_COMPOSER")


def _is_cursor_native_sandbox(
    environ: Mapping[str, str],
    *,
    sandbox_uid_remap: bool,
) -> bool:
    if sandbox_uid_remap:
        return True
    if _env_truthy(environ, "CURSOR_SANDBOX"):
        return True
    return bool(environ.get("CURSOR_SANDBOX_LANDLOCK_STATUS", "").strip())


def classify_runtime_mode(
    environ: Mapping[str, str],
    *,
    sandbox_uid_remap: bool,
) -> str:
    if _is_cloud_headless(environ):
        return RUNTIME_MODE_CLOUD_HEADLESS
    if _is_cursor_native_sandbox(environ, sandbox_uid_remap=sandbox_uid_remap):
        return RUNTIME_MODE_CURSOR_NATIVE_SANDBOX
    return RUNTIME_MODE_LOCAL_UNSANDBOXED


def _read_ownership(path: Path, *, sandbox_uid_remap: bool) -> OwnershipFacts | None:
    try:
        stat_result = path.stat()
    except OSError:
        return None
    return OwnershipFacts(
        path=str(path),
        uid=stat_result.st_uid,
        gid=stat_result.st_gid,
        interpreted_as_sandbox_view=sandbox_uid_remap,
    )


def _collect_signals(environ: Mapping[str, str]) -> dict[str, str]:
    names = sorted(set(_CURSOR_SIGNAL_VARS + _CLOUD_SIGNAL_VARS))
    return {name: environ[name] for name in names if name in environ}


def probe_runtime_capabilities(
    *,
    environ: Mapping[str, str] | None = None,
    uid_map_path: Path | str | None = None,
    cwd: Path | str | None = None,
    effective_uid_override: int | None = None,
) -> RuntimeCapabilityReport:
    """Probe the current (or injected) worker runtime envelope."""
    env = dict(os.environ if environ is None else environ)

    effective_uid: int | None
    if effective_uid_override is not None:
        effective_uid = effective_uid_override
    elif hasattr(os, "getuid"):
        effective_uid = os.getuid()
    else:
        effective_uid = None

    effective_username = env.get("USER") or env.get("USERNAME")
    if not effective_username:
        with contextlib.suppress(Exception):
            effective_username = getpass.getuser()

    cursor_orig_uid = _parse_int(env.get("CURSOR_ORIG_UID"))
    cursor_orig_gid = _parse_int(env.get("CURSOR_ORIG_GID"))

    uid_map_file = (
        Path(uid_map_path)
        if uid_map_path is not None
        else Path("/proc/self/uid_map")
    )
    uid_map = read_uid_map(uid_map_file)

    sandbox_uid_remap = detect_sandbox_uid_remap(
        uid_map,
        effective_uid=effective_uid,
        cursor_orig_uid=cursor_orig_uid,
    )
    identity_kind = classify_identity_kind(
        effective_uid=effective_uid,
        sandbox_uid_remap=sandbox_uid_remap,
    )
    runtime_mode = classify_runtime_mode(
        env,
        sandbox_uid_remap=sandbox_uid_remap,
    )

    cwd_path = Path(cwd) if cwd is not None else Path.cwd()
    ownership = _read_ownership(cwd_path, sandbox_uid_remap=sandbox_uid_remap)

    return RuntimeCapabilityReport(
        runtime_mode=runtime_mode,
        identity_kind=identity_kind,
        effective_uid=effective_uid,
        effective_username=effective_username,
        uid_map=uid_map,
        cursor_orig_uid=cursor_orig_uid,
        cursor_orig_gid=cursor_orig_gid,
        sandbox_uid_remap=sandbox_uid_remap,
        ownership=ownership,
        signals=_collect_signals(env),
    )


def get_platform_capabilities() -> RuntimeCapabilityReport:
    """Return runtime capabilities for the live worker environment."""
    return probe_runtime_capabilities()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only worker runtime capability probe (#1557a)."
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit structured JSON on stdout.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    report = get_platform_capabilities()
    if args.json:
        print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    else:
        print(f"runtime_mode={report.runtime_mode}")
        print(f"identity_kind={report.identity_kind}")
        if report.sandbox_uid_remap:
            print(
                "sandbox_uid_remap=true "
                f"(host_uid={report.cursor_orig_uid})"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
