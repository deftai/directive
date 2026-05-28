"""test_swarm_verify_review_clean.py -- Tests for scripts/swarm_verify_review_clean.py (#1364).

Covers the five acceptance paths from the vBRIEF:
- all-clean cohort exits 0 with "COHORT CLEAN"
- confidence=3 holdout (one PR) exits 1 with per-PR diagnostics
- SHA-stale HEAD (one PR) exits 1
- Greptile-errored sentinel exits 1
- empty cohort / malformed config exits 2

The script re-uses ``scripts/pr_merge_readiness.py`` for the per-PR parser
and gate. We exercise the cohort-level glue by patching the three fetch
functions in the loaded ``pr_merge_readiness`` module so the same test
fixtures the merge-readiness test suite uses (clean / findings bodies)
can drive the cohort verdict without hitting the real ``gh`` CLI.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    # Importing pr_merge_readiness first puts it into sys.modules so the
    # script under test resolves the same module object the tests patch.
    if "pr_merge_readiness" not in sys.modules:
        mr_spec = importlib.util.spec_from_file_location(
            "pr_merge_readiness",
            scripts_dir / "pr_merge_readiness.py",
        )
        assert mr_spec is not None and mr_spec.loader is not None
        mr_module = importlib.util.module_from_spec(mr_spec)
        sys.modules["pr_merge_readiness"] = mr_module
        mr_spec.loader.exec_module(mr_module)
    spec = importlib.util.spec_from_file_location(
        "swarm_verify_review_clean",
        scripts_dir / "swarm_verify_review_clean.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["swarm_verify_review_clean"] = module
    spec.loader.exec_module(module)
    return module


svrc = _load_module()
mr = sys.modules["pr_merge_readiness"]


# ---------------------------------------------------------------------------
# Greptile body fixtures (mirror the per-PR test fixtures so the two
# suites can co-evolve)
# ---------------------------------------------------------------------------


def _clean_body(sha: str = "abc1234567890def1234567890abcdef12345678", confidence: int = 5) -> str:
    return (
        "## Greptile Summary\n"
        "\n"
        "No P0 or P1 issues found in this PR.\n"
        "\n"
        f"**Confidence Score: {confidence}/5**\n"
        "\n"
        f"Last reviewed commit: [chore: small fix](https://github.com/deftai/directive/commit/{sha})\n"
    )


def _findings_body(sha: str, confidence: int, p0: int = 0, p1: int = 0, p2: int = 0) -> str:
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


def _errored_body() -> str:
    return "Greptile encountered an error while reviewing this PR"


# ---------------------------------------------------------------------------
# Per-PR fetch patching helper
# ---------------------------------------------------------------------------


def _patch_fetchers(monkeypatch, per_pr: dict[int, tuple[str, str]]):
    """Patch fetch_pr_head_sha / fetch_greptile_comment_body in ``pr_merge_readiness``
    to return canned (head_sha, body) tuples per PR number.

    ``per_pr`` maps PR number -> (head_sha, comment_body). Any PR not in
    the map raises AssertionError so a test mistake surfaces immediately
    rather than as a misleading "External error" exit.
    """

    def fake_head(pr_number: int, repo: str | None) -> str | None:
        assert pr_number in per_pr, f"unexpected PR #{pr_number} fetched"
        head, _ = per_pr[pr_number]
        return head

    def fake_body(pr_number: int, repo: str | None) -> str | None:
        assert pr_number in per_pr, f"unexpected PR #{pr_number} fetched"
        _, body = per_pr[pr_number]
        return body

    monkeypatch.setattr(mr, "fetch_pr_head_sha", fake_head)
    monkeypatch.setattr(mr, "fetch_greptile_comment_body", fake_body)
    # The script captured references at import time as default kwargs;
    # patch the module's exported names AND the captured defaults on
    # ``evaluate_pr`` so both surfaces stay in lockstep.
    monkeypatch.setattr(svrc, "_mr", mr)


# ---------------------------------------------------------------------------
# main() -- the integration surface tests should exercise
# ---------------------------------------------------------------------------


class TestMainAllClean:
    def test_all_clean_cohort_exits_0(self, monkeypatch, capsys):
        sha_a = "a" * 40
        sha_b = "b" * 40
        _patch_fetchers(
            monkeypatch,
            {
                1370: (sha_a, _clean_body(sha=sha_a, confidence=5)),
                1371: (sha_b, _clean_body(sha=sha_b, confidence=4)),
            },
        )
        rc = svrc.main(["1370", "1371", "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_OK
        out = capsys.readouterr().out
        assert "COHORT CLEAN" in out
        assert "PR #1370 -- CLEAN" in out
        assert "PR #1371 -- CLEAN" in out

    def test_all_clean_json_emits_all_clean_true(self, monkeypatch, capsys):
        sha = "c" * 40
        _patch_fetchers(monkeypatch, {1372: (sha, _clean_body(sha=sha, confidence=5))})
        rc = svrc.main(["1372", "--repo", "deftai/directive", "--json"])
        assert rc == svrc.EXIT_OK
        payload = json.loads(capsys.readouterr().out)
        assert payload["all_clean"] is True
        assert payload["pr_count"] == 1
        assert payload["pr_results"][0]["pr_number"] == 1372
        assert payload["pr_results"][0]["clean"] is True


class TestMainConfidenceHoldout:
    def test_confidence_3_holdout_blocks_cohort(self, monkeypatch, capsys):
        # The exact failure mode from the #1364 recurrence: every poller
        # reported back, but one PR landed at confidence=3 instead of >3.
        sha_a = "a" * 40
        sha_b = "b" * 40
        _patch_fetchers(
            monkeypatch,
            {
                1370: (sha_a, _clean_body(sha=sha_a, confidence=5)),
                1371: (sha_b, _findings_body(sha=sha_b, confidence=3, p2=1)),
            },
        )
        rc = svrc.main(["1370", "1371", "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_UNCLEAN
        out = capsys.readouterr().out
        assert "COHORT BLOCKED" in out
        assert "PR #1370 -- CLEAN" in out
        assert "PR #1371 -- UNCLEAN" in out
        assert "confidence is 3/5" in out


class TestMainShaStale:
    def test_stale_sha_blocks_cohort(self, monkeypatch, capsys):
        # The reviewed-but-stale path: HEAD advanced past Greptile's last
        # review SHA. The per-PR gate raises "Review is stale", and the
        # cohort gate MUST propagate it (do NOT promote partial freshness
        # to clean).
        head_sha = "a" * 40
        stale_sha = "b" * 40
        _patch_fetchers(
            monkeypatch,
            {1370: (head_sha, _clean_body(sha=stale_sha, confidence=5))},
        )
        rc = svrc.main(["1370", "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_UNCLEAN
        out = capsys.readouterr().out
        assert "COHORT BLOCKED" in out
        assert "Review is stale" in out


class TestMainErrored:
    def test_errored_sentinel_blocks_cohort(self, monkeypatch, capsys):
        sha = "a" * 40
        _patch_fetchers(monkeypatch, {1370: (sha, _errored_body())})
        rc = svrc.main(["1370", "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_UNCLEAN
        out = capsys.readouterr().out
        assert "COHORT BLOCKED" in out
        assert "ERRORED state" in out

    def test_no_greptile_body_blocks_cohort(self, monkeypatch, capsys):
        # No Greptile comment yet -- the gate must NOT promote silence to
        # clean.
        sha = "a" * 40
        _patch_fetchers(monkeypatch, {1370: (sha, "")})
        rc = svrc.main(["1370", "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_UNCLEAN
        assert "COHORT BLOCKED" in capsys.readouterr().out


class TestMainConfigError:
    def test_empty_cohort_exits_2(self, monkeypatch, capsys):
        rc = svrc.main(["--repo", "deftai/directive"])
        assert rc == svrc.EXIT_EXTERNAL_ERROR
        err = capsys.readouterr().err
        assert "empty cohort" in err

    def test_empty_cohort_json_exits_2(self, capsys):
        rc = svrc.main(["--repo", "deftai/directive", "--json"])
        assert rc == svrc.EXIT_EXTERNAL_ERROR
        payload = json.loads(capsys.readouterr().out)
        assert payload["pr_count"] == 0
        assert payload["all_clean"] is False

    def test_external_error_propagates_exit_2(self, monkeypatch, capsys):
        # gh fetch fails (returns None head_sha) -- propagate as
        # external-error, not as MERGE-BLOCKED on stale state.
        def boom_head(*_a, **_kw):
            return None

        monkeypatch.setattr(mr, "fetch_pr_head_sha", boom_head)
        rc = svrc.main(["1370", "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_EXTERNAL_ERROR

    def test_unreadable_vbrief_glob_records_resolution_error(self, tmp_path, capsys):
        bad = tmp_path / "broken.vbrief.json"
        bad.write_text("{not json", encoding="utf-8")
        rc = svrc.main(
            ["--cohort", str(bad), "--repo", "deftai/directive", "--json"]
        )
        # No PRs resolved -> empty cohort -> exit 2.
        assert rc == svrc.EXIT_EXTERNAL_ERROR
        payload = json.loads(capsys.readouterr().out)
        assert payload["pr_count"] == 0
        assert any("unreadable" in e["reason"] for e in payload["resolution_errors"])

    def test_glob_no_match_records_resolution_error(self, tmp_path, capsys):
        # Glob matches nothing -> structured resolution error -> exit 2.
        nowhere = tmp_path / "does-not-exist-*.vbrief.json"
        rc = svrc.main(
            ["--cohort", str(nowhere), "--repo", "deftai/directive", "--json"]
        )
        assert rc == svrc.EXIT_EXTERNAL_ERROR
        payload = json.loads(capsys.readouterr().out)
        assert any(
            "matched no files" in e["reason"] for e in payload["resolution_errors"]
        )


# ---------------------------------------------------------------------------
# Cohort discovery from vBRIEF references
# ---------------------------------------------------------------------------


class TestCohortDiscovery:
    def _write_vbrief(self, path: Path, prs: list[int]) -> None:
        refs = [
            {
                "uri": f"https://github.com/deftai/directive/pull/{n}",
                "type": "x-vbrief/github-pr",
                "title": f"PR #{n}",
            }
            for n in prs
        ]
        payload = {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {"title": "test", "status": "running", "items": [], "references": refs},
        }
        path.write_text(json.dumps(payload), encoding="utf-8")

    def test_resolve_cohort_dedupes_across_vbriefs(self, tmp_path):
        a = tmp_path / "2026-01-01-a.vbrief.json"
        b = tmp_path / "2026-01-02-b.vbrief.json"
        self._write_vbrief(a, [1370, 1371])
        self._write_vbrief(b, [1371, 1372])  # 1371 duplicated
        prs, errs = svrc.resolve_cohort_from_vbriefs([str(tmp_path / "*.vbrief.json")])
        assert prs == [1370, 1371, 1372]
        assert errs == []

    def test_resolve_cohort_no_refs_records_error(self, tmp_path):
        empty = tmp_path / "2026-01-01-empty.vbrief.json"
        empty.write_text(
            json.dumps(
                {
                    "vBRIEFInfo": {"version": "0.6"},
                    "plan": {"title": "no PR refs", "status": "running", "items": []},
                }
            ),
            encoding="utf-8",
        )
        prs, errs = svrc.resolve_cohort_from_vbriefs([str(empty)])
        assert prs == []
        assert len(errs) == 1
        assert "no x-vbrief/github-pr" in errs[0].reason

    def test_main_resolves_cohort_from_vbrief_then_evaluates(self, tmp_path, monkeypatch, capsys):
        vb = tmp_path / "2026-01-01-c.vbrief.json"
        self._write_vbrief(vb, [1380])
        sha = "f" * 40
        _patch_fetchers(monkeypatch, {1380: (sha, _clean_body(sha=sha, confidence=5))})
        rc = svrc.main(["--cohort", str(vb), "--repo", "deftai/directive"])
        assert rc == svrc.EXIT_OK
        assert "PR #1380 -- CLEAN" in capsys.readouterr().out
