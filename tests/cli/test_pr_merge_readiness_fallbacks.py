"""test_pr_merge_readiness_fallbacks.py -- #1368 layered fallback chain tests.

Covers:

- Primary path success (existing #796 behavior, now annotated via="primary").
- Primary EXTERNAL failure -> fallback1 (REST + Python-side comment parse).
- Primary + fallback1 EXTERNAL failure -> fallback2 (coarse PR-view signal,
  NEVER CLEAN regardless of upstream state).
- All three layers fail -> structured error envelope (via="error",
  ``partial_data`` populated, exit code EXIT_EXTERNAL_ERROR).
- Decode-crash analogue: when a gh capture returns empty stdout (the
  symptom of the original UnicodeDecodeError under cp1252), the cascade
  steps forward through fallback1/2/error rather than blinding.
- monitor_pr.py: CLEAN exit on first poll, fallback2 holds the loop,
  terminal PR state (merged/closed) returns EXIT_PR_TERMINAL, cap
  reached, sleep cadence tuple expansion.

The tests rely on monkey-patching ``subprocess.run`` so the helpers in
``scripts/_safe_subprocess.py`` (which route through ``subprocess.run``)
return synthesised gh outputs without spawning a real subprocess.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load(module_name: str, filename: str):
    """Load a sibling script as a module so it can be exercised under test.

    Uses :class:`importlib.util.spec_from_file_location` so the module is
    fresh per test session and not affected by import caching from other
    suites.
    """
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(
        module_name, SCRIPTS_DIR / filename,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


pr_merge_readiness = _load("pr_merge_readiness", "pr_merge_readiness.py")
monitor_pr = _load("monitor_pr", "monitor_pr.py")


# ---------------------------------------------------------------------------
# gh fake-run framework
# ---------------------------------------------------------------------------


def _ns(stdout: str = "", stderr: str = "", returncode: int = 0):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def _classify(cmd: list[str]) -> str:
    """Map a gh argv to a stable label so fake_run can dispatch responses."""
    joined = " ".join(cmd)
    if "nameWithOwner" in joined:
        return "repo-view"
    if "headRefOid" in joined:
        return "head-sha"
    if "/check-runs" in joined:
        return "check-runs"
    if "/pulls/" in joined and "/comments" not in joined:
        return "pr-view-rest"
    if "/issues/" in joined and "/comments" in joined and "--jq" in cmd:
        return "comments-jq"
    if "/issues/" in joined and "/comments" in joined:
        return "comments-rest"
    return "unknown"


def install_fake_gh(monkeypatch, responses: dict, log: list | None = None):
    """Patch subprocess.run to dispatch by classify(cmd) -> response.

    Each response can be a SimpleNamespace (single canned reply), or a
    callable taking the cmd and returning a SimpleNamespace (lets tests
    vary behaviour between calls of the same class).
    """
    call_log: list = log if log is not None else []

    def fake_run(cmd, **_kw):
        label = _classify(cmd)
        call_log.append((label, list(cmd)))
        response = responses.get(label)
        if response is None:
            return _ns(stderr=f"unexpected gh call: {' '.join(cmd)}", returncode=1)
        if callable(response):
            return response(cmd)
        return response

    monkeypatch.setattr(subprocess, "run", fake_run)
    return call_log


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


_HEAD_SHA = "abc1234567890def1234567890abcdef12345678"


def _clean_jq_body(sha: str = _HEAD_SHA, confidence: int = 5) -> str:
    """The --jq output the primary path expects (one Greptile body)."""
    return (
        "## Greptile Summary\n\n"
        "No P0 or P1 issues found in this PR.\n\n"
        f"**Confidence Score: {confidence}/5**\n\n"
        "Last reviewed commit: [chore: small fix]"
        f"(https://github.com/deftai/directive/commit/{sha})\n"
    )


def _greptile_rest_payload(sha: str = _HEAD_SHA, confidence: int = 5) -> str:
    """A REST /issues/<N>/comments response (one Greptile comment)."""
    return json.dumps([
        {
            "user": {"login": "greptile-apps[bot]"},
            "body": _clean_jq_body(sha=sha, confidence=confidence),
        },
        {
            "user": {"login": "human-reviewer"},
            "body": "LGTM",
        },
    ])


def _informal_clean_jq_body() -> str:
    """Synthetic informal clean body patterned on PR #1541 (#1543)."""
    return (
        "The review on `ac9f42a` has completed — no stall on my end. "
        "Both previously flagged issues are now resolved.\n\n"
        "The current diff is clean. No new issues to flag — the implementation "
        "looks solid. Good to proceed to the confidence exit gate.\n"
    )


