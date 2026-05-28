"""test_pr_wait_mergeable.py -- Tests for scripts/pr_wait_mergeable.py (#1369).

Covers the four acceptance paths from the vBRIEF:

- PR-becomes-ready-then-merges  -> exit 0 (the happy path; monitor returns
  CLEAN, the merge call fires and succeeds).
- Timeout                       -> exit 1 (monitor exits 1 / cap reached;
  the merge call MUST NOT fire).
- Protected-issue-link-present  -> exit 1 BEFORE merge call (Layer 3 #701
  inspection runs first; on detection the helper escalates without
  invoking the monitor OR the merge call).
- Config error                  -> exit 2 (missing --repo; missing python
  executable; monitor exit 2; malformed --protected token).

Plus a few orthogonal sanity-checkers (merge-failed mapping, sibling-
merged detection via monitor exit 3) so a future regression in the
outcome classifier surfaces here instead of in production.

Per the AGENTS.md ``## Safe subprocess capture (#1366)`` rule, any
subprocess capture in this test file routes through
``scripts/_safe_subprocess.run_text``. The tests themselves do NOT
invoke real subprocesses -- they monkey-patch the helper's
module-level run wrappers so the cascade runs entirely in-process.
``_safe_subprocess.run_text`` is exercised separately by the wrapper
unit tests below where we patch ``subprocess.run`` and verify the
helper forwards the captured outcome.

Story: #1369 (cascade automation reliability/tooling for Grok Build
hybrid path).
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load ``scripts/pr_wait_mergeable.py`` in-process.

    Register the module in ``sys.modules`` BEFORE ``exec_module`` so that
    ``@dataclass``'s ``_is_type`` introspection (which does
    ``sys.modules.get(cls.__module__).__dict__``) does not crash with
    ``AttributeError: 'NoneType' object has no attribute '__dict__'``.
    Mirrors the loader pattern from ``test_swarm_verify_review_clean.py``.
    """
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "pr_wait_mergeable",
        scripts_dir / "pr_wait_mergeable.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["pr_wait_mergeable"] = module
    spec.loader.exec_module(module)
    return module


pwm = _load_module()


# ---------------------------------------------------------------------------
# Test doubles for the chained subprocess wrappers
# ---------------------------------------------------------------------------


def _make_protected_fn(returncode: int, stdout: str = "", stderr: str = ""):
    """Build a protected-check stand-in that records its invocations."""
    calls: list[tuple] = []

    def fn(pr_number, repo, protected, **_kwargs):
        calls.append((pr_number, repo, tuple(protected)))
        return (returncode, stdout, stderr)

    fn.calls = calls  # type: ignore[attr-defined]
    return fn


def _make_monitor_fn(returncode: int, payload: dict | None = None, stderr: str = ""):
    """Build a monitor stand-in that records its invocations and emits JSON."""
    calls: list[tuple] = []
    stdout = json.dumps(payload, indent=2) if payload is not None else ""

    def fn(pr_number, repo, cap_minutes, **_kwargs):
        calls.append((pr_number, repo, cap_minutes))
        return (returncode, stdout, stderr)

    fn.calls = calls  # type: ignore[attr-defined]
    return fn


def _make_merge_fn(returncode: int, stdout: str = "", stderr: str = ""):
    """Build a gh-merge stand-in that records its invocations."""
    calls: list[tuple] = []

    def fn(pr_number, repo, **_kwargs):
        calls.append((pr_number, repo))
        return (returncode, stdout, stderr)

    fn.calls = calls  # type: ignore[attr-defined]
    return fn


def _clean_monitor_payload(pr_number: int = 1370) -> dict:
    """Mirror the shape ``scripts/monitor_pr.py --json`` writes on CLEAN."""
    return {
        "monitor_result": "CLEAN",
        "polls": 1,
        "readiness": {
            "pr_number": pr_number,
            "repo": "deftai/directive",
            "head_sha": "a" * 40,
            "verdict": {
                "found": True,
                "errored": False,
                "last_reviewed_sha": "a" * 40,
                "confidence": 5,
                "p0_count": 0,
                "p1_count": 0,
                "p2_count": 0,
                "raw_body_excerpt": "",
            },
            "failures": [],
            "merge_ready": True,
            "via": "primary",
        },
    }


