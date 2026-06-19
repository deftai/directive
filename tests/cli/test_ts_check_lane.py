"""Tests for the Node-toolchain-aware TS lane guard (#1530, #1790)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from scripts.ts_check_lane import LANE_COMMANDS, main, run_ts_lane


class _Runner:
    """Records invocations and returns a scripted exit code per call."""

    def __init__(self, codes: list[int]) -> None:
        self._codes = list(codes)
        self.calls: list[tuple[tuple[str, ...], str]] = []

    def __call__(self, argv, cwd):  # noqa: ANN001 - test stub
        self.calls.append((tuple(argv), cwd))
        code = self._codes.pop(0) if self._codes else 0
        return SimpleNamespace(returncode=code)


def test_skips_with_notice_when_pnpm_absent() -> None:
    messages: list[str] = []
    runner = _Runner([])

    rc = run_ts_lane(Path("/repo"), pnpm=None, runner=runner, out=messages.append)

    assert rc == 0
    assert runner.calls == []  # nothing executed
    assert any("skipping the TypeScript lane" in m for m in messages)


def test_runs_all_lane_commands_in_order_when_pnpm_present() -> None:
    runner = _Runner([0, 0, 0])

    rc = run_ts_lane(Path("/repo"), pnpm="/usr/bin/pnpm", runner=runner, out=lambda _m: None)

    assert rc == 0
    assert [argv for argv, _cwd in runner.calls] == [
        ("/usr/bin/pnpm", *cmd) for cmd in LANE_COMMANDS
    ]
    assert all(cwd == "/repo" for _argv, cwd in runner.calls)


def test_fails_fast_on_first_nonzero_exit() -> None:
    # lint passes, build fails -> test must NOT run, exit code propagates.
    runner = _Runner([0, 2, 0])
    messages: list[str] = []

    rc = run_ts_lane(
        Path("/repo"), pnpm="pnpm", runner=runner, out=messages.append
    )

    assert rc == 2
    assert len(runner.calls) == 2  # lint + build only; test skipped
    assert any("build` failed" in m for m in messages)


def test_main_passes_project_root(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_run_ts_lane(project_root, *, pnpm):  # noqa: ANN001 - test stub
        captured["project_root"] = project_root
        captured["pnpm"] = pnpm
        return 0

    monkeypatch.setattr("scripts.ts_check_lane.run_ts_lane", fake_run_ts_lane)
    monkeypatch.setattr("scripts.ts_check_lane._resolve_pnpm", lambda: "pnpm")

    rc = main(["--project-root", "/somewhere"])

    assert rc == 0
    assert captured["project_root"] == Path("/somewhere")
    assert captured["pnpm"] == "pnpm"