def _informal_clean_rest_payload() -> str:
    return json.dumps([
        {
            "user": {"login": "greptile-apps[bot]"},
            "body": _informal_clean_jq_body(),
        },
    ])


def _pr_rest_payload(
    sha: str = _HEAD_SHA, state: str = "open", merged: bool = False,
) -> str:
    """A REST /pulls/<N> response shape."""
    return json.dumps({
        "state": state,
        "merged": merged,
        "mergeable": True,
        "mergeable_state": "clean",
        "head": {"sha": sha, "ref": "fix/foo"},
    })


def _check_runs_payload() -> str:
    return json.dumps({
        "total_count": 2,
        "check_runs": [
            {"name": "Greptile Review", "status": "completed", "conclusion": "success"},
            {"name": "CI / build", "status": "completed", "conclusion": "success"},
        ],
    })


# ---------------------------------------------------------------------------
# Primary path tests
# ---------------------------------------------------------------------------


class TestPrimaryPath:
    def test_primary_clean_emits_via_primary(self, monkeypatch):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stdout=_clean_jq_body()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_PRIMARY
        assert result.merge_ready is True
        assert result.head_sha == _HEAD_SHA

    def test_primary_blocked_still_primary_no_fallback(self, monkeypatch):
        # Confidence 3/5 is merge-blocked but the body IS parseable;
        # cascade MUST stop at primary, not fall through.
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stdout=_clean_jq_body(confidence=3)),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_PRIMARY
        assert result.merge_ready is False
        assert any("confidence" in f.lower() for f in result.failures)

    def test_primary_no_greptile_comment_still_primary(self, monkeypatch):
        # Empty body from --jq // "" -- primary path interprets this as
        # "no Greptile comment found" and surfaces the right failure.
        # MUST NOT fall through to fallback1 because the primary fetch
        # SUCCEEDED, the comment just isn't there yet.
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stdout="\n"),  # gh api --jq // "" emits "\n"
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_PRIMARY
        assert result.merge_ready is False
        assert any("No Greptile rolling-summary" in f for f in result.failures)


