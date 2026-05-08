"""test_issue_ingest_direct.py -- Direct-import tests for scripts/issue_ingest.py.

Complements tests/cli/test_issue_ingest.py (subprocess-style CLI coverage) by
exercising internal helper functions and error branches that subprocess tests
cannot easily reach (subprocess failures, timeouts, argparse edge cases, bulk
output formatting, repo URL resolution).

These tests raise coverage of scripts/issue_ingest.py from ~76% toward ~95% so
the TOTAL coverage gate (>=85% per pyproject.toml) has headroom for the RC3
Wave 1 PRs (#507-#510).

Part of RC3 prep chore referenced by #506.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_issue_ingest():
    """Load scripts/issue_ingest.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "issue_ingest_direct",
        scripts_dir / "issue_ingest.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issue_ingest = _load_issue_ingest()


# ---------------------------------------------------------------------------
# _resolve_repo_url
# ---------------------------------------------------------------------------


class TestResolveRepoUrl:
    """Exercise all branches of _resolve_repo_url."""

    def test_empty_repo_returns_empty(self):
        assert issue_ingest._resolve_repo_url("") == ""

    def test_http_url_returned_stripped(self):
        assert (
            issue_ingest._resolve_repo_url("https://github.com/owner/repo/")
            == "https://github.com/owner/repo"
        )

    def test_http_url_without_trailing_slash_preserved(self):
        assert (
            issue_ingest._resolve_repo_url("http://example.com/path")
            == "http://example.com/path"
        )

    def test_owner_repo_pair_becomes_https(self):
        assert (
            issue_ingest._resolve_repo_url("octo/cat")
            == "https://github.com/octo/cat"
        )

    def test_malformed_repo_returns_empty(self):
        """Triple slash breaks OWNER/REPO regex and is not an http URL."""
        assert issue_ingest._resolve_repo_url("a/b/c") == ""

    def test_bare_string_returns_empty(self):
        assert issue_ingest._resolve_repo_url("just-a-word") == ""


# ---------------------------------------------------------------------------
# _fetch_single_issue error branches
# ---------------------------------------------------------------------------


class TestFetchSingleIssue:
    """Exercise subprocess failure modes not covered by the CLI tests."""

    def test_gh_not_found_returns_none(self, monkeypatch, capsys):
        def fake_run(*_args, **_kwargs):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(issue_ingest.subprocess, "run", fake_run)
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        err = capsys.readouterr().err
        assert "gh CLI not found" in err

    def test_gh_timeout_returns_none(self, monkeypatch, capsys):
        def fake_run(*_args, **_kwargs):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=30)

        monkeypatch.setattr(issue_ingest.subprocess, "run", fake_run)
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        assert "timed out" in capsys.readouterr().err

    def test_gh_nonzero_returncode_returns_none(self, monkeypatch, capsys):
        class FakeResult:
            returncode = 1
            stdout = ""
            stderr = "HTTP 404"

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        assert "gh CLI failed" in capsys.readouterr().err

    def test_invalid_json_returns_none(self, monkeypatch, capsys):
        class FakeResult:
            returncode = 0
            stdout = "{not json"
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        assert "failed to parse" in capsys.readouterr().err

    def test_html_url_normalised_to_url(self, monkeypatch):
        """gh api returns ``html_url``; _fetch_single_issue should copy it to url."""
        payload = {"number": 5, "title": "X", "html_url": "https://x/1"}

        class FakeResult:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        issue = issue_ingest._fetch_single_issue("o/r", 5)
        assert issue is not None
        assert issue["url"] == "https://x/1"

    def test_gh_api_shape_prefers_html_url_over_rest_api_url(self, monkeypatch):
        """#639 follow-up (Greptile P1): real ``gh api`` responses always
        carry BOTH ``url`` (REST API URL) AND ``html_url`` (browser URL).
        ``_fetch_single_issue`` MUST prefer ``html_url`` so the canonical
        ``uri`` field ends up as the browser URL required by
        ``conventions/references.md``.
        """
        payload = {
            "number": 7,
            "title": "Y",
            "url": "https://api.github.com/repos/o/r/issues/7",
            "html_url": "https://github.com/o/r/issues/7",
        }

        class FakeResult:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        issue = issue_ingest._fetch_single_issue("o/r", 7)
        assert issue is not None
        # Browser URL wins over REST API URL.
        assert issue["url"] == "https://github.com/o/r/issues/7"

    def test_empty_html_url_does_not_clobber_url(self, monkeypatch):
        """Defensive: an explicitly-empty ``html_url`` must not overwrite an
        otherwise-usable ``url`` field.
        """
        payload = {
            "number": 8,
            "title": "Z",
            "url": "https://github.com/o/r/issues/8",
            "html_url": "",
        }

        class FakeResult:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        issue = issue_ingest._fetch_single_issue("o/r", 8)
        assert issue is not None
        assert issue["url"] == "https://github.com/o/r/issues/8"


