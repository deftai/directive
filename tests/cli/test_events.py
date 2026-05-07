"""test_events.py -- Tests for the framework events surface (#635).

Covers:
- events/registry.json validates against its own shape (registry.schema.json
  required fields).
- The 5 detection-bound events are registered with expected names and
  category="detection-bound".
- ``scripts/_events.py::emit`` returns a uniform record matching
  ``events/event-record.schema.json``.
- ``emit`` raises :class:`EventEmissionError` for unregistered names.
- ``emit`` appends a JSON line to ``DEFT_EVENT_LOG`` when the env var is set.
- :func:`detect_agents_md_stale` codifies QUICK-START.md Step 2b correctly:
  None when AGENTS.md is absent or all referenced paths exist; payload when
  any referenced skill is missing or carries the deprecated-skill-redirect
  sentinel.
- Per-detector emit wiring: ``vbrief_validate.validate_all`` emits
  ``vbrief:invalid`` when errors/warnings surface; the migrator emits
  ``dirty-tree`` when its guard trips.

Issue: #635 (epic), authority: #642 canonical workflow comment.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
EVENTS_DIR = REPO_ROOT / "events"

# Add scripts/ to sys.path so the test file can import the helpers under test
# the same way the migrator and validator scripts do (sys.path.insert at
# module load).
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# Module renamed from `_events` to `_event_detect` to avoid file-level
# conflict with the sibling events-behavioral vBRIEF's `scripts/_events.py`
# (#635 coordination). Aliased here so test code can keep using the
# `_events` namespace identifier.
import _event_detect as _events  # noqa: E402, I001 -- after sys.path mutate


EXPECTED_DETECTION_BOUND_NAMES = frozenset(
    {
        "pre-cutover:detected",
        "vbrief:invalid",
        "agents-md:stale",
        "version:drift",
        "dirty-tree:detected",
        # #801: periodic remote-version probe -- emitted by
        # run::_maybe_emit_remote_drift_warning when the read-only
        # `git ls-remote --tags --refs <upstream>` probe returns BEHIND.
        "framework:remote-drift",
    }
)

# Post-#706 unification: the registry also lists 4 behavioral events
# (category="behavioral"). The detection-bound test surface here filters
# to detection-bound entries; the behavioral-emission tests live in
# tests/cli/test_behavioral_events.py.
EXPECTED_BEHAVIORAL_NAMES = frozenset(
    {
        "session:interrupted",
        "session:resumed",
        "plan:approved",
        "legacy:detected",
    }
)

EXPECTED_EVENT_NAMES = (
    EXPECTED_DETECTION_BOUND_NAMES | EXPECTED_BEHAVIORAL_NAMES
)

EVENT_NAME_RE = re.compile(r"^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$")
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


# ---------------------------------------------------------------------------
# Registry shape
# ---------------------------------------------------------------------------


class TestRegistryShape:
    """events/registry.json conforms to events/registry.schema.json."""

    def test_registry_loads(self) -> None:
        registry = _events.load_registry()
        assert isinstance(registry, dict)
        assert registry.get("version") == "1"
        assert isinstance(registry.get("events"), list)

    def test_registry_lists_six_detection_bound_events(self) -> None:
        """Post-#801: registry now lists 6 detection-bound events (the 5 from
        #635 plus ``framework:remote-drift``)."""
        registry = _events.load_registry()
        events = registry["events"]
        detection_bound = [e for e in events if e.get("category") == "detection-bound"]
        assert len(detection_bound) == 6, (
            f"Expected exactly 6 detection-bound events, found {len(detection_bound)}"
        )
        detection_names = {e["name"] for e in detection_bound}
        assert detection_names == EXPECTED_DETECTION_BOUND_NAMES, (
            "Detection-bound names mismatch: "
            f"extra={detection_names - EXPECTED_DETECTION_BOUND_NAMES}, "
            f"missing={EXPECTED_DETECTION_BOUND_NAMES - detection_names}"
        )

    def test_registry_event_names_match_expected_set(self) -> None:
        """Post-#706 unification: the registry includes both detection-bound
        and behavioral events. Post-#801 the expected union is 6 + 4 = 10 names."""
        names = _events.registered_event_names()
        assert names == EXPECTED_EVENT_NAMES, (
            f"Registry name mismatch: extra={names - EXPECTED_EVENT_NAMES}, "
            f"missing={EXPECTED_EVENT_NAMES - names}"
        )

    def test_each_event_has_required_fields(self) -> None:
        registry = _events.load_registry()
        required = {"name", "category", "description", "trigger", "payload", "consumers"}
        for event in registry["events"]:
            missing = required - event.keys()
            assert not missing, f"Event {event.get('name')!r} missing fields: {missing}"
            assert EVENT_NAME_RE.match(event["name"]), (
                f"Event name {event['name']!r} does not match canonical pattern"
            )
            assert event["category"] in {"detection-bound", "behavioral"}
            assert isinstance(event["payload"], dict) and event["payload"], (
                f"Event {event['name']!r} payload must be a non-empty object"
            )
            assert isinstance(event["consumers"], list) and event["consumers"], (
                f"Event {event['name']!r} consumers must be a non-empty array"
            )
            for key, contract in event["payload"].items():
                assert isinstance(contract, str) and contract, (
                    f"Event {event['name']!r} payload[{key!r}] must be a non-empty string"
                )

    def test_registry_schema_self_describes(self) -> None:
        """registry.schema.json itself parses and matches the canonical shape."""
        schema_path = EVENTS_DIR / "registry.schema.json"
        record_schema_path = EVENTS_DIR / "event-record.schema.json"
        assert schema_path.is_file()
        assert record_schema_path.is_file()
        registry_schema = json.loads(schema_path.read_text(encoding="utf-8"))
        record_schema = json.loads(record_schema_path.read_text(encoding="utf-8"))
        # Sanity: top-level required fields exist on both schemas.
        assert "events" in registry_schema["properties"]
        assert set(record_schema["required"]) == {"event", "detected_at", "payload"}