class TestInformalCleanFallbacks:
    def test_primary_informal_clean_blocked_with_targeted_diagnostic(self, monkeypatch):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stdout=_informal_clean_jq_body()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1541, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_PRIMARY
        assert result.merge_ready is False
        assert result.verdict.informal_clean is True
        assert any(
            "informal-clean missing-canonical-fields" in f
            for f in result.failures
        )

    def test_fallback1_informal_clean_blocked_with_targeted_diagnostic(self, monkeypatch):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stderr="gh rate-limited", returncode=1),
            "comments-rest": _ns(stdout=_informal_clean_rest_payload()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1541, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK1
        assert result.merge_ready is False
        assert result.verdict.informal_clean is True
        assert any(
            "informal-clean missing-canonical-fields" in f
            for f in result.failures
        )


# ---------------------------------------------------------------------------
# Fallback1 tests
# ---------------------------------------------------------------------------


class TestFallback1Path:
    def test_primary_comments_failure_falls_through_to_fallback1(self, monkeypatch):
        # Primary head-sha succeeds; primary comments-jq fails (rc=1);
        # fallback1 fetches comments via REST and parses Python-side.
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stderr="gh rate-limited", returncode=1),
            "comments-rest": _ns(stdout=_greptile_rest_payload()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK1
        assert result.merge_ready is True
        assert result.head_sha == _HEAD_SHA
        # The primary error must be preserved in partial_data so the
        # operator can see WHY we degraded.
        assert "primary_error" in result.partial_data

    def test_decode_crash_analogue_routes_to_fallback1(self, monkeypatch):
        # Simulate the canonical #1166 symptom: primary --jq returns
        # empty stdout (UnicodeDecodeError aborted the helper thread).
        # Empty stdout on the primary path is interpreted as "no
        # Greptile comment" via the whitespace-aware guard, so the
        # primary still returns merge-blocked WITHOUT falling through.
        # For the actual decode-crash symptom we test that a NON-ZERO
        # exit from the primary --jq capture routes through fallback1.
        def jq_decode_crash(_cmd):
            # rc=1 + empty stdout mirrors the #1366 symptom where the
            # reader thread crashed and the parent saw an error exit.
            return _ns(returncode=1, stderr="decode-crash")
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": jq_decode_crash,
            "comments-rest": _ns(stdout=_greptile_rest_payload()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK1
        assert result.merge_ready is True

    def test_fallback1_handles_paginated_rest_payload(self, monkeypatch):
        # gh api --paginate concatenates JSON arrays back-to-back. The
        # parser MUST collapse the two pages into a single comment list.
        page_1 = json.dumps([
            {"user": {"login": "human-reviewer"}, "body": "first page"},
        ])
        page_2 = json.dumps([
            {
                "user": {"login": "greptile-apps[bot]"},
                "body": _clean_jq_body(),
            },
        ])
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(returncode=1),
            "comments-rest": _ns(stdout=page_1 + "\n" + page_2),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK1
        assert result.merge_ready is True

    def test_fallback1_head_sha_via_rest_when_primary_head_failed(
        self, monkeypatch,
    ):
        # Primary head-sha fetch fails; fallback1 re-fetches via REST.
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(returncode=1, stderr="timeout"),
            "pr-view-rest": _ns(stdout=_pr_rest_payload()),
            "comments-rest": _ns(stdout=_greptile_rest_payload()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK1
        assert result.merge_ready is True
        assert result.head_sha == _HEAD_SHA

    def test_fallback1_emits_via_in_json(self, monkeypatch, capsys):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(returncode=1),
            "comments-rest": _ns(stdout=_greptile_rest_payload()),
        })
        rc = pr_merge_readiness.main([
            "1363", "--repo", "deftai/directive", "--json",
        ])
        assert rc == pr_merge_readiness.EXIT_OK
        payload = json.loads(capsys.readouterr().out)
        assert payload["via"] == "fallback1"
        assert payload["merge_ready"] is True


# ---------------------------------------------------------------------------
# Fallback2 tests
# ---------------------------------------------------------------------------


class TestFallback2Path:
    def test_primary_and_fallback1_both_fail_routes_to_fallback2(
        self, monkeypatch,
    ):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(returncode=1, stderr="primary boom"),
            "comments-rest": _ns(returncode=1, stderr="fallback1 boom"),
            "pr-view-rest": _ns(stdout=_pr_rest_payload()),
            "check-runs": _ns(stdout=_check_runs_payload()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK2
        # Fallback2 is NEVER CLEAN -- structural guarantee.
        assert result.merge_ready is False
        assert any(
            "fallback2 is a coarse signal" in f for f in result.failures
        )
        assert result.head_sha == _HEAD_SHA
        assert result.partial_data.get("pr_state") == "open"
        assert result.partial_data.get("merged") is False
        # The check_runs flattened summary surfaces Greptile's status.
        assert result.partial_data.get("check_runs", {}).get(
            "greptile_review"
        ) == {"status": "completed", "conclusion": "success"}

    def test_fallback2_surfaces_merged_state(self, monkeypatch):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(returncode=1),
            "comments-rest": _ns(returncode=1),
            "pr-view-rest": _ns(stdout=_pr_rest_payload(
                state="closed", merged=True,
            )),
            "check-runs": _ns(stdout=_check_runs_payload()),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK2
        assert result.partial_data.get("merged") is True
        assert result.partial_data.get("pr_state") == "closed"

    def test_fallback2_exit_code_is_blocked_not_error(
        self, monkeypatch, capsys,
    ):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(returncode=1),
            "comments-rest": _ns(returncode=1),
            "pr-view-rest": _ns(stdout=_pr_rest_payload()),
            "check-runs": _ns(stdout=_check_runs_payload()),
        })
        rc = pr_merge_readiness.main([
            "1363", "--repo", "deftai/directive", "--json",
        ])
        # fallback2 is merge-BLOCKED (exit 1), not external-error (2).
        assert rc == pr_merge_readiness.EXIT_MERGE_BLOCKED
        payload = json.loads(capsys.readouterr().out)
        assert payload["via"] == "fallback2"
        assert payload["merge_ready"] is False

    def test_fallback2_check_runs_failure_still_emits_partial(
        self, monkeypatch,
    ):
        # check-runs endpoint failing must NOT down-rank to error -- the
        # PR state/headSHA observation alone is a valid heartbeat.
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(returncode=1),
            "comments-rest": _ns(returncode=1),
            "pr-view-rest": _ns(stdout=_pr_rest_payload()),
            "check-runs": _ns(returncode=1, stderr="endpoint down"),
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_FALLBACK2
        assert result.partial_data.get("check_runs") is None
        assert "fallback2_check_runs_error" in result.partial_data


