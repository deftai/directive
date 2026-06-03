#!/usr/bin/env python3
"""preflight_architecture_sor.py -- system-of-record architecture gate.

Deterministic preflight for stateful work. The gate answers one question:

    Is this the correct system of record for this kind of state?

Two modes are supported:

- Story/spec mode: ``--story-path <path>`` validates the story's
  ``architecture.systemOfRecord`` design record before implementation.
- Diff mode: ``--base-ref <ref>`` scans changed runtime code for risky
  persistence signals and requires a matching design record, either supplied
  via ``--story-path`` or present on exactly one changed vBRIEF.

Exit codes:

- 0: pass
- 1: architecture violation
- 2: gate misconfigured or unable to inspect required inputs
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Make sibling helper modules importable when invoked as
# ``python scripts/preflight_architecture_sor.py`` from any working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

STATE_CLASSIFICATIONS = frozenset(
    {
        "durable_product_state",
        "auth_session_state",
        "authorization_state",
        "audit_event_state",
        "external_integration_state",
        "canonical_artifact",
        "cache",
        "projection",
        "import_export_artifact",
        "dev_only_fixture",
        "ephemeral_ui_state",
    }
)

DURABLE_CLASSIFICATIONS = frozenset(
    {
        "durable_product_state",
        "auth_session_state",
        "authorization_state",
        "audit_event_state",
        "external_integration_state",
    }
)

SECURITY_CLASSIFICATIONS = frozenset({"auth_session_state", "authorization_state"})

LOCAL_STORAGE_CLASSES = frozenset(
    {
        "json_file",
        "yaml_file",
        "toml_file",
        "sqlite_file",
        "browser_storage",
        "in_memory",
        "local_config",
        "filesystem",
    }
)

FILE_STORAGE_CLASSES = frozenset({"json_file", "yaml_file", "toml_file", "filesystem"})

DB_STORAGE_ALIASES = frozenset(
    {
        "application_database",
        "database",
        "db",
        "postgres",
        "postgresql",
        "mysql",
        "mariadb",
        "sqlite",
        "sqlite_file",
        "sql",
        "dynamodb",
        "firestore",
        "cosmosdb",
    }
)

EXTERNAL_STORAGE_ALIASES = frozenset(
    {
        "external_service",
        "service",
        "provider",
        "external_provider",
        "third_party_provider",
        "api_provider",
    }
)

STORAGE_ALIASES: dict[str, frozenset[str]] = {
    "json_file": frozenset({"json", "json_file", "local_json", "mutable_json"}),
    "yaml_file": frozenset({"yaml", "yml", "yaml_file", "local_yaml", "mutable_yaml"}),
    "toml_file": frozenset({"toml", "toml_file", "local_toml", "mutable_toml"}),
    "sqlite_file": frozenset({"sqlite", "sqlite_file", "sqlite_db", "db_file", "local_db"}),
    "browser_storage": frozenset(
        {"browser_storage", "local_storage", "session_storage", "indexeddb", "indexed_db"}
    ),
    "in_memory": frozenset({"in_memory", "memory", "process_memory", "process_local"}),
    "filesystem": frozenset({"filesystem", "file", "files", "local_file", "local_files"}),
    "database": DB_STORAGE_ALIASES,
    "external_service": EXTERNAL_STORAGE_ALIASES,
}

DURABLE_REQUIRED_FIELDS = (
    "owner",
    "approvedStorage",
    "permissionBoundary",
    "migrationRequired",
    "auditRequired",
    "concurrencyRequired",
    "concurrencySemantics",
    "transactionBoundary",
    "recoverySemantics",
    "conflictDetection",
    "deleteSemantics",
    "migrationPath",
)

REFERENCE_EVIDENCE_GROUPS = {
    "persistence": frozenset({"persistence", "database", "schema", "storage", "repository"}),
    "auth": frozenset({"auth", "authentication", "session", "identity"}),
    "permission": frozenset({"permission", "authorization", "ownership", "membership", "role"}),
}

LOW_RISK_PATH_PREFIXES = (
    ".github/",
    "docs/",
    "history/",
    "meta/",
    "references/",
    "templates/",
    "tests/",
    "vbrief/",
)

LOW_RISK_SUFFIXES = frozenset({".md", ".rst", ".txt"})

SCANNER_EXEMPT_PATHS = frozenset(
    {
        "scripts/preflight_architecture_sor.py",
        "scripts/_sor_gate_diff.py",
    }
)


@dataclass(frozen=True)
class GateFinding:
    """Human-readable architecture violation."""

    reason: str
    required_fix: str
    state_surface: str | None = None
    classification: str | None = None
    detected_storage: str | None = None
    approved_storage: str | None = None


@dataclass(frozen=True)
class GateResult:
    """Pure-data result of a gate evaluation."""

    code: int
    message: str
    findings: tuple[GateFinding, ...] = ()


@dataclass(frozen=True)
class DetectedSignal:
    """Stateful signal detected in a diff."""

    kind: str
    path: str
    line: int | None
    detail: str
    storage: str | None = None


def _norm(value: object) -> str:
    text = str(value).strip().lower()
    text = re.sub(r"[\s./:-]+", "_", text)
    text = re.sub(r"_+", "_", text)
    return text.strip("_")


def _as_string_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _non_empty(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict)):
        return bool(value)
    if isinstance(value, bool):
        return True
    return value is not None


def _truthy_flag(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "guarded", "excluded"}
    return False


def _contains_any(text: str, tokens: frozenset[str]) -> bool:
    normalised = _norm(text)
    return any(token in normalised for token in tokens)


def _storage_matches(storage: str, declared: object) -> bool:
    wanted = _norm(storage)
    aliases = {wanted}
    aliases.update(STORAGE_ALIASES.get(wanted, frozenset()))
    if wanted in DB_STORAGE_ALIASES:
        aliases.update(DB_STORAGE_ALIASES)
    if wanted in EXTERNAL_STORAGE_ALIASES:
        aliases.update(EXTERNAL_STORAGE_ALIASES)

    long_aliases = {alias for alias in aliases if len(alias) > 6}
    for item in _as_string_list(declared):
        token = _norm(item)
        if token in aliases:
            return True
        if len(token) > 6 and any(alias in token for alias in long_aliases):
            return True
    return False


def _approved_storage_text(surface: dict[str, Any]) -> str:
    values = _as_string_list(surface.get("approvedStorage"))
    return ", ".join(values) if values else "<missing>"


def _storage_is_local_unsafe(value: object) -> bool:
    for item in _as_string_list(value):
        token = _norm(item)
        if token in LOCAL_STORAGE_CLASSES:
            return True
        if any(alias in token for alias in LOCAL_STORAGE_CLASSES):
            return True
    return False


def _approved_database(value: object) -> bool:
    return any(_storage_matches("database", item) for item in _as_string_list(value))


def _approved_external(value: object) -> bool:
    return any(_storage_matches("external_service", item) for item in _as_string_list(value))


def _load_json_file(path: Path) -> tuple[dict[str, Any] | None, GateResult | None]:
    if not path.exists():
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: story path not found: {path}",
        )
    if not path.is_file():
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: story path is not a file: {path}",
        )
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: could not read {path}: {exc}",
        )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: {path} is not valid JSON: "
            f"{exc.msg} (line {exc.lineno})",
        )
    if not isinstance(payload, dict):
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: {path} top-level value is not an object",
        )
    return payload, None


def _system_of_record(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return the typed SOR block from a vBRIEF-like payload."""
    architecture = payload.get("architecture")
    if isinstance(architecture, dict) and isinstance(architecture.get("systemOfRecord"), dict):
        return architecture["systemOfRecord"]

    # Compatibility path for early adopters that nest extensions under plan.
    plan = payload.get("plan")
    if isinstance(plan, dict):
        plan_architecture = plan.get("architecture")
        if isinstance(plan_architecture, dict) and isinstance(
            plan_architecture.get("systemOfRecord"), dict
        ):
            return plan_architecture["systemOfRecord"]
    return None


