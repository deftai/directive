"""Tests for scripts/preflight_architecture_sor.py.

The fixtures mirror the proposal acceptance examples:

- durable product state on JSON file fails
- durable product state on approved DB passes
- canonical artifact file reads pass
- cache file writes pass only with invalidation metadata
- browser storage passes only for ephemeral UI state
- reference-app parity fails without persistence/auth comparison
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "preflight_architecture_sor.py"
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "sor_gate"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    return _load_module("preflight_architecture_sor", PREFLIGHT_PATH)


def _fixture(name: str) -> Path:
    return FIXTURE_DIR / name


def _write_story(tmp_path: Path, payload: dict[str, Any]) -> Path:
    path = tmp_path / "vbrief" / "active" / "story.vbrief.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _load_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def test_durable_product_state_on_json_file_fails(preflight):
    result = preflight.evaluate_story(_fixture("durable_json_fails.vbrief.json"))
    assert result.code == 1
    assert "Durable" in result.message
    assert "json_file" in result.message


def test_durable_product_state_on_approved_db_passes(preflight):
    result = preflight.evaluate_story(_fixture("durable_db_passes.vbrief.json"))
    assert result.code == 0


def test_canonical_artifact_file_reads_pass(preflight):
    result = preflight.evaluate_story(_fixture("canonical_artifact_passes.vbrief.json"))
    assert result.code == 0

    diff = """\
diff --git a/app/catalog.py b/app/catalog.py
--- a/app/catalog.py
+++ b/app/catalog.py
@@ -0,0 +1 @@
+CATALOG = json.loads(Path("seed-catalog.json").read_text(encoding="utf-8"))
"""
    diff_result = preflight.evaluate_diff_text(diff, project_root=REPO_ROOT)
    assert diff_result.code == 0
    assert "no stateful diff signals" in diff_result.message


def test_cache_file_writes_pass_only_with_invalidation_metadata(preflight, tmp_path):
    good_story = _fixture("cache_file_passes.vbrief.json")
    good = preflight.evaluate_story(good_story)
    assert good.code == 0

    diff = """\
diff --git a/app/cache_store.py b/app/cache_store.py
--- a/app/cache_store.py
+++ b/app/cache_store.py
@@ -0,0 +1 @@
+Path(".cache/search.json").write_text(json.dumps(result), encoding="utf-8")
"""
    diff_result = preflight.evaluate_diff_text(
        diff,
        project_root=REPO_ROOT,
        story_path=good_story,
    )
    assert diff_result.code == 0

    payload = _load_payload(good_story)
    surface = payload["architecture"]["systemOfRecord"]["stateSurfaces"][0]
    del surface["invalidationRules"]
    bad_story = _write_story(tmp_path, payload)
    bad = preflight.evaluate_story(bad_story)
    assert bad.code == 1
    assert "invalidation" in bad.message


def test_browser_storage_passes_only_for_ephemeral_ui_state(preflight):
    diff = """\
diff --git a/web/sidebar.ts b/web/sidebar.ts
--- a/web/sidebar.ts
+++ b/web/sidebar.ts
@@ -0,0 +1 @@
+localStorage.setItem("selectedSidebarTab", tabId)
"""
    browser_story = _fixture("browser_ephemeral_passes.vbrief.json")
    ok = preflight.evaluate_diff_text(diff, project_root=REPO_ROOT, story_path=browser_story)
    assert ok.code == 0

    durable_story = _fixture("durable_db_passes.vbrief.json")
    blocked = preflight.evaluate_diff_text(diff, project_root=REPO_ROOT, story_path=durable_story)
    assert blocked.code == 1
    assert "browser_storage" in blocked.message


def test_reference_app_parity_fails_without_persistence_auth_comparison(preflight):
    result = preflight.evaluate_story(
        _fixture("reference_app_missing_comparison_fails.vbrief.json")
    )
    assert result.code == 1
    assert "Reference-application parity" in result.message


def test_durable_db_diff_passes_with_mutation_and_model_signals(preflight):
    diff = """\