# ---------------------------------------------------------------------------
# Total-failure tests
# ---------------------------------------------------------------------------


class TestTotalFailurePath:
    def test_every_layer_fails_returns_via_error(self, monkeypatch):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(returncode=1, stderr="primary boom"),
            "pr-view-rest": _ns(returncode=1, stderr="fallback boom"),
            # comments-* / check-runs unreachable from this state.
        })
        result = pr_merge_readiness.compute_gate_result(
            pr_number=1363, repo="deftai/directive",
        )
        assert result.via == pr_merge_readiness.VIA_ERROR
        assert result.merge_ready is False
        assert result.error is not None
        # partial_data MUST carry the per-layer error messages so a
        # monitor parsing the envelope can step forward with context.
        assert "primary_error" in result.partial_data
        assert "fallback1_error" in result.partial_data
        assert "fallback2_error" in result.partial_data

    def test_total_failure_main_exits_external_error(
        self, monkeypatch, capsys,
    ):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(returncode=1, stderr="all-down"),
            "pr-view-rest": _ns(returncode=1, stderr="all-down"),
        })
        rc = pr_merge_readiness.main([
            "1363", "--repo", "deftai/directive", "--json",
        ])
        assert rc == pr_merge_readiness.EXIT_EXTERNAL_ERROR
        payload = json.loads(capsys.readouterr().out)
        assert payload["via"] == "error"
        assert payload["merge_ready"] is False
        assert "error" in payload
        assert "partial_data" in payload

    def test_human_output_labels_external_error_distinct_from_blocked(
        self, monkeypatch, capsys,
    ):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(returncode=1, stderr="all-down"),
            "pr-view-rest": _ns(returncode=1, stderr="all-down"),
        })
        rc = pr_merge_readiness.main(["1363", "--repo", "deftai/directive"])
        assert rc == pr_merge_readiness.EXIT_EXTERNAL_ERROR
        out = capsys.readouterr().out
        assert "EXTERNAL-ERROR" in out
        assert "via=error" in out


# ---------------------------------------------------------------------------
# Backward-compat regression: existing test surface still passes
# ---------------------------------------------------------------------------


