"""#1250 regressions for ``task triage:welcome`` wipCap handling."""
# ruff: noqa: E402,I001

from __future__ import annotations

import json
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT / "scripts"))
from _project_definition_io import project_definition_mutation_lock
import triage_welcome


def _seed_project_definition(
    root: Path,
    *,
    triage_scope: list[dict[str, Any]] | None = None,
    wip_cap: int | None = None,
) -> Path:
    path = root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    policy: dict[str, Any] = {}
    if triage_scope is not None:
        policy["triageScope"] = triage_scope
    if wip_cap is not None:
        policy["wipCap"] = wip_cap
    payload: dict[str, Any] = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"narratives": {}, "policy": policy} if policy else {"narratives": {}},
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


class _ScriptedInput:
    def __init__(self, responses: list[str]) -> None:
        self._iter: Iterator[str] = iter(responses)

    def __call__(self, _prompt: str) -> str:
        try:
            return next(self._iter)
        except StopIteration:
            raise EOFError from None


class _CapturedOutput:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, line: str = "") -> None:
        self.lines.append(line)

    def joined(self) -> str:
        return "\n".join(self.lines)


def _project_definition(root: Path) -> dict[str, Any]:
    return json.loads(
        (root / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
            encoding="utf-8"
        )
    )


def _assert_default_not_materialized_message(output: _CapturedOutput) -> None:
    joined = output.joined()
    assert "Wrote plan.policy.wipCap = 10" not in joined
    assert (
        "plan.policy.wipCap = 10 "
        "(framework default; field not materialized)"
    ) in joined


def test_write_wip_cap_default_on_fresh_consumer_is_noop(tmp_path: Path) -> None:
    """Default confirm with no prior value leaves field and audit absent."""
    _seed_project_definition(tmp_path)
    changed, audit = triage_welcome.write_wip_cap(
        tmp_path, triage_welcome.DEFAULT_WIP_CAP
    )

    assert changed is False
    assert audit == ""
    assert "wipCap" not in _project_definition(tmp_path)["plan"].get("policy", {})
    assert not (tmp_path / triage_welcome.AUDIT_LOG_REL_PATH).exists()


def test_write_wip_cap_explicit_non_default_writes_and_audits(
    tmp_path: Path,
) -> None:
    """Explicit non-default values materialize the override and audit row."""
    _seed_project_definition(tmp_path)
    changed, audit = triage_welcome.write_wip_cap(tmp_path, 25)

    assert changed is True
    assert "value=25" in audit
    assert "changed=true" in audit
    assert _project_definition(tmp_path)["plan"]["policy"]["wipCap"] == 25
    log = (tmp_path / triage_welcome.AUDIT_LOG_REL_PATH).read_text(
        encoding="utf-8"
    )
    assert "field=plan.policy.wipCap" in log
    assert "value=25" in log


def test_write_wip_cap_clears_typed_field_when_set_to_default(
    tmp_path: Path,
) -> None:
    """Changing a custom override back to default removes the typed field."""
    _seed_project_definition(tmp_path, wip_cap=25)
    changed, audit = triage_welcome.write_wip_cap(
        tmp_path, triage_welcome.DEFAULT_WIP_CAP
    )

    assert changed is True
    assert "action=cleared-to-default" in audit
    assert "previous=25" in audit
    assert "wipCap" not in _project_definition(tmp_path)["plan"]["policy"]
    log = (tmp_path / triage_welcome.AUDIT_LOG_REL_PATH).read_text(
        encoding="utf-8"
    )
    assert "action=cleared-to-default" in log
    assert "field=plan.policy.wipCap" in log


def test_write_wip_cap_same_typed_value_rewrites_with_changed_false(
    tmp_path: Path,
) -> None:
    """Re-confirming an existing non-default override audits changed=false."""
    _seed_project_definition(tmp_path, wip_cap=25)
    changed, audit = triage_welcome.write_wip_cap(tmp_path, 25)

    assert changed is False
    assert "changed=false" in audit
    assert _project_definition(tmp_path)["plan"]["policy"]["wipCap"] == 25


def test_default_wip_cap_menu_value_reports_not_materialized(
    tmp_path: Path,
) -> None:
    """The default menu path must not claim it wrote the omitted field."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
    )
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([""]),
        output_fn=output,
        run_subprocess=False,
    )

    assert outcome.exit_code == 0
    assert outcome.wip_cap_choice == triage_welcome.DEFAULT_WIP_CAP
    assert "wipCap" not in _project_definition(tmp_path)["plan"]["policy"]
    _assert_default_not_materialized_message(output)


def test_clear_to_default_entry_reports_cleared_not_written(
    tmp_path: Path, monkeypatch
) -> None:
    """A cleanup audit entry must not produce a misleading write message."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
    )

    def _fake_write(_root: Path, _cap: int) -> tuple[bool, str]:
        return True, "actor=triage-welcome action=cleared-to-default"

    monkeypatch.setattr(triage_welcome, "write_wip_cap", _fake_write)
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput([""]),
        output_fn=output,
        run_subprocess=False,
    )

    joined = output.joined()
    assert outcome.exit_code == 0
    assert "Cleared plan.policy.wipCap override" in joined
    assert "Wrote plan.policy.wipCap" not in joined


def test_write_wip_cap_waits_for_project_definition_lock(tmp_path: Path) -> None:
    """Concurrent welcome writers serialize on the PROJECT-DEFINITION lock."""
    _seed_project_definition(tmp_path, wip_cap=25)
    started = threading.Event()
    finished = threading.Event()
    errors: list[BaseException] = []

    def _worker() -> None:
        started.set()
        try:
            triage_welcome.write_wip_cap(tmp_path, 20)
        except BaseException as exc:  # pragma: no cover -- surfaced below
            errors.append(exc)
        finally:
            finished.set()

    with project_definition_mutation_lock(tmp_path):
        thread = threading.Thread(target=_worker)
        thread.start()
        assert started.wait(timeout=5.0)
        time.sleep(0.1)
        assert not finished.is_set()

    thread.join(timeout=5.0)
    assert finished.is_set()
    assert not errors
    assert _project_definition(tmp_path)["plan"]["policy"]["wipCap"] == 20


def test_custom_wip_cap_default_value_reports_not_materialized(
    tmp_path: Path,
) -> None:
    """The custom prompt path typing default is the same no-op contract."""
    _seed_project_definition(
        tmp_path,
        triage_scope=triage_welcome.SUBSCRIPTION_PRESETS["small"],
    )
    output = _CapturedOutput()
    outcome = triage_welcome.run_welcome(
        tmp_path,
        input_fn=_ScriptedInput(["4", str(triage_welcome.DEFAULT_WIP_CAP)]),
        output_fn=output,
        run_subprocess=False,
    )

    assert outcome.exit_code == 0
    assert outcome.wip_cap_choice == triage_welcome.DEFAULT_WIP_CAP
    assert "wipCap" not in _project_definition(tmp_path)["plan"]["policy"]
    _assert_default_not_materialized_message(output)
