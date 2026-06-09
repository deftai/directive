#!/usr/bin/env python3
"""github_auth_modes.py -- worker-environment GitHub auth validation (#1557b).

Validates ``host-gh`` versus ``injected-token`` credential modes from the
same execution envelope that will perform GitHub operations. Consumes the
read-only runtime probe from :mod:`platform_capabilities` to classify the
worker sandbox and attach remediation when parent host auth can succeed
while the worker environment cannot.

Modes:

- ``injected-token`` -- require ``GH_TOKEN`` / ``GITHUB_TOKEN`` (or
  enterprise equivalents). Fail closed when missing; never fall back to
  host ``gh`` credential store state.
- ``host-gh`` -- permit host ``gh`` auth after ``gh auth status`` and a
  minimal GitHub API reachability check succeed from the worker environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _safe_subprocess import run_text  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from platform_capabilities import (  # noqa: E402
    RUNTIME_MODE_CLOUD_HEADLESS,
    RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
    RuntimeCapabilityReport,
    get_platform_capabilities,
    probe_runtime_capabilities,
)

reconfigure_stdio()

GITHUB_AUTH_MODE_INJECTED_TOKEN = "injected-token"
GITHUB_AUTH_MODE_HOST_GH = "host-gh"

KNOWN_GITHUB_AUTH_MODES: frozenset[str] = frozenset(
    {
        GITHUB_AUTH_MODE_INJECTED_TOKEN,
        GITHUB_AUTH_MODE_HOST_GH,
    }
)

_INJECTED_TOKEN_ENV_VARS: tuple[str, ...] = (
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
)

DEFAULT_VALIDATION_REPO = "deftai/directive"

FAILURE_MISSING_INJECTED_TOKEN = "missing_injected_token"
FAILURE_GH_AUTH = "gh_auth_failed"
FAILURE_API_UNREACHABLE = "api_unreachable"
FAILURE_REPO_ACCESS = "repo_access_denied"
FAILURE_INVALID_MODE = "invalid_auth_mode"

_SANDBOX_REMEDIATION = (
    "Remediation options for worker sandbox GitHub auth failures:\n"
    "  - Run the GitHub step with full-access execution\n"
    "  - Allowlist the trusted gh command path for the worker sandbox\n"
    "  - Use injected-token handoff (keep token values out of prompts and "
    "transcripts)"
)

_REPO_ACCESS_REMEDIATION = (
    "Remediation options for repo-access failures:\n"
    "  - Confirm the worker credential can read the target repository\n"
    "  - Run the GitHub step with full-access execution if host gh has access\n"
    "  - Use injected-token handoff scoped to the required repository"
)

GhRunner = Callable[[Sequence[str], Mapping[str, str] | None], Any]


@dataclass(frozen=True)
class GitHubAuthValidationResult:
    """Outcome of validating a worker's GitHub credential mode."""

    ok: bool
    github_auth_mode: str
    runtime_mode: str | None
    failure_kind: str | None
    detail: str
    remediation: str | None = None
    login: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "github_auth_mode": self.github_auth_mode,
            "runtime_mode": self.runtime_mode,
            "failure_kind": self.failure_kind,
            "detail": self.detail,
            "remediation": self.remediation,
            "login": self.login,
        }


def find_injected_token(environ: Mapping[str, str]) -> str | None:
    """Return the first non-empty injected token env var, if any."""
    for name in _INJECTED_TOKEN_ENV_VARS:
        value = environ.get(name, "").strip()
        if value:
            return value
    return None


def infer_github_auth_mode(runtime_report: RuntimeCapabilityReport) -> str:
    """Suggest an auth mode from runtime capability probe output."""
    if runtime_report.runtime_mode == RUNTIME_MODE_CLOUD_HEADLESS:
        return GITHUB_AUTH_MODE_INJECTED_TOKEN
    return GITHUB_AUTH_MODE_HOST_GH


def _default_run_gh(
    args: Sequence[str],
    environ: Mapping[str, str] | None,
) -> Any:
    env = dict(os.environ if environ is None else environ)
    return run_text(["gh", *args], env=env)


def _split_repo(repo: str) -> tuple[str, str]:
    owner, _, name = repo.strip().partition("/")
    if not owner or not name:
        msg = f"invalid repository slug: {repo!r} (expected owner/repo)"
        raise ValueError(msg)
    return owner, name