def _story_mentions_reference_app(payload: dict[str, Any]) -> bool:
    text = json.dumps(payload, sort_keys=True).lower()
    return bool(
        re.search(
            r"reference[- ]app|reference application|modeled after|modelled after|parity",
            text,
        )
    )


def _record_surfaces(record: dict[str, Any]) -> list[dict[str, Any]]:
    surfaces = record.get("stateSurfaces")
    if not isinstance(surfaces, list):
        return []
    return [surface for surface in surfaces if isinstance(surface, dict)]


def _surface_name(surface: dict[str, Any]) -> str:
    name = surface.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else "<unnamed>"


def _surface_classification(surface: dict[str, Any]) -> str | None:
    value = surface.get("classification")
    return value if isinstance(value, str) else None


def _surface_allows_storage(surface: dict[str, Any], storage: str) -> bool:
    classification = _surface_classification(surface)
    approved = surface.get("approvedStorage")

    if _storage_matches(storage, approved):
        return True

    if storage == "database" and _approved_database(approved):
        return True

    if storage in FILE_STORAGE_CLASSES:
        return classification in {
            "canonical_artifact",
            "cache",
            "import_export_artifact",
            "dev_only_fixture",
        }

    if storage == "sqlite_file":
        return _storage_matches("sqlite_file", approved) or (
            classification in DURABLE_CLASSIFICATIONS and _approved_database(approved)
        )

    if storage == "browser_storage":
        return classification == "ephemeral_ui_state"

    if storage == "in_memory":
        return classification in {"ephemeral_ui_state", "cache"}

    if storage == "external_service":
        return classification == "external_integration_state" or _approved_external(approved)

    return False


