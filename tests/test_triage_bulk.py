"""Tests for scripts/triage_bulk.py (#883 Story 3 rebind onto cache:*).

Covers:

- ``bulk_action`` filter semantics (label, age-days, AND combinations).
- Zero-match clean exit.
- ``list_cached_candidates`` walks the unified
  ``.deft-cache/github-issue/<owner>/<repo>/<N>/`` layout, calls
  ``cache.cache_get`` for every key, and tolerates missing / malformed
  cache entries.
- Empty-cache hard-fail (``CacheEmptyError`` -> exit 2).
- Audit-log skip semantics (terminal records ALWAYS short-circuit;
  in-progress records short-circuit unless ``re_action=True``).

A fake ``cache`` module is injected via ``cache_module=`` so tests do
not depend on the real :mod:`scripts.cache` import path or on disk
side-effects beyond the per-test ``tmp_path``. ``triage_actions`` and
``candidates_log`` are stubbed via ``actions_module=`` /
``candidates_log_module=`` for the same reason.
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

triage_bulk = importlib.import_module("triage_bulk")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _issue(
    number: int,
    *,
    labels: list[str] | None = None,
    author: str = "octocat",
    days_old: int = 0,
) -> dict[str, object]:
    """Build a minimal cached-issue payload."""

    created = datetime.now(UTC) - timedelta(days=days_old)
    return {
        "number": number,
        "title": f"Issue {number}",
        "body": "",
        "state": "open",
        "labels": [{"name": name} for name in (labels or [])],
        "author": {"login": author},
        "createdAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedAt": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": f"https://github.com/deftai/directive/issues/{number}",
    }


@pytest.fixture
def stub_actions_module() -> SimpleNamespace:
    """A namespace-shaped stub of Story 3's ``triage_actions``."""

    calls: list[tuple[str, int, str, dict[str, object]]] = []

    def _record(name: str):
        def _fn(n: int, repo: str, **kwargs: object) -> None:
            calls.append((name, n, repo, kwargs))

        return _fn

    return SimpleNamespace(
        accept=_record("accept"),
        reject=_record("reject"),
        defer=_record("defer"),
        needs_ac=_record("needs-ac"),
        calls=calls,
    )


@pytest.fixture
def empty_audit_log() -> SimpleNamespace:
    """A namespace stub of ``candidates_log`` with an empty ``read_all``."""

    return SimpleNamespace(read_all=lambda **_kw: [])


def _audit_log_with(*entries: dict[str, Any]) -> SimpleNamespace:
    """Build a ``candidates_log`` stub whose ``read_all`` yields ``entries``."""

    return SimpleNamespace(read_all=lambda **_kw: list(entries))


def _audit_entry(
    issue_number: int,
    decision: str,
    *,
    timestamp: str = "2026-05-05T10:00:00Z",
    repo: str = "deftai/directive",
) -> dict[str, Any]:
    """Build a minimal audit-log entry of the shape ``read_all`` yields."""

    return {
        "decision_id": "00000000-0000-0000-0000-000000000000",
        "timestamp": timestamp,
        "repo": repo,
        "issue_number": issue_number,
        "decision": decision,
        "actor": "agent:test",
    }


