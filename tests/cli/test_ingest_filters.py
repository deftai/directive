"""tests/cli/test_ingest_filters.py -- label/author ingest scoping (#1033 + #1055).

The triage ingest surface (``scm:issue:list``, ``cache:fetch-all``,
``triage:bootstrap``) historically pulled the entire open backlog. #1033
(filter by label) and #1055 (filter by author) add scoping that composes
with AND semantics. This module pins the ``cache:fetch-all`` surface --
both the :func:`cache.cache_fetch_all` Python entrypoint and the CLI
``fetch-all`` argument plumbing -- for the three cases the combined
carrier closes: label-only, author-only, and combined.

The companion surfaces are covered alongside their existing suites:

- ``scm:issue:list --rest`` (#1033/#1055) -> ``tests/test_scm_rest.py``
- ``rest_issue_list`` / ``rest_issue_list_paginated`` argv -> ``tests/cli/test_gh_rest.py``
- ``run_fetch_all`` lister threading -> ``tests/test_cache_fetch.py``
- ``triage:bootstrap`` -> ``tests/test_triage_bootstrap.py``

Hermetic: ``run_fetch_all`` (the REST enumeration driver) is monkeypatched
so no network / gh process is touched.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

cache = importlib.import_module("cache")


def _fake_report() -> SimpleNamespace:
    """Minimal stand-in for FetchAllReport (only the attrs _cmd_fetch_all uses)."""
    return SimpleNamespace(to_json=lambda: "{}", failed=0)


def _patch_run_fetch_all(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
) -> None:
    """Capture the kwargs cache_fetch_all forwards to run_fetch_all."""

    def fake_run_fetch_all(**kwargs: Any) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace(
            issues_written=0, already_fresh=0, issues_failed=0, failures=[]
        )

    monkeypatch.setattr(cache, "run_fetch_all", fake_run_fetch_all)


# ---------------------------------------------------------------------------
# cache.cache_fetch_all() Python entrypoint
# ---------------------------------------------------------------------------


class TestCacheFetchAllFilters:
    def test_label_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}
        _patch_run_fetch_all(monkeypatch, captured)
        cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            labels=("adoption-blocker",),
        )
        assert captured["labels"] == ("adoption-blocker",)
        assert captured["author"] is None

    def test_author_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}
        _patch_run_fetch_all(monkeypatch, captured)
        cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            author="octocat",
        )
        assert captured["author"] == "octocat"
        assert captured["labels"] == ()

    def test_label_and_author_compose(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}
        _patch_run_fetch_all(monkeypatch, captured)
        cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            labels=("bug", "p0"),
            author="octocat",
        )
        assert captured["labels"] == ("bug", "p0")
        assert captured["author"] == "octocat"

    def test_default_no_filters(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}
        _patch_run_fetch_all(monkeypatch, captured)
        cache.cache_fetch_all(source="github-issue", repo="deftai/directive")
        assert captured["labels"] == ()
        assert captured["author"] is None


# ---------------------------------------------------------------------------
# _normalise_label_filter (repeated + comma-separated flattening)
# ---------------------------------------------------------------------------


class TestNormaliseLabelFilter:
    def test_none_returns_empty(self) -> None:
        assert cache._normalise_label_filter(None) == ()

    def test_empty_list_returns_empty(self) -> None:
        assert cache._normalise_label_filter([]) == ()

    def test_single_value(self) -> None:
        assert cache._normalise_label_filter(["bug"]) == ("bug",)

    def test_comma_separated_split(self) -> None:
        assert cache._normalise_label_filter(["bug,p0"]) == ("bug", "p0")

    def test_repeated_and_comma_compose(self) -> None:
        assert cache._normalise_label_filter(["bug,p0", "enhancement"]) == (
            "bug",
            "p0",
            "enhancement",
        )

    def test_whitespace_and_blanks_dropped(self) -> None:
        assert cache._normalise_label_filter([" bug , ", "", "p0"]) == (
            "bug",
            "p0",
        )


# ---------------------------------------------------------------------------
# CLI fetch-all argument plumbing (--label / --author)
# ---------------------------------------------------------------------------


class TestFetchAllCli:
    def _patch_cache_fetch_all(
        self, monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
    ) -> None:
        def fake_fetch_all(**kwargs: Any) -> SimpleNamespace:
            captured.update(kwargs)
            return _fake_report()

        monkeypatch.setattr(cache, "cache_fetch_all", fake_fetch_all)

    def test_cli_label_repeated_and_comma(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}
        self._patch_cache_fetch_all(monkeypatch, captured)
        rc = cache.main([
            "fetch-all",
            "--source", "github-issue",
            "--repo", "deftai/directive",
            "--label", "bug,p0",
            "--label", "enhancement",
        ])
        assert rc == 0
        assert captured["labels"] == ("bug", "p0", "enhancement")
        assert captured["author"] is None

    def test_cli_author(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}
        self._patch_cache_fetch_all(monkeypatch, captured)
        rc = cache.main([
            "fetch-all",
            "--source", "github-issue",
            "--repo", "deftai/directive",
            "--author", "octocat",
        ])
        assert rc == 0
        assert captured["author"] == "octocat"
        assert captured["labels"] == ()

    def test_cli_label_and_author_compose(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}
        self._patch_cache_fetch_all(monkeypatch, captured)
        rc = cache.main([
            "fetch-all",
            "--source", "github-issue",
            "--repo", "deftai/directive",
            "--label", "bug",
            "--author", "octocat",
        ])
        assert rc == 0
        assert captured["labels"] == ("bug",)
        assert captured["author"] == "octocat"

    def test_cli_default_no_filters(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}
        self._patch_cache_fetch_all(monkeypatch, captured)
        rc = cache.main([
            "fetch-all",
            "--source", "github-issue",
            "--repo", "deftai/directive",
        ])
        assert rc == 0
        assert captured["labels"] == ()
        assert captured["author"] is None
