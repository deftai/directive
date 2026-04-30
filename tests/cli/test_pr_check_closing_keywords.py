"""test_pr_check_closing_keywords.py -- Layer 0 closing-keyword lint (#737).

Coverage:
- Negation-context detection: ``DOES NOT CLOSE #N``, ``intentionally not
  Closes``, ``never Fixes``, ``WITHOUT closing``, etc. -- all flagged.
- Quotation-context detection: backticked / curly-quoted closing
  keywords -- flagged.
- Example-context detection: ``e.g. Closes #N`` / ``i.e. Closes #N``
  / ``for example, Closes #N`` / ``such as Closes`` / ``like Closes``
  -- flagged.
- Code-block context detection: closing keyword inside a triple-backtick
  fence -- flagged.
- True-positive control: a real ``Closes #N`` not in any flagged
  context returns NO findings.
- ``--pr <N>`` end-to-end with stubbed ``gh`` calls.
- ``--body-file`` / ``--commits-file`` offline mode.
- ``--allow-known-false-positives`` escape hatch suppresses listed
  issue numbers.
- Three-state exit codes: 0 clean / 1 hits / 2 config error.

Story: #737. Pure stdlib + ``gh`` CLI; tests use monkeypatch on
``subprocess.run`` rather than hitting GitHub.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "pr_check_closing_keywords",
        scripts_dir / "pr_check_closing_keywords.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["pr_check_closing_keywords"] = module
    spec.loader.exec_module(module)
    return module


pr_check = _load_module()


# ---------------------------------------------------------------------------
# find_hits -- detection variants
# ---------------------------------------------------------------------------


class TestNegationDetection:
    def test_does_not_close_flagged(self):
        text = "This PR DOES NOT CLOSE #734 -- the issue stays open."
        hits = pr_check.find_hits(text, source="pr-body")
        assert len(hits) == 1
        assert hits[0].issue_number == 734
        assert hits[0].reason == "negation"

    def test_intentionally_not_flagged(self):
        text = "Intentionally not Closes #642 because it is the umbrella."
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(h.reason == "negation" for h in hits)
        assert any(h.issue_number == 642 for h in hits)

    def test_never_fixes_flagged(self):
        text = "We never Fixes #100 in this PR; that is deferred to v2."
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(h.reason == "negation" and h.issue_number == 100 for h in hits)

    def test_without_closing_flagged(self):
        text = "Lands the gate WITHOUT Closes #999 because it is umbrella."
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(h.reason == "negation" and h.issue_number == 999 for h in hits)


class TestQuotationDetection:
    def test_backticked_closing_keyword_flagged(self):
        text = "Note: do not write `Closes #642` in the body."
        hits = pr_check.find_hits(text, source="pr-body")
        assert len(hits) == 1
        assert hits[0].reason in ("quotation", "negation")
        assert hits[0].issue_number == 642


class TestExampleDetection:
    def test_eg_closes_flagged(self):
        text = "Use a closing keyword (e.g. Closes #100) only when intended."
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(h.reason == "example" and h.issue_number == 100 for h in hits)

    def test_for_example_closes_flagged(self):
        text = "For example, Closes #234 would auto-close on merge."
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(h.issue_number == 234 for h in hits)


class TestCodeBlockDetection:
    def test_triple_backtick_fenced_flagged(self):
        text = (
            "Documentation example:\n"
            "```\n"
            "Closes #500\n"
            "```\n"
            "End example."
        )
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(
            h.reason == "code-block" and h.issue_number == 500 for h in hits
        )


class TestBlockquoteDetection:
    def test_blockquote_flagged(self):
        text = "Body intro.\n> Closes #42 must not appear here.\nMore body."
        hits = pr_check.find_hits(text, source="pr-body")
        assert any(
            h.reason == "blockquote" and h.issue_number == 42 for h in hits
        )


class TestTruePositiveControl:
    def test_legit_closes_returns_no_hit(self):
        """A real ``Closes #N`` outside any flagged context produces NO findings."""
        text = (
            "feat(core): land the gate.\n\nCloses #734\n\nDescription continues..."
        )
        hits = pr_check.find_hits(text, source="pr-body")
        assert hits == [], (
            f"a true-positive Closes MUST NOT be flagged; got: {hits}"
        )

    def test_no_keyword_returns_no_hit(self):
        text = "Refs #642 (umbrella; remains open)."
        hits = pr_check.find_hits(text, source="pr-body")
        assert hits == []


# ---------------------------------------------------------------------------
# main / CLI -- exit codes + --pr / --body-file / --commits-file
# ---------------------------------------------------------------------------


class TestMainExitCodes:
    def test_clean_body_exits_zero(self, tmp_path):
        body = tmp_path / "body.md"
        body.write_text(
            "feat: lint introduction.\n\nCloses #1234\n",
            encoding="utf-8",
        )
        rc = pr_check.main(["--body-file", str(body)])
        assert rc == pr_check.EXIT_OK

    def test_negation_hit_exits_one(self, tmp_path):
        body = tmp_path / "body.md"
        body.write_text(
            "feat: gate.\n\nDOES NOT CLOSE #734 (umbrella).\n",
            encoding="utf-8",
        )
        rc = pr_check.main(["--body-file", str(body)])
        assert rc == pr_check.EXIT_HITS_FOUND

    def test_no_input_source_exits_two(self, capsys):
        rc = pr_check.main([])
        assert rc == pr_check.EXIT_CONFIG_ERROR
        err = capsys.readouterr().err
        assert "must specify --pr OR --body-file" in err

    def test_invalid_allow_token_exits_two(self, tmp_path):
        body = tmp_path / "body.md"
        body.write_text("clean body", encoding="utf-8")
        rc = pr_check.main(
            [
                "--body-file",
                str(body),
                "--allow-known-false-positives",
                "abc",
            ]
        )
        assert rc == pr_check.EXIT_CONFIG_ERROR

    def test_missing_body_file_exits_two(self, tmp_path):
        rc = pr_check.main(["--body-file", str(tmp_path / "does-not-exist.md")])
        assert rc == pr_check.EXIT_CONFIG_ERROR


