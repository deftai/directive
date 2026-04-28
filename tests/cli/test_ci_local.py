"""test_ci_local.py -- Tests for scripts/ci_local.py.

Covers (#233 plan.item ``task-ci-local``):

- Argument parsing: --matrix / --skip-build / --verbose / --fail-fast /
  --no-fail-fast / --root, including the mutually-exclusive
  --fail-fast / --no-fail-fast pair.
- Host-matrix mapping (linux/macos/windows host -> matrix slice).
- Step pipeline composition under each matrix and --skip-build.
- ``task build:verify`` graceful absence: when ``task --list`` does not
  contain ``build:verify``, the step is emitted with applies()=False
  and a non-empty skip reason; when present, applies()=True.
- Runner behavior: OK / FAIL / SKIP rows; verbose output mirroring;
  fail-fast aborts subsequent steps; --no-fail-fast lets the pipeline
  continue.
- StepResult counts for the aggregate summary; exit code shape (0
  success, 1 step failure, 2 config error).
- Round-trip on a fixture project: invoke main() against a synthetic
  --root, confirm the runner walks the expected steps.

Tests use ``importlib.util`` to load the script in-process and
``monkeypatch`` to stub out tool detection / subprocess invocation so
the suite is hermetic and fast (no real ``uv``, ``go``, ``task``, or
``pytest`` calls leak into CI).

Refs #233, #642, #635, #633, #709.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/ci_local.py in-process."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "ci_local",
        scripts_dir / "ci_local.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before exec so dataclass-introspection helpers in stdlib
    # (which look up cls.__module__ in sys.modules) work correctly under
    # importlib.util-loaded modules. Without this, ``@dataclass`` raises
    # ``AttributeError: 'NoneType' object has no attribute '__dict__'``
    # at decoration time.
    sys.modules["ci_local"] = module
    spec.loader.exec_module(module)
    return module


ci_local = _load_module()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _patch_executables(monkeypatch, *, present: set[str]) -> None:
    """Stub ``shutil.which`` / ``ci_local._has_executable`` so only ``present`` resolve."""

    def fake_which(name: str) -> str | None:
        return f"/fake/{name}" if name in present else None

    monkeypatch.setattr(ci_local.shutil, "which", fake_which)


def _stub_run(monkeypatch, *, returncode: int = 0, stdout: str = "", stderr: str = ""):
    """Replace ci_local._run_command with a noop returning the supplied tuple."""
    calls: list[tuple[list[str], dict]] = []

    def fake_run(cmd, cwd, *, env_overrides=None):
        calls.append((list(cmd), {"cwd": str(cwd), "env_overrides": env_overrides}))
        return returncode, stdout, stderr

    monkeypatch.setattr(ci_local, "_run_command", fake_run)
    return calls


def _force_host(monkeypatch, system: str) -> None:
    """Force ``platform.system()`` to return ``system``."""
    monkeypatch.setattr(ci_local.platform, "system", lambda: system)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


class TestArgumentParsing:
    def test_default_matrix_is_host(self):
        parser = ci_local._build_parser()
        args = parser.parse_args([])
        assert args.matrix == "host"

    def test_explicit_matrix_choices(self):
        parser = ci_local._build_parser()
        for choice in ("linux", "macos", "windows", "all", "host"):
            args = parser.parse_args(["--matrix", choice])
            assert args.matrix == choice

    def test_invalid_matrix_choice_exits(self, capsys):
        parser = ci_local._build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["--matrix", "freebsd"])

    def test_skip_build_default_false(self):
        parser = ci_local._build_parser()
        args = parser.parse_args([])
        assert args.skip_build is False

    def test_skip_build_flag_sets_true(self):
        parser = ci_local._build_parser()
        args = parser.parse_args(["--skip-build"])
        assert args.skip_build is True

    def test_verbose_default_false(self):
        parser = ci_local._build_parser()
        args = parser.parse_args([])
        assert args.verbose is False

    def test_verbose_flag_sets_true(self):
        parser = ci_local._build_parser()
        args = parser.parse_args(["--verbose"])
        assert args.verbose is True

    def test_fail_fast_default_true(self):
        parser = ci_local._build_parser()
        args = parser.parse_args([])
        assert args.fail_fast is True

    def test_no_fail_fast_sets_false(self):
        parser = ci_local._build_parser()
        args = parser.parse_args(["--no-fail-fast"])
        assert args.fail_fast is False


# ---------------------------------------------------------------------------
# Host matrix resolution
# ---------------------------------------------------------------------------


class TestHostMatrix:
    @pytest.mark.parametrize(
        "system,expected",
        [
            ("Linux", "linux"),
            ("Darwin", "macos"),
            ("Windows", "windows"),
            ("FreeBSD", "linux"),  # fallback
        ],
    )
    def test_host_matrix_mapping(self, monkeypatch, system, expected):
        _force_host(monkeypatch, system)
        assert ci_local._host_matrix() == expected

    def test_resolve_matrix_passthrough(self):
        assert ci_local._resolve_matrix("linux") == "linux"
        assert ci_local._resolve_matrix("windows") == "windows"

    def test_resolve_matrix_host_token(self, monkeypatch):
        _force_host(monkeypatch, "Linux")
        assert ci_local._resolve_matrix("host") == "linux"

    def test_devnull_for_host_unix(self, monkeypatch):
        _force_host(monkeypatch, "Linux")
        assert ci_local._devnull_for_host() == "/dev/null"

    def test_devnull_for_host_windows(self, monkeypatch):
        _force_host(monkeypatch, "Windows")
        assert ci_local._devnull_for_host() == "NUL"


# ---------------------------------------------------------------------------
# build:verify graceful absence
# ---------------------------------------------------------------------------


class TestBuildVerifyDetection:
    def test_returns_false_when_task_missing(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present=set())
        assert ci_local._build_verify_available(tmp_path) is False

    def test_returns_false_when_task_list_lacks_build_verify(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"task"})
        _stub_run(
            monkeypatch,
            returncode=0,
            stdout="* build: Package framework for distribution\n* test: Run tests\n",
        )
        assert ci_local._build_verify_available(tmp_path) is False

    def test_returns_true_when_task_list_contains_build_verify(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"task"})
        _stub_run(
            monkeypatch,
            returncode=0,
            stdout="* build: Package framework\n* build:verify: Verify dist\n",
        )
        assert ci_local._build_verify_available(tmp_path) is True

    def test_returns_false_when_task_list_fails(self, monkeypatch, tmp_path, capsys):
        # Greptile P2 #713: when ``task --list`` fails (e.g. malformed
        # Taskfile.yml) we must surface a warning so the underlying error
        # isn't silently swallowed behind "build:verify not yet
        # implemented".
        _patch_executables(monkeypatch, present={"task"})
        _stub_run(monkeypatch, returncode=2, stdout="", stderr="boom")
        assert ci_local._build_verify_available(tmp_path) is False
        captured = capsys.readouterr()
        assert "task --list" in captured.err
        assert "exited 2" in captured.err
        assert "boom" in captured.err


# ---------------------------------------------------------------------------
# Pipeline composition
# ---------------------------------------------------------------------------


class TestPipelineComposition:
    def test_includes_python_steps_when_uv_present(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"uv"})
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=True)
        names = [s.name for s in steps]
        assert "python: uv sync" in names
        assert "python: ruff lint" in names
        assert "python: mypy tests/" in names
        assert "python: pytest with coverage" in names

    def test_skips_python_steps_when_uv_missing(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present=set())
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=True)
        # Probe step is emitted but applies()=False so it skips.
        for step in steps:
            if step.name.startswith("python:"):
                assert step.applies() is False

    def test_go_cross_compile_steps_when_skip_build_false(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"go"})
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=False)
        names = [s.name for s in steps]
        assert "go: test ./cmd/deft-install/" in names
        assert "go: build linux/amd64" in names
        assert "go: build darwin/arm64" in names
        assert "go: build windows/amd64" in names

    def test_go_cross_compile_skipped_under_skip_build(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"go"})
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=True)
        names = [s.name for s in steps]
        assert "go: test ./cmd/deft-install/" in names
        assert "go: build linux/amd64" not in names
        assert "go: build darwin/arm64" not in names
        assert "go: build windows/amd64" not in names

    def test_task_steps_when_task_present(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"task"})
        _stub_run(monkeypatch, returncode=0, stdout="")  # build:verify probe says absent
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=False)
        names = [s.name for s in steps]
        assert "task toolchain:check" in names
        assert "task verify:stubs" in names
        assert "task verify:links" in names
        assert "task verify:rule-ownership" in names
        assert "task vbrief:validate" in names
        assert "task build" in names
        assert "task build:verify" in names

    def test_task_build_verify_skipped_when_absent(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"task"})
        _stub_run(monkeypatch, returncode=0, stdout="* build: foo\n")
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=False)
        bv = next(s for s in steps if s.name == "task build:verify")
        assert bv.applies() is False
        assert "not yet implemented" in bv.skip_reason()

    def test_task_build_verify_runs_when_present(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"task"})
        _stub_run(monkeypatch, returncode=0, stdout="* build:verify: Verify\n")
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=False)
        bv = next(s for s in steps if s.name == "task build:verify")
        assert bv.applies() is True

    def test_windows_dispatch_skipped_on_linux(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"uv"})
        _force_host(monkeypatch, "Linux")
        steps = ci_local.build_pipeline(tmp_path, matrix="windows", skip_build=True)
        windows_steps = [s for s in steps if s.name.startswith("windows-task-dispatch")]
        assert windows_steps, "expected at least one windows-task-dispatch step row"
        for step in windows_steps:
            assert step.applies() is False
            assert "Windows" in step.skip_reason()

    def test_windows_dispatch_skipped_when_matrix_is_linux(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"uv"})
        _force_host(monkeypatch, "Windows")
        steps = ci_local.build_pipeline(tmp_path, matrix="linux", skip_build=True)
        windows_steps = [s for s in steps if s.name.startswith("windows-task-dispatch")]
        for step in windows_steps:
            assert step.applies() is False

    def test_windows_dispatch_runs_on_windows_with_matrix(self, monkeypatch, tmp_path):
        _patch_executables(monkeypatch, present={"uv"})
        _force_host(monkeypatch, "Windows")
        steps = ci_local.build_pipeline(tmp_path, matrix="windows", skip_build=True)
        windows_steps = [s for s in steps if s.name.startswith("windows-task-dispatch")]
        assert windows_steps
        assert all(s.applies() for s in windows_steps)


# ---------------------------------------------------------------------------
# Runner behavior
# ---------------------------------------------------------------------------


class TestRunner:
    def _make_step(self, name: str, *, rc: int = 0):
        return ci_local.Step(
            name=name,
            run_fn=lambda _root, _rc=rc: (_rc, f"out:{_rc}", f"err:{_rc}"),
        )

    def _make_skipped(self, name: str, reason: str = "not applicable"):
        return ci_local.Step(
            name=name,
            run_fn=lambda _root: (0, "", ""),
            applies_fn=lambda: False,
            skip_reason_fn=lambda: reason,
        )

    def test_all_ok_returns_only_ok_results(self, tmp_path):
        steps = [self._make_step("a"), self._make_step("b")]
        emitted: list[str] = []
        results = ci_local.run_pipeline(
            tmp_path, steps, fail_fast=True, verbose=False, out=emitted.append
        )
        assert [r.status for r in results] == ["ok", "ok"]
        assert all("OK" in line or "running" in line for line in emitted)

    def test_skip_emits_skip_result(self, tmp_path):
        steps = [self._make_skipped("a", reason="missing tool")]
        emitted: list[str] = []
        results = ci_local.run_pipeline(
            tmp_path, steps, fail_fast=True, verbose=False, out=emitted.append
        )
        assert len(results) == 1
        assert results[0].status == "skip"
        assert results[0].skip_reason == "missing tool"
        assert any("SKIP" in line for line in emitted)

    def test_fail_fast_aborts_subsequent_steps(self, tmp_path):
        steps = [
            self._make_step("a", rc=0),
            self._make_step("b", rc=2),
            self._make_step("c", rc=0),
        ]
        emitted: list[str] = []
        results = ci_local.run_pipeline(
            tmp_path, steps, fail_fast=True, verbose=False, out=emitted.append
        )
        statuses = [r.status for r in results]
        assert statuses == ["ok", "fail", "skip"]
        assert results[2].skip_reason.startswith("aborted")

    def test_no_fail_fast_runs_every_step(self, tmp_path):
        steps = [
            self._make_step("a", rc=0),
            self._make_step("b", rc=2),
            self._make_step("c", rc=0),
        ]
        results = ci_local.run_pipeline(
            tmp_path, steps, fail_fast=False, verbose=False, out=lambda _: None
        )
        statuses = [r.status for r in results]
        assert statuses == ["ok", "fail", "ok"]

    def test_verbose_emits_stdout_and_stderr_on_success(self, tmp_path):
        steps = [self._make_step("a", rc=0)]
        emitted: list[str] = []
        ci_local.run_pipeline(
            tmp_path, steps, fail_fast=True, verbose=True, out=emitted.append
        )
        joined = "\n".join(emitted)
        assert "--- stdout ---" in joined
        assert "out:0" in joined

    def test_failure_emits_diagnostic_block(self, tmp_path):
        steps = [self._make_step("a", rc=7)]
        emitted: list[str] = []
        ci_local.run_pipeline(
            tmp_path, steps, fail_fast=True, verbose=False, out=emitted.append
        )
        joined = "\n".join(emitted)
        assert "FAIL" in joined
        assert "--- stdout ---" in joined
        assert "--- stderr ---" in joined
        assert "exit code 7" in joined

    def test_filenotfound_recorded_as_failure(self, tmp_path):
        def boom(_root):
            raise FileNotFoundError("uv")

        steps = [ci_local.Step(name="missing tool", run_fn=boom)]
        emitted: list[str] = []
        results = ci_local.run_pipeline(
            tmp_path, steps, fail_fast=True, verbose=False, out=emitted.append
        )
        assert results[0].status == "fail"
        assert results[0].return_code is None
        assert "executable not found" in "\n".join(emitted)


# ---------------------------------------------------------------------------
# Aggregate report
# ---------------------------------------------------------------------------


class TestSummary:
    def test_summary_counts(self):
        results = [
            ci_local.StepResult(name="a", status="ok", elapsed=0.1),
            ci_local.StepResult(name="b", status="fail", elapsed=0.2, return_code=1),
            ci_local.StepResult(name="c", status="skip", elapsed=0.0, skip_reason="off"),
        ]
        summary = ci_local.format_summary(results)
        assert "total:   3" in summary
        assert "passed:  1" in summary
        assert "failed:  1" in summary
        assert "skipped: 1" in summary
        assert "Failed steps:" in summary
        assert "Skipped steps:" in summary
        assert "- b (exit 1)" in summary
        assert "- c -- off" in summary

    def test_summary_no_failures_no_failed_section(self):
        results = [ci_local.StepResult(name="a", status="ok", elapsed=0.1)]
        summary = ci_local.format_summary(results)
        assert "Failed steps:" not in summary

    def test_summary_includes_total_elapsed(self):
        results = [
            ci_local.StepResult(name="a", status="ok", elapsed=0.5),
            ci_local.StepResult(name="b", status="ok", elapsed=1.5),
        ]
        summary = ci_local.format_summary(results)
        assert "elapsed: 2.00s" in summary


# ---------------------------------------------------------------------------
# main / CLI exit codes
# ---------------------------------------------------------------------------


class TestMain:
    def test_main_invalid_root_exits_2(self, capsys, tmp_path):
        missing = tmp_path / "does-not-exist"
        rc = ci_local.main(["--root", str(missing)])
        assert rc == ci_local.EXIT_CONFIG_ERROR

    def test_main_no_applicable_tools_exits_2(self, monkeypatch, tmp_path, capsys):
        # Greptile P1 #713: with zero tools on PATH every step constructor
        # emits an applies()=False probe row, so ``build_pipeline`` is
        # non-empty but every step skips. The runner used to exit 0 in
        # this shape (every-step-skipped), violating the documented
        # three-state exit-code contract; the fix is to also exit 2 when
        # ``not any(s.applies() for s in steps)``. This test exercises the
        # natural no-tools path rather than monkeypatching build_pipeline.
        _patch_executables(monkeypatch, present=set())
        rc = ci_local.main(["--root", str(tmp_path), "--matrix", "linux"])
        assert rc == ci_local.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "no CI steps applicable" in captured.err

    def test_main_empty_pipeline_exits_2(self, monkeypatch, tmp_path, capsys):
        # Defensive coverage of the original ``not steps`` branch in case a
        # future refactor removes the probe rows.
        monkeypatch.setattr(ci_local, "build_pipeline", lambda *a, **kw: [])
        rc = ci_local.main(["--root", str(tmp_path)])
        assert rc == ci_local.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "no CI steps applicable" in captured.err

    def test_main_returns_0_when_all_steps_pass(self, monkeypatch, tmp_path, capsys):
        _patch_executables(monkeypatch, present=set())  # all probes skip cleanly

        def fake_pipeline(root, *, matrix, skip_build):
            return [
                ci_local.Step(
                    name="noop",
                    run_fn=lambda _r: (0, "", ""),
                )
            ]

        monkeypatch.setattr(ci_local, "build_pipeline", fake_pipeline)
        rc = ci_local.main(["--root", str(tmp_path), "--matrix", "linux"])
        assert rc == ci_local.EXIT_OK

    def test_main_returns_1_when_any_step_fails(self, monkeypatch, tmp_path):
        def fake_pipeline(root, *, matrix, skip_build):
            return [
                ci_local.Step(
                    name="ok-step",
                    run_fn=lambda _r: (0, "", ""),
                ),
                ci_local.Step(
                    name="bad-step",
                    run_fn=lambda _r: (3, "", "boom"),
                ),
            ]

        monkeypatch.setattr(ci_local, "build_pipeline", fake_pipeline)
        rc = ci_local.main(
            ["--root", str(tmp_path), "--matrix", "linux", "--no-fail-fast"]
        )
        assert rc == ci_local.EXIT_STEP_FAILED


# ---------------------------------------------------------------------------
# Round-trip on a fixture project
# ---------------------------------------------------------------------------


class TestRoundTrip:
    def test_main_walks_synthetic_pipeline_in_order(self, monkeypatch, tmp_path, capsys):
        seen_steps: list[str] = []

        def fake_pipeline(root, *, matrix, skip_build):
            assert matrix == "linux"
            assert skip_build is True
            return [
                ci_local.Step(
                    name=name,
                    run_fn=lambda _r, _n=name: (
                        seen_steps.append(_n) or (0, f"{_n} ok", "")
                    ),
                )
                for name in ("python: ruff lint", "task vbrief:validate")
            ]

        monkeypatch.setattr(ci_local, "build_pipeline", fake_pipeline)
        rc = ci_local.main(
            [
                "--root",
                str(tmp_path),
                "--matrix",
                "linux",
                "--skip-build",
            ]
        )
        assert rc == ci_local.EXIT_OK
        assert seen_steps == ["python: ruff lint", "task vbrief:validate"]
        captured = capsys.readouterr()
        # Aggregate summary lands on stdout.
        assert "ci:local summary" in captured.out
        assert "passed:  2" in captured.out


# ---------------------------------------------------------------------------
# Output capture utility (smoke test for the runner emit hook)
# ---------------------------------------------------------------------------


class TestOutputHook:
    def test_default_emit_uses_print(self, tmp_path, capsys):
        steps = [
            ci_local.Step(
                name="hello",
                run_fn=lambda _r: (0, "", ""),
            )
        ]
        ci_local.run_pipeline(tmp_path, steps, fail_fast=True, verbose=False)
        captured = capsys.readouterr()
        assert "hello" in captured.out

    def test_emit_callable_is_used(self, tmp_path):
        steps = [
            ci_local.Step(
                name="hello",
                run_fn=lambda _r: (0, "", ""),
            )
        ]
        buffer = io.StringIO()
        ci_local.run_pipeline(
            tmp_path,
            steps,
            fail_fast=True,
            verbose=False,
            out=lambda line: buffer.write(line + "\n"),
        )
        assert "hello" in buffer.getvalue()
