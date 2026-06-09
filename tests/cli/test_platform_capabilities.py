"""Tests for scripts/platform_capabilities.py (#1557a).

Covers runtime_mode classification (local-unsandboxed, cursor-native-sandbox,
cloud-headless), Cursor sandbox UID remap interpretation, and read-only probe
behaviour.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "platform_capabilities.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("platform_capabilities", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["platform_capabilities"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def pc():
    return _load_module()


def _write_uid_map(path: Path, lines: list[str]) -> Path:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


class TestRuntimeModeClassification:
    def test_local_unsandboxed_default(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"USER": "msadams"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=1000,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_LOCAL_UNSANDBOXED
        assert report.identity_kind == pc.IDENTITY_LOCAL_USER

    def test_cursor_native_sandbox_with_uid_remap(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", ["0 1000 1"])
        report = pc.probe_runtime_capabilities(
            environ={
                "USER": "root",
                "CURSOR_SANDBOX": "1",
                "CURSOR_ORIG_UID": "1000",
                "CURSOR_ORIG_GID": "1000",
                "CURSOR_SANDBOX_LANDLOCK_STATUS": "fully_enforced",
            },
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=0,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_CURSOR_NATIVE_SANDBOX
        assert report.sandbox_uid_remap is True
        assert report.identity_kind == pc.IDENTITY_SANDBOX_REMAPPED_LOCAL_USER

    def test_cloud_headless_cursor_agent(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"CURSOR_AGENT": "1"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=1000,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_CLOUD_HEADLESS

    def test_cloud_headless_grok_build(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"GROK_BUILD": "true"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=1000,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_CLOUD_HEADLESS

    def test_cloud_headless_deft_agent_runtime(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"DEFT_AGENT_RUNTIME": "grok-build"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=1000,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_CLOUD_HEADLESS

    def test_cloud_headless_ci_without_local_composer(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"CI": "true"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=1000,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_CLOUD_HEADLESS


class TestSandboxUidRemapInterpretation:
    def test_sandbox_remap_not_real_root(self, pc):
        uid_map = (pc.UidMapEntry(inside_id=0, outside_id=1000, length=1),)
        assert pc.detect_sandbox_uid_remap(
            uid_map,
            effective_uid=0,
            cursor_orig_uid=1000,
        )

    def test_real_root_without_remap(self, pc):
        uid_map = (pc.UidMapEntry(inside_id=0, outside_id=0, length=1),)
        assert not pc.detect_sandbox_uid_remap(
            uid_map,
            effective_uid=0,
            cursor_orig_uid=1000,
        )
        assert (
            pc.classify_identity_kind(
                effective_uid=0,
                sandbox_uid_remap=False,
            )
            == pc.IDENTITY_REAL_ROOT
        )

    def test_cursor_sandbox_env_without_uid_map_still_classifies(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"CURSOR_SANDBOX": "1", "CURSOR_ORIG_UID": "1000"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=0,
        )
        assert report.runtime_mode == pc.RUNTIME_MODE_CURSOR_NATIVE_SANDBOX
        assert report.identity_kind == pc.IDENTITY_REAL_ROOT
        assert report.sandbox_uid_remap is False


class TestReadOnlyProbe:
    def test_probe_does_not_mutate_vbrief_lifecycle_files(self, pc, tmp_path):
        vbrief_dir = tmp_path / "vbrief" / "active"
        vbrief_dir.mkdir(parents=True)
        vbrief_path = vbrief_dir / "story.vbrief.json"
        vbrief_path.write_text('{"plan":{"status":"running"}}', encoding="utf-8")
        uid_map = _write_uid_map(tmp_path / "uid_map", ["0 1000 1"])

        before_mtime = vbrief_path.stat().st_mtime_ns
        time.sleep(0.01)

        pc.probe_runtime_capabilities(
            environ={
                "CURSOR_SANDBOX": "1",
                "CURSOR_ORIG_UID": "1000",
            },
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=0,
        )

        after_mtime = vbrief_path.stat().st_mtime_ns
        assert after_mtime == before_mtime

    def test_get_platform_capabilities_alias(self, pc, monkeypatch):
        monkeypatch.setattr(
            pc,
            "probe_runtime_capabilities",
            lambda **kwargs: pc.RuntimeCapabilityReport(
                runtime_mode=pc.RUNTIME_MODE_LOCAL_UNSANDBOXED,
                identity_kind=pc.IDENTITY_LOCAL_USER,
                effective_uid=1000,
                effective_username="probe-user",
                uid_map=(),
                cursor_orig_uid=None,
                cursor_orig_gid=None,
                sandbox_uid_remap=False,
                ownership=None,
                signals={},
            ),
        )
        report = pc.get_platform_capabilities()
        assert report.runtime_mode == pc.RUNTIME_MODE_LOCAL_UNSANDBOXED


class TestUidMapParsing:
    def test_read_uid_map_parses_rows(self, pc, tmp_path):
        path = _write_uid_map(
            tmp_path / "uid_map",
            ["0 1000 1", "# comment", "1 1 65535"],
        )
        entries = pc.read_uid_map(path)
        assert entries == (
            pc.UidMapEntry(inside_id=0, outside_id=1000, length=1),
            pc.UidMapEntry(inside_id=1, outside_id=1, length=65535),
        )

    def test_read_uid_map_missing_file_returns_empty(self, pc, tmp_path):
        assert pc.read_uid_map(tmp_path / "missing") == ()


class TestCliAndSerialization:
    def test_main_json_output(self, pc, monkeypatch, capsys):
        monkeypatch.setattr(
            pc,
            "get_platform_capabilities",
            lambda: pc.RuntimeCapabilityReport(
                runtime_mode=pc.RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
                identity_kind=pc.IDENTITY_SANDBOX_REMAPPED_LOCAL_USER,
                effective_uid=0,
                effective_username="root",
                uid_map=(pc.UidMapEntry(inside_id=0, outside_id=1000, length=1),),
                cursor_orig_uid=1000,
                cursor_orig_gid=1000,
                sandbox_uid_remap=True,
                ownership=None,
                signals={"CURSOR_SANDBOX": "1"},
            ),
        )
        assert pc.main(["--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["runtime_mode"] == pc.RUNTIME_MODE_CURSOR_NATIVE_SANDBOX
        assert payload["sandbox_uid_remap"] is True
        assert payload["uid_map"][0]["outside_id"] == 1000

    def test_to_dict_round_trip_fields(self, pc, tmp_path):
        uid_map = _write_uid_map(tmp_path / "uid_map", [])
        report = pc.probe_runtime_capabilities(
            environ={"USER": "msadams"},
            uid_map_path=uid_map,
            cwd=tmp_path,
            effective_uid_override=1000,
        )
        payload = report.to_dict()
        assert payload["runtime_mode"] == pc.RUNTIME_MODE_LOCAL_UNSANDBOXED
        assert "signals" in payload
        assert payload["ownership"]["path"] == str(tmp_path)