# ---------------------------------------------------------------------------
# main() argparse + control-flow branches
# ---------------------------------------------------------------------------


class TestMainCli:
    def test_missing_args_errors(self, tmp_path):
        """Neither issue number nor --all -> argparse error (SystemExit 2)."""
        with pytest.raises(SystemExit) as excinfo:
            issue_ingest.main(["--vbrief-dir", str(tmp_path), "--repo", "o/r"])
        assert excinfo.value.code == 2

    def test_conflicting_args_errors(self, tmp_path):
        """Both issue number and --all -> argparse error."""
        with pytest.raises(SystemExit) as excinfo:
            issue_ingest.main(
                ["5", "--all", "--vbrief-dir", str(tmp_path), "--repo", "o/r"]
            )
        assert excinfo.value.code == 2

    def test_vbrief_dir_created_when_missing(self, tmp_path, monkeypatch):
        """main() creates the vbrief-dir if it does not exist."""
        vbrief_dir = tmp_path / "new_vbrief"
        assert not vbrief_dir.exists()

        monkeypatch.setattr(
            issue_ingest, "_fetch_single_issue",
            lambda _repo, _n, *, cwd=None: {
                "number": 1, "title": "T", "url": "",
            },
        )
        rc = issue_ingest.main(
            ["1", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r"]
        )
        assert rc == 0
        assert vbrief_dir.is_dir()

    def test_no_repo_detected_returns_2(self, tmp_path, monkeypatch, capsys):
        """detect_repo + resolve_project_repo both fail -> exit 2."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        # Stub out BOTH detection paths. resolve_project_repo is called
        # first (#538); without this stub the test running inside the
        # deft worktree would return ``deftai/directive`` and we would
        # never reach the detect_repo fallback.
        monkeypatch.setattr(
            issue_ingest, "resolve_project_repo",
            lambda *_a, **_k: None,
        )
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "")
        rc = issue_ingest.main(["1", "--vbrief-dir", str(vbrief_dir)])
        assert rc == 2
        assert "could not detect repo" in capsys.readouterr().err

    def test_single_issue_success_returns_0(self, tmp_path, monkeypatch, capsys):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        monkeypatch.setattr(
            issue_ingest, "_fetch_single_issue",
            lambda _repo, _n, *, cwd=None: {
                "number": 42, "title": "Do thing",
                "url": "https://github.com/o/r/issues/42",
                "labels": [{"name": "bug"}],
            },
        )
        rc = issue_ingest.main(
            ["42", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r"]
        )
        assert rc == 0
        out = capsys.readouterr().out
        assert "CREATED" in out
        assert list(vbrief_dir.rglob("*.vbrief.json"))

    def test_bulk_mode_prints_summary(self, tmp_path, monkeypatch, capsys):
        """--all branch prints summary + per-entry lines for all three buckets."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        # Pre-seed one duplicate
        (vbrief_dir / "pending").mkdir()
        (vbrief_dir / "pending" / "2026-04-01-2-exists.vbrief.json").write_text(
            json.dumps({
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Exists",
                    "status": "pending",
                    "items": [],
                    "references": [{"type": "github-issue", "id": "#2"}],
                },
            }),
            encoding="utf-8",
        )

        issues = [
            {"number": 1, "title": "New", "url": "", "labels": []},
            {"number": 2, "title": "Dup", "url": "", "labels": []},
        ]
        monkeypatch.setattr(
            issue_ingest, "fetch_open_issues",
            lambda _repo, cwd=None: issues,
        )
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "o/r")

        rc = issue_ingest.main([
            "--all", "--vbrief-dir", str(vbrief_dir),
        ])
        assert rc == 0
        out = capsys.readouterr().out
        assert "bulk summary" in out
        assert "1 created" in out
        assert "1 duplicate" in out
        assert "CREATED" in out
        assert "SKIP" in out

    def test_bulk_mode_dry_run_prints_dryrun_entries(
        self, tmp_path, monkeypatch, capsys
    ):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        issues = [
            {"number": 10, "title": "A", "url": "", "labels": []},
            {"number": 11, "title": "B", "url": "", "labels": []},
        ]
        monkeypatch.setattr(
            issue_ingest, "fetch_open_issues",
            lambda _repo, cwd=None: issues,
        )

        rc = issue_ingest.main([
            "--all", "--dry-run",
            "--vbrief-dir", str(vbrief_dir), "--repo", "o/r",
        ])
        assert rc == 0
        out = capsys.readouterr().out
        assert "2 dry-run" in out
        assert "DRY-RUN" in out
        # No files written because of --dry-run
        assert list(vbrief_dir.rglob("*.vbrief.json")) == []