def _signal_location(signal: DetectedSignal) -> str:
    if signal.line is None:
        return signal.path
    return f"{signal.path}:{signal.line}"


def _format_failure(findings: list[GateFinding]) -> str:
    first = findings[0]
    lines = ["system-of-record gate failed", ""]
    if first.state_surface is not None:
        lines.append(f"State surface: {first.state_surface}")
    if first.classification is not None:
        lines.append(f"Classification: {first.classification}")
    if first.detected_storage is not None:
        lines.append(f"Detected storage: {first.detected_storage}")
    if first.approved_storage is not None:
        lines.append(f"Approved storage: {first.approved_storage}")
    lines.extend(["", "Reason:", first.reason, "", "Required fix:", first.required_fix])

    if len(findings) > 1:
        lines.extend(["", f"Additional findings: {len(findings) - 1}"])
        for finding in findings[1:6]:
            prefix = finding.state_surface or finding.detected_storage or "record"
            lines.append(f"- {prefix}: {finding.reason}")
        if len(findings) > 6:
            lines.append(f"- ... {len(findings) - 6} more")
    return "\n".join(lines)


def _validate_reference_apps(
    record: dict[str, Any],
    payload: dict[str, Any] | None,
    findings: list[GateFinding],
) -> None:
    refs = record.get("referenceApplications", [])
    mentions_reference = payload is not None and _story_mentions_reference_app(payload)
    if refs in (None, []):
        if mentions_reference:
            findings.append(
                GateFinding(
                    reason=(
                        "Reference-application parity is mentioned, but the "
                        "system-of-record block has no referenceApplications comparison."
                    ),
                    required_fix=(
                        "Add referenceApplications entries covering persistence, "
                        "auth/session, ownership/permission, preserved behavior, "
                        "and intentionally omitted behavior."
                    ),
                )
            )
        return
    if not isinstance(refs, list):
        findings.append(
            GateFinding(
                reason="referenceApplications must be a list.",
                required_fix="Render referenceApplications as a list of comparison records.",
            )
        )
        return

    for idx, ref in enumerate(refs):
        if not isinstance(ref, dict):
            findings.append(
                GateFinding(
                    reason=f"referenceApplications[{idx}] is not an object.",
                    required_fix=(
                        "Use an object with name, evidence, mustPreserve, "
                        "and intentionallyNotCarriedForward."
                    ),
                )
            )
            continue
        name = ref.get("name")
        surface = (
            name
            if isinstance(name, str) and name.strip()
            else f"referenceApplications[{idx}]"
        )
        evidence_text = " ".join(_as_string_list(ref.get("evidence"))).lower()
        for label, tokens in REFERENCE_EVIDENCE_GROUPS.items():
            if not any(token in evidence_text for token in tokens):
                findings.append(
                    GateFinding(
                        state_surface=surface,
                        reason=f"Reference-app comparison omits the {label} model.",
                        required_fix=(
                            "Compare the reference persistence, auth/session, "
                            "ownership/permission, and workflow/runtime model "
                            "before implementation."
                        ),
                    )
                )
        if not _as_string_list(ref.get("mustPreserve")):
            findings.append(
                GateFinding(
                    state_surface=surface,
                    reason="Reference-app comparison omits mustPreserve behavior.",
                    required_fix="List the persistence/auth/permission behavior being preserved.",
                )
            )
        if "intentionallyNotCarriedForward" not in ref or not isinstance(
            ref.get("intentionallyNotCarriedForward"), list
        ):
            findings.append(
                GateFinding(
                    state_surface=surface,
                    reason="Reference-app comparison omits intentionallyNotCarriedForward.",
                    required_fix=(
                        "Add an explicit list, even when empty, of reference behavior "
                        "not being carried forward."
                    ),
                )
            )


