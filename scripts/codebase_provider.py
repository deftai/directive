#!/usr/bin/env python3
"""Provider selection and validation for #1595 codebase-map artifacts."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shlex
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

import code_structure_validate
from _content_root import content_root
from _safe_subprocess import run_text
from codebase_default_extractor import (
    build_codebase_map,
    config_error_to_dict,
    default_code_structure_path,
    file_sha256,
)
from codebase_projection_registry import CODEBASE_MAP_KIND

CODEBASE_MAP_SCHEMA_PATH = Path("vbrief/schemas/codebase-map.schema.json")
_REPO_ROOT = Path(__file__).resolve().parents[1]
_SCHEMA_ANNOTATION_KEYS = frozenset({"$schema", "$id", "title", "description"})
_SUPPORTED_SCHEMA_KEYS = _SCHEMA_ANNOTATION_KEYS | frozenset(
    {
        "additionalProperties",
        "const",
        "items",
        "minItems",
        "minimum",
        "minLength",
        "properties",
        "required",
        "type",
    }
)


@dataclass
class ProviderSelection:
    """Result of selecting either an external provider or the default extractor."""

    artifact: dict[str, Any]
    used_external_provider: bool
    fallback_reason: str | None = None


@dataclass(frozen=True)
class ProviderArtifactPolicy:
    """Durable artifact-at-a-path policy for one projection kind."""

    artifact_path: Path | None = None
    expect_provider: str | None = None
    expect_version: str | None = None
    invalid_reason: str | None = None


@lru_cache(maxsize=1)
def _load_codebase_map_schema() -> dict[str, Any]:
    schema_path = content_root(_REPO_ROOT) / CODEBASE_MAP_SCHEMA_PATH
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    if not isinstance(schema, dict):
        raise ValueError(f"{CODEBASE_MAP_SCHEMA_PATH} must contain a JSON object")
    return schema


def _schema_for_expected_kind(expected_kind: str) -> dict[str, Any]:
    schema = _load_codebase_map_schema()
    if expected_kind == CODEBASE_MAP_KIND:
        return schema
    schema = copy.deepcopy(schema)
    schema["properties"]["kind"]["const"] = expected_kind
    return schema


def _schema_path(path: str, field: str) -> str:
    return f"{path}.{field}" if path else field


def _schema_error_path(path: str) -> str:
    return path or "<root>"


def _type_names(schema_type: object) -> tuple[str, ...]:
    if isinstance(schema_type, str):
        return (schema_type,)
    if isinstance(schema_type, list) and all(isinstance(item, str) for item in schema_type):
        return tuple(schema_type)
    return ()


def _matches_json_type(value: object, schema_type: str) -> bool:
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "null":
        return value is None
    if schema_type == "object":
        return isinstance(value, dict)
    if schema_type == "string":
        return isinstance(value, str)
    return False


def _type_label(schema_type: str) -> str:
    if schema_type == "array":
        return "an array"
    if schema_type == "integer":
        return "an integer"
    if schema_type == "object":
        return "an object"
    return f"a {schema_type}"


def _schema_type_error(path: str, schema_types: tuple[str, ...]) -> str:
    if len(schema_types) == 1:
        return f"{_schema_error_path(path)} must be {_type_label(schema_types[0])}"
    return f"{_schema_error_path(path)} must be one of: {', '.join(schema_types)}"


def _validate_schema_shape(schema: object, path: str) -> list[str]:
    if not isinstance(schema, dict):
        return [f"schema at {_schema_error_path(path)} must be an object"]

    errors: list[str] = []
    unknown = sorted(set(schema) - _SUPPORTED_SCHEMA_KEYS)
    for keyword in unknown:
        errors.append(
            f"schema at {_schema_error_path(path)} uses unsupported keyword {keyword!r}"
        )

    schema_types = _type_names(schema.get("type"))
    if "type" in schema and not schema_types:
        errors.append(f"schema at {_schema_error_path(path)} has unsupported type")

    required = schema.get("required")
    if required is not None and (
        not isinstance(required, list) or any(not isinstance(item, str) for item in required)
    ):
        errors.append(f"schema at {_schema_error_path(path)} has invalid required[]")

    properties = schema.get("properties")
    if properties is not None:
        if not isinstance(properties, dict):
            errors.append(f"schema at {_schema_error_path(path)} has invalid properties")
        else:
            for field, child_schema in properties.items():
                errors.extend(_validate_schema_shape(child_schema, _schema_path(path, field)))

    if "items" in schema:
        errors.extend(_validate_schema_shape(schema["items"], f"{path}[]"))

    additional = schema.get("additionalProperties")
    if additional is not None and not isinstance(additional, bool):
        errors.append(
            f"schema at {_schema_error_path(path)} has unsupported additionalProperties"
        )

    return errors


def _validate_json_schema_subset(
    value: object, schema: dict[str, Any], path: str = ""
) -> list[str]:
    schema_errors = _validate_schema_shape(schema, path)
    if schema_errors:
        return schema_errors

    errors: list[str] = []
    schema_types = _type_names(schema.get("type"))
    if schema_types and not any(
        _matches_json_type(value, schema_type) for schema_type in schema_types
    ):
        return [_schema_type_error(path, schema_types)]

    if "const" in schema and value != schema["const"]:
        errors.append(f"{_schema_error_path(path)} must be {schema['const']!r}")

    if isinstance(value, dict):
        required = schema.get("required", [])
        for field in required:
            if field not in value:
                errors.append(f"{_schema_path(path, field)} must be present")

        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for field, child_schema in properties.items():
                if field in value:
                    errors.extend(
                        _validate_json_schema_subset(
                            value[field],
                            child_schema,
                            _schema_path(path, field),
                        )
                    )

        if schema.get("additionalProperties") is False and isinstance(properties, dict):
            for field in sorted(set(value) - set(properties)):
                errors.append(f"{_schema_path(path, field)} is not allowed")

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            if min_items == 1:
                errors.append(f"{_schema_error_path(path)} must be a non-empty array")
            else:
                errors.append(f"{_schema_error_path(path)} must contain at least {min_items} items")
        if "items" in schema:
            for index, item in enumerate(value):
                errors.extend(
                    _validate_json_schema_subset(item, schema["items"], f"{path}[{index}]")
                )

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(value) < min_length:
            if min_length == 1:
                errors.append(f"{_schema_error_path(path)} must be a non-empty string")
            else:
                errors.append(
                    f"{_schema_error_path(path)} must contain at least {min_length} characters"
                )

    if isinstance(value, int) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append(f"{_schema_error_path(path)} must be >= {minimum}")

    return errors


def validate_provider_artifact(
    artifact: object, *, expected_kind: str = CODEBASE_MAP_KIND
) -> list[str]:
    """Return deterministic JSON Schema contract errors for a provider artifact."""
    if not isinstance(artifact, dict):
        return ["artifact must be a JSON object"]

    return _validate_json_schema_subset(artifact, _schema_for_expected_kind(expected_kind))


def _is_safe_relative_path(value: object) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "\\" in text or text.startswith(("~", "$")):
        return False
    path = PurePosixPath(text)
    if path.is_absolute() or re.match(r"^[A-Za-z]:", text):
        return False
    return ".." not in path.parts


def _project_definition_path(project_root: Path) -> Path:
    return project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"


def _expect_value(expect: object, *keys: str) -> str | None:
    if not isinstance(expect, dict):
        return None
    cursor: object = expect
    for key in keys:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(key)
    if isinstance(cursor, str) and cursor.strip():
        return cursor.strip()
    return None


def load_provider_artifact_policy(
    project_root: Path, *, kind: str = CODEBASE_MAP_KIND
) -> ProviderArtifactPolicy:
    """Read ``plan.policy.projectionProviders[kind]`` without invoking providers."""
    path = _project_definition_path(project_root)
    if not path.exists():
        return ProviderArtifactPolicy()

    data = code_structure_validate.load_json_file(path)
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return ProviderArtifactPolicy()
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return ProviderArtifactPolicy()
    providers = policy.get("projectionProviders")
    if not isinstance(providers, dict):
        return ProviderArtifactPolicy()
    config = providers.get(kind)
    if config is None:
        return ProviderArtifactPolicy()
    if not isinstance(config, dict):
        return ProviderArtifactPolicy(
            invalid_reason=f"plan.policy.projectionProviders[{kind!r}] must be an object"
        )

    artifact_path = config.get("artifactPath")
    if not _is_safe_relative_path(artifact_path):
        return ProviderArtifactPolicy(
            invalid_reason=(
                f"plan.policy.projectionProviders[{kind!r}].artifactPath "
                "must be repository-relative"
            )
        )

    expect = config.get("expect")
    expect_provider = (
        _expect_value(expect, "provider")
        or _expect_value(expect, "name")
        or _expect_value(expect, "provider", "name")
    )
    expect_version = (
        _expect_value(expect, "version")
        or _expect_value(expect, "providerVersion")
        or _expect_value(expect, "provider", "version")
    )

    return ProviderArtifactPolicy(
        artifact_path=Path(str(artifact_path)),
        expect_provider=expect_provider,
        expect_version=expect_version,
    )


def artifact_sha256(artifact: dict[str, Any]) -> str:
    """Return a stable SHA-256 digest for a provider artifact."""
    payload = json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _provider_expectation_errors(
    artifact: dict[str, Any], policy: ProviderArtifactPolicy
) -> list[str]:
    provider = artifact.get("provider")
    if not isinstance(provider, dict):
        return ["provider must be an object"]
    errors: list[str] = []
    if policy.expect_provider and provider.get("name") != policy.expect_provider:
        errors.append(
            "provider name mismatch: "
            f"expected {policy.expect_provider!r}, got {provider.get('name')!r}"
        )
    if policy.expect_version and provider.get("version") != policy.expect_version:
        errors.append(
            "provider version mismatch: "
            f"expected {policy.expect_version!r}, got {provider.get('version')!r}"
        )
    return errors


def _freshness_signal(artifact: dict[str, Any]) -> tuple[bool | None, str | None]:
    source = artifact.get("source")
    candidates: list[object] = [artifact.get("freshness")]
    if isinstance(source, dict):
        candidates.append(source.get("freshness"))
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        fresh = candidate.get("fresh")
        if isinstance(fresh, bool):
            if fresh:
                return True, None
            return False, str(candidate.get("reason") or "provider freshness signal is stale")
        status = candidate.get("status")
        if isinstance(status, str):
            normalized = status.strip().lower()
            if normalized in {"fresh", "ok", "current"}:
                return True, None
            if normalized in {"stale", "dirty", "out-of-date", "outdated"}:
                return False, str(
                    candidate.get("reason") or f"provider freshness status is {status!r}"
                )
    return None, None


def _content_hash_entries(artifact: dict[str, Any]) -> list[dict[str, str]]:
    source = artifact.get("source")
    if not isinstance(source, dict):
        return []
    content_hashes = source.get("contentHashes")
    if isinstance(content_hashes, dict):
        raw_entries: object = content_hashes.get("files", [])
    else:
        raw_entries = content_hashes

    entries: list[dict[str, str]] = []
    if isinstance(raw_entries, dict):
        for path, digest in raw_entries.items():
            if isinstance(path, str) and isinstance(digest, str):
                entries.append({"path": path, "sha256": digest})
    elif isinstance(raw_entries, list):
        for item in raw_entries:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            digest = item.get("sha256") or item.get("value") or item.get("digest")
            algorithm = str(item.get("algorithm") or "sha256").lower()
            if isinstance(path, str) and isinstance(digest, str) and algorithm == "sha256":
                entries.append({"path": path, "sha256": digest})
    return entries


def provider_artifact_freshness_errors(
    artifact: dict[str, Any], project_root: Path
) -> list[str]:
    """Return no-network freshness errors for an artifact-at-a-path provider."""
    signaled_fresh, reason = _freshness_signal(artifact)
    if signaled_fresh is True:
        return []
    if signaled_fresh is False:
        return [reason or "provider freshness signal is stale"]

    entries = _content_hash_entries(artifact)
    if not entries:
        return [
            "provider artifact freshness could not be verified: "
            "missing source.freshness or source.contentHashes.files[]"
        ]

    errors: list[str] = []
    for entry in entries:
        rel_path = entry["path"]
        expected = entry["sha256"]
        if not _is_safe_relative_path(rel_path):
            errors.append(
                "provider artifact content hash path is not "
                f"repository-relative: {rel_path!r}"
            )
            continue
        path = project_root / rel_path
        if not path.is_file():
            errors.append(f"provider artifact source file is missing: {rel_path}")
            continue
        actual = file_sha256(path)
        if actual != expected:
            errors.append(
                "provider artifact source hash mismatch: "
                f"{rel_path} expected {expected}, got {actual}"
            )
    return errors


def _fallback(project_root: Path, reason: str) -> ProviderSelection:
    return ProviderSelection(
        artifact=build_codebase_map(project_root, fallback_reason=reason),
        used_external_provider=False,
        fallback_reason=reason,
    )


def _selection_from_artifact_path(
    project_root: Path, artifact_path: Path, policy: ProviderArtifactPolicy
) -> ProviderSelection:
    path = artifact_path if artifact_path.is_absolute() else project_root / artifact_path
    if not path.exists():
        return _fallback(project_root, f"provider artifact path does not exist: {artifact_path}")
    if not path.is_file():
        return _fallback(project_root, f"provider artifact path is not a file: {artifact_path}")
    try:
        artifact = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _fallback(project_root, f"provider artifact was not valid JSON: {exc.msg}")
    except OSError as exc:
        return _fallback(project_root, f"provider artifact could not be read: {exc}")

    errors = validate_provider_artifact(artifact)
    if errors:
        return _fallback(project_root, "provider artifact contract mismatch: " + "; ".join(errors))
    expectation_errors = _provider_expectation_errors(artifact, policy)
    if expectation_errors:
        return _fallback(
            project_root,
            "provider artifact expectation mismatch: " + "; ".join(expectation_errors),
        )
    freshness_errors = provider_artifact_freshness_errors(artifact, project_root)
    if freshness_errors:
        return _fallback(project_root, "provider artifact is stale: " + "; ".join(freshness_errors))

    return ProviderSelection(artifact=artifact, used_external_provider=True)


def select_codebase_map(
    project_root: Path,
    provider_command: str | list[str] | None = None,
    *,
    artifact_path: Path | str | None = None,
) -> ProviderSelection:
    """Return an external provider artifact when valid, else the default artifact."""
    project_root = project_root.resolve()
    if artifact_path is not None and str(artifact_path) != "":
        policy = ProviderArtifactPolicy(artifact_path=Path(str(artifact_path)))
        return _selection_from_artifact_path(project_root, policy.artifact_path, policy)

    if provider_command is None or provider_command == "":
        policy = load_provider_artifact_policy(project_root)
        if policy.invalid_reason:
            return _fallback(project_root, policy.invalid_reason)
        if policy.artifact_path is not None:
            return _selection_from_artifact_path(project_root, policy.artifact_path, policy)
        return _fallback(project_root, "no external codebase-map provider configured")

    try:
        command = (
            shlex.split(provider_command) if isinstance(provider_command, str) else provider_command
        )
    except ValueError as exc:
        return _fallback(project_root, f"provider command could not be parsed: {exc}")
    if not command:
        return _fallback(project_root, "provider command was empty")

    try:
        completed = run_text(command, cwd=str(project_root), timeout=60)
    except Exception as exc:  # noqa: BLE001 -- provider failure is intentionally non-fatal.
        return _fallback(project_root, f"provider command failed before output: {exc}")

    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "no provider output"
        return _fallback(
            project_root,
            f"provider command exited {completed.returncode}: {detail}",
        )

    try:
        artifact = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return _fallback(project_root, f"provider output was not valid JSON: {exc.msg}")

    errors = validate_provider_artifact(artifact)
    if errors:
        return _fallback(project_root, "provider artifact contract mismatch: " + "; ".join(errors))

    return ProviderSelection(artifact=artifact, used_external_provider=True)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Select a codebase-map provider artifact.")
    parser.add_argument("--project-root", default=".", help="Repository root to inspect.")
    parser.add_argument(
        "--artifact-path",
        help=(
            "Repository-relative provider artifact path. When omitted, "
            'plan.policy.projectionProviders["codebase-map"].artifactPath is used.'
        ),
    )
    parser.add_argument("--provider-command", help="External provider argv string.")
    args = parser.parse_args(argv)

    project_root = Path(args.project_root)
    try:
        selection = select_codebase_map(
            project_root,
            args.provider_command,
            artifact_path=args.artifact_path,
        )
    except code_structure_validate.CodeStructureConfigError as exc:
        print(
            json.dumps(
                config_error_to_dict(default_code_structure_path(project_root, None), exc),
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(selection.artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