# ---------------------------------------------------------------------------
# --pr <N> end-to-end with stubbed gh
# ---------------------------------------------------------------------------


class TestPrModeStubbed:
    def test_pr_mode_calls_gh_for_body_and_commits(self, monkeypatch):
        """``--pr 735`` MUST issue both ``--json body`` and ``--json commits``."""
        invocations: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            invocations.append(list(cmd))
            if "body" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps({"body": "Refs #642 only."}),
                    stderr="",
                    returncode=0,
                )
            if "commits" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps(
                        {
                            "commits": [
                                {
                                    "messageHeadline": "feat: implement",
                                    "messageBody": "Closes #1\n",
                                }
                            ]
                        }
                    ),
                    stderr="",
                    returncode=0,
                )
            raise AssertionError(f"unexpected gh argv: {cmd}")

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = pr_check.main(["--pr", "735"])
        assert rc == pr_check.EXIT_OK
        # One body call, one commits call.
        assert any("body" in cmd for cmd in invocations)
        assert any("commits" in cmd for cmd in invocations)

    def test_pr_mode_finds_negation_hit(self, monkeypatch, capsys):
        def fake_run(cmd, **kwargs):
            if "body" in cmd:
                return SimpleNamespace(
                    stdout=json.dumps(
                        {
                            "body": (
                                "Body header. Intentionally NOT using "
                                "`Closes #642` because umbrella."
                            )
                        }
                    ),
                    stderr="",
                    returncode=0,
                )
            return SimpleNamespace(
                stdout=json.dumps({"commits": []}), stderr="", returncode=0
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = pr_check.main(["--pr", "735"])
        assert rc == pr_check.EXIT_HITS_FOUND
        err = capsys.readouterr().err
        assert "FAIL:" in err
        assert "642" in err

    def test_pr_mode_gh_failure_exits_two(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="permission denied", returncode=1
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = pr_check.main(["--pr", "735"])
        assert rc == pr_check.EXIT_CONFIG_ERROR

    def test_pr_mode_gh_missing_exits_two(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = pr_check.main(["--pr", "735"])
        assert rc == pr_check.EXIT_CONFIG_ERROR


# ---------------------------------------------------------------------------
# Allow-list escape hatch
# ---------------------------------------------------------------------------


class TestAllowKnownFalsePositives:
    def test_allow_list_suppresses_hits(self, tmp_path):
        body = tmp_path / "body.md"
        body.write_text(
            "Body. Intentionally not `Closes #999` (test fixture).\n",
            encoding="utf-8",
        )
        # Without allow-list -> exit 1.
        rc = pr_check.main(["--body-file", str(body)])
        assert rc == pr_check.EXIT_HITS_FOUND
        # With allow-list including #999 -> exit 0.
        rc = pr_check.main(
            [
                "--body-file",
                str(body),
                "--allow-known-false-positives",
                "999",
            ]
        )
        assert rc == pr_check.EXIT_OK

    def test_allow_list_comma_and_repeat(self, tmp_path):
        body = tmp_path / "body.md"
        body.write_text(
            "Intentionally not Closes #100 and not Closes #200.\n",
            encoding="utf-8",
        )
        # Single comma list.
        rc = pr_check.main(
            [
                "--body-file",
                str(body),
                "--allow-known-false-positives",
                "100,200",
            ]
        )
        assert rc == pr_check.EXIT_OK
        # Repeated flag.
        rc = pr_check.main(
            [
                "--body-file",
                str(body),
                "--allow-known-false-positives",
                "100",
                "--allow-known-false-positives",
                "200",
            ]
        )
        assert rc == pr_check.EXIT_OK


# ---------------------------------------------------------------------------
# --commits-file offline mode
# ---------------------------------------------------------------------------


class TestCommitsFileOfflineMode:
    def test_commits_file_with_negation_hit_exits_one(self, tmp_path):
        commits = tmp_path / "commits.txt"
        commits.write_text(
            "feat: gate land.\n\nDOES NOT CLOSE #734 (umbrella).\n--END--\n"
            "chore: minor.\n\nFollow-up.\n",
            encoding="utf-8",
        )
        rc = pr_check.main(["--commits-file", str(commits)])
        assert rc == pr_check.EXIT_HITS_FOUND

    def test_commits_file_clean_exits_zero(self, tmp_path):
        commits = tmp_path / "commits.txt"
        commits.write_text(
            "feat: gate land.\n\nRefs #734 (umbrella).\n--END--\n",
            encoding="utf-8",
        )
        rc = pr_check.main(["--commits-file", str(commits)])
        assert rc == pr_check.EXIT_OK