def _cap_reached_payload() -> dict:
    return {
        "monitor_result": "CAP-REACHED",
        "polls": 12,
        "readiness": {
            "merge_ready": False,
            "via": "fallback2",
            "failures": ["fallback2 is a coarse signal, not a CLEAN verdict ..."],
            "partial_data": {"pr_state": "open", "merged": False},
        },
    }


def _pr_merged_by_sibling_payload() -> dict:
    return {
        "monitor_result": "PR-TERMINAL",
        "polls": 3,
        "readiness": {
            "merge_ready": False,
            "via": "fallback2",
            "partial_data": {
                "pr_state": "closed",
                "merged": True,
            },
        },
    }


def _pr_closed_payload() -> dict:
    return {
        "monitor_result": "PR-TERMINAL",
        "polls": 5,
        "readiness": {
            "merge_ready": False,
            "via": "fallback2",
            "partial_data": {
                "pr_state": "closed",
                "merged": False,
            },
        },
    }


# ---------------------------------------------------------------------------
# Acceptance path 1: PR becomes ready, then merges (exit 0)
# ---------------------------------------------------------------------------


class TestReadyThenMerge:
    def test_clean_monitor_triggers_merge_and_exits_zero(self):
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(
            returncode=0, payload=_clean_monitor_payload(1370)
        )
        merge_fn = _make_merge_fn(returncode=0, stdout="merged via squash")

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_MERGED
        assert result.outcome == "merged"
        # No --protected provided, so the inspector MUST NOT be invoked.
        assert protected_fn.calls == []
        # Monitor was invoked exactly once with the resolved cap.
        assert monitor_fn.calls == [(1370, "deftai/directive", 30)]
        # Merge fired AFTER the CLEAN monitor return.
        assert merge_fn.calls == [(1370, "deftai/directive")]
        assert result.merge_stdout == "merged via squash"

    def test_protected_clean_then_clean_monitor_then_merge(self):
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(
            returncode=0, payload=_clean_monitor_payload(1371)
        )
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1371,
            repo="deftai/directive",
            cap_minutes=15,
            protected=[1119, 1140],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_MERGED
        # Protected inspector ran first with the right cohort.
        assert protected_fn.calls == [(1371, "deftai/directive", (1119, 1140))]
        # Monitor then merge.
        assert len(monitor_fn.calls) == 1
        assert len(merge_fn.calls) == 1


# ---------------------------------------------------------------------------
# Acceptance path 2: Timeout / cap-reached (exit 1; merge MUST NOT fire)
# ---------------------------------------------------------------------------


class TestTimeout:
    def test_monitor_cap_reached_exits_one_without_merging(self):
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(
            returncode=1, payload=_cap_reached_payload()
        )
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_TIMEOUT_OR_ESCALATION
        assert result.outcome == "cap-reached"
        # Merge MUST NOT be called when the monitor times out.
        assert merge_fn.calls == []
        # The monitor's payload survives into the result envelope.
        assert result.monitor_result.get("monitor_result") == "CAP-REACHED"

    def test_pr_closed_without_merge_exits_one(self):
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(
            returncode=3, payload=_pr_closed_payload()
        )
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_TIMEOUT_OR_ESCALATION
        assert result.outcome == "pr-closed"
        assert merge_fn.calls == []


# ---------------------------------------------------------------------------
# Acceptance path 3: Protected-issue link present -> exit 1 BEFORE merge call
# ---------------------------------------------------------------------------