# ---------------------------------------------------------------------------
# _build_issue_vbrief / _target_filename edge cases
# ---------------------------------------------------------------------------


class TestBuildIssueVbrief:
    def test_issue_without_title_uses_fallback(self):
        vbrief, folder = issue_ingest._build_issue_vbrief(
            {"number": 99, "url": "https://x"}, "pending", ""
        )
        assert vbrief["plan"]["title"] == "Issue #99"
        assert folder == "pending"

    def test_issue_without_url_uses_repo_url_template(self):
        """#639: canonical ``{uri, type, title}`` shape with resolvable URL."""
        vbrief, folder = issue_ingest._build_issue_vbrief(
            {"number": 5, "title": "hi"}, "proposed", "https://github.com/o/r"
        )
        assert vbrief["vBRIEFInfo"]["version"] == "0.6"
        refs = vbrief["plan"]["references"]
        assert refs[0]["uri"] == "https://github.com/o/r/issues/5"
        assert refs[0]["type"] == "x-vbrief/github-issue"
        assert refs[0]["title"] == "Issue #5: hi"
        # Legacy keys MUST NOT leak into canonical output.
        assert "id" not in refs[0]
        assert "url" not in refs[0]
        assert "Ingested from https://github.com/o/r/issues/5" in (
            vbrief["plan"]["narratives"]["Origin"]
        )

    def test_issue_without_url_or_repo_origin_reference_omitted(self):
        """#639: when neither the payload nor ``repo_url`` yields a browser URL,
        no reference is emitted -- ``VBriefReference`` requires ``uri`` and we
        must not forge one. The issue number survives in ``narratives.Origin``.
        """
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 3, "title": "z"}, "proposed", ""
        )
        # references is either absent or empty -- both are honest signals.
        assert vbrief["plan"].get("references", []) == []
        assert vbrief["plan"]["narratives"]["Origin"] == "Ingested from issue #3"
        assert vbrief["vBRIEFInfo"]["version"] == "0.6"

    def test_labels_as_strings_supported(self):
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 2, "title": "t", "labels": ["bug", "p1"]},
            "proposed", "",
        )
        assert vbrief["plan"]["narratives"]["Labels"] == "bug, p1"

    def test_labels_mixed_skips_malformed(self):
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {
                "number": 4,
                "title": "t",
                "labels": [
                    {"name": "keep"},
                    {"no_name": "drop"},  # dict without name -> skipped
                    "plain",
                    None,  # neither dict nor str -> skipped
                ],
            },
            "proposed", "",
        )
        labels = vbrief["plan"]["narratives"]["Labels"].split(", ")
        assert "keep" in labels
        assert "plain" in labels
        assert "drop" not in labels

    def test_target_filename_uses_slug(self):
        name = issue_ingest._target_filename(10, "Refactor the widget code")
        assert name.endswith("-10-refactor-the-widget-code.vbrief.json")

    def test_target_filename_empty_title_falls_back(self):
        name = issue_ingest._target_filename(11, "")
        assert name.endswith("-11-issue-11.vbrief.json")