def _populate_cache_layout(
    cache_root: Path,
    repo: str,
    payloads: dict[int, dict[str, Any]],
    *,
    fetched_at: str = "2026-05-05T00:00:00Z",
) -> None:
    """Write the unified-cache layout for ``repo`` under ``cache_root``."""

    owner, name = repo.split("/", 1)
    base = cache_root / "github-issue" / owner / name
    base.mkdir(parents=True, exist_ok=True)
    for n, payload in payloads.items():
        entry_dir = base / str(n)
        entry_dir.mkdir(parents=True, exist_ok=True)
        (entry_dir / "raw.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )
        meta = {
            "source": "github-issue",
            "key": f"{repo}/{n}",
            "fetched_at": fetched_at,
            "ttl_seconds": 7 * 24 * 60 * 60,
            "expires_at": "2099-01-01T00:00:00Z",
            "scan_result": {
                "passed": True,
                "scanned_at": fetched_at,
                "scanner_version": "2.0.0",
                "flags": [],
            },
            "size_bytes": len(json.dumps(payload)),
            "stale": False,
        }
        (entry_dir / "meta.json").write_text(
            json.dumps(meta), encoding="utf-8"
        )


class _NotFoundError(KeyError):
    pass


class _ValidationError(ValueError):
    pass


class _CacheError(RuntimeError):
    pass


def _build_fake_cache_module(cache_root: Path) -> SimpleNamespace:
    """Build a minimal fake ``cache`` module that walks the on-disk layout."""

    def cache_get(
        source: str,
        key: str,
        *,
        cache_root: Path | None = None,
        allow_stale: bool = True,
    ) -> SimpleNamespace:
        owner, repo, n = key.split("/")
        edir = (cache_root or Path(".deft-cache")) / source / owner / repo / n
        meta_path = edir / "meta.json"
        if not meta_path.exists():
            raise _NotFoundError(f"no meta.json at {meta_path}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return SimpleNamespace(
            source=source,
            key=key,
            entry_dir=edir,
            meta=meta,
            content_path=None,
            stale=False,
        )

    return SimpleNamespace(
        cache_get=cache_get,
        CacheNotFoundError=_NotFoundError,
        CacheValidationError=_ValidationError,
        CacheError=_CacheError,
    )


# ---------------------------------------------------------------------------
# bulk_action filter semantics (preserves #845 Story 4 behavior)
# ---------------------------------------------------------------------------


def test_bulk_accept_filters_by_label(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    issues = [
        _issue(101, labels=["triage", "bug"]),
        _issue(102, labels=["enhancement"]),
        _issue(103, labels=["bug"]),
    ]
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="bug",
        actions_module=stub_actions_module,
        candidates_log_module=empty_audit_log,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 2
    assert sorted(call[1] for call in stub_actions_module.calls) == [101, 103]
    assert {call[0] for call in stub_actions_module.calls} == {"accept"}
    assert "[triage:bulk-accept] total: 2" in out.getvalue()


def test_bulk_accept_combined_label_and_age_days(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    issues = [
        _issue(201, labels=["bug"], days_old=10),
        _issue(202, labels=["bug"], days_old=2),
        _issue(203, labels=["docs"], days_old=30),
        _issue(204, labels=["bug", "p0"], days_old=15),
    ]

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="bug",
        age_days=7,
        actions_module=stub_actions_module,
        candidates_log_module=empty_audit_log,
        issues_provider=lambda _repo: issues,
        out=io.StringIO(),
    )

    assert actioned == 2
    assert sorted(call[1] for call in stub_actions_module.calls) == [201, 204]


def test_bulk_action_zero_match_clean_exit(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    issues = [_issue(301, labels=["docs"])]
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "accept",
        "deftai/directive",
        label="nonexistent-label",
        actions_module=stub_actions_module,
        candidates_log_module=empty_audit_log,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 0
    assert stub_actions_module.calls == []
    assert "[triage:bulk-accept] zero matches for given filters" in out.getvalue()


# ---------------------------------------------------------------------------
# list_cached_candidates -- new cache:get walk
# ---------------------------------------------------------------------------


def test_list_cached_candidates_returns_empty_on_missing_dir(tmp_path: Path) -> None:
    """Missing cache layout -> empty list (caller maps to hard-fail)."""

    fake_cache = _build_fake_cache_module(tmp_path / "nonexistent")
    out = triage_bulk.list_cached_candidates(
        "deftai/directive",
        cache_root=tmp_path / "nonexistent",
        cache_module=fake_cache,
        out=io.StringIO(),
    )
    assert out == []


def test_list_cached_candidates_consumes_cache_get(tmp_path: Path) -> None:
    """Populated cache -> cache_get is called for every key, payloads returned."""

    cache_root = tmp_path / ".deft-cache"
    payloads = {11: _issue(11, labels=["bug"]), 22: _issue(22, labels=["docs"])}
    _populate_cache_layout(cache_root, "deftai/directive", payloads)

    fake_cache = _build_fake_cache_module(cache_root)
    seen_keys: list[str] = []
    original_get = fake_cache.cache_get

    def _spy(source: str, key: str, **kwargs: Any):
        seen_keys.append(key)
        return original_get(source, key, **kwargs)

    fake_cache.cache_get = _spy

    sink = io.StringIO()
    out = triage_bulk.list_cached_candidates(
        "deftai/directive",
        cache_root=cache_root,
        cache_module=fake_cache,
        out=sink,
    )

    assert sorted(item["number"] for item in out) == [11, 22]
    # Both keys went through cache:get -- the new contract is that cache:get
    # is the read path, not a flat sidecar walk.
    assert sorted(seen_keys) == [
        "deftai/directive/11",
        "deftai/directive/22",
    ]
    assert "WARN" not in sink.getvalue()


def test_list_cached_candidates_tolerates_invalid_raw_json(tmp_path: Path) -> None:
    """A malformed raw.json is logged and skipped; valid entries still surface."""

    cache_root = tmp_path / ".deft-cache"
    payloads = {1: _issue(1), 4: _issue(4)}
    _populate_cache_layout(cache_root, "deftai/directive", payloads)

    # Insert a malformed raw.json + a non-dict raw.json.
    bad_root = cache_root / "github-issue" / "deftai" / "directive"
    for n, contents in ((2, "{not valid json"), (3, "[1, 2, 3]")):
        edir = bad_root / str(n)
        edir.mkdir(parents=True, exist_ok=True)
        (edir / "raw.json").write_text(contents, encoding="utf-8")
        meta = {
            "source": "github-issue",
            "key": f"deftai/directive/{n}",
            "fetched_at": "2026-05-05T00:00:00Z",
            "ttl_seconds": 86400,
            "expires_at": "2099-01-01T00:00:00Z",
            "scan_result": {
                "passed": True,
                "scanned_at": "2026-05-05T00:00:00Z",
                "scanner_version": "2.0.0",
                "flags": [],
            },
            "size_bytes": len(contents),
            "stale": False,
        }
        (edir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    sink = io.StringIO()
    fake_cache = _build_fake_cache_module(cache_root)
    out = triage_bulk.list_cached_candidates(
        "deftai/directive",
        cache_root=cache_root,
        cache_module=fake_cache,
        out=sink,
    )

    assert sorted(item["number"] for item in out) == [1, 4]
    rendered = sink.getvalue()
    assert "deftai/directive/2" in rendered
    assert "deftai/directive/3" in rendered
    assert "WARN" in rendered


# ---------------------------------------------------------------------------
# Empty-cache hard-fail (#915 invariant preserved post-rebind)
# ---------------------------------------------------------------------------


def test_bulk_action_raises_cache_empty_on_no_candidates(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    with pytest.raises(
        triage_bulk.CacheEmptyError, match="cache is empty for deftai/directive"
    ):
        triage_bulk.bulk_action(
            "defer",
            "deftai/directive",
            actions_module=stub_actions_module,
            candidates_log_module=empty_audit_log,
            issues_provider=lambda _repo: [],
        )


def test_main_empty_cache_returns_exit_2(
    stub_actions_module: SimpleNamespace,
    empty_audit_log: SimpleNamespace,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "triage_actions", stub_actions_module)
    monkeypatch.setitem(sys.modules, "candidates_log", empty_audit_log)
    monkeypatch.setattr(
        triage_bulk, "list_cached_candidates", lambda *_a, **_kw: []
    )

    rc = triage_bulk.main(["defer", "--repo", "deftai/directive"])
    assert rc == 2
    captured = capsys.readouterr()
    assert "cache is empty for deftai/directive" in captured.err
    assert "task triage:bootstrap" in captured.err


# ---------------------------------------------------------------------------
# Audit-log skip semantics (#915 invariants preserved)
# ---------------------------------------------------------------------------


def test_bulk_skips_issues_with_terminal_audit_records(
    stub_actions_module: SimpleNamespace,
) -> None:
    issues = [_issue(401), _issue(402), _issue(403)]
    audit = _audit_log_with(
        _audit_entry(401, "accept"),
        _audit_entry(402, "reject"),
    )
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 1
    assert sorted(call[1] for call in stub_actions_module.calls) == [403]
    assert "skipped 2 candidate(s) with prior audit-log records" in out.getvalue()


def test_bulk_skips_in_progress_records_without_re_action(
    stub_actions_module: SimpleNamespace,
) -> None:
    issues = [_issue(501), _issue(502), _issue(503)]
    audit = _audit_log_with(
        _audit_entry(501, "defer"),
        _audit_entry(502, "needs-ac"),
    )
    out = io.StringIO()

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=out,
    )

    assert actioned == 1
    assert sorted(call[1] for call in stub_actions_module.calls) == [503]
    assert "pass --re-action to override defer/needs-ac records" in out.getvalue()


def test_bulk_re_action_overrides_in_progress_but_not_terminal(
    stub_actions_module: SimpleNamespace,
) -> None:
    issues = [_issue(601), _issue(602), _issue(603), _issue(604)]
    audit = _audit_log_with(
        _audit_entry(601, "defer"),
        _audit_entry(602, "needs-ac"),
        _audit_entry(603, "accept"),  # terminal -- still skipped
    )

    actioned = triage_bulk.bulk_action(
        "defer",
        "deftai/directive",
        re_action=True,
        actions_module=stub_actions_module,
        candidates_log_module=audit,
        issues_provider=lambda _repo: issues,
        out=io.StringIO(),
    )

    assert actioned == 3
    assert sorted(call[1] for call in stub_actions_module.calls) == [601, 602, 604]


# ---------------------------------------------------------------------------
# argparse + signature-mismatch fallback
# ---------------------------------------------------------------------------


def test_argparse_accepts_re_action_flag(
    stub_actions_module: SimpleNamespace,
    empty_audit_log: SimpleNamespace,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "triage_actions", stub_actions_module)
    monkeypatch.setitem(sys.modules, "candidates_log", empty_audit_log)
    monkeypatch.setattr(
        triage_bulk,
        "list_cached_candidates",
        lambda *_a, **_kw: [_issue(1, labels=["bug"])],
    )

    rc = triage_bulk.main(
        ["defer", "--repo", "deftai/directive", "--label", "bug", "--re-action"]
    )
    assert rc == 0


def test_invoke_action_propagates_typeerror_from_action_body(
    stub_actions_module: SimpleNamespace, empty_audit_log: SimpleNamespace
) -> None:
    def _broken_accept(_n: int, _repo: str, **_kwargs: object) -> None:
        raise TypeError("unsupported operand type(s) for +: 'int' and 'str'")

    stub_actions_module.accept = _broken_accept
    issues = [_issue(1, labels=["bug"])]

    with pytest.raises(TypeError, match="unsupported operand"):
        triage_bulk.bulk_action(
            "accept",
            "deftai/directive",
            label="bug",
            actions_module=stub_actions_module,
            candidates_log_module=empty_audit_log,
            issues_provider=lambda _repo: issues,
            out=io.StringIO(),
        )


# ---------------------------------------------------------------------------
# Skip-set helper (pure function)
# ---------------------------------------------------------------------------


def test_build_skip_set_default_includes_terminal_and_in_progress() -> None:
    skip = triage_bulk._build_skip_set(False)
    assert skip == {"accept", "reject", "mark-duplicate", "defer", "needs-ac"}


def test_build_skip_set_re_action_excludes_in_progress() -> None:
    skip = triage_bulk._build_skip_set(True)
    assert skip == {"accept", "reject", "mark-duplicate"}
    assert "defer" not in skip
    assert "needs-ac" not in skip
