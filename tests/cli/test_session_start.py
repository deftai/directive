from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_module(name: str, path: Path):
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _init_git(project_root: Path) -> str:
    subprocess.run(["git", "init"], cwd=project_root, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=project_root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=project_root,
        check=True,
    )
    (project_root / "README.md").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=project_root, check=True)
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=project_root,
        check=True,
        capture_output=True,
    )
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=project_root,
        text=True,
    ).strip()


def test_run_session_start_records_quick_state(tmp_path: Path) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    head = _init_git(tmp_path)

    code, payload, lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
    )

    assert code == 0
    assert "Deft Directive active -- AGENTS.md loaded." in lines
    state_path = tmp_path / ".deft" / "ritual-state.json"
    assert state_path.is_file()
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["schemaVersion"] == 1
    assert state["git_head"] == head
    assert state["worktree_path"] == str(tmp_path.resolve())
    assert set(state["quick_steps"]) == {
        "alignment",
        "branch_policy",
        "triage_welcome",
    }
    assert state["quick_steps"]["branch_policy"]["ok"] is True
    assert payload["ready"] is True


def test_run_session_start_records_explicit_deferrals(tmp_path: Path) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)

    code, _payload, _lines = session_start.run_session_start(
        tmp_path,
        deferrals={
            "triage_welcome": "offline review only",
            "doctor": "run at dispatch",
        },
        write_history=False,
    )

    assert code == 0
    state = json.loads((tmp_path / ".deft" / "ritual-state.json").read_text(encoding="utf-8"))
    assert state["quick_steps"]["triage_welcome"]["deferred_reason"] == "offline review only"
    assert state["gated_steps"]["doctor"]["deferred_reason"] == "run at dispatch"


def test_run_session_start_records_triage_failure_and_can_defer(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)

    def fail_triage(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setitem(
        sys.modules,
        "triage_welcome",
        SimpleNamespace(
            run_default_mode=fail_triage,
            task_command_args=lambda args, *, task_prefix=None: [
                f"{task_prefix}{args[0]}",
                *args[1:],
            ],
        ),
    )

    code, payload, _lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
        task_prefix="deft:",
    )

    state_path = tmp_path / ".deft" / "ritual-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert code == 1
    assert payload["ready"] is False
    assert state["quick_steps"]["triage_welcome"]["ok"] is False
    assert state["quick_steps"]["triage_welcome"]["command"] == [
        "task",
        "deft:triage:welcome",
    ]
    assert "network down" in state["quick_steps"]["triage_welcome"]["message"]

    code, payload, _lines = session_start.run_session_start(
        tmp_path,
        deferrals={"triage_welcome": "network unavailable"},
        write_history=False,
    )

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert code == 0
    assert payload["ready"] is True
    assert state["quick_steps"]["triage_welcome"]["deferred_reason"] == ("network unavailable")


def test_run_session_start_threads_task_prefix_to_triage_welcome(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)
    captured: dict[str, object] = {}

    def fake_task_command_args(args, *, task_prefix=None):
        captured["command_prefix"] = task_prefix
        return [f"{task_prefix}{args[0]}", *args[1:]]

    def fake_run_default_mode(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(exit_code=0)

    monkeypatch.setitem(
        sys.modules,
        "triage_welcome",
        SimpleNamespace(
            run_default_mode=fake_run_default_mode,
            task_command_args=fake_task_command_args,
        ),
    )

    code, _payload, _lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
        task_prefix="deft:",
    )

    state = json.loads((tmp_path / ".deft" / "ritual-state.json").read_text(encoding="utf-8"))
    assert code == 0
    assert captured["task_prefix"] == "deft:"
    assert captured["command_prefix"] == "deft:"
    assert state["quick_steps"]["triage_welcome"]["command"] == [
        "task",
        "deft:triage:welcome",
    ]


def test_run_git_captures_text_as_utf8(tmp_path: Path, monkeypatch) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    captured: dict[str, object] = {}

    def fake_run(*args, **kwargs):
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="ok\n", stderr="")

    monkeypatch.setattr(session_start.subprocess, "run", fake_run)

    code, stdout, stderr = session_start._run_git(tmp_path, ["status"])

    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert code == 0
    assert stdout == "ok"
    assert stderr == ""
    assert kwargs["encoding"] == "utf-8"
    assert kwargs["errors"] == "replace"