# ---------------------------------------------------------------------------
# emit() behavior
# ---------------------------------------------------------------------------


class TestEmit:
    """`emit` builds uniform records and respects the registry."""

    def setup_method(self) -> None:
        _events.clear_registry_cache()

    def test_emit_returns_record_matching_schema(self) -> None:
        record = _events.emit(
            "dirty-tree:detected",
            {"project_root": "/tmp/example"},
        )
        assert set(record.keys()) == {"event", "detected_at", "payload"}
        assert record["event"] == "dirty-tree:detected"
        assert ISO_TIMESTAMP_RE.match(record["detected_at"])
        assert record["payload"] == {"project_root": "/tmp/example"}

    def test_emit_rejects_unregistered_event(self) -> None:
        with pytest.raises(_events.EventEmissionError):
            _events.emit("not-a-real:event", {})

    def test_emit_writes_to_log_file(self, tmp_path, monkeypatch) -> None:
        log_path = tmp_path / "events.log"
        monkeypatch.setenv("DEFT_EVENT_LOG", str(log_path))
        record = _events.emit(
            "version:drift",
            {
                "project_root": "/tmp/example",
                "recorded_version": "0.19.0",
                "current_version": "0.20.0",
                "marker_path": "/tmp/example/vbrief/.deft-version",
            },
        )
        assert log_path.is_file()
        line = log_path.read_text(encoding="utf-8").strip()
        parsed = json.loads(line)
        assert parsed == record

    def test_emit_silent_when_no_log_env(self, tmp_path, monkeypatch) -> None:
        # DEFT_EVENT_LOG explicitly unset -> no file should be created.
        monkeypatch.delenv("DEFT_EVENT_LOG", raising=False)
        log_candidate = tmp_path / "should-not-exist.log"
        record = _events.emit(
            "dirty-tree:detected", {"project_root": str(tmp_path)}
        )
        assert isinstance(record, dict)
        assert not log_candidate.exists()

    def test_emit_caps_payload_lists(self, monkeypatch) -> None:
        monkeypatch.delenv("DEFT_EVENT_LOG", raising=False)
        big_errors = [f"err-{i}" for i in range(120)]
        record = _events.emit(
            "vbrief:invalid",
            {
                "vbrief_dir": "/tmp",
                "error_count": len(big_errors),
                "warning_count": 0,
                "errors": big_errors,
                "warnings": [],
            },
        )
        assert len(record["payload"]["errors"]) == 50
        # error_count remains the true count (not the truncated length).
        assert record["payload"]["error_count"] == 120


# ---------------------------------------------------------------------------
# detect_agents_md_stale -- QUICK-START.md Step 2b codification
# ---------------------------------------------------------------------------