def _sandbox_remediation(runtime_mode: str | None, failure_kind: str) -> str | None:
    if runtime_mode != RUNTIME_MODE_CURSOR_NATIVE_SANDBOX:
        return None
    if failure_kind in {
        FAILURE_GH_AUTH,
        FAILURE_API_UNREACHABLE,
        FAILURE_REPO_ACCESS,
    }:
        return _SANDBOX_REMEDIATION
    return None


def _repo_access_remediation(failure_kind: str) -> str | None:
    if failure_kind == FAILURE_REPO_ACCESS:
        return _REPO_ACCESS_REMEDIATION
    return None


def _merge_remediation(
    runtime_mode: str | None,
    failure_kind: str,
) -> str | None:
    parts: list[str] = []
    sandbox = _sandbox_remediation(runtime_mode, failure_kind)
    if sandbox:
        parts.append(sandbox)
    repo = _repo_access_remediation(failure_kind)
    if repo and repo not in parts:
        parts.append(repo)
    if not parts:
        return None
    return "\n\n".join(parts)


def _parse_login(stdout: str) -> str | None:
    text = stdout.strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(payload, str) and payload:
        return payload
    if isinstance(payload, dict):
        login = payload.get("login")
        if isinstance(login, str) and login:
            return login
    return None


def validate_injected_token_mode(
    environ: Mapping[str, str],
    *,
    repo: str = DEFAULT_VALIDATION_REPO,
    runtime_mode: str | None = None,
    run_gh: GhRunner | None = None,
) -> GitHubAuthValidationResult:
    """Validate injected-token mode without falling back to host gh state."""
    runner = _default_run_gh if run_gh is None else run_gh
    token = find_injected_token(environ)
    if token is None:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_INJECTED_TOKEN,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_MISSING_INJECTED_TOKEN,
            detail=(
                "injected-token mode requires GH_TOKEN, GITHUB_TOKEN, or "
                "GH_ENTERPRISE_TOKEN; host gh credential store is not used"
            ),
        )

    auth_status = runner(["auth", "status"], environ)
    if auth_status.returncode != 0:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_INJECTED_TOKEN,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_GH_AUTH,
            detail="injected token present but gh auth status failed in worker",
            remediation=_merge_remediation(runtime_mode, FAILURE_GH_AUTH),
        )

    user_api = runner(["api", "user", "--jq", ".login"], environ)
    if user_api.returncode != 0:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_INJECTED_TOKEN,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_API_UNREACHABLE,
            detail="injected token present but GitHub API is unreachable",
            remediation=_merge_remediation(runtime_mode, FAILURE_API_UNREACHABLE),
        )

    login = _parse_login(user_api.stdout)
    owner, name = _split_repo(repo)
    repo_api = runner(["api", f"repos/{owner}/{name}"], environ)
    if repo_api.returncode != 0:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_INJECTED_TOKEN,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_REPO_ACCESS,
            detail=f"injected token can reach GitHub API but cannot access {repo}",
            remediation=_merge_remediation(runtime_mode, FAILURE_REPO_ACCESS),
            login=login,
        )

    return GitHubAuthValidationResult(
        ok=True,
        github_auth_mode=GITHUB_AUTH_MODE_INJECTED_TOKEN,
        runtime_mode=runtime_mode,
        failure_kind=None,
        detail="injected-token mode validated in worker environment",
        login=login,
    )


def validate_host_gh_mode(
    environ: Mapping[str, str],
    *,
    repo: str = DEFAULT_VALIDATION_REPO,
    runtime_mode: str | None = None,
    run_gh: GhRunner | None = None,
) -> GitHubAuthValidationResult:
    """Validate host-gh mode from the worker execution environment."""
    runner = _default_run_gh if run_gh is None else run_gh

    auth_status = runner(["auth", "status"], environ)
    if auth_status.returncode != 0:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_HOST_GH,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_GH_AUTH,
            detail="gh auth status failed in worker environment",
            remediation=_merge_remediation(runtime_mode, FAILURE_GH_AUTH),
        )

    user_api = runner(["api", "user", "--jq", ".login"], environ)
    if user_api.returncode != 0:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_HOST_GH,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_API_UNREACHABLE,
            detail="gh auth status passed but GitHub API is unreachable",
            remediation=_merge_remediation(runtime_mode, FAILURE_API_UNREACHABLE),
        )

    owner, name = _split_repo(repo)
    repo_api = runner(["api", f"repos/{owner}/{name}"], environ)
    if repo_api.returncode != 0:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=GITHUB_AUTH_MODE_HOST_GH,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_REPO_ACCESS,
            detail=f"GitHub API reachable but repository access failed for {repo}",
            remediation=_merge_remediation(runtime_mode, FAILURE_REPO_ACCESS),
            login=_parse_login(user_api.stdout),
        )

    return GitHubAuthValidationResult(
        ok=True,
        github_auth_mode=GITHUB_AUTH_MODE_HOST_GH,
        runtime_mode=runtime_mode,
        failure_kind=None,
        detail="host-gh mode validated in worker environment",
        login=_parse_login(user_api.stdout),
    )