# ---------------------------------------------------------------------------
# #988 body fidelity -- narratives.Overview + plan.tags
# ---------------------------------------------------------------------------


class TestBodyFidelityAndTags:
    """Cover the #988 contract: body lands in narratives.Overview and labels
    populate the structured plan.tags array.
    """

    def test_body_lands_in_narratives_overview(self):
        """#988: ``plan.narratives.Overview`` MUST equal the issue body verbatim."""
        body = (
            "## Summary\nThis is the canonical body.\n\n"
            "## Acceptance Criteria\n- [ ] does the thing\n"
        )
        vbrief, _folder = issue_ingest._build_issue_vbrief(
            {"number": 12, "title": "T", "body": body, "url": "https://x/12"},
            "proposed",
            "",
        )
        assert vbrief["plan"]["narratives"]["Overview"] == body

    def test_missing_body_omits_overview(self):
        """When the GitHub payload has no body, ``Overview`` is omitted (not
        emitted as an empty string -- that would lie about there being
        content).
        """
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 13, "title": "T"}, "proposed", ""
        )
        assert "Overview" not in vbrief["plan"]["narratives"]

    def test_empty_body_omits_overview(self):
        """An explicit empty-string body is honest about "no content"."""
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 14, "title": "T", "body": ""}, "proposed", ""
        )
        assert "Overview" not in vbrief["plan"]["narratives"]

    def test_plan_tags_populated_from_label_dicts(self):
        """#988: ``plan.tags`` is a structured array of label-name strings."""
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {
                "number": 15,
                "title": "T",
                "labels": [
                    {"name": "bug"},
                    {"name": "adoption-blocker"},
                ],
            },
            "proposed",
            "",
        )
        assert vbrief["plan"]["tags"] == ["bug", "adoption-blocker"]
        # narratives.Labels survives for backward compatibility.
        assert vbrief["plan"]["narratives"]["Labels"] == "bug, adoption-blocker"

    def test_plan_tags_populated_from_string_labels(self):
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 16, "title": "T", "labels": ["alpha", "beta"]},
            "proposed",
            "",
        )
        assert vbrief["plan"]["tags"] == ["alpha", "beta"]

    def test_plan_tags_omitted_when_no_labels(self):
        """No labels -> no ``plan.tags`` key (rather than an empty array)."""
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 17, "title": "T"}, "proposed", ""
        )
        assert "tags" not in vbrief["plan"]

    def test_plan_items_remains_empty_per_988_non_goals(self):
        """#988 Non-goals: section-parsing into ``plan.items`` is explicitly a
        follow-up. ``plan.items`` MUST remain ``[]`` from this fix.
        """
        body = (
            "## Acceptance Criteria\n- [ ] thing one\n- [ ] thing two\n"
        )
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 18, "title": "T", "body": body},
            "proposed",
            "",
        )
        assert vbrief["plan"]["items"] == []


# ---------------------------------------------------------------------------
# #988 cache-first fetch path -- _fetch_from_cache + _fetch_issue
# ---------------------------------------------------------------------------


