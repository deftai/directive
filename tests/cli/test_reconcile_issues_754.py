"""test_reconcile_issues_754.py -- inverted-lookup tests for #754.

Coverage for the inverted-lookup gate fix landed in #754:
- ``fetch_issue_states`` batches above the GraphQL aliased-node ceiling.
- Mixed OPEN / CLOSED state classification works through ``reconcile``.
- ``fetch_issue_states`` returns ``None`` on gh subprocess errors.
- The default ``reconcile`` shape contains NO ``unlinked`` bucket.
- The pipeline gate scales by O(vBRIEF-count) -- 250+ vBRIEFs referencing
  OPEN issues never false-positive (the v0.21.0 32-mismatch flood the
  prior 200-issue cap produced).  [Covered in test_release_vbrief_lifecycle.py]
- ``--report-unlinked`` paginates correctly AND honours the
  ``--max-open-issues`` cap.
- The default cap of 1000 fires the documented diagnostic + non-zero
  exit when exceeded.

Refs: vbrief/active/2026-04-30-754-vbrief-lifecycle-sync-gate-false-positives-on-large-repos.
vbrief.json
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/reconcile_issues.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "reconcile_issues_754",
        scripts_dir / "reconcile_issues.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reconcile = _load_module()


# ---------------------------------------------------------------------------
# fetch_issue_states
# ---------------------------------------------------------------------------


class _GraphQLStub:
    """Capture the GraphQL queries gh receives + return canned payloads.

    Each invocation appends the ``-f query=...`` argument to ``self.calls``
    and returns the next-in-line payload from ``self.responses`` (or the
    last entry if the list is exhausted -- mirrors how a real backend
    would respond uniformly to the same query shape).
    """

    def __init__(self, responses: list[dict]):
        self.responses = responses
        self.calls: list[str] = []

    def __call__(self, argv, **_kwargs):
        # Locate the ``query=...`` argument, regardless of position.
        query_arg = next(
            (a for a in argv if isinstance(a, str) and a.startswith("query=")),
            "",
        )
        self.calls.append(query_arg)
        idx = min(len(self.calls) - 1, len(self.responses) - 1)
        payload = self.responses[idx]

        class R:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        return R()


class TestFetchIssueStates:
    def test_fetch_issue_states_batches_above_500(self, monkeypatch):
        """600 issues split into multiple GraphQL calls (batch_size=200).

        The helper MUST split the input across multiple ``gh api graphql``
        invocations -- the merged dict must contain a state for every
        requested issue. Verifies the inverted-lookup helper handles
        repos with many vBRIEF references.
        """
        # Build 600 OPEN responses (one per batch).
        per_batch_payload = lambda start, count: {  # noqa: E731
            "data": {
                "repository": {
                    f"i{n}": {"state": "OPEN"}
                    for n in range(start, start + count)
                }
            }
        }
        # 600 issues / batch_size=200 -> 3 batches.
        responses = [
            per_batch_payload(1, 200),
            per_batch_payload(201, 200),
            per_batch_payload(401, 200),
        ]
        stub = _GraphQLStub(responses)
        monkeypatch.setattr(reconcile.subprocess, "run", stub)

        states = reconcile.fetch_issue_states(
            "deftai/directive", set(range(1, 601))
        )
        assert states is not None
        assert len(states) == 600
        assert all(states[n] == "OPEN" for n in range(1, 601))
        # The helper MUST issue at least 3 GraphQL calls (no truncation).
        assert len(stub.calls) >= 3

    def test_fetch_issue_states_handles_closed_open_mix(self, monkeypatch):
        """Mixed OPEN/CLOSED responses classify through reconcile correctly."""
        payload = {
            "data": {
                "repository": {
                    "i100": {"state": "OPEN"},
                    "i200": {"state": "CLOSED"},
                    "i300": {"state": "OPEN"},
                }
            }
        }
        stub = _GraphQLStub([payload])
        monkeypatch.setattr(reconcile.subprocess, "run", stub)

        states = reconcile.fetch_issue_states(
            "deftai/directive", {100, 200, 300}
        )
        assert states == {100: "OPEN", 200: "CLOSED", 300: "OPEN"}

        # Pipe through reconcile and confirm classification.
        issue_to_vbriefs = {
            100: ["active/a.vbrief.json"],
            200: ["proposed/b.vbrief.json"],
            300: ["pending/c.vbrief.json"],
        }
        report = reconcile.reconcile(issue_to_vbriefs, states)
        assert report["summary"]["linked_count"] == 2
        assert report["summary"]["vbriefs_no_open_issue_count"] == 1
        assert "unlinked" not in report
        # The CLOSED entry lands in no_open_issue.
        assert report["no_open_issue"][0]["issue_number"] == 200

    def test_fetch_issue_states_returns_none_on_gh_error(
        self, monkeypatch, capsys
    ):
        """Non-zero gh exit -> helper returns None (mirrors fetch_open_issues)."""
        class R:
            returncode = 1
            stdout = ""
            stderr = "auth: bad credentials"

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        result = reconcile.fetch_issue_states(
            "deftai/directive", {1, 2, 3}
        )
        assert result is None
        assert "gh CLI failed" in capsys.readouterr().err

    def test_fetch_issue_states_empty_set_no_subprocess(self, monkeypatch):
        """Empty input set -> empty dict; no subprocess invocation."""
        def boom(*_a, **_k):  # pragma: no cover - asserted not called
            raise AssertionError(
                "fetch_issue_states must NOT call subprocess for empty input"
            )

        monkeypatch.setattr(reconcile.subprocess, "run", boom)
        assert reconcile.fetch_issue_states("o/r", set()) == {}

    def test_fetch_issue_states_not_found_sentinel(self, monkeypatch):
        """Null GraphQL node -> NOT_FOUND sentinel (issue does not exist)."""
        payload = {
            "data": {
                "repository": {
                    "i999": None,  # GitHub returns null for missing issues.
                }
            }
        }
        stub = _GraphQLStub([payload])
        monkeypatch.setattr(reconcile.subprocess, "run", stub)

        states = reconcile.fetch_issue_states("deftai/directive", {999})
        assert states == {999: "NOT_FOUND"}

    def test_fetch_issue_states_partial_error_soft_failure(
        self, monkeypatch, capsys
    ):
        """Non-zero exit + parseable data field -> soft failure (#754).

        When some referenced numbers are PRs (or deleted records) gh
        emits a top-level ``errors[*]`` block AND exits non-zero, but
        the response ``data`` field is still populated. The helper MUST
        treat that as a soft failure: surface a warning, classify the
        offending aliases as NOT_FOUND, and return the merged dict.
        """
        # Non-zero exit, but stdout carries a parseable response with
        # one resolved issue and one null (the PR-aliased-as-issue case).
        body = json.dumps(
            {
                "data": {
                    "repository": {
                        "i100": {"state": "OPEN"},
                        "i200": None,
                    }
                },
                "errors": [
                    {"message": "Could not resolve to an Issue with the number of 200."}
                ],
            }
        )

        class R:
            returncode = 1
            stdout = body
            stderr = (
                "gh: Could not resolve to an Issue with the number of 200."
            )

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        states = reconcile.fetch_issue_states(
            "deftai/directive", {100, 200}
        )
        assert states == {100: "OPEN", 200: "NOT_FOUND"}
        # A warning about the partial errors must surface so operators
        # see the trace -- but it is NOT a fatal error.
        err = capsys.readouterr().err
        assert "partial errors" in err.lower()


# ---------------------------------------------------------------------------
# reconcile (default inverted shape)
# ---------------------------------------------------------------------------


class TestReconcileNoUnlinkedDefault:
    def test_reconcile_no_unlinked_in_default_path(self):
        """Default reconcile MUST emit only linked + no_open_issue (no unlinked)."""
        issue_to_vbriefs = {
            10: ["pending/a.vbrief.json"],
            20: ["active/b.vbrief.json"],
            30: ["completed/c.vbrief.json"],
        }
        state_map = {10: "OPEN", 20: "CLOSED", 30: "CLOSED"}
        report = reconcile.reconcile(issue_to_vbriefs, state_map)

        assert "linked" in report
        assert "no_open_issue" in report
        assert "unlinked" not in report, (
            "default reconcile MUST drop the unlinked bucket (#754)"
        )
        # Summary likewise omits the unlinked counters.
        assert "unlinked_count" not in report["summary"]
        assert "total_open_issues" not in report["summary"]
        assert report["summary"]["linked_count"] == 1
        assert report["summary"]["vbriefs_no_open_issue_count"] == 2


# ---------------------------------------------------------------------------
# --report-unlinked CLI flag + --max-open-issues cap
# ---------------------------------------------------------------------------


class TestReportUnlinkedFlag:
    def test_report_unlinked_flag_paginates_and_caps(
        self, tmp_path, monkeypatch, capsys
    ):
        """--report-unlinked --max-open-issues=N aborts when count > N."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # Synthesize 50 open issues -- well above any cap below 50.
        fake_open = [
            {"number": n, "title": f"Issue {n}", "url": "", "labels": []}
            for n in range(1, 51)
        ]
        monkeypatch.setattr(
            reconcile,
            "fetch_all_open_issues",
            lambda _r, cwd=None: fake_open,
        )
        monkeypatch.setattr(
            reconcile, "detect_repo", lambda: "deftai/directive"
        )
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "reconcile_issues.py",
                "--vbrief-dir",
                str(vbrief_dir),
                "--repo",
                "deftai/directive",
                "--report-unlinked",
                "--max-open-issues",
                "10",
            ],
        )
        rc = reconcile.main()
        assert rc == 1
        err = capsys.readouterr().err
        # Canonical diagnostic shape per the vBRIEF.
        assert "50 open issues exceeds --max-open-issues=10" in err
        assert "raise the cap or drop --report-unlinked" in err

    def test_report_unlinked_default_cap_1000(
        self, tmp_path, monkeypatch, capsys
    ):
        """Default cap is 1000; >1000 open issues triggers the diagnostic."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # 1500 fake open issues -> exceeds the 1000 default cap.
        fake_open = [
            {"number": n, "title": f"Issue {n}", "url": "", "labels": []}
            for n in range(1, 1501)
        ]
        monkeypatch.setattr(
            reconcile,
            "fetch_all_open_issues",
            lambda _r, cwd=None: fake_open,
        )
        monkeypatch.setattr(
            reconcile, "detect_repo", lambda: "deftai/directive"
        )
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "reconcile_issues.py",
                "--vbrief-dir",
                str(vbrief_dir),
                "--repo",
                "deftai/directive",
                "--report-unlinked",
                # NB: NO --max-open-issues -> uses DEFAULT_MAX_OPEN_ISSUES (1000).
            ],
        )
        rc = reconcile.main()
        assert rc == 1
        err = capsys.readouterr().err
        assert "1500 open issues exceeds --max-open-issues=1000" in err
        assert "raise the cap or drop --report-unlinked" in err

    def test_report_unlinked_under_cap_emits_three_section_report(
        self, tmp_path, monkeypatch, capsys
    ):
        """--report-unlinked under the cap emits the legacy three-section report."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        fake_open = [
            {"number": 1, "title": "Open A", "url": "", "labels": []},
            {"number": 2, "title": "Open B", "url": "", "labels": []},
        ]
        monkeypatch.setattr(
            reconcile,
            "fetch_all_open_issues",
            lambda _r, cwd=None: fake_open,
        )
        monkeypatch.setattr(
            reconcile, "detect_repo", lambda: "deftai/directive"
        )
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "reconcile_issues.py",
                "--vbrief-dir",
                str(vbrief_dir),
                "--repo",
                "deftai/directive",
                "--report-unlinked",
                "--format",
                "json",
            ],
        )
        rc = reconcile.main()
        assert rc == 0
        out = capsys.readouterr().out
        parsed = json.loads(out)
        # Legacy three-section shape MUST contain unlinked.
        assert "unlinked" in parsed
        assert parsed["summary"]["unlinked_count"] == 2
        assert parsed["summary"]["total_open_issues"] == 2


