"""Tests for the #1595 codebase-map provider contract."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import codebase_default_extractor as extractor  # noqa: E402
import codebase_provider as provider  # noqa: E402
from _content_root import content_root  # noqa: E402

# Post-#1875: shippable schemas live under content/ in the source repo; resolve
# the published schema path against the content root (matches the provider).
_CONTENT_ROOT = content_root(_REPO_ROOT)


def _valid_artifact() -> dict:
    return {
        "formatVersion": "codebase-map.v1",
        "contractVersion": "codebase-provider.v1",
        "kind": "codebase-map",
        "provider": {"name": "fixture-provider", "version": "1.0"},
        "source": {"projectRoot": "/fixture"},
        "modules": [
            {
                "id": "app",
                "files": ["app/main.py"],
                "derivedFrom": {"files": "provider", "intent": "provider"},
            }
        ],
        "coupling": [],
        "entryPoints": [],
        "languageDistribution": [
            {"language": "Python", "files": 1, "derivedFrom": "extension-heuristic"}
        ],
        "degraded": [],
    }


def _write_policy_project(project_root: Path, policy: dict) -> None:
    project_def = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    project_def.parent.mkdir(parents=True)
    project_def.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {
                    "title": "Fixture",
                    "status": "running",
                    "items": [],
                    "policy": policy,
                },
            }
        ),
        encoding="utf-8",
    )


def _artifact_with_hash(project_root: Path, rel_path: str = "src/main.py") -> dict:
    source_file = project_root / rel_path
    source_file.parent.mkdir(parents=True, exist_ok=True)
    source_file.write_text("print('hello')\n", encoding="utf-8")
    artifact = _valid_artifact()
    artifact["provider"] = {"name": "fixture-provider", "version": "1.0"}
    artifact["source"] = {
        "projectRoot": str(project_root),
        "contentHashes": {
            "algorithm": "sha256",
            "files": [{"path": rel_path, "sha256": provider.file_sha256(source_file)}],
        },
    }
    return artifact


def test_validate_provider_artifact_accepts_contract() -> None:
    assert provider.validate_provider_artifact(_valid_artifact()) == []


def test_provider_reuses_default_extractor_file_hash_helper() -> None:
    assert provider.file_sha256 is extractor.file_sha256


def test_validate_provider_artifact_reports_contract_mismatch() -> None:
    artifact = _valid_artifact()
    artifact["contractVersion"] = "wrong"
    artifact["modules"] = []

    errors = provider.validate_provider_artifact(artifact)

    assert "contractVersion must be 'codebase-provider.v1'" in errors
    assert "modules must be a non-empty array" in errors


def test_validate_provider_artifact_rejects_missing_tier1_skeleton() -> None:
    artifact = _valid_artifact()
    del artifact["coupling"]
    del artifact["entryPoints"]
    del artifact["languageDistribution"]

    errors = provider.validate_provider_artifact(artifact)

    assert "coupling must be present" in errors
    assert "entryPoints must be present" in errors
    assert "languageDistribution must be present" in errors


def test_validate_provider_artifact_rejects_degenerate_modules() -> None:
    artifact = _valid_artifact()
    artifact["modules"] = [{}]

    errors = provider.validate_provider_artifact(artifact)

    assert "modules[0].id must be present" in errors
    assert "modules[0].files must be present" in errors
    assert "modules[0].derivedFrom must be present" in errors


def test_validate_provider_artifact_rejects_module_field_type_mismatch() -> None:
    artifact = _valid_artifact()
    artifact["modules"][0]["derivedFrom"] = "provider"
    artifact["modules"][0]["files"] = [""]
    artifact["languageDistribution"][0]["files"] = "one"

    errors = provider.validate_provider_artifact(artifact)

    assert "modules[0].derivedFrom must be an object" in errors
    assert "modules[0].files[0] must be a non-empty string" in errors
    assert "languageDistribution[0].files must be an integer" in errors


def test_codebase_map_schema_and_golden_fixture_are_published() -> None:
    schema_path = _CONTENT_ROOT / provider.CODEBASE_MAP_SCHEMA_PATH
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert schema["$id"].endswith("codebase-map.v1.schema.json")
    assert schema["required"] == [
        "formatVersion",
        "contractVersion",
        "kind",
        "provider",
        "source",
        "modules",
        "coupling",
        "entryPoints",
        "languageDistribution",
        "degraded",
    ]
    assert schema["properties"]["formatVersion"]["const"] == "codebase-map.v1"
    assert schema["properties"]["contractVersion"]["const"] == "codebase-provider.v1"

    golden = json.loads(
        (_REPO_ROOT / "tests/fixtures/codebase-map.v1.golden.json").read_text(
            encoding="utf-8"
        )
    )
    assert provider.validate_provider_artifact(golden) == []


def test_validate_provider_artifact_uses_published_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema = json.loads(
        (_CONTENT_ROOT / provider.CODEBASE_MAP_SCHEMA_PATH).read_text(encoding="utf-8")
    )
    schema["required"].append("schemaOnly")
    monkeypatch.setattr(provider, "_load_codebase_map_schema", lambda: schema)

    errors = provider.validate_provider_artifact(_valid_artifact())

    assert "schemaOnly must be present" in errors


def test_validate_provider_artifact_fails_closed_on_unsupported_schema_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        provider,
        "_load_codebase_map_schema",
        lambda: {"type": "object", "patternProperties": {}},
    )

    errors = provider.validate_provider_artifact(_valid_artifact())

    assert "schema at <root> uses unsupported keyword 'patternProperties'" in errors


def test_select_provider_accepts_conformant_external_artifact(
    tmp_path: Path, monkeypatch
) -> None:
    completed = type(
        "Completed",
        (),
        {"returncode": 0, "stdout": json.dumps(_valid_artifact()), "stderr": ""},
    )()
    monkeypatch.setattr(provider, "run_text", lambda *args, **kwargs: completed)

    selection = provider.select_codebase_map(tmp_path, "fixture-provider --json")

    assert selection.used_external_provider is True
    assert selection.artifact["provider"]["name"] == "fixture-provider"


def test_select_provider_falls_back_on_invalid_artifact(tmp_path: Path, monkeypatch) -> None:
    completed = type(
        "Completed",
        (),
        {"returncode": 0, "stdout": json.dumps({"formatVersion": "wrong"}), "stderr": ""},
    )()
    monkeypatch.setattr(provider, "run_text", lambda *args, **kwargs: completed)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\n", encoding="utf-8")

    selection = provider.select_codebase_map(tmp_path, "fixture-provider --json")

    assert selection.used_external_provider is False
    assert selection.fallback_reason is not None
    assert selection.artifact["provider"]["name"] == "directive-default-extractor"
    assert "provider artifact contract mismatch" in selection.fallback_reason


def test_select_provider_falls_back_when_no_provider_is_configured(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\n", encoding="utf-8")

    selection = provider.select_codebase_map(tmp_path)

    assert selection.used_external_provider is False
    assert selection.artifact["provider"]["fallbackReason"] == (
        "no external codebase-map provider configured"
    )


def test_select_provider_falls_back_when_provider_command_is_malformed(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\n", encoding="utf-8")

    selection = provider.select_codebase_map(tmp_path, '"unterminated')

    assert selection.used_external_provider is False
    assert selection.fallback_reason is not None
    assert "provider command could not be parsed" in selection.fallback_reason


def test_load_provider_artifact_policy_reads_projection_provider_config(tmp_path: Path) -> None:
    _write_policy_project(
        tmp_path,
        {
            "projectionProviders": {
                "codebase-map": {
                    "artifactPath": ".planning/codebase/provider-map.json",
                    "expect": {"provider": "fixture-provider", "version": "1.0"},
                }
            }
        },
    )

    policy = provider.load_provider_artifact_policy(tmp_path)

    assert policy.artifact_path == Path(".planning/codebase/provider-map.json")
    assert policy.expect_provider == "fixture-provider"
    assert policy.expect_version == "1.0"
    assert policy.invalid_reason is None


def test_select_provider_accepts_policy_artifact_path(tmp_path: Path) -> None:
    artifact_path = tmp_path / ".planning" / "codebase" / "provider-map.json"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_text(json.dumps(_artifact_with_hash(tmp_path)), encoding="utf-8")
    _write_policy_project(
        tmp_path,
        {
            "projectionProviders": {
                "codebase-map": {
                    "artifactPath": ".planning/codebase/provider-map.json",
                    "expect": {"provider": "fixture-provider", "version": "1.0"},
                }
            }
        },
    )

    selection = provider.select_codebase_map(tmp_path)

    assert selection.used_external_provider is True
    assert selection.artifact["provider"]["name"] == "fixture-provider"


def test_select_provider_falls_back_when_policy_expectation_mismatches(
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / ".planning" / "codebase" / "provider-map.json"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_text(json.dumps(_artifact_with_hash(tmp_path)), encoding="utf-8")
    _write_policy_project(
        tmp_path,
        {
            "projectionProviders": {
                "codebase-map": {
                    "artifactPath": ".planning/codebase/provider-map.json",
                    "expect": {"provider": "other-provider"},
                }
            }
        },
    )

    selection = provider.select_codebase_map(tmp_path)

    assert selection.used_external_provider is False
    assert selection.fallback_reason is not None
    assert "provider artifact expectation mismatch" in selection.fallback_reason


def test_select_provider_falls_back_when_policy_artifact_is_stale(tmp_path: Path) -> None:
    artifact_path = tmp_path / ".planning" / "codebase" / "provider-map.json"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_text(json.dumps(_artifact_with_hash(tmp_path)), encoding="utf-8")
    (tmp_path / "src" / "main.py").write_text("print('changed')\n", encoding="utf-8")
    _write_policy_project(
        tmp_path,
        {
            "projectionProviders": {
                "codebase-map": {
                    "artifactPath": ".planning/codebase/provider-map.json",
                }
            }
        },
    )

    selection = provider.select_codebase_map(tmp_path)

    assert selection.used_external_provider is False
    assert selection.fallback_reason is not None
    assert "provider artifact is stale" in selection.fallback_reason


def test_select_provider_falls_back_when_policy_artifact_lacks_freshness(
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / ".planning" / "codebase" / "provider-map.json"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_text(json.dumps(_valid_artifact()), encoding="utf-8")
    _write_policy_project(
        tmp_path,
        {
            "projectionProviders": {
                "codebase-map": {
                    "artifactPath": ".planning/codebase/provider-map.json",
                }
            }
        },
    )

    selection = provider.select_codebase_map(tmp_path)

    assert selection.used_external_provider is False
    assert selection.fallback_reason is not None
    assert "freshness could not be verified" in selection.fallback_reason


def test_provider_main_reports_default_extractor_config_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    vbrief_path = tmp_path / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    vbrief_path.parent.mkdir()
    vbrief_path.write_text("{not-json", encoding="utf-8")

    exit_code = provider.main(["--project-root", str(tmp_path)])

    captured = capsys.readouterr()
    assert exit_code == 2
    assert captured.out == ""
    payload = json.loads(captured.err)
    assert payload["ok"] is False
    assert payload["path"] == str(vbrief_path)
    assert payload["errors"][0]["code"] == "CS-CONFIG"
    assert "not valid JSON" in payload["errors"][0]["message"]