def _validate_surface(surface: dict[str, Any], findings: list[GateFinding]) -> None:
    name = _surface_name(surface)
    classification = _surface_classification(surface)

    if not isinstance(surface.get("name"), str) or not surface["name"].strip():
        findings.append(
            GateFinding(
                state_surface=name,
                reason="State surface is missing a non-empty name.",
                required_fix="Add a stable state surface name.",
            )
        )

    if classification not in STATE_CLASSIFICATIONS:
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                reason=f"Unknown state classification: {classification!r}.",
                required_fix="Use one of the documented system-of-record state classifications.",
            )
        )
        return

    approved = surface.get("approvedStorage")
    forbidden = surface.get("forbiddenStorage", [])

    if not _non_empty(surface.get("owner")) and classification != "ephemeral_ui_state":
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                reason="State surface is missing an owner.",
                required_fix=(
                    "Declare the service, database, provider, or layer that owns the state."
                ),
            )
        )

    if not _as_string_list(approved):
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                reason="State surface is missing approvedStorage.",
                required_fix="Declare the approved system of record for this state.",
            )
        )

    for item in _as_string_list(forbidden):
        if _storage_matches(item, approved):
            findings.append(
                GateFinding(
                    state_surface=name,
                    classification=classification,
                    detected_storage=item,
                    approved_storage=_approved_storage_text(surface),
                    reason="approvedStorage contradicts forbiddenStorage.",
                    required_fix="Remove the contradiction before implementation.",
                )
            )

    if classification in DURABLE_CLASSIFICATIONS:
        if _storage_is_local_unsafe(approved):
            findings.append(
                GateFinding(
                    state_surface=name,
                    classification=classification,
                    detected_storage=_approved_storage_text(surface),
                    approved_storage="durable database, service, or external provider",
                    reason=(
                        "Durable, auth, authorization, audit, or integration state "
                        "cannot be assigned to local files, browser storage, or process memory."
                    ),
                    required_fix=(
                        "Use the approved durable storage layer, or reclassify this "
                        "state as cache/dev-only/import/export with production guards."
                    ),
                )
            )
        for field in DURABLE_REQUIRED_FIELDS:
            value = surface.get(field)
            if field.endswith("Required"):
                if not isinstance(value, bool):
                    findings.append(
                        GateFinding(
                            state_surface=name,
                            classification=classification,
                            reason=f"Durable state is missing boolean {field}.",
                            required_fix=(
                                "Answer the durable-state concurrency, audit, migration, "
                                "permission, recovery, and delete semantics before implementation."
                            ),
                        )
                    )
            elif not _non_empty(value):
                findings.append(
                    GateFinding(
                        state_surface=name,
                        classification=classification,
                        reason=f"Durable state is missing {field}.",
                        required_fix=(
                            "Answer the durable-state concurrency, transaction, recovery, "
                            "conflict, delete, ownership, permission, and migration questions."
                        ),
                    )
                )

    if classification in SECURITY_CLASSIFICATIONS and _storage_is_local_unsafe(approved):
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                detected_storage=_approved_storage_text(surface),
                approved_storage="approved auth/session/permission mechanism",
                reason="Auth/session/permission state is backed by local or process-local storage.",
                required_fix="Use the approved auth/session and authorization system of record.",
            )
        )

    if classification == "cache":
        if _truthy_flag(surface.get("authoritative")):
            findings.append(
                GateFinding(
                    state_surface=name,
                    classification=classification,
                    reason="Cache is marked authoritative.",
                    required_fix=(
                        "Point authoritative writes at the source of truth; "
                        "keep the cache rebuildable."
                    ),
                )
            )
        has_invalidation = _non_empty(surface.get("invalidation")) or _non_empty(
            surface.get("invalidationRules")
        )
        if not has_invalidation:
            findings.append(
                GateFinding(
                    state_surface=name,
                    classification=classification,
                    reason="Cache lacks invalidation metadata.",
                    required_fix=(
                        "Declare invalidation rules, TTL, or source-change invalidation "
                        "before use."
                    ),
                )
            )

    if classification == "projection":
        if not _non_empty(surface.get("sourceOfTruth")):
            findings.append(
                GateFinding(
                    state_surface=name,
                    classification=classification,
                    reason="Projection lacks sourceOfTruth.",
                    required_fix="Declare the authoritative source that feeds this read model.",
                )
            )
        projection_mutable = _truthy_flag(surface.get("mutable")) or _truthy_flag(
            surface.get("directMutationAllowed")
        )
        if projection_mutable:
            findings.append(
                GateFinding(
                    state_surface=name,
                    classification=classification,
                    reason="Projection is mutable directly.",
                    required_fix=(
                        "Mutate the authoritative source, then rebuild or refresh "
                        "the projection."
                    ),
                )
            )

    if classification == "dev_only_fixture" and not (
        _truthy_flag(surface.get("productionGuard"))
        or _truthy_flag(surface.get("excludedFromProduction"))
    ):
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                reason="Dev-only storage lacks a production guard.",
                required_fix="Add an explicit productionGuard or excludedFromProduction flag.",
            )
        )

    if classification == "import_export_artifact" and (
        _truthy_flag(surface.get("liveState")) or _truthy_flag(surface.get("authoritative"))
    ):
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                reason="Import/export artifact is marked as live or authoritative state.",
                required_fix=(
                    "Use it only as a temporary transfer artifact, not live "
                    "application state."
                ),
            )
        )

    if classification == "canonical_artifact" and (
        _truthy_flag(surface.get("mutable")) or _truthy_flag(surface.get("authoritative"))
    ):
        findings.append(
            GateFinding(
                state_surface=name,
                classification=classification,
                reason="Canonical artifact is marked mutable or authoritative app persistence.",
                required_fix=(
                    "Use canonical artifacts as evidence/source-authored input, "
                    "not mutable app records."
                ),
            )
        )