class TestCachePreference:
    """Cover the #883/#988 contract: a fresh unified-cache hit is preferred
    over a live ``gh api`` round-trip; cache miss / stale falls back to live.
    """

    @staticmethod
    def _seed_cache(tmp_path, repo: str, number: int, raw: dict) -> None:
        """Write a raw.json under the cache root in the shape ``cache.cache_get``
        consumes (the entry dir matches ``entry_dir("github-issue", key)``).
        """
        owner, name = repo.split("/")
        edir = tmp_path / "github-issue" / owner / name / str(number)
        edir.mkdir(parents=True, exist_ok=True)
        (edir / "raw.json").write_text(
            json.dumps(raw, indent=2), encoding="utf-8"
        )

    def test_fetch_from_cache_returns_cached_payload(self, monkeypatch, tmp_path):
        """When a fresh cache hit exists, ``_fetch_from_cache`` returns its
        ``raw.json`` parsed into a dict.
        """
        from types import SimpleNamespace

        raw = {"number": 21, "title": "Cached", "body": "BODY", "url": "https://x/21"}
        self._seed_cache(tmp_path, "o/r", 21, raw)

        def fake_get(source, key, *, cache_root=None, allow_stale=False):
            assert source == "github-issue"
            assert key == "o/r/21"
            assert allow_stale is False
            return SimpleNamespace(
                source=source,
                key=key,
                entry_dir=tmp_path / "github-issue" / "o" / "r" / "21",
                meta={},
                content_path=None,
                stale=False,
            )

        fake_cache = SimpleNamespace(cache_get=fake_get)
        monkeypatch.setattr(issue_ingest, "cache", fake_cache)

        got = issue_ingest._fetch_from_cache("o/r", 21)
        assert got is not None
        assert got["number"] == 21
        assert got["body"] == "BODY"

    def test_fetch_from_cache_returns_none_on_miss(self, monkeypatch):
        """Cache miss -> ``None`` so the wrapper falls back to live fetch."""
        from types import SimpleNamespace

        def fake_get(*_a, **_k):
            raise KeyError("miss")

        monkeypatch.setattr(
            issue_ingest, "cache", SimpleNamespace(cache_get=fake_get)
        )
        assert issue_ingest._fetch_from_cache("o/r", 22) is None

    def test_fetch_from_cache_returns_none_on_stale(self, monkeypatch):
        """Stale entry surfaces as ``CacheNotFoundError`` from cache_get; the
        wrapper swallows and falls back.
        """
        from types import SimpleNamespace

        def fake_get(*_a, **_k):
            # cache.cache_get raises CacheNotFoundError when allow_stale=False
            # AND the entry is stale; from this layer's perspective the only
            # contract is "any error -> live fetch fallback".
            raise RuntimeError("stale")

        monkeypatch.setattr(
            issue_ingest, "cache", SimpleNamespace(cache_get=fake_get)
        )
        assert issue_ingest._fetch_from_cache("o/r", 23) is None

    def test_fetch_from_cache_returns_none_when_cache_module_missing(
        self, monkeypatch
    ):
        """On a slim checkout without ``scripts/cache.py``, ``_fetch_from_cache``
        returns ``None`` cleanly (no AttributeError) so the live-fetch path
        runs.
        """
        monkeypatch.setattr(issue_ingest, "cache", None)
        assert issue_ingest._fetch_from_cache("o/r", 24) is None

    def test_fetch_issue_prefers_cache_over_live(self, monkeypatch, tmp_path):
        """#988: cache hit short-circuits the live ``gh api`` call entirely."""
        from types import SimpleNamespace

        raw = {"number": 30, "title": "Cached", "body": "FROM CACHE", "url": "https://x/30"}
        self._seed_cache(tmp_path, "o/r", 30, raw)

        def fake_get(source, key, *, cache_root=None, allow_stale=False):
            return SimpleNamespace(
                source=source,
                key=key,
                entry_dir=tmp_path / "github-issue" / "o" / "r" / "30",
                meta={},
                content_path=None,
                stale=False,
            )

        called = {"live": False}

        def _spy_live(*_a, **_k):
            called["live"] = True
            return {"number": 999, "title": "LIVE", "body": "LIVE"}

        monkeypatch.setattr(
            issue_ingest, "cache", SimpleNamespace(cache_get=fake_get)
        )
        monkeypatch.setattr(issue_ingest, "_fetch_single_issue", _spy_live)

        got = issue_ingest._fetch_issue("o/r", 30)
        assert got is not None
        assert got["body"] == "FROM CACHE"
        assert called["live"] is False, "live fetch must be skipped on cache hit"

    def test_fetch_issue_falls_back_to_live_on_cache_miss(self, monkeypatch):
        """Cache miss -> live ``gh api`` fetch is invoked."""
        from types import SimpleNamespace

        def fake_get(*_a, **_k):
            raise KeyError("miss")

        monkeypatch.setattr(
            issue_ingest, "cache", SimpleNamespace(cache_get=fake_get)
        )

        called = {"live": False}

        def _spy_live(repo, number, *, cwd=None):
            called["live"] = True
            return {"number": number, "title": "LIVE", "body": "L", "url": "https://x"}

        monkeypatch.setattr(issue_ingest, "_fetch_single_issue", _spy_live)
        got = issue_ingest._fetch_issue("o/r", 31)
        assert called["live"] is True
        assert got is not None
        assert got["body"] == "L"


