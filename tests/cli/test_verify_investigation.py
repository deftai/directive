"""test_verify_investigation.py -- coverage for the #1621 investigation-ledger validator.

Exercises ``scripts/verify_investigation.py``:

- the pure ``validate_ledger`` checklist (hard failures + soft warnings),
- ``load_ledger`` config-error surface,
- the three-state CLI exit (0 close-ready / 1 hard failures / 2 config error).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import verify_investigation as vi  # noqa: E402


def _close_ready_ledger() -> dict:
    """A minimal ledger that passes every hard check."""
    return {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": "2026-06-14-example",
            "title": "Why did X happen?",
            "status": "completed",
            "items": [
                {
                    "id": "branch.slowness",
                    "title": "Why slow",
                    "status": "completed",
                    "items": [
                        {
                            "id": "claim.slowness.M1",
                            "title": "embed contention",
                            "status": "completed",
                            "metadata": {"x-claim": {"evidenceRefs": ["EV-001"]}},
                        }
                    ],
                },
                {
                    "id": "branch.queue",
                    "title": "Queue wait",
                    "status": "failed",
                    "items": [
                        {
                            "id": "claim.queue.B1",
                            "title": "saturation",
                            "status": "failed",
                            "metadata": {
                                "x-claim": {
                                    "ruledOutReason": "active=2, cap=8",
                                    "evidenceRefs": ["EV-002"],
                                }
                            },
                        }
                    ],
                },
            ],
            "edges": [
                {"from": "claim.queue.B1", "to": "branch.queue", "type": "invalidates"}
            ],
            "references": [
                {"id": "EV-001", "type": "log-excerpt"},
                {"id": "EV-002", "type": "metric-snapshot"},
            ],
            "metadata": {
                "x-investigation": {
                    "profile": "forensic-research-v1",
                    "wavesCompleted": {"1": True, "2": True, "3": True, "4": True},
                }
            },
        },
    }


class TestValidateLedgerHappyPath:
    def test_close_ready_ledger_passes(self) -> None:
        result = vi.validate_ledger(_close_ready_ledger())
        assert result.ok, [f.code for f in result.hard_failures]
        assert result.hard_failures == []


class TestHardFailures:
    def test_missing_waves_fails(self) -> None:
        data = _close_ready_ledger()
        data["plan"]["metadata"]["x-investigation"]["wavesCompleted"] = {
            "1": True,
            "2": True,
        }
        result = vi.validate_ledger(data)
        assert not result.ok
        assert any(f.code == "HF-WAVES" for f in result.hard_failures)

    def test_running_status_fails(self) -> None:
        data = _close_ready_ledger()
        data["plan"]["status"] = "running"
        result = vi.validate_ledger(data)
        assert any(f.code == "HF-STATUS" for f in result.hard_failures)

    def test_failed_claim_without_ruled_out_reason_fails(self) -> None:
        data = _close_ready_ledger()
        # Drop ruledOutReason from the failed claim.
        data["plan"]["items"][1]["items"][0]["metadata"]["x-claim"] = {
            "evidenceRefs": ["EV-002"]
        }
        result = vi.validate_ledger(data)
        assert any(f.code == "HF-FAILED-CLAIM" for f in result.hard_failures)

    def test_completed_claim_without_evidence_fails(self) -> None:
        data = _close_ready_ledger()
        data["plan"]["items"][0]["items"][0]["metadata"]["x-claim"] = {}
        result = vi.validate_ledger(data)
        assert any(f.code == "HF-COMPLETED-CLAIM" for f in result.hard_failures)

    def test_dangling_evidence_ref_fails(self) -> None:
        data = _close_ready_ledger()
        data["plan"]["items"][0]["items"][0]["metadata"]["x-claim"][
            "evidenceRefs"
        ] = ["EV-999"]
        result = vi.validate_ledger(data)
        assert any(f.code == "HF-DANGLING-EV" for f in result.hard_failures)

    def test_title_only_citation_does_not_satisfy_evidence(self) -> None:
        """A claim citing a reference's human-readable title (not its EV-* id)
        must NOT pass -- only structured ids count (Greptile P1)."""
        data = _close_ready_ledger()
        data["plan"]["references"][0]["title"] = "query latency spike"
        data["plan"]["items"][0]["items"][0]["metadata"]["x-claim"][
            "evidenceRefs"
        ] = ["query latency spike"]
        result = vi.validate_ledger(data)
        assert any(f.code == "HF-DANGLING-EV" for f in result.hard_failures)

    def test_failed_branch_without_invalidates_edge_fails(self) -> None:
        data = _close_ready_ledger()
        data["plan"]["edges"] = []
        result = vi.validate_ledger(data)
        assert any(f.code == "HF-BRANCH-NO-EDGE" for f in result.hard_failures)


class TestSoftWarnings:
    def test_blocked_claim_warns_but_passes(self) -> None:
        data = _close_ready_ledger()
        # Add a blocked claim on a live branch.
        data["plan"]["items"][0]["items"].append(
            {
                "id": "claim.slowness.M2",
                "title": "host pressure",
                "status": "blocked",
                "metadata": {"x-claim": {}},
            }
        )
        result = vi.validate_ledger(data)
        assert result.ok
        assert any(f.code == "SW-BLOCKED" for f in result.soft_warnings)

    def test_multiple_survivors_warns(self) -> None:
        data = _close_ready_ledger()
        # Flip the failed branch to completed (with valid evidence) so two survive.
        branch = data["plan"]["items"][1]
        branch["status"] = "completed"
        branch["items"][0]["status"] = "completed"
        branch["items"][0]["metadata"]["x-claim"] = {"evidenceRefs": ["EV-002"]}
        result = vi.validate_ledger(data)
        assert result.ok
        assert any(f.code == "SW-MULTI-SURVIVOR" for f in result.soft_warnings)


class TestLoadLedgerConfigErrors:
    def test_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(vi.LedgerConfigError):
            vi.load_ledger(tmp_path / "nope.json")

    def test_malformed_json(self, tmp_path: Path) -> None:
        p = tmp_path / "bad.json"
        p.write_text("{not json", encoding="utf-8")
        with pytest.raises(vi.LedgerConfigError):
            vi.load_ledger(p)

    def test_wrong_profile(self, tmp_path: Path) -> None:
        p = tmp_path / "wrong.json"
        data = _close_ready_ledger()
        data["plan"]["metadata"]["x-investigation"]["profile"] = "something-else"
        p.write_text(json.dumps(data), encoding="utf-8")
        with pytest.raises(vi.LedgerConfigError):
            vi.load_ledger(p)

    def test_missing_plan(self, tmp_path: Path) -> None:
        p = tmp_path / "noplan.json"
        p.write_text(json.dumps({"vBRIEFInfo": {"version": "0.6"}}), encoding="utf-8")
        with pytest.raises(vi.LedgerConfigError):
            vi.load_ledger(p)


class TestCliExitCodes:
    def _write(self, tmp_path: Path, data: dict) -> Path:
        p = tmp_path / "investigation.vbrief.json"
        p.write_text(json.dumps(data), encoding="utf-8")
        return p

    def test_exit_0_close_ready(self, tmp_path: Path) -> None:
        p = self._write(tmp_path, _close_ready_ledger())
        assert vi.main(["--ledger", str(p)]) == 0

    def test_exit_1_hard_failure(self, tmp_path: Path) -> None:
        data = _close_ready_ledger()
        data["plan"]["status"] = "running"
        p = self._write(tmp_path, data)
        assert vi.main(["--ledger", str(p)]) == 1

    def test_exit_2_missing_ledger(self, tmp_path: Path) -> None:
        assert vi.main(["--ledger", str(tmp_path / "absent.json")]) == 2

    def test_exit_2_no_path(self) -> None:
        assert vi.main([]) == 2

    def test_positional_path_accepted(self, tmp_path: Path) -> None:
        p = self._write(tmp_path, _close_ready_ledger())
        assert vi.main([str(p)]) == 0

    def test_json_output_shape(self, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
        data = _close_ready_ledger()
        data["plan"]["status"] = "running"
        p = self._write(tmp_path, data)
        rc = vi.main(["--ledger", str(p), "--json"])
        assert rc == 1
        payload = json.loads(capsys.readouterr().out)
        assert payload["exit"] == 1
        assert any(f["code"] == "HF-STATUS" for f in payload["hard_failures"])