def _validate_signals(record: dict[str, Any], signals: list[DetectedSignal]) -> list[GateFinding]:
    surfaces = _record_surfaces(record)
    findings: list[GateFinding] = []
    durable_surfaces = [
        surface
        for surface in surfaces
        if _surface_classification(surface) in DURABLE_CLASSIFICATIONS
    ]
    auth_surfaces = [
        surface
        for surface in surfaces
        if _surface_classification(surface) in SECURITY_CLASSIFICATIONS
    ]

    for signal in signals:
        if signal.storage:
            matching_surfaces = [
                surface for surface in surfaces if _surface_allows_storage(surface, signal.storage)
            ]
            forbidden_matches = [
                surface
                for surface in surfaces
                if any(
                    _storage_matches(signal.storage, item)
                    for item in _as_string_list(surface.get("forbiddenStorage"))
                )
            ]
            if forbidden_matches:
                surface = forbidden_matches[0]
                findings.append(
                    GateFinding(
                        state_surface=_surface_name(surface),
                        classification=_surface_classification(surface),
                        detected_storage=signal.storage,
                        approved_storage=_approved_storage_text(surface),
                        reason=(
                            f"The diff implements {signal.storage} at {_signal_location(signal)}, "
                            "but the design record forbids that storage."
                        ),
                        required_fix=(
                            "Move the implementation to the approved system of record "
                            "or update the design record before implementation."
                        ),
                    )
                )
            elif not matching_surfaces:
                findings.append(
                    GateFinding(
                        detected_storage=signal.storage,
                        reason=(
                            f"The diff implements {signal.storage} at {_signal_location(signal)} "
                            "without a state surface that approves it."
                        ),
                        required_fix=(
                            "Declare a matching state surface, or move the implementation "
                            "to the approved system of record."
                        ),
                    )
                )

        if signal.kind == "mutation_endpoint" and not durable_surfaces:
            findings.append(
                GateFinding(
                    reason=(
                        f"Stateful create/update/delete API signal at {_signal_location(signal)} "
                        "has no durable owner in the design record."
                    ),
                    required_fix=(
                        "Declare the durable state surface that owns this mutation, including "
                        "permission and recovery semantics."
                    ),
                )
            )

        if signal.kind == "auth_state" and not auth_surfaces:
            findings.append(
                GateFinding(
                    reason=(
                        f"Auth/session/permission signal at {_signal_location(signal)} "
                        "has no auth_session_state or authorization_state surface."
                    ),
                    required_fix=(
                        "Declare the approved auth/session or authorization system "
                        "of record."
                    ),
                )
            )

        if signal.kind == "workflow_state" and not durable_surfaces:
            findings.append(
                GateFinding(
                    reason=(
                        f"Workflow/job/runtime state signal at {_signal_location(signal)} "
                        "has no durable or service-backed owner."
                    ),
                    required_fix="Declare the job/workflow state owner and recovery semantics.",
                )
            )

    return findings