# ---------------------------------------------------------------------------
# #985 ingest_single_for_accept -- importable Python entry point
# ---------------------------------------------------------------------------


class TestIngestSingleForAccept:
    """Cover the #985 contract: ``ingest_single_for_accept`` writes a vBRIEF
    in ``<project_root>/vbrief/proposed/`` from a fetched issue.
    """

    def test_writes_proposed_vbrief_with_canonical_shape(
        self, monkeypatch, tmp_path
    ):
        """Happy path: a proposed/ vBRIEF is written, carrying body and tags."""

        def _fake_fetch(repo, number, *, cwd=None, cache_root=None):
            return {
                "number": int(number),
                "title": "Triaged Issue",
                "body": "## Summary\nReal body.\n",
                "url": "https://github.com/o/r/issues/100",
                "labels": [{"name": "bug"}, {"name": "p1"}],
            }

        monkeypatch.setattr(issue_ingest, "_fetch_issue", _fake_fetch)

        result, path = issue_ingest.ingest_single_for_accept(
            100, "o/r", project_root=tmp_path
        )
        assert result == "created"
        assert path is not None
        assert path.exists()
        # Path is inside vbrief/proposed/.
        assert path.parent == tmp_path / "vbrief" / "proposed"
        # Filename matches the slug rules from _vbrief_build.slugify.
        assert path.name.endswith("-100-triaged-issue.vbrief.json")

        vbrief = json.loads(path.read_text(encoding="utf-8"))
        assert vbrief["vBRIEFInfo"]["version"] == "0.6"
        plan = vbrief["plan"]
        assert plan["narratives"]["Overview"] == "## Summary\nReal body.\n"
        assert plan["tags"] == ["bug", "p1"]
        # Canonical reference shape (#534/#613/#639).
        ref = plan["references"][0]
        assert ref["uri"] == "https://github.com/o/r/issues/100"
        assert ref["type"] == "x-vbrief/github-issue"
        assert ref["title"] == "Issue #100: Triaged Issue"

    def test_raises_when_fetch_fails(self, monkeypatch, tmp_path):
        """Both cache and live fetch fail -> ``RuntimeError`` so the caller
        (``triage_actions.accept``) can roll the audit entry back.
        """
        monkeypatch.setattr(
            issue_ingest, "_fetch_issue", lambda *_a, **_k: None
        )
        with pytest.raises(RuntimeError, match="failed to fetch GitHub issue"):
            issue_ingest.ingest_single_for_accept(
                404, "o/r", project_root=tmp_path
            )

    def test_returns_duplicate_when_already_ingested(self, monkeypatch, tmp_path):
        """Pre-existing vBRIEF for the issue -> ``ingest_one`` returns
        ``duplicate``; ``ingest_single_for_accept`` propagates that result
        rather than raising.
        """
        # Pre-seed a vBRIEF that references issue #200 in proposed/.
        proposed = tmp_path / "vbrief" / "proposed"
        proposed.mkdir(parents=True, exist_ok=True)
        (proposed / "2026-04-01-200-existing.vbrief.json").write_text(
            json.dumps(
                {
                    "vBRIEFInfo": {"version": "0.6"},
                    "plan": {
                        "title": "Existing",
                        "status": "proposed",
                        "items": [],
                        "references": [
                            {
                                "uri": "https://github.com/o/r/issues/200",
                                "type": "x-vbrief/github-issue",
                                "title": "Issue #200: Existing",
                            }
                        ],
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        def _fake_fetch(repo, number, *, cwd=None, cache_root=None):
            return {"number": int(number), "title": "X", "body": "Y", "url": ""}

        monkeypatch.setattr(issue_ingest, "_fetch_issue", _fake_fetch)

        result, _path = issue_ingest.ingest_single_for_accept(
            200, "o/r", project_root=tmp_path
        )
        assert result == "duplicate"