diff --git a/app/models.py b/app/models.py
--- a/app/models.py
+++ b/app/models.py
@@ -0,0 +1,3 @@
+class Workspace(Base):
+    __tablename__ = "workspaces"
+    id = db.Column(db.String, primary_key=True)
diff --git a/app/routes.py b/app/routes.py
--- a/app/routes.py
+++ b/app/routes.py
@@ -0,0 +1,2 @@
+@app.post("/workspaces")
+def create_workspace():
"""
    result = preflight.evaluate_diff_text(
        diff,
        project_root=REPO_ROOT,
        story_path=_fixture("durable_db_passes.vbrief.json"),
    )
    assert result.code == 0


def test_declared_db_but_diff_implements_json_file_fails(preflight):
    diff = """\
diff --git a/app/workspace_repository.py b/app/workspace_repository.py
--- a/app/workspace_repository.py
+++ b/app/workspace_repository.py
@@ -0,0 +1 @@
+Path("workspaces.json").write_text(json.dumps(workspaces), encoding="utf-8")
"""
    result = preflight.evaluate_diff_text(
        diff,
        project_root=REPO_ROOT,
        story_path=_fixture("durable_db_passes.vbrief.json"),
    )
    assert result.code == 1
    assert "json_file" in result.message
    assert "forbids" in result.message or "without a state surface" in result.message


def test_storage_matching_does_not_equate_generic_file_with_json_file(preflight):
    assert preflight._storage_matches("json_file", "json_file")
    assert preflight._storage_matches("database", "application database")
    assert not preflight._storage_matches("filesystem", "json_file")
    assert not preflight._storage_matches("database", "indexeddb")


def test_diff_scanner_exempts_its_own_helper_file(preflight):
    diff = """\
diff --git a/scripts/_sor_gate_diff.py b/scripts/_sor_gate_diff.py
--- a/scripts/_sor_gate_diff.py
+++ b/scripts/_sor_gate_diff.py
@@ -0,0 +1,3 @@
+r"(write_text|write_bytes)"
+r"\\b(auth|session|permission)\\b"
+Path("workspaces.json").write_text("{}")
"""
    signals, _ = preflight.scan_diff(diff)
    assert signals == []


def test_auth_and_workflow_signals_do_not_match_path_only(preflight):
    diff = """\
diff --git a/app/auth.py b/app/auth.py
--- a/app/auth.py
+++ b/app/auth.py
@@ -0,0 +1 @@
+# copy edit only
diff --git a/app/queue.py b/app/queue.py
--- a/app/queue.py
+++ b/app/queue.py
@@ -0,0 +1 @@
+# copy edit only
"""
    signals, _ = preflight.scan_diff(diff)
    assert [signal.kind for signal in signals] == []


def test_workflow_signal_ignores_plain_text_mentions(preflight):
    diff = """\
diff --git a/app/worker.py b/app/worker.py
--- a/app/worker.py
+++ b/app/worker.py
@@ -0,0 +1,3 @@
+logger.debug("job failed while syncing")
+status_message = "queue stalled"
+# runtime warning copy edit
"""
    signals, _ = preflight.scan_diff(diff)
    assert [signal.kind for signal in signals] == []


def test_workflow_signal_detects_stateful_mutations(preflight):
    diff = """\
diff --git a/app/worker.py b/app/worker.py
--- a/app/worker.py
+++ b/app/worker.py
@@ -0,0 +1,3 @@
+def enqueue_job(job_id):
+    job_queue.append(job_id)
+    worker_state[job_id] = "running"
"""
    signals, _ = preflight.scan_diff(diff)
    assert "workflow_state" in [signal.kind for signal in signals]


def test_stateful_diff_without_design_record_fails(preflight):
    diff = """\
diff --git a/app/routes.py b/app/routes.py
--- a/app/routes.py
+++ b/app/routes.py
@@ -0,0 +1 @@
+@app.delete("/workspaces/{workspace_id}")
"""
    result = preflight.evaluate_diff_text(diff, project_root=REPO_ROOT)
    assert result.code == 1
    assert "no matching" in result.message


def test_main_story_mode_json_schema(preflight, capsys):
    code = preflight.main(
        [
            "--story-path",
            str(_fixture("durable_db_passes.vbrief.json")),
            "--json",
        ]
    )
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert code == 0
    assert payload["ok"] is True
    assert payload["exit_code"] == 0