class TestDetectAgentsMdStale:
    def test_returns_none_when_agents_md_absent(self, tmp_path) -> None:
        assert _events.detect_agents_md_stale(tmp_path) is None

    def test_returns_none_when_all_referenced_skills_present(self, tmp_path) -> None:
        # framework_root is tmp_path/deft (consumer layout).
        deft_root = tmp_path / "deft"
        skill_dir = deft_root / "skills" / "deft-directive-setup"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "# deft-directive-setup\nFresh skill content.\n", encoding="utf-8"
        )
        (tmp_path / "AGENTS.md").write_text(
            "Read deft/skills/deft-directive-setup/SKILL.md for setup.\n",
            encoding="utf-8",
        )
        assert _events.detect_agents_md_stale(tmp_path) is None

    def test_detects_missing_skill_path(self, tmp_path) -> None:
        # AGENTS.md references a skill that does not exist on disk.
        (tmp_path / "deft").mkdir()
        (tmp_path / "AGENTS.md").write_text(
            "Read deft/skills/deft-not-real/SKILL.md.\n", encoding="utf-8"
        )
        payload = _events.detect_agents_md_stale(tmp_path)
        assert payload is not None
        assert payload["missing_paths"] == ["deft/skills/deft-not-real/SKILL.md"]
        assert payload["redirect_paths"] == []

    def test_detects_redirect_stub_skill_path(self, tmp_path) -> None:
        deft_root = tmp_path / "deft"
        skill_dir = deft_root / "skills" / "deft-old-skill"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "<!-- deft:deprecated-skill-redirect -->\n# deft-old-skill (Deprecated)\n",
            encoding="utf-8",
        )
        (tmp_path / "AGENTS.md").write_text(
            "Read deft/skills/deft-old-skill/SKILL.md for guidance.\n",
            encoding="utf-8",
        )
        payload = _events.detect_agents_md_stale(tmp_path)
        assert payload is not None
        assert payload["redirect_paths"] == ["deft/skills/deft-old-skill/SKILL.md"]
        assert payload["missing_paths"] == []

    def test_dedupes_repeated_tokens(self, tmp_path) -> None:
        (tmp_path / "deft").mkdir()
        (tmp_path / "AGENTS.md").write_text(
            "deft/skills/deft-x/SKILL.md\n"
            "Also see deft/skills/deft-x/SKILL.md again.\n",
            encoding="utf-8",
        )
        payload = _events.detect_agents_md_stale(tmp_path)
        assert payload is not None
        assert payload["missing_paths"] == ["deft/skills/deft-x/SKILL.md"]


# ---------------------------------------------------------------------------
# Per-detector wiring -- vbrief_validate emits vbrief:invalid
# ---------------------------------------------------------------------------


class TestVbriefValidateEmit:
    """validate_all emits vbrief:invalid when warnings or errors surface."""

    def test_emit_when_placeholder_warning_fires(
        self, tmp_path, monkeypatch
    ) -> None:
        # Build a minimal vbrief dir with the deprecated SPECIFICATION.md
        # containing real (non-redirect) content -> placeholder warning fires.
        vbrief_dir = tmp_path / "vbrief"
        for folder in ("proposed", "pending", "active", "completed", "cancelled"):
            (vbrief_dir / folder).mkdir(parents=True)
        (tmp_path / "SPECIFICATION.md").write_text(
            "# Real content with no redirect sentinel\n", encoding="utf-8"
        )
        log_path = tmp_path / "events.log"
        monkeypatch.setenv("DEFT_EVENT_LOG", str(log_path))

        # Re-import vbrief_validate fresh so it sees the env var via the
        # module-level _emit_event reference (the helper resolves it lazily
        # from os.environ inside emit()).
        import importlib

        import vbrief_validate

        importlib.reload(vbrief_validate)
        errors, warnings, scope_count = vbrief_validate.validate_all(vbrief_dir)
        assert scope_count == 0
        assert any("non-redirect content" in w for w in warnings)

        # Event log should contain a single vbrief:invalid record.
        assert log_path.is_file(), "Expected DEFT_EVENT_LOG to be written"
        records = [
            json.loads(line)
            for line in log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        kinds = [r["event"] for r in records]
        assert "vbrief:invalid" in kinds
        invalid = next(r for r in records if r["event"] == "vbrief:invalid")
        assert invalid["payload"]["warning_count"] >= 1


# ---------------------------------------------------------------------------
# Per-detector wiring -- migrator emits dirty-tree
# ---------------------------------------------------------------------------


def _git_init(path: Path) -> None:
    """Initialise a git repo in ``path`` for the dirty-tree integration test."""
    subprocess.run(
        ["git", "init", "-q"], cwd=str(path), check=True, capture_output=True
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=str(path),
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=str(path),
        check=True,
        capture_output=True,
    )


class TestMigratorDirtyTreeEmit:
    """``migrate`` emits dirty-tree when its guard trips."""

    def test_dirty_tree_event_emitted(self, tmp_path, monkeypatch) -> None:
        _git_init(tmp_path)
        # Create an uncommitted file so `git status --porcelain` is non-empty.
        (tmp_path / "dirty.txt").write_text("content\n", encoding="utf-8")

        log_path = tmp_path / "events.log"
        monkeypatch.setenv("DEFT_EVENT_LOG", str(log_path))

        import importlib

        import migrate_vbrief

        importlib.reload(migrate_vbrief)
        ok, messages = migrate_vbrief.migrate(tmp_path)
        assert ok is False
        assert any("Working tree is not clean" in m for m in messages)

        records = [
            json.loads(line)
            for line in log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        kinds = [r["event"] for r in records]
        assert "dirty-tree:detected" in kinds
        dirty = next(r for r in records if r["event"] == "dirty-tree:detected")
        # ``project_root`` matches the resolved tmp path. Path comparison via
        # Path() handles symlink resolution differences across platforms.
        assert Path(dirty["payload"]["project_root"]) == tmp_path.resolve()