def validate_github_auth(
    github_auth_mode: str,
    *,
    environ: Mapping[str, str] | None = None,
    runtime_report: RuntimeCapabilityReport | None = None,
    repo: str = DEFAULT_VALIDATION_REPO,
    run_gh: GhRunner | None = None,
) -> GitHubAuthValidationResult:
    """Validate the requested GitHub auth mode for the worker environment."""
    env = dict(os.environ if environ is None else environ)
    runtime_mode = None if runtime_report is None else runtime_report.runtime_mode

    if github_auth_mode not in KNOWN_GITHUB_AUTH_MODES:
        return GitHubAuthValidationResult(
            ok=False,
            github_auth_mode=github_auth_mode,
            runtime_mode=runtime_mode,
            failure_kind=FAILURE_INVALID_MODE,
            detail=(
                f"unknown github_auth_mode {github_auth_mode!r}; "
                f"expected one of {sorted(KNOWN_GITHUB_AUTH_MODES)}"
            ),
        )

    if github_auth_mode == GITHUB_AUTH_MODE_INJECTED_TOKEN:
        return validate_injected_token_mode(
            env,
            repo=repo,
            runtime_mode=runtime_mode,
            run_gh=run_gh,
        )
    return validate_host_gh_mode(
        env,
        repo=repo,
        runtime_mode=runtime_mode,
        run_gh=run_gh,
    )


def validate_github_auth_for_worker(
    github_auth_mode: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    runtime_report: RuntimeCapabilityReport | None = None,
    repo: str = DEFAULT_VALIDATION_REPO,
    run_gh: GhRunner | None = None,
) -> GitHubAuthValidationResult:
    """Probe runtime (when needed) and validate the worker auth mode."""
    report = (
        get_platform_capabilities()
        if runtime_report is None
        else runtime_report
    )
    mode = infer_github_auth_mode(report) if github_auth_mode is None else github_auth_mode
    return validate_github_auth(
        mode,
        environ=environ,
        runtime_report=report,
        repo=repo,
        run_gh=run_gh,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate GitHub auth mode inside the worker environment (#1557b)."
    )
    parser.add_argument(
        "--github-auth-mode",
        choices=sorted(KNOWN_GITHUB_AUTH_MODES),
        help="Credential mode to validate (default: infer from runtime probe).",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_VALIDATION_REPO,
        help=f"Repository slug for host-gh repo-access check (default: {DEFAULT_VALIDATION_REPO}).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit structured JSON on stdout.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    result = validate_github_auth_for_worker(
        args.github_auth_mode,
        repo=args.repo,
    )
    if args.json:
        print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    else:
        status = "ok" if result.ok else "failed"
        print(f"github_auth_mode={result.github_auth_mode} status={status}")
        print(f"detail={result.detail}")
        if result.remediation:
            print(result.remediation)
    return 0 if result.ok else 1


__all__ = [
    "DEFAULT_VALIDATION_REPO",
    "FAILURE_API_UNREACHABLE",
    "FAILURE_GH_AUTH",
    "FAILURE_INVALID_MODE",
    "FAILURE_MISSING_INJECTED_TOKEN",
    "FAILURE_REPO_ACCESS",
    "GITHUB_AUTH_MODE_HOST_GH",
    "GITHUB_AUTH_MODE_INJECTED_TOKEN",
    "GitHubAuthValidationResult",
    "find_injected_token",
    "infer_github_auth_mode",
    "validate_github_auth",
    "validate_github_auth_for_worker",
    "validate_host_gh_mode",
    "validate_injected_token_mode",
    "main",
    "probe_runtime_capabilities",
]


if __name__ == "__main__":
    raise SystemExit(main())