class TestPrimaryBackwardCompat:
    def test_via_field_always_present_in_json(self, monkeypatch, capsys):
        install_fake_gh(monkeypatch, {
            "head-sha": _ns(stdout=_HEAD_SHA + "\n"),
            "comments-jq": _ns(stdout=_clean_jq_body()),
        })
        pr_merge_readiness.main([
            "1363", "--repo", "deftai/directive", "--json",
        ])
        payload = json.loads(capsys.readouterr().out)
        assert "via" in payload
        assert payload["via"] == "primary"
        # Existing #796 keys still surface.
        assert "merge_ready" in payload
        assert "head_sha" in payload
        assert "verdict" in payload
        assert "failures" in payload


# ---------------------------------------------------------------------------
# monitor_pr.py tests
# ---------------------------------------------------------------------------


class _FakeClock:
    """Deterministic monotonic clock advanced by the test."""

    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value


def _make_call_log(*payloads):
    """Return a callable that yields one payload per invocation."""
    seq = iter(payloads)

    def _call(_pr_number, _repo):
        try:
            payload = next(seq)
        except StopIteration:
            payload = {"via": "error", "merge_ready": False, "error": "no more"}
        return monitor_pr.PollResult(
            exit_code=0 if payload.get("merge_ready") else 1,
            payload=payload,
            raw_stdout=json.dumps(payload),
            raw_stderr="",
        )

    return _call