class TestProtectedLinkedBeforeMerge:
    def test_protected_link_exits_one_without_invoking_monitor_or_merge(self):
        protected_fn = _make_protected_fn(
            returncode=1,
            stderr="FAIL: PR has persistent links to protected issue(s): #1119",
        )
        monitor_fn = _make_monitor_fn(returncode=0, payload=_clean_monitor_payload())
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[1119],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_TIMEOUT_OR_ESCALATION
        assert result.outcome == "protected-linked"
        # Critical: protected check fired with the right list AND the
        # downstream cascade was short-circuited BEFORE monitor/merge.
        assert protected_fn.calls == [(1370, "deftai/directive", (1119,))]
        assert monitor_fn.calls == []
        assert merge_fn.calls == []
        assert "closingIssuesReferences" in (result.error or "")
        # The protected-check payload survives so a parent monitor can
        # surface the underlying script's stderr message.
        assert result.protected_check["returncode"] == 1
        assert "protected issue" in result.protected_check["stderr"]


# ---------------------------------------------------------------------------
# Acceptance path 4: Config error (exit 2)
# ---------------------------------------------------------------------------


class TestConfigError:
    def test_main_without_repo_exits_two(self, monkeypatch, capsys):
        # Make sure $GH_REPO is not set in the environment so the gate
        # actually triggers.
        monkeypatch.delenv("GH_REPO", raising=False)
        rc = pwm.main(["1370"])
        assert rc == pwm.EXIT_CONFIG_ERROR
        err = capsys.readouterr().err
        assert "--repo" in err

    def test_main_with_malformed_protected_token_exits_two(self, monkeypatch, capsys):
        # Unicode superscript matches str.isdigit() but not str.isdecimal();
        # the helper's _parse_protected MUST reject it before any subprocess
        # is invoked.
        rc = pwm.main(
            [
                "1370",
                "--repo",
                "deftai/directive",
                "--protected",
                "\u00b2",
            ]
        )
        assert rc == pwm.EXIT_CONFIG_ERROR
        err = capsys.readouterr().err
        assert "Invalid protected issue token" in err

    def test_monitor_config_error_propagates_to_exit_two(self):
        protected_fn = _make_protected_fn(returncode=0)
        # monitor exit 2 == gh missing / invalid args.
        monitor_fn = _make_monitor_fn(returncode=2, payload={"monitor_result": "CONFIG-ERROR"})
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )
        assert result.exit_code == pwm.EXIT_CONFIG_ERROR
        assert result.outcome == "config-error"
        assert merge_fn.calls == []

    def test_protected_check_external_error_collapses_to_config_error(self):
        # Exit 2 from the protected inspector means it could not run the
        # check at all (gh missing, malformed JSON, etc.). The gate cannot
        # affirm safety, so the cascade halts with EXIT_CONFIG_ERROR.
        protected_fn = _make_protected_fn(
            returncode=2,
            stderr="Error: gh CLI not found.",
        )
        monitor_fn = _make_monitor_fn(returncode=0, payload=_clean_monitor_payload())
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[1119],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )
        assert result.exit_code == pwm.EXIT_CONFIG_ERROR
        assert result.outcome == "config-error"
        # Monitor / merge MUST NOT run when the gate cannot affirm safety.
        assert monitor_fn.calls == []
        assert merge_fn.calls == []


# ---------------------------------------------------------------------------
# Orthogonal: merge-failed mapping and sibling-merged shortcut
# ---------------------------------------------------------------------------