# ---------------------------------------------------------------------------
# fetch_all_open_issues (used by --report-unlinked)
# ---------------------------------------------------------------------------


class TestFetchAllOpenIssues:
    def test_invokes_gh_with_unlimited_pagination(self, monkeypatch):
        """``--limit 0`` is the gh contract for unlimited native pagination."""
        captured: dict[str, list[str]] = {}

        class R:
            returncode = 0
            stdout = json.dumps(
                [{"number": 1, "title": "T", "url": "", "labels": []}]
            )
            stderr = ""

        def fake_run(argv, **_kwargs):
            captured["argv"] = list(argv)
            return R()

        monkeypatch.setattr(reconcile.subprocess, "run", fake_run)
        result = reconcile.fetch_all_open_issues("deftai/directive")
        assert result == [
            {"number": 1, "title": "T", "url": "", "labels": []}
        ]
        # Argv MUST request unlimited pagination.
        assert "--limit" in captured["argv"]
        assert "0" in captured["argv"]

    def test_returns_none_on_gh_error(self, monkeypatch, capsys):
        """Non-zero exit propagates as None."""
        class R:
            returncode = 1
            stdout = ""
            stderr = "rate-limited"

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.fetch_all_open_issues("o/r") is None
        assert "gh CLI failed" in capsys.readouterr().err

    def test_returns_none_on_timeout(self, monkeypatch, capsys):
        """TimeoutExpired surfaces as None."""
        def fake_run(*_a, **_k):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=300)

        monkeypatch.setattr(reconcile.subprocess, "run", fake_run)
        assert reconcile.fetch_all_open_issues("o/r") is None
        assert "timed out" in capsys.readouterr().err
