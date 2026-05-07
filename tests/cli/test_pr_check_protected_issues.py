"""test_pr_check_protected_issues.py -- Tests for scripts/pr_check_protected_issues.py.

Covers (#701, Layer 3 closing-keyword hardening):
- Happy path: closingIssuesReferences contains only non-protected issue numbers -> exit 0
- Protected issue linked: overlap detected -> exit 1, offender(s) printed to stderr
- Multiple --protected flags + comma-separated list flatten correctly (additive)
- No --protected supplied -> exit 0 (skip)
- gh CLI missing (FileNotFoundError) -> exit 2
- gh CLI failure (non-zero return code) -> exit 2
- Malformed JSON output -> exit 2
- Unexpected closingIssuesReferences shape -> exit 2
- Invalid protected issue token -> exit 2

Uses in-process module loading via ``importlib.util`` and monkeypatches
``subprocess.run`` rather than hitting the real GitHub API.

Story: #701 (Layer 3 -- Persistent closingIssuesReferences Link).
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
    """Load scripts/pr_check_protected_issues.py in-process."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "pr_check_protected_issues",
        scripts_dir / "pr_check_protected_issues.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pr_check = _load_module()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gh_payload(*issue_numbers: int) -> str:
    """Build a JSON payload mimicking ``gh pr view --json closingIssuesReferences``."""
    return json.dumps(
        {
            "closingIssuesReferences": [
                {"number": n, "title": f"Issue #{n}", "url": f"https://example/issues/{n}"}
                for n in issue_numbers
            ]
        }
    )


def _make_run_returning(stdout: str, returncode: int = 0):
    """Return a subprocess.run replacement that yields the given stdout + returncode."""

    def fake_run(cmd, **kwargs):
        return SimpleNamespace(stdout=stdout, stderr="", returncode=returncode)

    return fake_run


# ---------------------------------------------------------------------------
# fetch_closing_issues_references
# ---------------------------------------------------------------------------


