"""Tests for scripts/github_auth_modes.py (#1557b).

Covers injected-token fail-closed behaviour, host-gh worker-environment
validation, sandbox auth-failure remediation, and repo-access remediation.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "github_auth_modes.py"
PLATFORM_SCRIPT_PATH = REPO_ROOT / "scripts" / "platform_capabilities.py"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def pc():
    return _load_module(PLATFORM_SCRIPT_PATH, "platform_capabilities")


@pytest.fixture()
def gam(pc):
    # platform_capabilities must be importable as a sibling module.
    sys.modules.setdefault("platform_capabilities", pc)
    return _load_module(SCRIPT_PATH, "github_auth_modes")


def _completed(
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _recording_runner(responses: dict[tuple[str, ...], SimpleNamespace]):
    calls: list[tuple[tuple[str, ...], dict]] = []

    def runner(args, environ):
        calls.append((tuple(args), dict(environ or {})))
        key = tuple(args)
        if key not in responses:
            msg = f"unexpected gh invocation: {list(args)}"
            raise AssertionError(msg)
        return responses[key]

    runner.calls = calls  # type: ignore[attr-defined]
    return runner


class TestInjectedTokenMode:
    def test_missing_token_fails_closed_without_host_gh_probe(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=0),
                ("api", "user", "--jq", ".login"): _completed(stdout='"bot"'),
            }
        )
        result = gam.validate_injected_token_mode(
            {},
            runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_MISSING_INJECTED_TOKEN
        assert runner.calls == []  # type: ignore[attr-defined]

    def test_missing_token_does_not_use_host_gh_even_when_parent_auth_works(self, gam, pc):
        calls: list[tuple[str, ...]] = []

        def runner(args, _environ):
            calls.append(tuple(args))
            return _completed(returncode=0, stdout='"parent-user"')

        result = gam.validate_injected_token_mode(
            {"USER": "parent"},
            runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_MISSING_INJECTED_TOKEN
        assert calls == []

    def test_github_token_env_var_is_accepted(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=0),
                ("api", "user", "--jq", ".login"): _completed(stdout='"worker-bot"'),
                ("api", "repos/deftai/directive"): _completed(
                    stdout='{"full_name":"deftai/directive"}'
                ),
            }
        )
        result = gam.validate_injected_token_mode(
            {"GITHUB_TOKEN": "secret-token"},
            runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
            run_gh=runner,
        )
        assert result.ok
        assert result.login == "worker-bot"
        assert runner.calls[0][1]["GITHUB_TOKEN"] == "secret-token"  # type: ignore[attr-defined]
        assert [call[0] for call in runner.calls] == [  # type: ignore[attr-defined]
            ("auth", "status"),
            ("api", "user", "--jq", ".login"),
            ("api", "repos/deftai/directive"),
        ]

    def test_injected_token_auth_failure_in_worker(self, gam, pc):
        runner = _recording_runner(
            {("auth", "status"): _completed(returncode=1, stderr="invalid token")}
        )
        result = gam.validate_injected_token_mode(
            {"GH_TOKEN": "bad"},
            runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_GH_AUTH

    def test_injected_token_fails_when_repo_access_denied(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=0),
                ("api", "user", "--jq", ".login"): _completed(stdout='"worker-bot"'),
                ("api", "repos/deftai/directive"): _completed(
                    returncode=404,
                    stderr="not found",
                ),
            }
        )
        result = gam.validate_injected_token_mode(
            {"GH_TOKEN": "narrow-token"},
            repo="deftai/directive",
            runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_REPO_ACCESS
        assert result.login == "worker-bot"
        assert result.remediation is not None
        assert "repository" in result.remediation.lower()


class TestHostGhMode:
    def test_host_gh_validates_auth_status_and_api_from_worker(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=0),
                ("api", "user", "--jq", ".login"): _completed(stdout='"msadams"'),
                ("api", "repos/deftai/directive"): _completed(
                    stdout='{"full_name":"deftai/directive"}'
                ),
            }
        )
        result = gam.validate_host_gh_mode(
            {"USER": "msadams"},
            repo="deftai/directive",
            runtime_mode=pc.RUNTIME_MODE_LOCAL_UNSANDBOXED,
            run_gh=runner,
        )
        assert result.ok
        assert result.login == "msadams"
        assert [call[0] for call in runner.calls] == [  # type: ignore[attr-defined]
            ("auth", "status"),
            ("api", "user", "--jq", ".login"),
            ("api", "repos/deftai/directive"),
        ]

    def test_host_gh_fails_when_gh_auth_status_fails(self, gam, pc):
        runner = _recording_runner(
            {("auth", "status"): _completed(returncode=1, stderr="not logged in")}
        )
        result = gam.validate_host_gh_mode(
            {},
            runtime_mode=pc.RUNTIME_MODE_LOCAL_UNSANDBOXED,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_GH_AUTH


class TestSandboxRemediation:
    def test_sandbox_auth_failure_names_remediation_options(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=1, stderr="sandbox blocked"),
            }
        )
        report = pc.RuntimeCapabilityReport(
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
        )
        result = gam.validate_github_auth(
            gam.GITHUB_AUTH_MODE_HOST_GH,
            environ={},
            runtime_report=report,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_GH_AUTH
        assert result.remediation is not None
        assert "full-access execution" in result.remediation
        assert "allowlist" in result.remediation.lower()
        assert "injected-token handoff" in result.remediation

    def test_sandbox_api_unreachable_names_remediation(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=0),
                ("api", "user", "--jq", ".login"): _completed(returncode=1, stderr="network"),
            }
        )
        report = pc.RuntimeCapabilityReport(
            runtime_mode=pc.RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
            identity_kind=pc.IDENTITY_SANDBOX_REMAPPED_LOCAL_USER,
            effective_uid=0,
            effective_username="root",
            uid_map=(),
            cursor_orig_uid=1000,
            cursor_orig_gid=1000,
            sandbox_uid_remap=True,
            ownership=None,
            signals={"CURSOR_SANDBOX": "1"},
        )
        result = gam.validate_github_auth(
            gam.GITHUB_AUTH_MODE_HOST_GH,
            environ={},
            runtime_report=report,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_API_UNREACHABLE
        assert "full-access execution" in (result.remediation or "")


class TestRepoAccessRemediation:
    def test_repo_access_failure_includes_remediation(self, gam, pc):
        runner = _recording_runner(
            {
                ("auth", "status"): _completed(returncode=0),
                ("api", "user", "--jq", ".login"): _completed(stdout='"msadams"'),
                ("api", "repos/deftai/directive"): _completed(returncode=404, stderr="not found"),
            }
        )
        result = gam.validate_host_gh_mode(
            {},
            repo="deftai/directive",
            runtime_mode=pc.RUNTIME_MODE_LOCAL_UNSANDBOXED,
            run_gh=runner,
        )
        assert not result.ok
        assert result.failure_kind == gam.FAILURE_REPO_ACCESS
        assert result.remediation is not None
        assert "repository" in result.remediation.lower()
        assert "injected-token handoff" in result.remediation


class TestRuntimeInference:
    def test_cloud_headless_infers_injected_token(self, gam, pc):
        report = pc.RuntimeCapabilityReport(
            runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
            identity_kind=pc.IDENTITY_LOCAL_USER,
            effective_uid=1000,
            effective_username="agent",
            uid_map=(),
            cursor_orig_uid=None,
            cursor_orig_gid=None,
            sandbox_uid_remap=False,
            ownership=None,
            signals={"CURSOR_AGENT": "1"},
        )
        assert gam.infer_github_auth_mode(report) == gam.GITHUB_AUTH_MODE_INJECTED_TOKEN

    def test_local_unsandboxed_infers_host_gh(self, gam, pc):
        report = pc.RuntimeCapabilityReport(
            runtime_mode=pc.RUNTIME_MODE_LOCAL_UNSANDBOXED,
            identity_kind=pc.IDENTITY_LOCAL_USER,
            effective_uid=1000,
            effective_username="msadams",
            uid_map=(),
            cursor_orig_uid=None,
            cursor_orig_gid=None,
            sandbox_uid_remap=False,
            ownership=None,
            signals={},
        )
        assert gam.infer_github_auth_mode(report) == gam.GITHUB_AUTH_MODE_HOST_GH


class TestTokenDiscovery:
    @pytest.mark.parametrize(
        "env_name",
        ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"],
    )
    def test_find_injected_token_accepts_standard_env_vars(self, gam, env_name):
        assert gam.find_injected_token({env_name: "tok"}) == "tok"


class TestCliAndSerialization:
    def test_main_json_success(self, gam, pc, monkeypatch, capsys):
        monkeypatch.setattr(
            gam,
            "validate_github_auth_for_worker",
            lambda *args, **kwargs: gam.GitHubAuthValidationResult(
                ok=True,
                github_auth_mode=gam.GITHUB_AUTH_MODE_HOST_GH,
                runtime_mode=pc.RUNTIME_MODE_LOCAL_UNSANDBOXED,
                failure_kind=None,
                detail="ok",
                login="msadams",
            ),
        )
        assert gam.main(["--github-auth-mode", "host-gh", "--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload["login"] == "msadams"

    def test_main_failure_exit_code(self, gam, pc, monkeypatch):
        monkeypatch.setattr(
            gam,
            "validate_github_auth_for_worker",
            lambda *args, **kwargs: gam.GitHubAuthValidationResult(
                ok=False,
                github_auth_mode=gam.GITHUB_AUTH_MODE_INJECTED_TOKEN,
                runtime_mode=pc.RUNTIME_MODE_CLOUD_HEADLESS,
                failure_kind=gam.FAILURE_MISSING_INJECTED_TOKEN,
                detail="missing token",
            ),
        )
        assert gam.main(["--github-auth-mode", "injected-token"]) == 1

    def test_to_dict_round_trip(self, gam, pc):
        result = gam.GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=gam.GITHUB_AUTH_MODE_HOST_GH,
            runtime_mode=pc.RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
            failure_kind=gam.FAILURE_GH_AUTH,
            detail="failed",
            remediation="try full-access",
        )
        payload = result.to_dict()
        assert payload["failure_kind"] == gam.FAILURE_GH_AUTH
        assert payload["remediation"] == "try full-access"