def test_default_branch_sync_is_quiet_when_default_branch_is_current(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")

    def fake_run_git(_root: Path, args: list[str]) -> tuple[int, str, str]:
        if args[:2] == ["symbolic-ref", "refs/remotes/origin/HEAD"]:
            return 0, "origin/master", ""
        if args[:2] == ["rev-parse", "--abbrev-ref"]:
            return 0, "origin/master", ""
        if args[:2] == ["fetch", "--quiet"]:
            return 0, "", ""
        if args[:3] == ["rev-list", "--left-right", "--count"]:
            return 0, "0 0", ""
        raise AssertionError(args)

    monkeypatch.setattr(session_start, "_run_git", fake_run_git)

    result = session_start.default_branch_sync(tmp_path)

    assert result.branch == "master"
    assert result.upstream == "origin/master"
    assert result.warning is None


def test_default_branch_sync_warns_for_behind_ahead_and_diverged(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")

    def fake_run_git(counts: str):
        def inner(_root: Path, args: list[str]) -> tuple[int, str, str]:
            if args[:2] == ["symbolic-ref", "refs/remotes/origin/HEAD"]:
                return 0, "origin/main", ""
            if args[:2] == ["rev-parse", "--abbrev-ref"]:
                return 0, "origin/main", ""
            if args[:2] == ["fetch", "--quiet"]:
                return 0, "", ""
            if args[:3] == ["rev-list", "--left-right", "--count"]:
                return 0, counts, ""
            raise AssertionError(args)

        return inner

    monkeypatch.setattr(session_start, "_run_git", fake_run_git("0 1"))
    assert session_start.default_branch_sync(tmp_path).warning == (
        "[deft branch] Local main is behind origin/main by 1 commit."
    )

    monkeypatch.setattr(session_start, "_run_git", fake_run_git("2 0"))
    assert session_start.default_branch_sync(tmp_path).warning == (
        "[deft branch] Local main is ahead of origin/main by 2 commits."
    )

    monkeypatch.setattr(session_start, "_run_git", fake_run_git("2 3"))
    assert session_start.default_branch_sync(tmp_path).warning == (
        "[deft branch] Local main has diverged from origin/main (2 ahead, 3 behind)."
    )


def test_default_branch_sync_warns_for_missing_upstream_and_fetch_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")

    def missing_upstream(_root: Path, args: list[str]) -> tuple[int, str, str]:
        if args[:2] == ["symbolic-ref", "refs/remotes/origin/HEAD"]:
            return 0, "origin/master", ""
        if args[:2] == ["rev-parse", "--abbrev-ref"]:
            return 128, "", "no upstream"
        raise AssertionError(args)

    monkeypatch.setattr(session_start, "_run_git", missing_upstream)
    assert session_start.default_branch_sync(tmp_path).warning == (
        "[deft branch] Local master has no upstream tracking branch."
    )

    def fetch_failure(_root: Path, args: list[str]) -> tuple[int, str, str]:
        if args[:2] == ["symbolic-ref", "refs/remotes/origin/HEAD"]:
            return 0, "origin/master", ""
        if args[:2] == ["rev-parse", "--abbrev-ref"]:
            return 0, "origin/master", ""
        if args[:2] == ["fetch", "--quiet"]:
            return 128, "", "network unavailable"
        raise AssertionError(args)

    monkeypatch.setattr(session_start, "_run_git", fetch_failure)
    assert session_start.default_branch_sync(tmp_path).warning == (
        "[deft branch] Could not refresh origin/master for local master: network unavailable"
    )


def test_default_branch_candidates_fallback_uses_remote_tracking_refs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")

    probed: list[list[str]] = []

    def fake_run_git(_root: Path, args: list[str]) -> tuple[int, str, str]:
        if args[:2] == ["symbolic-ref", "refs/remotes/origin/HEAD"]:
            return 128, "", "origin/HEAD not set"
        if args[:1] == ["show-ref"]:
            probed.append(args)
            ref = args[-1]
            return (0, "", "") if ref == "refs/remotes/origin/master" else (1, "", "")
        raise AssertionError(args)

    monkeypatch.setattr(session_start, "_run_git", fake_run_git)

    candidates = session_start._default_branch_candidates(tmp_path)

    assert candidates == ["master"]
    probed_refs = [args[-1] for args in probed]
    assert "refs/remotes/origin/master" in probed_refs
    assert all(ref.startswith("refs/remotes/origin/") for ref in probed_refs)


def test_run_session_start_orders_branch_and_tool_warnings_before_triage(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")
    _init_git(tmp_path)

    monkeypatch.setattr(
        session_start,
        "default_branch_sync",
        lambda _root: session_start.DefaultBranchSync(
            branch="master",
            upstream="origin/master",
            ahead=0,
            behind=1,
            warning="[deft branch] Local master is behind origin/master by 1 commit.",
        ),
    )

    def fake_verify_tools(*_args, **kwargs):
        kwargs["output_fn"]("[deft tools] Required tools are available.")
        return SimpleNamespace(exit_code=0)

    monkeypatch.setattr(session_start.verify_tools, "verify_required_tools", fake_verify_tools)
    monkeypatch.setitem(
        sys.modules,
        "triage_welcome",
        SimpleNamespace(
            run_default_mode=lambda *_args, **kwargs: (
                kwargs["output_fn"]("[triage] welcome"),
                SimpleNamespace(exit_code=0),
            )[1],
            task_command_args=lambda args, *, task_prefix=None: args,
        ),
    )

    code, _payload, lines = session_start.run_session_start(
        tmp_path,
        write_history=False,
    )

    assert code == 0
    policy_idx = next(i for i, line in enumerate(lines) if line.startswith("[deft policy]"))
    branch_idx = lines.index("[deft branch] Local master is behind origin/master by 1 commit.")
    tools_idx = lines.index("[deft tools] Required tools are available.")
    triage_idx = lines.index("[triage] welcome")
    assert policy_idx < branch_idx < tools_idx < triage_idx


def test_parse_deferrals_rejects_unknown_step() -> None:
    session_start = _load_module("session_start", SCRIPTS_DIR / "session_start.py")

    parsed, errors = session_start._parse_deferrals(["bogus=not today"])

    assert parsed == {}
    assert errors
    assert "unknown ritual step" in errors[0]