class TestMergeFailureAndSiblingMerge:
    def test_gh_pr_merge_failure_surfaces_as_exit_one(self):
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(returncode=0, payload=_clean_monitor_payload())
        merge_fn = _make_merge_fn(returncode=1, stderr="branch protection refused")

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_TIMEOUT_OR_ESCALATION
        assert result.outcome == "merge-failed"
        # Merge was attempted exactly once.
        assert merge_fn.calls == [(1370, "deftai/directive")]
        assert "branch protection" in (result.error or "")

    def test_pr_merged_by_sibling_returns_exit_zero(self):
        # Monitor exit 3 + partial_data.merged == True means a sibling
        # cascade merged the PR out from under us. The goal is reached;
        # exit 0, do NOT re-invoke gh pr merge.
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(
            returncode=3, payload=_pr_merged_by_sibling_payload()
        )
        merge_fn = _make_merge_fn(returncode=0)

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_MERGED
        assert result.outcome == "merged-by-sibling"
        # No double-merge attempt.
        assert merge_fn.calls == []
        # Critical (Greptile P2 on PR #1377): a SUCCESS path (exit_code
        # 0) MUST NOT carry a non-None ``error`` field. A consumer
        # parsing the JSON envelope and seeing ``exit_code: 0`` AND
        # ``error: "monitor exited 3 ..."`` would treat the two fields
        # as self-contradictory.
        assert result.error is None
        envelope = result.to_dict()
        assert envelope["exit_code"] == 0
        assert "error" not in envelope  # to_dict() omits None error

    def test_gh_missing_at_merge_stage_exits_two_not_one(self):
        # Greptile P1 on PR #1377: ``run_gh_merge`` returns rc=-1 on
        # FileNotFoundError (gh CLI not installed) AND on TimeoutExpired
        # (gh wrapper failed at OS layer). Both are CONFIGURATION
        # errors -- the gate cannot run -- and MUST surface as exit 2,
        # NOT exit 1. Automated callers keying on exit 2 to skip
        # retries (vs exit 1 = "try again later") would loop
        # indefinitely on a host where gh is permanently absent if
        # this mapped to exit 1. Mirrors the rc=-1 contract that
        # ``run_protected_check`` already upholds.
        protected_fn = _make_protected_fn(returncode=0)
        monitor_fn = _make_monitor_fn(returncode=0, payload=_clean_monitor_payload())
        merge_fn = _make_merge_fn(
            returncode=-1,
            stderr="gh CLI not found. Install GitHub CLI.",
        )

        result = pwm.wait_mergeable_and_merge(
            pr_number=1370,
            repo="deftai/directive",
            cap_minutes=30,
            protected=[],
            protected_fn=protected_fn,
            monitor_fn=monitor_fn,
            merge_fn=merge_fn,
        )

        assert result.exit_code == pwm.EXIT_CONFIG_ERROR
        assert result.outcome == "config-error"
        assert merge_fn.calls == [(1370, "deftai/directive")]
        assert "gh pr merge wrapper failed at OS layer" in (result.error or "")
        # Stderr from the wrapper survives so a parent monitor can
        # surface the canonical "gh CLI not found" message.
        assert "gh CLI not found" in (result.error or "")


# ---------------------------------------------------------------------------
# CLI argument parsing + JSON output envelope
# ---------------------------------------------------------------------------


class TestParseProtected:
    def test_single_token(self):
        assert pwm._parse_protected(["1119"]) == [1119]

    def test_comma_separated_dedup_sorted(self):
        assert pwm._parse_protected(["1140,1119,1119"]) == [1119, 1140]

    def test_repeated_flag_aggregates(self):
        assert pwm._parse_protected(["1119", "1140,642"]) == [642, 1119, 1140]

    def test_strips_hash_prefix(self):
        assert pwm._parse_protected(["#1119,#642"]) == [642, 1119]

    def test_rejects_unicode_superscript(self):
        with pytest.raises(ValueError, match="Invalid protected issue token"):
            pwm._parse_protected(["\u00b2"])

    def test_rejects_alpha_token(self):
        with pytest.raises(ValueError, match="Invalid protected issue token"):
            pwm._parse_protected(["abc"])


class TestMainHappyPathJson:
    def test_main_emits_json_envelope_on_clean_then_merged(self, monkeypatch, capsys):
        monkeypatch.setattr(pwm, "run_protected_check", _make_protected_fn(0))
        monkeypatch.setattr(
            pwm, "run_monitor", _make_monitor_fn(0, _clean_monitor_payload(1370))
        )
        monkeypatch.setattr(
            pwm, "run_gh_merge", _make_merge_fn(0, stdout="merged: squash")
        )

        rc = pwm.main(
            [
                "1370",
                "--repo",
                "deftai/directive",
                "--cap-minutes",
                "5",
                "--json",
            ]
        )
        assert rc == pwm.EXIT_MERGED
        out = capsys.readouterr().out
        payload = json.loads(out)
        assert payload["pr_number"] == 1370
        assert payload["repo"] == "deftai/directive"
        assert payload["outcome"] == "merged"
        assert payload["exit_code"] == 0
        assert payload["merge_stdout"] == "merged: squash"


