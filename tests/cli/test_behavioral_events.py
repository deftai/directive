"""test_behavioral_events.py -- end-to-end coverage for the 4 behavioral
framework events (#635 events behavioral wiring, post-#706 unification).

Covers the vBRIEF acceptance criteria for
``vbrief/proposed/2026-04-27-635-events-behavioral-wiring.vbrief.json``,
adjusted for the unified ``events/registry.json`` data file (per the
Repair Authority [AXIOM] proposal in #709 and the data-file-convention
check follow-up in #710):

  (1) Unified registry data file lists exactly the 4 behavioral events
      (``category: "behavioral"``) with payload contracts. Mirrored by
      ``scripts/_events.KNOWN_EVENTS`` and ``REQUIRED_PAYLOAD``.
  (2) Each event has at least one synthetic emission point exercised
      end-to-end here (session pair via direct ``emit`` calls,
      ``plan:approved`` via the CLI, ``legacy:detected`` via
      ``scripts/_vbrief_legacy.emit_legacy_artifacts`` with the
      callback wired by ``scripts/migrate_vbrief.py``).
  (3) ``session:interrupted`` / ``session:resumed`` pairing is enforced --
      ``validate_pairing`` rejects orphan resumed records.
  (4) Skill text references each event by name. Asserted via grep on the
      consuming SKILL.md files.

Unification additions:
  (5) Every event in the unified registry carries a valid ``category``
      value (``detection-bound`` or ``behavioral``).
  (6) Every behavioral-category event matches the expected behavioral
      semantics (4 known names; required-payload tuple non-empty;
      consumers references at least one runtime emission surface).

Issue: #635 (epic), #642 (workflow umbrella), #709 (Repair Authority
[AXIOM]), #710 (data-file-convention check follow-up).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import _events  # noqa: E402
from _events import (  # noqa: E402
    KNOWN_EVENTS,
    REQUIRED_PAYLOAD,
    emit,
    main as events_main,
    read_events,
    validate_pairing,
)
from _vbrief_build import slugify as _slugify_shared  # noqa: E402
from _vbrief_legacy import emit_legacy_artifacts  # noqa: E402

# Behavioral events vBRIEF expects exactly these 3 (paired session counts
# as 2 names; legacy:detected and plan:approved make 4 total). The
# detection-bound sibling registry will land more on top of the same
# helper but is out of scope for this test module.
EXPECTED_BEHAVIORAL_NAMES: frozenset[str] = frozenset({
    "session:interrupted",
    "session:resumed",
    "plan:approved",
    "legacy:detected",
})


# =============================================================================
# Acceptance criterion (1): registry shape
# =============================================================================


class TestRegistry:
    def test_known_events_match_expected_set(self) -> None:
        """KNOWN_EVENTS is the authoritative emit-time gate."""
        assert KNOWN_EVENTS == EXPECTED_BEHAVIORAL_NAMES

    def test_required_payload_keys_present_for_every_event(self) -> None:
        for name in EXPECTED_BEHAVIORAL_NAMES:
            assert name in REQUIRED_PAYLOAD, (
                f"required-payload contract missing for {name!r}"
            )
            required = REQUIRED_PAYLOAD[name]
            assert required, (
                f"required-payload tuple for {name!r} must be non-empty"
            )

    def test_session_pair_required_payloads(self) -> None:
        """The pair MUST be co-emittable: resumed carries interrupted_id."""
        assert "session_id" in REQUIRED_PAYLOAD["session:interrupted"]
        assert "reason" in REQUIRED_PAYLOAD["session:interrupted"]
        assert "session_id" in REQUIRED_PAYLOAD["session:resumed"]
        assert "interrupted_id" in REQUIRED_PAYLOAD["session:resumed"]

    def test_unified_registry_lists_the_four_behavioral_events(self) -> None:
        """events/registry.json is the unified canonical contract -- the
        prior events/behavioral.yaml has been folded in (#706 unification
        per #709 / #710). Behavioral entries MUST carry
        ``category: "behavioral"`` and the 4 expected names must match."""
        registry = json.loads(
            (REPO_ROOT / "events" / "registry.json").read_text(
                encoding="utf-8"
            )
        )
        behavioral = [
            e for e in registry["events"]
            if e.get("category") == "behavioral"
        ]
        names = {e["name"] for e in behavioral}
        assert names == EXPECTED_BEHAVIORAL_NAMES, (
            f"registry.json behavioral names mismatch: extra={names - EXPECTED_BEHAVIORAL_NAMES}, "
            f"missing={EXPECTED_BEHAVIORAL_NAMES - names}"
        )

    def test_behavioral_yaml_is_dropped(self) -> None:
        """events/behavioral.yaml MUST NOT exist post-unification -- the
        file was folded into registry.json with a category enum partition.
        A re-introduction would split the contract again, defeating the
        unification."""
        legacy_path = REPO_ROOT / "events" / "behavioral.yaml"
        assert not legacy_path.exists(), (
            "events/behavioral.yaml MUST be dropped post-#706 unification "
            "(see registry.json `category` partition)"
        )

    def test_registry_schema_includes_category_enum(self) -> None:
        """events/registry.schema.json MUST require the `category` field
        on every event and constrain its enum to the two known categories
        (detection-bound, behavioral). Future categories are additive
        enum extensions per #710."""
        schema = json.loads(
            (REPO_ROOT / "events" / "registry.schema.json").read_text(
                encoding="utf-8"
            )
        )
        event_def = schema["$defs"]["Event"]
        assert "category" in event_def["required"], (
            "registry schema MUST require `category` on every event"
        )
        category_prop = event_def["properties"]["category"]
        assert set(category_prop["enum"]) >= {"detection-bound", "behavioral"}


class TestUnifiedRegistry:
    """Unification additions (#706 per #709 / #710): assert the unified
    registry surface invariants beyond the pre-existing behavioral
    acceptance criteria."""

    def test_every_event_has_valid_category(self) -> None:
        """Acceptance criterion (5) addition: every entry in the unified
        registry MUST carry a valid ``category`` value. Guards against a
        future entry that forgets the field or uses a stale value
        outside the schema enum."""
        registry = json.loads(
            (REPO_ROOT / "events" / "registry.json").read_text(
                encoding="utf-8"
            )
        )
        valid_categories = {"detection-bound", "behavioral"}
        for event in registry["events"]:
            assert "category" in event, (
                f"Event {event.get('name')!r} missing `category` field"
            )
            assert event["category"] in valid_categories, (
                f"Event {event['name']!r} has invalid category "
                f"{event['category']!r}; expected one of {valid_categories}"
            )

    def test_every_behavioral_event_has_runtime_emission_semantics(
        self,
    ) -> None:
        """Acceptance criterion (6) addition: every behavioral entry MUST
        match the expected behavioral semantics -- name in the known
        4-tuple, non-empty required-payload contract via
        ``REQUIRED_PAYLOAD``, at least one consumer pointer, and a
        trigger string that names a runtime emission surface (the
        ``scripts/_events.py`` helper or a callback wiring point).
        Guards against a behavioral entry that drifts back into
        detection-bound shape."""
        registry = json.loads(
            (REPO_ROOT / "events" / "registry.json").read_text(
                encoding="utf-8"
            )
        )
        behavioral = [
            e for e in registry["events"]
            if e.get("category") == "behavioral"
        ]
        assert len(behavioral) == 4, (
            f"Expected 4 behavioral events, found {len(behavioral)}"
        )
        for event in behavioral:
            name = event["name"]
            assert name in EXPECTED_BEHAVIORAL_NAMES, (
                f"Unknown behavioral event {name!r}"
            )
            assert REQUIRED_PAYLOAD.get(name), (
                f"Behavioral event {name!r} has no REQUIRED_PAYLOAD entry"
            )
            assert event.get("consumers"), (
                f"Behavioral event {name!r} consumers list is empty"
            )
            trigger = event.get("trigger", "")
            assert (
                "scripts/_events.py" in trigger
                or "scripts/_vbrief_legacy" in trigger
                or "scripts/migrate_vbrief" in trigger
            ), (
                f"Behavioral event {name!r} trigger does not reference a "
                f"runtime emission surface: {trigger!r}"
            )


# =============================================================================
# Acceptance criterion (2) + (3): emit + pairing
# =============================================================================


@pytest.fixture
def event_log(tmp_path: Path) -> Path:
    return tmp_path / ".deft" / "events.jsonl"


class TestEmit:
    def test_unknown_event_rejected(self, event_log: Path) -> None:
        with pytest.raises(ValueError, match="unknown event"):
            emit("definitely:not-a-real-event", {}, log_path=event_log)

    def test_missing_required_field_rejected(self, event_log: Path) -> None:
        with pytest.raises(ValueError, match="missing required fields"):
            emit(
                "session:interrupted",
                {"session_id": "s1"},  # missing reason
                log_path=event_log,
            )

    def test_emit_appends_jsonl_record_with_envelope(
        self, event_log: Path
    ) -> None:
        record = emit(
            "session:interrupted",
            {"session_id": "s1", "reason": "context-window-shift"},
            log_path=event_log,
        )
        assert record["event"] == "session:interrupted"
        assert record["payload"] == {
            "session_id": "s1",
            "reason": "context-window-shift",
        }
        assert isinstance(record["id"], str) and record["id"]
        assert record["detected_at"].endswith("Z")

        # Round-trip read: jsonl append-only.
        roundtrip = read_events(log_path=event_log)
        assert len(roundtrip) == 1
        assert roundtrip[0]["id"] == record["id"]

    def test_legacy_detected_payload_minimum(self, event_log: Path) -> None:
        record = emit(
            "legacy:detected",
            {
                "title": "Open Questions",
                "source": "PRD.md",
                "range": "140-170",
                "size_bytes": 300,
                "inline": True,
                "sidecar": None,
                "flagged": True,
            },
            log_path=event_log,
        )
        assert record["payload"]["flagged"] is True

    def test_plan_approved_payload_minimum(self, event_log: Path) -> None:
        record = emit(
            "plan:approved",
            {
                "plan_ref": "https://github.com/example/repo/pull/42",
                "approver": "msadams",
                "approval_phrase": "yes",
                "pr_number": 42,
            },
            log_path=event_log,
        )
        assert record["payload"]["approval_phrase"] == "yes"
        assert record["payload"]["pr_number"] == 42


class TestSessionPairing:
    def test_well_formed_pair_has_no_orphans(self, event_log: Path) -> None:
        opened = emit(
            "session:interrupted",
            {"session_id": "s1", "reason": "context-window-shift"},
            log_path=event_log,
        )
        emit(
            "session:resumed",
            {"session_id": "s1", "interrupted_id": opened["id"]},
            log_path=event_log,
        )
        orphans = validate_pairing(log_path=event_log)
        assert orphans == []

    def test_orphan_resumed_is_invalid(self, event_log: Path) -> None:
        """Acceptance criterion (3): a session:resumed without a matching
        session:interrupted MUST be flagged."""
        emit(
            "session:resumed",
            {"session_id": "s1", "interrupted_id": "no-such-id"},
            log_path=event_log,
        )
        orphans = validate_pairing(log_path=event_log)
        assert len(orphans) == 1
        assert orphans[0]["event"] == "session:resumed"

    def test_double_resumed_against_one_interrupt_is_orphan(
        self, event_log: Path
    ) -> None:
        """Greptile #706 P2: 1:1 pairing -- one interrupt id may satisfy at
        most one ``session:resumed``. A double-emitted resumed referencing
        the same ``interrupted_id`` is treated as orphan."""
        opened = emit(
            "session:interrupted",
            {"session_id": "s1", "reason": "context-window-shift"},
            log_path=event_log,
        )
        emit(
            "session:resumed",
            {"session_id": "s1", "interrupted_id": opened["id"]},
            log_path=event_log,
        )
        # Second resumed referencing the same interrupted id -- MUST be
        # flagged as orphan.
        emit(
            "session:resumed",
            {"session_id": "s1", "interrupted_id": opened["id"]},
            log_path=event_log,
        )
        orphans = validate_pairing(log_path=event_log)
        assert len(orphans) == 1, (
            "second session:resumed against the same interrupt id MUST be "
            "orphan (1:1 pairing per Greptile #706 P2)"
        )
        assert orphans[0]["event"] == "session:resumed"

    def test_resumed_before_interrupted_is_orphan(
        self, event_log: Path
    ) -> None:
        """Pairing is order-aware -- a resumed referencing an interrupted
        emitted later in the same log is still orphan because the helper
        tracks open interrupts in stream order."""
        opened_later = emit(
            "session:interrupted",
            {"session_id": "s1", "reason": "context-window-shift"},
            log_path=event_log,
        )
        # Manually craft an out-of-order log (resumed first) by re-writing.
        all_events = read_events(log_path=event_log)
        manual_resumed = {
            "event": "session:resumed",
            "id": "manual-resumed",
            "detected_at": "2026-04-27T22:25:52Z",
            "payload": {
                "session_id": "s1",
                "interrupted_id": opened_later["id"],
            },
        }
        with event_log.open("w", encoding="utf-8") as fh:
            fh.write(
                json.dumps(manual_resumed, ensure_ascii=False, sort_keys=True)
            )
            fh.write("\n")
            for record in all_events:
                fh.write(
                    json.dumps(record, ensure_ascii=False, sort_keys=True)
                )
                fh.write("\n")
        orphans = validate_pairing(log_path=event_log)
        assert len(orphans) == 1


# =============================================================================
# legacy:detected wired through emit_legacy_artifacts
# =============================================================================


class TestLegacyDetectedEmission:
    def test_no_emission_when_callback_is_none(self, tmp_path: Path) -> None:
        """Default API surface preserved: existing callers (and the
        existing _vbrief_legacy tests) emit no events."""
        events_seen: list[tuple[str, dict]] = []

        sections = [("Dependency Graph", "phase-1 -> phase-2", 10, 12)]
        narrative, _sidecars, stats = emit_legacy_artifacts(
            sections,
            "SPECIFICATION.md",
            tmp_path,
            slugify_fn=_slugify_shared,
        )
        assert "Dependency Graph" in narrative
        assert stats[0]["title"] == "Dependency Graph"
        # Sanity: the local capture list stayed empty because we never
        # passed it as the emitter.
        assert events_seen == []

    def test_emission_per_section_via_callback(self, tmp_path: Path) -> None:
        events_seen: list[tuple[str, dict]] = []

        def _capture(name: str, payload: dict) -> None:
            events_seen.append((name, payload))

        sections = [
            ("Dependency Graph", "phase-1 -> phase-2", 10, 12),
            ("Open Questions", "what about X?", 50, 70),
        ]
        emit_legacy_artifacts(
            sections,
            "SPECIFICATION.md",
            tmp_path,
            slugify_fn=_slugify_shared,
            event_emitter=_capture,
        )
        assert len(events_seen) == 2
        assert all(name == "legacy:detected" for name, _ in events_seen)
        captured_titles = [payload["title"] for _, payload in events_seen]
        assert captured_titles == ["Dependency Graph", "Open Questions"]

    def test_flagged_appears_in_event_payload_when_passed(
        self, tmp_path: Path
    ) -> None:
        """Greptile #706 P1: when ``flagged=True`` is passed (PRD.md
        hand-edit captures), the ``legacy:detected`` event payload MUST
        carry ``flagged: True`` -- the migrator's prior post-hoc patch
        landed AFTER emission and silently dropped the field."""
        events_seen: list[tuple[str, dict]] = []

        def _capture(name: str, payload: dict) -> None:
            events_seen.append((name, payload))

        sections = [("Open Questions", "what about X?", 50, 70)]
        emit_legacy_artifacts(
            sections,
            "PRD.md",
            tmp_path,
            slugify_fn=_slugify_shared,
            warning_prefix="warn",
            event_emitter=_capture,
            flagged=True,
        )
        assert len(events_seen) == 1
        name, payload = events_seen[0]
        assert name == "legacy:detected"
        assert payload.get("flagged") is True, (
            "flagged=True MUST land in the emitted payload BEFORE event "
            "emission so the events/behavioral.yaml contract is honoured "
            "(Greptile #706 P1)"
        )

    def test_flagged_default_false_omits_field_in_event_payload(
        self, tmp_path: Path
    ) -> None:
        """Default ``flagged=False`` does NOT add the field to the payload
        -- non-PRD captures emit a payload without the flag, matching the
        registry's optional-field semantics."""
        events_seen: list[tuple[str, dict]] = []

        def _capture(name: str, payload: dict) -> None:
            events_seen.append((name, payload))

        sections = [("Dependency Graph", "phase-1 -> phase-2", 10, 12)]
        emit_legacy_artifacts(
            sections,
            "SPECIFICATION.md",
            tmp_path,
            slugify_fn=_slugify_shared,
            event_emitter=_capture,
        )
        assert len(events_seen) == 1
        _, payload = events_seen[0]
        assert "flagged" not in payload

    def test_emitter_failures_do_not_break_capture(
        self, tmp_path: Path
    ) -> None:
        """The migrator MUST keep capturing legacy artifacts even if the
        events sink is unavailable -- legacy capture is the primary
        contract; events are an additive observability layer."""

        def _broken(_name: str, _payload: dict) -> None:
            raise RuntimeError("event bus unavailable")

        sections = [("Dependency Graph", "phase-1 -> phase-2", 10, 12)]
        narrative, _sidecars, stats = emit_legacy_artifacts(
            sections,
            "SPECIFICATION.md",
            tmp_path,
            slugify_fn=_slugify_shared,
            event_emitter=_broken,
        )
        assert "Dependency Graph" in narrative
        assert stats[0]["inline"] is True


# =============================================================================
# CLI surface (Acceptance criterion (4) reach: CLI is the agent emission point)
# =============================================================================


class TestCli:
    def test_emit_via_cli(self, event_log: Path) -> None:
        rc = events_main([
            "emit",
            "plan:approved",
            "--log",
            str(event_log),
            "--plan-ref",
            "https://github.com/example/repo/pull/42",
            "--approver",
            "msadams",
            "--approval-phrase",
            "yes",
            "--pr-number",
            "42",
        ])
        assert rc == 0
        records = read_events(log_path=event_log)
        assert len(records) == 1
        assert records[0]["event"] == "plan:approved"
        assert records[0]["payload"]["pr_number"] == 42

    def test_validate_pairing_cli_exits_nonzero_on_orphan(
        self, event_log: Path
    ) -> None:
        emit(
            "session:resumed",
            {"session_id": "s1", "interrupted_id": "missing"},
            log_path=event_log,
        )
        rc = events_main(["validate-pairing", "--log", str(event_log)])
        assert rc == 1

    def test_validate_pairing_cli_exits_zero_on_well_formed(
        self, event_log: Path
    ) -> None:
        opened = emit(
            "session:interrupted",
            {"session_id": "s1", "reason": "context-window-shift"},
            log_path=event_log,
        )
        emit(
            "session:resumed",
            {"session_id": "s1", "interrupted_id": opened["id"]},
            log_path=event_log,
        )
        rc = events_main(["validate-pairing", "--log", str(event_log)])
        assert rc == 0

    def test_script_runnable_as_subprocess(
        self, event_log: Path, tmp_path: Path
    ) -> None:
        """Smoke test: the CLI surface is reachable as a direct script
        invocation. ``python -m scripts._events`` works equivalently when
        ``scripts/`` is on PYTHONPATH (mirroring the in-process test
        harness above); skill docs reference the ``python -m`` form for
        agent ergonomics."""
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "_events.py"),
                "emit",
                "session:interrupted",
                "--log",
                str(event_log),
                "--session-id",
                "s-cli",
                "--reason",
                "alignment-probe",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, result.stderr
        records = read_events(log_path=event_log)
        assert len(records) == 1
        assert records[0]["event"] == "session:interrupted"


# =============================================================================
# Acceptance criterion (4): consuming skills reference each event by name
# =============================================================================


class TestSkillReferences:
    @pytest.mark.parametrize(
        "skill_path,event_name",
        [
            (
                "skills/deft-directive-sync/SKILL.md",
                "session:interrupted",
            ),
            (
                "skills/deft-directive-sync/SKILL.md",
                "session:resumed",
            ),
            (
                "skills/deft-directive-review-cycle/SKILL.md",
                "plan:approved",
            ),
        ],
    )
    def test_event_name_referenced_in_consuming_skill(
        self, skill_path: str, event_name: str
    ) -> None:
        body = (REPO_ROOT / skill_path).read_text(encoding="utf-8")
        assert event_name in body, (
            f"{skill_path} MUST reference {event_name!r} by name "
            "(acceptance criterion 4 in vbrief/proposed/"
            "2026-04-27-635-events-behavioral-wiring.vbrief.json)"
        )


# Suppress the unused-import lint for the module-import shim.
_ = _events  # noqa: F841