def validate_record(
    record: dict[str, Any] | None,
    *,
    story_payload: dict[str, Any] | None = None,
    signals: list[DetectedSignal] | None = None,
) -> GateResult:
    """Validate a system-of-record design record."""
    if record is None:
        finding = GateFinding(
            reason="Triggered story has no architecture.systemOfRecord design record.",
            required_fix=(
                "Add a system-of-record block classifying each state surface "
                "before implementation."
            ),
        )
        return GateResult(1, _format_failure([finding]), (finding,))

    findings: list[GateFinding] = []
    surfaces = _record_surfaces(record)
    if not isinstance(record.get("stateSurfaces"), list) or not surfaces:
        findings.append(
            GateFinding(
                reason="systemOfRecord.stateSurfaces is missing or empty.",
                required_fix=(
                    "Declare at least one state surface with classification "
                    "and approvedStorage."
                ),
            )
        )
    for surface in surfaces:
        _validate_surface(surface, findings)

    _validate_reference_apps(record, story_payload, findings)

    if signals:
        findings.extend(_validate_signals(record, signals))

    if findings:
        return GateResult(1, _format_failure(findings), tuple(findings))
    return GateResult(0, "OK system-of-record gate passed.")


def evaluate_story(story_path: Path) -> GateResult:
    payload, error = _load_json_file(story_path)
    if error is not None:
        return error
    assert payload is not None
    return validate_record(_system_of_record(payload), story_payload=payload)


def scan_diff(diff_text: str) -> tuple[list[DetectedSignal], list[str]]:
    from _sor_gate_diff import scan_diff as _impl

    return _impl(diff_text)


def evaluate_diff_text(
    diff_text: str,
    *,
    project_root: Path,
    story_path: Path | None = None,
) -> GateResult:
    from _sor_gate_diff import evaluate_diff_text as _impl

    return _impl(diff_text, project_root=project_root, story_path=story_path)


def evaluate_diff(
    project_root: Path,
    base_ref: str,
    story_path: Path | None = None,
) -> GateResult:
    from _sor_gate_diff import evaluate_diff as _impl

    return _impl(project_root, base_ref, story_path=story_path)


def _emit_json(result: GateResult) -> str:
    payload = {
        "ok": result.code == 0,
        "exit_code": result.code,
        "message": result.message,
        "findings": [
            {
                "state_surface": finding.state_surface,
                "classification": finding.classification,
                "detected_storage": finding.detected_storage,
                "approved_storage": finding.approved_storage,
                "reason": finding.reason,
                "required_fix": finding.required_fix,
            }
            for finding in result.findings
        ],
    }
    return json.dumps(payload, sort_keys=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preflight_architecture_sor.py",
        description=(
            "System-of-record architecture gate. Use --story-path for story-time "
            "preflight, or --base-ref for diff-time verification."
        ),
    )
    parser.add_argument("--story-path", help="Path to the story/spec vBRIEF JSON file.")
    parser.add_argument(
        "--base-ref",
        help="Base ref for diff-time verification, for example origin/main or upstream/master.",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root for diff-time verification. Defaults to current directory.",
    )
    parser.add_argument("--json", action="store_true", dest="emit_json")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root)
    story_path = Path(args.story_path) if args.story_path else None

    if args.base_ref:
        result = evaluate_diff(project_root, args.base_ref, story_path=story_path)
    elif story_path is not None:
        result = evaluate_story(story_path)
    else:
        result = GateResult(
            2,
            "system-of-record gate misconfigured: pass --story-path, --base-ref, or both.",
        )

    if args.emit_json:
        print(_emit_json(result))
    elif result.code == 0:
        print(result.message)
    else:
        print(result.message, file=sys.stderr)

    return result.code


if __name__ == "__main__":
    sys.exit(main())