# ---------------------------------------------------------------------------
# Subprocess wrappers exercise the #1366 _safe_subprocess.run_text helper
# ---------------------------------------------------------------------------


class TestSubprocessWrappersUseSafeRunText:
    """The wrappers MUST route through ``_safe_subprocess.run_text`` per
    the AGENTS.md ``## Safe subprocess capture (#1366)`` rule.

    We exercise the wrappers by patching ``subprocess.run`` (the call
    site ``run_text`` ultimately invokes) and verifying that the
    forced safety defaults (utf-8 / errors=replace / shell=False) make
    it all the way to the OS-level call.
    """

    def _fake_run(self, *, returncode=0, stdout="", stderr=""):
        captured: dict = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = list(cmd)
            captured["kwargs"] = dict(kwargs)
            return SimpleNamespace(
                returncode=returncode, stdout=stdout, stderr=stderr
            )

        return fake_run, captured

    def test_run_monitor_forces_utf8_replace_and_shell_false(self, monkeypatch):
        fake, captured = self._fake_run(stdout='{"monitor_result": "CLEAN"}')
        monkeypatch.setattr(subprocess, "run", fake)

        rc, out, err = pwm.run_monitor(1370, "deftai/directive", 10)

        assert rc == 0
        assert "CLEAN" in out
        # _safe_subprocess.run_text forces these safety defaults; the
        # wrapper MUST inherit them by going through run_text.
        kwargs = captured["kwargs"]
        assert kwargs.get("encoding") == "utf-8"
        assert kwargs.get("errors") == "replace"
        assert kwargs.get("shell") is False
        assert kwargs.get("capture_output") is True
        # And the monitor script path was passed.
        assert any("monitor_pr.py" in part for part in captured["cmd"])

    def test_run_gh_merge_forces_utf8_replace_and_shell_false(self, monkeypatch):
        fake, captured = self._fake_run(stdout="merged")
        monkeypatch.setattr(subprocess, "run", fake)

        rc, out, _err = pwm.run_gh_merge(1370, "deftai/directive")
        assert rc == 0
        assert out == "merged"
        cmd = captured["cmd"]
        assert cmd[0] == "gh"
        assert "pr" in cmd and "merge" in cmd
        assert "--squash" in cmd
        assert "--delete-branch" in cmd
        assert "--admin" in cmd
        assert "--repo" in cmd and "deftai/directive" in cmd
        kwargs = captured["kwargs"]
        assert kwargs.get("encoding") == "utf-8"
        assert kwargs.get("errors") == "replace"
        assert kwargs.get("shell") is False

    def test_run_protected_check_forces_utf8_replace_and_shell_false(self, monkeypatch):
        fake, captured = self._fake_run(stdout="OK")
        monkeypatch.setattr(subprocess, "run", fake)

        rc, _out, _err = pwm.run_protected_check(
            1370, "deftai/directive", [1119, 1140]
        )
        assert rc == 0
        # The wrapper joins the list onto a single comma-separated flag.
        cmd = captured["cmd"]
        assert any("pr_check_protected_issues.py" in part for part in cmd)
        protected_idx = cmd.index("--protected")
        assert cmd[protected_idx + 1] == "1119,1140"
        kwargs = captured["kwargs"]
        assert kwargs.get("encoding") == "utf-8"
        assert kwargs.get("errors") == "replace"
        assert kwargs.get("shell") is False

    def test_run_gh_merge_returns_minus_one_when_gh_missing(self, monkeypatch):
        def fake_run(*_a, **_kw):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc, _out, err = pwm.run_gh_merge(1370, "deftai/directive")
        assert rc == -1
        assert "gh CLI not found" in err