class TestMonitorLoop:
    def test_clean_exit_on_first_poll(self):
        clock = _FakeClock()
        sleeps: list = []
        exit_code, payload, polls = monitor_pr.monitor(
            pr_number=1363,
            repo="deftai/directive",
            cap_minutes=10,
            sleep_fn=lambda s: sleeps.append(s),
            clock_fn=clock.now,
            call_readiness_fn=_make_call_log({
                "via": "primary",
                "merge_ready": True,
                "head_sha": _HEAD_SHA,
                "failures": [],
            }),
        )
        assert exit_code == monitor_pr.EXIT_CLEAN
        assert polls == 1
        assert payload["via"] == "primary"
        assert sleeps == [], "CLEAN exit must not sleep"

    def test_fallback2_does_not_trigger_clean(self):
        # fallback2 with merge_ready=False holds the loop; eventually
        # primary CLEAN fires.
        clock = _FakeClock()

        def advancing_sleep(s):
            clock.value += s

        exit_code, payload, polls = monitor_pr.monitor(
            pr_number=1363,
            repo="deftai/directive",
            cap_minutes=120,
            cadence=((1, 5),),  # tight cadence for the test
            sleep_fn=advancing_sleep,
            clock_fn=clock.now,
            call_readiness_fn=_make_call_log(
                {"via": "fallback2", "merge_ready": False, "failures": ["a"]},
                {"via": "fallback2", "merge_ready": False, "failures": ["a"]},
                {"via": "primary", "merge_ready": True, "failures": []},
            ),
        )
        assert exit_code == monitor_pr.EXIT_CLEAN
        assert payload["via"] == "primary"
        assert polls == 3

    def test_fallback2_with_merge_ready_true_is_still_not_clean(self):
        # Defensive: even if some future refactor accidentally sets
        # merge_ready=True on a fallback2 payload, monitor MUST NOT
        # promote that to CLEAN. The CLEAN gate keys on via∈{primary,
        # fallback1}.
        clock = _FakeClock()

        def advancing_sleep(s):
            clock.value += s

        exit_code, payload, polls = monitor_pr.monitor(
            pr_number=1363,
            repo="deftai/directive",
            cap_minutes=120,
            cadence=((1, 3),),
            sleep_fn=advancing_sleep,
            clock_fn=clock.now,
            call_readiness_fn=_make_call_log(
                # Pathological: merge_ready=True on fallback2 MUST NOT
                # trigger CLEAN.
                {"via": "fallback2", "merge_ready": True, "failures": []},
                {"via": "fallback2", "merge_ready": True, "failures": []},
                {"via": "fallback2", "merge_ready": True, "failures": []},
            ),
        )
        # Loop exhausts without CLEAN -- ends at cap.
        assert exit_code in (monitor_pr.EXIT_CAP_REACHED,)
        assert payload["via"] == "fallback2"
        assert polls == 3

    def test_terminal_pr_state_short_circuits(self):
        clock = _FakeClock()
        exit_code, payload, polls = monitor_pr.monitor(
            pr_number=1363,
            repo="deftai/directive",
            cap_minutes=10,
            sleep_fn=lambda s: None,
            clock_fn=clock.now,
            call_readiness_fn=_make_call_log({
                "via": "fallback2",
                "merge_ready": False,
                "failures": ["fallback2 is a coarse signal..."],
                "partial_data": {
                    "pr_state": "closed",
                    "merged": True,
                    "mergeable": None,
                },
            }),
        )
        assert exit_code == monitor_pr.EXIT_PR_TERMINAL
        assert polls == 1

    def test_cap_reached_returns_cap_reached(self):
        clock = _FakeClock()

        def advancing_sleep(s):
            # Force the clock past the cap on the second sleep.
            clock.value += s * 1000

        exit_code, _payload, _polls = monitor_pr.monitor(
            pr_number=1363,
            repo="deftai/directive",
            cap_minutes=1,
            cadence=((1, 5),),
            sleep_fn=advancing_sleep,
            clock_fn=clock.now,
            call_readiness_fn=_make_call_log(
                *[
                    {"via": "error", "merge_ready": False, "failures": ["x"]}
                    for _ in range(10)
                ]
            ),
        )
        assert exit_code == monitor_pr.EXIT_CAP_REACHED

    def test_cadence_intervals_expansion(self):
        expanded = monitor_pr._cadence_intervals(
            cadence=((60, 3), (180, 3), (300, 5)),
        )
        assert expanded == [60, 60, 60, 180, 180, 180, 300, 300, 300, 300, 300]

    def test_default_cadence_is_1_3_5_minute_tiers(self):
        # Document the requirement: 1m / 3m / 5m.
        cadence = monitor_pr._DEFAULT_CADENCE
        intervals_seconds = {interval for interval, _ in cadence}
        assert 60 in intervals_seconds
        assert 180 in intervals_seconds
        assert 300 in intervals_seconds

    def test_call_readiness_handles_empty_stdout(self, monkeypatch):
        # Defensive: a future regression where the readiness script
        # emits empty stdout must not blind the monitor.
        def fake_run_text(_cmd, **_kw):
            return SimpleNamespace(stdout="", stderr="oops", returncode=2)

        monkeypatch.setattr(monitor_pr, "run_text", fake_run_text)
        result = monitor_pr.call_readiness(1, "deftai/directive")
        assert result.payload["via"] == "error"
        assert result.payload["merge_ready"] is False
        assert "empty stdout" in result.payload["error"]

    def test_call_readiness_handles_non_json_stdout(self, monkeypatch):
        def fake_run_text(_cmd, **_kw):
            return SimpleNamespace(
                stdout="not json at all", stderr="", returncode=1,
            )

        monkeypatch.setattr(monitor_pr, "run_text", fake_run_text)
        result = monitor_pr.call_readiness(1, "deftai/directive")
        assert result.payload["via"] == "error"
        assert "non-JSON" in result.payload["error"]


class TestMonitorCli:
    def test_missing_repo_returns_config_error(self, monkeypatch, capsys):
        monkeypatch.delenv("GH_REPO", raising=False)
        rc = monitor_pr.main(["1363"])
        assert rc == monitor_pr.EXIT_CONFIG_ERROR

    def test_clean_exit_emits_json_envelope(self, monkeypatch, capsys):
        monkeypatch.setattr(monitor_pr, "monitor", lambda **_: (
            monitor_pr.EXIT_CLEAN,
            {"via": "primary", "merge_ready": True, "failures": []},
            1,
        ))
        rc = monitor_pr.main([
            "1363", "--repo", "deftai/directive", "--json",
        ])
        assert rc == monitor_pr.EXIT_CLEAN
        payload = json.loads(capsys.readouterr().out)
        assert payload["monitor_result"] == "CLEAN"
        assert payload["readiness"]["via"] == "primary"
