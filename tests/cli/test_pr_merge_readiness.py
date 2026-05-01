"""test_pr_merge_readiness.py -- Tests for scripts/pr_merge_readiness.py.

Covers (#796 follow-up; PR #652 incident):
- Greptile body parsing: SHA / confidence / P0 / P1 / P2 / errored
- Badge-count primary path and section-heading fallback
- Negation false-positive resilience (clean-summary text doesn't fire P0/P1)
- Gate evaluation: each failure mode returns the correct message
- main() exit codes for merge-ready, merge-blocked, external error
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
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "pr_merge_readiness",
        scripts_dir / "pr_merge_readiness.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register in sys.modules BEFORE exec_module so @dataclass's internal
    # _is_type check (which does sys.modules.get(cls.__module__).__dict__)
    # finds the module and doesn't AttributeError on NoneType.
    sys.modules["pr_merge_readiness"] = module
    spec.loader.exec_module(module)
    return module


merge_readiness = _load_module()


# ---------------------------------------------------------------------------
# Greptile body fixtures
# ---------------------------------------------------------------------------


def _clean_body(sha: str = "abc1234567890def1234567890abcdef12345678", confidence: int = 5) -> str:
    """A clean Greptile rolling-summary body matching production format."""
    return (
        f"## Greptile Summary\n"
        f"\n"
        f"No P0 or P1 issues found in this PR.\n"
        f"\n"
        f"**Confidence Score: {confidence}/5**\n"
        f"\n"
        f"Last reviewed commit: [chore: small fix](https://github.com/deftai/directive/commit/{sha})\n"
    )


def _findings_body(sha: str, confidence: int, p0: int = 0, p1: int = 0, p2: int = 0) -> str:
    """A Greptile body with N badge-rendered findings of each severity."""
    body = "## Greptile Summary\n\n"
    for _ in range(p0):
        body += '<img alt="P0" src="..."> Critical thing here.\n'
    for _ in range(p1):
        body += '<img alt="P1" src="..."> Real defect here.\n'
    for _ in range(p2):
        body += '<img alt="P2" src="..."> Style nit here.\n'
    body += f"\n**Confidence Score: {confidence}/5**\n\n"
    body += f"Last reviewed commit: [fix: stuff](https://github.com/deftai/directive/commit/{sha})\n"
    return body


def _section_body(sha: str, confidence: int, p0: int, p1: int, p2: int) -> str:
    """A Greptile body using structured-section headings (no badges)."""
    return (
        f"## Greptile Summary\n\n"
        f"### P0 findings ({p0})\n\n"
        f"### P1 findings ({p1})\n\n"
        f"### P2 findings ({p2})\n\n"
        f"**Confidence Score: {confidence}/5**\n\n"
        f"Last reviewed commit: [refactor](https://github.com/deftai/directive/commit/{sha})\n"
    )


# ---------------------------------------------------------------------------
# parse_greptile_body
# ---------------------------------------------------------------------------


class TestParseGreptileBody:
    def test_empty_body_returns_not_found(self):
        v = merge_readiness.parse_greptile_body("")
        assert v.found is False
        assert v.last_reviewed_sha is None
        assert v.confidence is None
        assert v.p0_count == 0 and v.p1_count == 0

    @pytest.mark.parametrize(
        "whitespace_body",
        [
            "\n",          # gh api --jq single-page no-comment (P2 #2 from PR #797)
            "\n\n",        # 2-page paginated no-comment
            "\n\n\n\n",    # N-page paginated no-comment (P2 #3 from PR #797)
            "   ",         # bare spaces
            "\t",          # tab only
            " \n \t \n ",  # mixed whitespace
        ],
        ids=["single-newline", "two-newlines", "four-newlines", "spaces", "tab", "mixed"],
    )
    def test_whitespace_only_body_returns_not_found(self, whitespace_body):
        # Regression: gh api --jq raw mode emits trailing newlines for empty
        # outputs, including the `// ""` empty-string fallback. With
        # `--paginate` jq runs per-page, so a no-comment PR with N pages
        # produces N newlines. The whitespace-aware guard MUST route these
        # through the not-found path so the gate emits the intended
        # "No Greptile rolling-summary comment found" diagnostic.
        v = merge_readiness.parse_greptile_body(whitespace_body)
        assert v.found is False
        assert v.last_reviewed_sha is None
        assert v.confidence is None

    def test_clean_body_parses_all_fields(self):
        sha = "deadbeef1234567890deadbeef1234567890abcd"
        v = merge_readiness.parse_greptile_body(_clean_body(sha=sha, confidence=5))
        assert v.found is True
        assert v.errored is False
        assert v.last_reviewed_sha == sha
        assert v.confidence == 5
        assert v.p0_count == 0
        assert v.p1_count == 0

    def test_clean_summary_text_does_not_false_positive_p0_p1(self):
        # Regression guard: "No P0 or P1 issues found" contains literal P0/P1
        # tokens. Naive substring scan would flag this -- badge approach must not.
        v = merge_readiness.parse_greptile_body(_clean_body())
        assert v.p0_count == 0
        assert v.p1_count == 0

    def test_badge_findings_counted(self):
        body = _findings_body(
            sha="aaaaaaa", confidence=2, p0=1, p1=2, p2=3,
        )
        v = merge_readiness.parse_greptile_body(body)
        assert v.p0_count == 1
        assert v.p1_count == 2
        assert v.p2_count == 3
        assert v.confidence == 2

    def test_section_heading_fallback_when_no_badges(self):
        body = _section_body(sha="bbbbbbb", confidence=4, p0=0, p1=1, p2=5)
        v = merge_readiness.parse_greptile_body(body)
        assert v.p0_count == 0
        assert v.p1_count == 1
        assert v.p2_count == 5

    def test_errored_sentinel_detected(self):
        body = "Greptile encountered an error while reviewing this PR"
        v = merge_readiness.parse_greptile_body(body)
        assert v.errored is True

    def test_unparseable_confidence_returns_none(self):
        body = "Last reviewed commit: [x](https://github.com/o/r/commit/abc1234)\n"
        v = merge_readiness.parse_greptile_body(body)
        assert v.confidence is None

    def test_unparseable_sha_returns_none(self):
        body = "**Confidence Score: 5/5**\n"
        v = merge_readiness.parse_greptile_body(body)
        assert v.last_reviewed_sha is None

    def test_sha_takes_last_match_not_first(self):
        # Self-dogfood on PR #797: Greptile may quote suggestion code
        # containing the same `Last reviewed commit:` pattern (e.g. test
        # fixtures referenced in a P2 finding). The actual ground-truth
        # SHA lives in the trailing `<sub>` block.
        body = (
            "### Issue 3\n"
            "```python\n"
            'body_mixed = "Last reviewed commit: [x]'
            "(https://github.com/o/r/commit/bbbbbbb)\"\n"
            "```\n"
            "**Confidence Score: 4/5**\n\n"
            "<sub>Reviews (3): Last reviewed commit: "
            "[real](https://github.com/deftai/directive/commit/d65eb9f41c2bfd8c)\n"
        )
        v = merge_readiness.parse_greptile_body(body)
        assert v.last_reviewed_sha == "d65eb9f41c2bfd8c"

    def test_mixed_format_p2_badge_with_p1_section_heading(self):
        # PR #797 Greptile P1: a legacy-format body (no <details>) with P2
        # badges inline AND P1 section heading must still surface the P1
        # count via the heading fallback.
        body = (
            '<img alt="P2" src="..."> Style nit.\n'
            "### P1 findings (1)\n\n"
            "**Confidence Score: 4/5**\n\n"
            "Last reviewed commit: [x]"
            "(https://github.com/deftai/directive/commit/abc1234)\n"
        )
        v = merge_readiness.parse_greptile_body(body)
        assert v.p1_count == 1, "P1 heading must merge in despite P2 badge presence"
        assert v.p2_count == 1, "P2 badge count preserved"

    def test_rich_format_details_body_skips_heading_fallback(self):
        # PR #797 self-dogfood (post-85c0b1d): Greptile's clean rich-format
        # review used <details> collapsibles and quoted the new test
        # fixture's `### P1 findings (1)` literal in its summary. The
        # heading-fallback must NOT trip on quoted strings inside the
        # modern <details>-wrapped format. Badge counts are authoritative
        # whenever <details> is present.
        body = (
            "<details><summary><h3>Greptile Summary</h3></summary>\n\n"
            "This PR introduces a programmatic gate. "
            "No P0 or P1 issues found.\n\n"
            "```python\n"
            '# quoted from test fixture\n'
            'body = "### P1 findings (1)\\n"\n'
            "```\n\n"
            "**Confidence Score: 5/5**\n\n"
            "</details>\n\n"
            "<sub>Last reviewed commit: "
            "[fix](https://github.com/deftai/directive/commit/85c0b1de994a)</sub>\n"
        )
        v = merge_readiness.parse_greptile_body(body)
        assert v.p0_count == 0
        assert v.p1_count == 0, (
            "<details> body must skip heading-fallback to avoid quoted-fixture false positives"
        )
        assert v.confidence == 5
        assert v.last_reviewed_sha == "85c0b1de994a"


# ---------------------------------------------------------------------------
# evaluate_gates
# ---------------------------------------------------------------------------


class TestEvaluateGates:
    def _verdict(self, **overrides):
        defaults = {
            "found": True,
            "errored": False,
            "last_reviewed_sha": "abc1234567890def1234567890abcdef12345678",
            "confidence": 5,
            "p0_count": 0,
            "p1_count": 0,
            "p2_count": 0,
        }
        defaults.update(overrides)
        return merge_readiness.GreptileVerdict(**defaults)

    def test_all_clean_passes(self):
        head = "abc1234567890def1234567890abcdef12345678"
        failures = merge_readiness.evaluate_gates(1, head, self._verdict())
        assert failures == []

    def test_no_greptile_comment_fails(self):
        v = self._verdict(found=False, last_reviewed_sha=None, confidence=None)
        failures = merge_readiness.evaluate_gates(1, "abc", v)
        assert any("No Greptile rolling-summary" in f for f in failures)

    def test_errored_state_fails(self):
        failures = merge_readiness.evaluate_gates(
            1, "abc1234", self._verdict(errored=True),
        )
        assert any("ERRORED state" in f for f in failures)

    def test_stale_sha_fails(self):
        v = self._verdict(last_reviewed_sha="aaaaaaa")
        failures = merge_readiness.evaluate_gates(1, "bbbbbbb", v)
        assert any("Review is stale" in f for f in failures)

    def test_short_sha_prefix_match_passes(self):
        # Greptile may emit a 7-char short SHA; HEAD is full 40-char.
        # The verdict's short SHA is the prefix of HEAD -- treat as match.
        head = "abc1234567890def1234567890abcdef12345678"
        v = self._verdict(last_reviewed_sha="abc1234")
        failures = merge_readiness.evaluate_gates(1, head, v)
        assert not any("stale" in f.lower() for f in failures)

    def test_low_confidence_fails(self):
        v = self._verdict(confidence=3)
        failures = merge_readiness.evaluate_gates(
            1, "abc1234567890def1234567890abcdef12345678", v,
        )
        assert any("confidence is 3/5" in f for f in failures)

    def test_confidence_4_passes(self):
        v = self._verdict(confidence=4)
        failures = merge_readiness.evaluate_gates(
            1, "abc1234567890def1234567890abcdef12345678", v,
        )
        assert not any("confidence" in f.lower() for f in failures)

    def test_p1_finding_fails(self):
        v = self._verdict(p1_count=1)
        failures = merge_readiness.evaluate_gates(
            1, "abc1234567890def1234567890abcdef12345678", v,
        )
        assert any("P1 findings" in f for f in failures)

    def test_p2_only_passes(self):
        v = self._verdict(p2_count=5)
        failures = merge_readiness.evaluate_gates(
            1, "abc1234567890def1234567890abcdef12345678", v,
        )
        assert failures == []

    def test_pr_652_incident_signature_fails(self):
        # PR #652 incident: confidence 3/5 + 1 P1 + 2 P2. Both gates must fire.
        head = "abc1234567890def1234567890abcdef12345678"
        v = self._verdict(
            last_reviewed_sha=head, confidence=3, p1_count=1, p2_count=2,
        )
        failures = merge_readiness.evaluate_gates(1, head, v)
        assert len(failures) >= 2
        assert any("confidence" in f.lower() for f in failures)
        assert any("P1" in f for f in failures)


# ---------------------------------------------------------------------------
# main / CLI
# ---------------------------------------------------------------------------


class TestMain:
    def _patch_gh(
        self,
        monkeypatch,
        head_sha: str,
        comment_body: str,
        repo: str = "deftai/directive",
    ):
        """Patch subprocess.run to fake gh outputs for the three calls main() makes."""
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if "headRefOid" in cmd:
                return SimpleNamespace(stdout=head_sha + "\n", stderr="", returncode=0)
            if "nameWithOwner" in cmd:
                return SimpleNamespace(stdout=repo + "\n", stderr="", returncode=0)
            if "/comments" in " ".join(cmd):
                return SimpleNamespace(stdout=comment_body, stderr="", returncode=0)
            return SimpleNamespace(stdout="", stderr="unexpected gh call", returncode=1)

        monkeypatch.setattr(subprocess, "run", fake_run)
        return calls

    def test_clean_pr_exits_0(self, monkeypatch, capsys):
        sha = "abc1234567890def1234567890abcdef12345678"
        self._patch_gh(monkeypatch, sha, _clean_body(sha=sha))
        rc = merge_readiness.main(["123", "--repo", "deftai/directive"])
        assert rc == merge_readiness.EXIT_OK
        out = capsys.readouterr().out
        assert "MERGE-READY" in out

    def test_blocked_pr_exits_1(self, monkeypatch, capsys):
        sha = "abc1234567890def1234567890abcdef12345678"
        body = _findings_body(sha=sha, confidence=3, p1=1, p2=2)
        self._patch_gh(monkeypatch, sha, body)
        rc = merge_readiness.main(["652", "--repo", "deftai/directive"])
        assert rc == merge_readiness.EXIT_MERGE_BLOCKED
        out = capsys.readouterr().out
        assert "MERGE-BLOCKED" in out

    def test_no_greptile_comment_exits_1(self, monkeypatch):
        sha = "abc1234567890def1234567890abcdef12345678"
        self._patch_gh(monkeypatch, sha, "")
        rc = merge_readiness.main(["1", "--repo", "deftai/directive"])
        assert rc == merge_readiness.EXIT_MERGE_BLOCKED

    def test_no_greptile_comment_production_newline_exits_1(self, monkeypatch, capsys):
        # Production parity: `gh api --jq '... // ""'` (raw mode) emits `\n`
        # for an empty-string fallback, not an empty stdout. With
        # `--paginate` jq runs per-page, so the output is `\n` * page_count.
        # The CLI must still route to MERGE-BLOCKED with the
        # "No Greptile rolling-summary comment found" diagnostic, NOT
        # the misleading "Could not parse SHA" / "Could not parse confidence"
        # diagnostics that the pre-fix code emitted (PR #797 Greptile P2).
        sha = "abc1234567890def1234567890abcdef12345678"
        self._patch_gh(monkeypatch, sha, "\n\n\n")  # 3-page paginated empty
        rc = merge_readiness.main(["1", "--repo", "deftai/directive"])
        assert rc == merge_readiness.EXIT_MERGE_BLOCKED
        out = capsys.readouterr().out
        assert "No Greptile rolling-summary" in out
        # Negative assertion: must NOT emit the parser-failure diagnostics.
        assert "Could not parse `Last reviewed commit:`" not in out
        assert "Could not parse `Confidence Score:" not in out

    def test_gh_failure_exits_2(self, monkeypatch):
        def fake_run(*_a, **_kw):
            return SimpleNamespace(stdout="", stderr="boom", returncode=1)
        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = merge_readiness.main(["1", "--repo", "deftai/directive"])
        assert rc == merge_readiness.EXIT_EXTERNAL_ERROR

    def test_json_emit(self, monkeypatch, capsys):
        sha = "abc1234567890def1234567890abcdef12345678"
        self._patch_gh(monkeypatch, sha, _clean_body(sha=sha))
        rc = merge_readiness.main(["1", "--repo", "deftai/directive", "--json"])
        assert rc == merge_readiness.EXIT_OK
        out = capsys.readouterr().out
        payload = json.loads(out)
        assert payload["merge_ready"] is True
        assert payload["pr_number"] == 1