class TestFetchClosingIssuesReferences:
    def test_returns_numbers_for_well_formed_payload(self, monkeypatch):
        monkeypatch.setattr(
            subprocess, "run", _make_run_returning(_gh_payload(701, 642))
        )
        assert pr_check.fetch_closing_issues_references(701) == [701, 642]

    def test_returns_empty_list_for_no_links(self, monkeypatch):
        monkeypatch.setattr(subprocess, "run", _make_run_returning(_gh_payload()))
        assert pr_check.fetch_closing_issues_references(123) == []

    def test_gh_not_installed_returns_none(self, monkeypatch):
        def fake_run(*_a, **_kw):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert pr_check.fetch_closing_issues_references(1) is None

    def test_gh_failed_returns_none(self, monkeypatch):
        def fake_run(*_a, **_kw):
            return SimpleNamespace(
                stdout="", stderr="boom", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert pr_check.fetch_closing_issues_references(1) is None

    def test_gh_timeout_returns_none(self, monkeypatch):
        def fake_run(*_a, **_kw):
            raise subprocess.TimeoutExpired(cmd=["gh"], timeout=30)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert pr_check.fetch_closing_issues_references(1) is None

    def test_malformed_json_returns_none(self, monkeypatch):
        monkeypatch.setattr(subprocess, "run", _make_run_returning("not-json"))
        assert pr_check.fetch_closing_issues_references(1) is None

    def test_unexpected_shape_returns_none(self, monkeypatch):
        monkeypatch.setattr(
            subprocess,
            "run",
            _make_run_returning(json.dumps({"closingIssuesReferences": "oops"})),
        )
        assert pr_check.fetch_closing_issues_references(1) is None

    def test_repo_flag_forwarded_when_supplied(self, monkeypatch):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(
                stdout=_gh_payload(99), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        pr_check.fetch_closing_issues_references(1, repo="o/r")
        assert "--repo" in captured["cmd"]
        assert "o/r" in captured["cmd"]

    def test_repo_flag_omitted_when_not_supplied(self, monkeypatch):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(
                stdout=_gh_payload(99), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        pr_check.fetch_closing_issues_references(1)
        assert "--repo" not in captured["cmd"]


# ---------------------------------------------------------------------------
# _parse_protected
# ---------------------------------------------------------------------------


class TestParseProtected:
    def test_single_value(self):
        assert pr_check._parse_protected(["167"]) == [167]

    def test_comma_separated(self):
        assert pr_check._parse_protected(["167,698,642"]) == [167, 642, 698]

    def test_repeated_flag_aggregates(self):
        assert pr_check._parse_protected(["167", "698,642"]) == [167, 642, 698]

    def test_strips_hash_prefix(self):
        assert pr_check._parse_protected(["#167,#642"]) == [167, 642]

    def test_dedup_and_sort(self):
        assert pr_check._parse_protected(["642,167,167"]) == [167, 642]

    def test_empty_list_returns_empty(self):
        assert pr_check._parse_protected([]) == []

    def test_invalid_token_raises(self):
        with pytest.raises(ValueError):
            pr_check._parse_protected(["abc"])

    def test_unicode_superscript_rejected_with_custom_error(self):
        # Greptile P2: ``isdigit()`` returns True for Unicode digit characters
        # such as superscript 2 ('\u00b2'), but ``int('\u00b2')`` raises.
        # ``isdecimal()`` (the new guard) rejects the superscript with our
        # custom message rather than letting Python's generic
        # ``invalid literal for int()`` surface from int(tok).
        with pytest.raises(ValueError, match="Invalid protected issue token"):
            pr_check._parse_protected(["\u00b2"])


# ---------------------------------------------------------------------------
# main / CLI
# ---------------------------------------------------------------------------


class TestMain:
    def test_no_protected_supplied_exits_0(self, monkeypatch, capsys):
        # gh should NOT be invoked when no protected list is given.
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("gh should not be invoked when --protected is empty")

        monkeypatch.setattr(subprocess, "run", boom)
        rc = pr_check.main(["701"])
        assert rc == pr_check.EXIT_OK

    def test_happy_path_no_overlap_exits_0(self, monkeypatch, capsys):
        # closingIssuesReferences contains only #701 (the PR's own closes), and
        # the protected list (#167, #698, #642) does NOT overlap -> safe.
        monkeypatch.setattr(subprocess, "run", _make_run_returning(_gh_payload(701)))
        rc = pr_check.main(["701", "--protected", "167,698,642"])
        assert rc == pr_check.EXIT_OK
        captured = capsys.readouterr()
        assert "OK" in captured.err

    def test_protected_overlap_exits_1(self, monkeypatch, capsys):
        # closingIssuesReferences includes #642, which is in the protected list.
        monkeypatch.setattr(subprocess, "run", _make_run_returning(_gh_payload(642)))
        rc = pr_check.main(["401", "--protected", "642"])
        assert rc == pr_check.EXIT_PROTECTED_LINKED
        captured = capsys.readouterr()
        assert "FAIL" in captured.err
        assert "#642" in captured.err

    def test_multiple_protected_flags_aggregated(self, monkeypatch):
        monkeypatch.setattr(
            subprocess, "run", _make_run_returning(_gh_payload(167))
        )
        rc = pr_check.main(
            ["701", "--protected", "642", "--protected", "167,698"]
        )
        assert rc == pr_check.EXIT_PROTECTED_LINKED

    def test_gh_missing_exits_2(self, monkeypatch):
        def fake_run(*_a, **_kw):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = pr_check.main(["701", "--protected", "167"])
        assert rc == pr_check.EXIT_EXTERNAL_ERROR

    def test_gh_failed_exits_2(self, monkeypatch):
        def fake_run(*_a, **_kw):
            return SimpleNamespace(stdout="", stderr="auth", returncode=4)

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = pr_check.main(["701", "--protected", "167"])
        assert rc == pr_check.EXIT_EXTERNAL_ERROR

    def test_malformed_json_exits_2(self, monkeypatch):
        monkeypatch.setattr(subprocess, "run", _make_run_returning("not-json"))
        rc = pr_check.main(["701", "--protected", "167"])
        assert rc == pr_check.EXIT_EXTERNAL_ERROR

    def test_invalid_protected_token_exits_2(self, monkeypatch):
        # gh should NOT be invoked when --protected parsing fails.
        def boom(*_a, **_kw):  # pragma: no cover - asserted not called
            raise AssertionError("gh should not be invoked on malformed --protected")

        monkeypatch.setattr(subprocess, "run", boom)
        rc = pr_check.main(["701", "--protected", "abc"])
        assert rc == pr_check.EXIT_EXTERNAL_ERROR
