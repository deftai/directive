"""tests/test_cache.py -- unit tests for the unified cache layer (#883 Story 2).

Covers:

- :class:`TestSchemaValidation` -- positive + negative cases against
  :func:`cache.validate_meta` (M4 fail-closed contract).
- :class:`TestCachePut` -- atomic write semantics, scanner integration,
  hard-fail/fence-and-pass/strip-and-pass paths, audit log append.
- :class:`TestCacheGet` -- hit / miss / stale flag / --no-stale
  semantic.
- :class:`TestCacheInvalidate` -- delete + audit append; idempotent.
- :class:`TestCacheFetchAll` -- rate-limit retry (M1), skip-fresh
  idempotency (M2), partial-failure exit shape, structured JSON output.
- :class:`TestCachePrune` -- expired-only filter, dry-run, source filter.
- :class:`TestCLI` -- end-to-end argv exit-code contract.
- :class:`TestSchemaAlignment` -- regression guard between the JSON
  schema file and the in-module validator.
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

cache = importlib.import_module("cache")
cache_scanner = importlib.import_module("cache_scanner")
_cache_fetch = importlib.import_module("_cache_fetch")
_cache_validate = importlib.import_module("_cache_validate")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _good_meta(**overrides: Any) -> dict[str, Any]:
    """Return a valid meta.json shape; tests apply targeted overrides."""
    base = {
        "source": "github-issue",
        "key": "deftai/directive/883",
        "fetched_at": "2026-05-05T00:00:00Z",
        "ttl_seconds": 604800,
        "expires_at": "2026-05-12T00:00:00Z",
        "scan_result": {
            "passed": True,
            "scanned_at": "2026-05-05T00:00:00Z",
            "scanner_version": "2.0.0",
            "flags": [],
        },
        "size_bytes": 1024,
        "stale": False,
    }
    base.update(overrides)
    return base


def _good_raw(number: int = 883, body: str = "Plain body.") -> dict[str, Any]:
    return {
        "number": number,
        "title": "feat(cache): test entry",
        "body": body,
        "state": "OPEN",
        "author": {"login": "tester"},
        "createdAt": "2026-05-01T00:00:00Z",
        "updatedAt": "2026-05-05T00:00:00Z",
        "labels": [],
        "comments": [],
        "url": f"https://github.com/deftai/directive/issues/{number}",
    }


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


class TestSchemaValidation:
    """Positive + negative cases for cache.validate_meta (M4 fail-closed contract)."""

    def test_positive_minimal_meta(self) -> None:
        cache.validate_meta(_good_meta())

    def test_positive_with_etag_optional(self) -> None:
        cache.validate_meta(_good_meta(etag='W/"abc123"'))

    def test_positive_with_flags(self) -> None:
        meta = _good_meta()
        meta["scan_result"]["flags"] = [
            {
                "category": "injection-heading",
                "severity": "fence-and-pass",
                "detail": "wrapped 1 occurrence",
                "match_count": 1,
            }
        ]
        cache.validate_meta(meta)

    @pytest.mark.parametrize(
        "missing",
        [
            "source",
            "key",
            "fetched_at",
            "ttl_seconds",
            "expires_at",
            "scan_result",
            "size_bytes",
            "stale",
        ],
    )
    def test_negative_missing_required_top_level(self, missing: str) -> None:
        meta = _good_meta()
        del meta[missing]
        with pytest.raises(_cache_validate.CacheValidationError, match=missing):
            cache.validate_meta(meta)

    def test_negative_unknown_top_level_key(self) -> None:
        with pytest.raises(_cache_validate.CacheValidationError, match="unknown keys"):
            cache.validate_meta(_good_meta(extra_field="boo"))

    @pytest.mark.parametrize(
        "field,bad_value",
        [
            ("source", "github-pr"),  # not in v1 enum
            ("key", ""),  # empty key
            ("ttl_seconds", -1),  # negative
            ("ttl_seconds", "604800"),  # string not int
            ("size_bytes", -10),
            ("stale", "false"),  # string not bool
            ("fetched_at", "not-a-date"),
            ("expires_at", "2026-05-12"),  # missing T + Z
        ],
    )
    def test_negative_top_level_type_errors(self, field: str, bad_value: Any) -> None:
        with pytest.raises(_cache_validate.CacheValidationError):
            cache.validate_meta(_good_meta(**{field: bad_value}))

    def test_negative_scan_result_missing_field(self) -> None:
        meta = _good_meta()
        del meta["scan_result"]["passed"]
        with pytest.raises(_cache_validate.CacheValidationError, match="passed"):
            cache.validate_meta(meta)

    def test_negative_scan_result_unknown_extra(self) -> None:
        meta = _good_meta()
        meta["scan_result"]["foo"] = "bar"
        with pytest.raises(_cache_validate.CacheValidationError, match="foo"):
            cache.validate_meta(meta)

    def test_negative_scanner_version_not_semver(self) -> None:
        meta = _good_meta()
        meta["scan_result"]["scanner_version"] = "v2"
        with pytest.raises(_cache_validate.CacheValidationError, match="SemVer"):
            cache.validate_meta(meta)

    def test_negative_flag_unknown_category(self) -> None:
        meta = _good_meta()
        meta["scan_result"]["flags"] = [
            {"category": "shell-cmd-injection", "severity": "hard-fail", "detail": "x"}
        ]
        with pytest.raises(_cache_validate.CacheValidationError, match="category"):
            cache.validate_meta(meta)

    def test_negative_flag_unknown_severity(self) -> None:
        meta = _good_meta()
        meta["scan_result"]["flags"] = [
            {"category": "credentials", "severity": "warn", "detail": "x"}
        ]
        with pytest.raises(_cache_validate.CacheValidationError, match="severity"):
            cache.validate_meta(meta)

    def test_negative_flag_negative_match_count(self) -> None:
        meta = _good_meta()
        meta["scan_result"]["flags"] = [
            {
                "category": "credentials",
                "severity": "hard-fail",
                "detail": "x",
                "match_count": -1,
            }
        ]
        with pytest.raises(_cache_validate.CacheValidationError, match="match_count"):
            cache.validate_meta(meta)

    def test_negative_root_must_be_object(self) -> None:
        with pytest.raises(_cache_validate.CacheValidationError, match="<root>"):
            cache.validate_meta([])  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# cache.cache_put
# ---------------------------------------------------------------------------


class TestCachePut:
    """Atomic write + scanner integration paths."""

    def test_writes_raw_content_meta_on_clean_body(self, tmp_path: Path) -> None:
        result = cache.cache_put(
            "github-issue",
            "deftai/directive/883",
            _good_raw(),
            cache_root=tmp_path,
        )
        edir = result.entry_dir
        assert (edir / "raw.json").exists()
        assert (edir / "content.md").exists()
        assert (edir / "meta.json").exists()
        assert result.scan_result.passed is True
        assert result.content_written is True
        # meta.json validates against the schema.
        meta = json.loads((edir / "meta.json").read_text(encoding="utf-8"))
        cache.validate_meta(meta)

    def test_hard_fail_skips_content_md(self, tmp_path: Path) -> None:
        body_with_secret = f"oops: AKIA{'A' * 16}"
        result = cache.cache_put(
            "github-issue",
            "deftai/directive/884",
            _good_raw(number=884, body=body_with_secret),
            cache_root=tmp_path,
        )
        edir = result.entry_dir
        assert (edir / "raw.json").exists()
        assert not (edir / "content.md").exists(), (
            "credentials hard-fail must NOT write content.md"
        )
        assert (edir / "meta.json").exists()
        assert result.scan_result.passed is False
        assert result.content_written is False
        meta = json.loads((edir / "meta.json").read_text(encoding="utf-8"))
        assert meta["scan_result"]["passed"] is False
        cats = [f["category"] for f in meta["scan_result"]["flags"]]
        assert "credentials" in cats

    def test_fence_and_pass_writes_wrapped_content(self, tmp_path: Path) -> None:
        body = "## STEP 1\nDo X."
        result = cache.cache_put(
            "github-issue",
            "deftai/directive/885",
            _good_raw(number=885, body=body),
            cache_root=tmp_path,
        )
        content = (result.entry_dir / "content.md").read_text(encoding="utf-8")
        assert "```quarantined" in content
        assert result.scan_result.passed is True

    def test_strip_and_pass_writes_stripped_content(self, tmp_path: Path) -> None:
        body = "hello\u200bworld"  # zero-width space
        result = cache.cache_put(
            "github-issue",
            "deftai/directive/886",
            _good_raw(number=886, body=body),
            cache_root=tmp_path,
        )
        content = (result.entry_dir / "content.md").read_text(encoding="utf-8")
        assert "\u200b" not in content
        assert "helloworld" in content

    def test_audit_log_appended_on_each_put(self, tmp_path: Path) -> None:
        cache.cache_put(
            "github-issue",
            "deftai/directive/887",
            _good_raw(number=887),
            cache_root=tmp_path,
        )
        cache.cache_put(
            "github-issue",
            "deftai/directive/888",
            _good_raw(number=888),
            cache_root=tmp_path,
        )
        audit = (tmp_path / "quarantine-audit.jsonl").read_text(encoding="utf-8")
        lines = [line for line in audit.splitlines() if line.strip()]
        assert len(lines) == 2
        records = [json.loads(line) for line in lines]
        assert all(r["event"] == "cache:put" for r in records)
        keys = [r["key"] for r in records]
        assert "deftai/directive/887" in keys
        assert "deftai/directive/888" in keys

    def test_audit_appended_even_on_hard_fail(self, tmp_path: Path) -> None:
        body = f"AKIA{'A' * 16}"
        cache.cache_put(
            "github-issue",
            "deftai/directive/889",
            _good_raw(number=889, body=body),
            cache_root=tmp_path,
        )
        audit = (tmp_path / "quarantine-audit.jsonl").read_text(encoding="utf-8")
        lines = [line for line in audit.splitlines() if line.strip()]
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record["scan_passed"] is False
        assert record["content_written"] is False

    def test_atomic_write_no_tmp_residue(self, tmp_path: Path) -> None:
        cache.cache_put(
            "github-issue",
            "deftai/directive/890",
            _good_raw(number=890),
            cache_root=tmp_path,
        )
        # No leftover .tmp files in the entry directory.
        edir = cache.entry_dir(
            "github-issue", "deftai/directive/890", cache_root=tmp_path
        )
        leftovers = list(edir.glob("*.tmp"))
        assert leftovers == [], f"unexpected tmp residue: {leftovers!r}"

    def test_invalid_key_raises(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="invalid github-issue key"):
            cache.cache_put(
                "github-issue", "not-a-valid-key", _good_raw(), cache_root=tmp_path
            )

    def test_unknown_source_raises(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="unknown source"):
            cache.cache_put(
                "github-pr", "deftai/directive/1", _good_raw(), cache_root=tmp_path
            )

    def test_negative_ttl_raises(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="ttl_seconds"):
            cache.cache_put(
                "github-issue",
                "deftai/directive/891",
                _good_raw(number=891),
                ttl_seconds=-1,
                cache_root=tmp_path,
            )

    def test_overwrite_clears_prior_content_on_hard_fail(
        self, tmp_path: Path
    ) -> None:
        # First put: clean. Then put a credentials body. The content.md
        # from the first put must be removed so cache:get does not serve
        # safe-but-stale text under a hard-fail entry.
        cache.cache_put(
            "github-issue",
            "deftai/directive/892",
            _good_raw(number=892, body="clean"),
            cache_root=tmp_path,
        )
        edir = cache.entry_dir(
            "github-issue", "deftai/directive/892", cache_root=tmp_path
        )
        assert (edir / "content.md").exists()
        cache.cache_put(
            "github-issue",
            "deftai/directive/892",
            _good_raw(number=892, body=f"AKIA{'A' * 16}"),
            cache_root=tmp_path,
        )
        assert not (edir / "content.md").exists()


# ---------------------------------------------------------------------------
# cache.cache_get
# ---------------------------------------------------------------------------


class TestCacheGet:
    """Hit / miss / stale flag."""

    def test_hit_returns_meta_and_content(self, tmp_path: Path) -> None:
        cache.cache_put(
            "github-issue",
            "deftai/directive/100",
            _good_raw(number=100),
            cache_root=tmp_path,
        )
        result = cache.cache_get(
            "github-issue", "deftai/directive/100", cache_root=tmp_path
        )
        assert result.content_path is not None
        assert result.content_path.exists()
        assert result.stale is False

    def test_miss_raises(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheNotFoundError):
            cache.cache_get(
                "github-issue", "deftai/directive/9999", cache_root=tmp_path
            )

    def test_stale_returned_with_flag_when_allow_stale(self, tmp_path: Path) -> None:
        # Write entry with 0 TTL so it is immediately stale.
        cache.cache_put(
            "github-issue",
            "deftai/directive/101",
            _good_raw(number=101),
            ttl_seconds=0,
            cache_root=tmp_path,
            fetched_at=datetime.now(UTC) - timedelta(days=1),
        )
        result = cache.cache_get(
            "github-issue",
            "deftai/directive/101",
            allow_stale=True,
            cache_root=tmp_path,
        )
        assert result.stale is True

    def test_stale_blocked_when_allow_stale_false(self, tmp_path: Path) -> None:
        cache.cache_put(
            "github-issue",
            "deftai/directive/102",
            _good_raw(number=102),
            ttl_seconds=0,
            cache_root=tmp_path,
            fetched_at=datetime.now(UTC) - timedelta(days=1),
        )
        with pytest.raises(cache.CacheNotFoundError, match="stale"):
            cache.cache_get(
                "github-issue",
                "deftai/directive/102",
                allow_stale=False,
                cache_root=tmp_path,
            )

    def test_get_validates_meta_on_read(self, tmp_path: Path) -> None:
        # Write a deliberately-bad meta.json directly. cache:get must
        # fail-closed (M4) rather than serve corrupt content.
        edir = cache.entry_dir(
            "github-issue", "deftai/directive/103", cache_root=tmp_path
        )
        edir.mkdir(parents=True, exist_ok=True)
        (edir / "meta.json").write_text(
            json.dumps({"source": "github-issue", "key": "x"}),
            encoding="utf-8",
        )
        with pytest.raises(_cache_validate.CacheValidationError):
            cache.cache_get(
                "github-issue", "deftai/directive/103", cache_root=tmp_path
            )

    def test_get_handles_missing_content_md(self, tmp_path: Path) -> None:
        # When scan hard-fails, content.md is absent. cache:get must
        # still return meta + None for content_path.
        body = f"AKIA{'A' * 16}"
        cache.cache_put(
            "github-issue",
            "deftai/directive/104",
            _good_raw(number=104, body=body),
            cache_root=tmp_path,
        )
        result = cache.cache_get(
            "github-issue", "deftai/directive/104", cache_root=tmp_path
        )
        assert result.content_path is None
        assert result.meta["scan_result"]["passed"] is False

    def test_meta_stale_mirrors_get_result_stale_fresh(self, tmp_path: Path) -> None:
        # Regression for #883 Story 2 P2: GetResult.meta["stale"] used to be
        # always False (the on-disk meta.json default), independent of the
        # actual TTL state. cache_get now mirrors the computed staleness
        # onto the in-memory meta dict so meta["stale"] == result.stale.
        cache.cache_put(
            "github-issue",
            "deftai/directive/105",
            _good_raw(number=105),
            cache_root=tmp_path,
        )
        result = cache.cache_get(
            "github-issue", "deftai/directive/105", cache_root=tmp_path
        )
        assert result.stale is False
        assert result.meta["stale"] is False

    def test_meta_stale_mirrors_get_result_stale_expired(
        self, tmp_path: Path
    ) -> None:
        # Regression for #883 Story 2 P2: an entry past its TTL must surface
        # meta["stale"] == True (matching GetResult.stale), not the False
        # value persisted in meta.json at write time.
        cache.cache_put(
            "github-issue",
            "deftai/directive/106",
            _good_raw(number=106),
            ttl_seconds=0,
            cache_root=tmp_path,
            fetched_at=datetime.now(UTC) - timedelta(days=1),
        )
        result = cache.cache_get(
            "github-issue",
            "deftai/directive/106",
            allow_stale=True,
            cache_root=tmp_path,
        )
        assert result.stale is True
        assert result.meta["stale"] is True


# ---------------------------------------------------------------------------
# cache.cache_invalidate
# ---------------------------------------------------------------------------


class TestCacheInvalidate:
    """Delete + audit append; idempotent."""

    def test_invalidate_existing_entry(self, tmp_path: Path) -> None:
        cache.cache_put(
            "github-issue",
            "deftai/directive/200",
            _good_raw(number=200),
            cache_root=tmp_path,
        )
        existed = cache.cache_invalidate(
            "github-issue",
            "deftai/directive/200",
            reason="closed",
            cache_root=tmp_path,
        )
        assert existed is True
        edir = cache.entry_dir(
            "github-issue", "deftai/directive/200", cache_root=tmp_path
        )
        assert not edir.exists()

    def test_invalidate_missing_entry_idempotent(self, tmp_path: Path) -> None:
        existed = cache.cache_invalidate(
            "github-issue",
            "deftai/directive/201",
            cache_root=tmp_path,
        )
        assert existed is False

    def test_invalidate_appends_audit_record(self, tmp_path: Path) -> None:
        cache.cache_invalidate(
            "github-issue",
            "deftai/directive/202",
            reason="manual cleanup",
            cache_root=tmp_path,
        )
        audit = (tmp_path / "quarantine-audit.jsonl").read_text(encoding="utf-8")
        record = json.loads(audit.splitlines()[-1])
        assert record["event"] == "cache:invalidate"
        assert record["reason"] == "manual cleanup"


# ---------------------------------------------------------------------------
# cache.cache_fetch_all
# ---------------------------------------------------------------------------


def _fake_proc(stdout: str, stderr: str = "", returncode: int = 0) -> mock.Mock:
    m = mock.Mock()
    m.stdout = stdout
    m.stderr = stderr
    m.returncode = returncode
    return m


class TestCacheFetchAll:
    """Rate-limit retry + skip-fresh idempotency + partial-failure exit shape."""

    def test_invalid_repo_arg_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="invalid --repo"):
            cache.cache_fetch_all(
                source="github-issue",
                repo="not a repo",
                cache_root=tmp_path,
            )

    def test_invalid_source_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="not supported in v1"):
            cache.cache_fetch_all(
                source="github-pr",
                repo="deftai/directive",
                cache_root=tmp_path,
            )

    def test_invalid_batch_size_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="batch-size"):
            cache.cache_fetch_all(
                source="github-issue",
                repo="deftai/directive",
                batch_size=0,
                cache_root=tmp_path,
            )

    def test_invalid_delay_ms_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="delay-ms"):
            cache.cache_fetch_all(
                source="github-issue",
                repo="deftai/directive",
                delay_ms=-1,
                cache_root=tmp_path,
            )

    def test_happy_path_two_issues(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        list_payload = json.dumps(
            [
                {"number": 1, "title": "a", "state": "OPEN", "updatedAt": "2026-05-05T00:00:00Z"},
                {"number": 2, "title": "b", "state": "OPEN", "updatedAt": "2026-05-05T00:00:00Z"},
            ]
        )

        def fake_run(cmd: list[str], **_: object) -> mock.Mock:
            if "scm:issue:list" in cmd:
                return _fake_proc(list_payload)
            if "scm:issue:view" in cmd:
                num = int(cmd[cmd.index("--") + 1])
                return _fake_proc(json.dumps(_good_raw(number=num)))
            return _fake_proc("", returncode=1)

        monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
        monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
        report = cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            batch_size=10,
            delay_ms=0,
            cache_root=tmp_path,
        )
        assert report.succeeded == 2
        assert report.failed == 0
        assert report.skipped == 0

    def test_skip_fresh_idempotency(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Pre-populate one entry so the orchestrator skips it.
        cache.cache_put(
            "github-issue",
            "deftai/directive/1",
            _good_raw(number=1),
            cache_root=tmp_path,
        )
        list_payload = json.dumps(
            [
                {"number": 1, "title": "a", "state": "OPEN", "updatedAt": "2026-05-05T00:00:00Z"},
                {"number": 2, "title": "b", "state": "OPEN", "updatedAt": "2026-05-05T00:00:00Z"},
            ]
        )
        view_calls: list[int] = []

        def fake_run(cmd: list[str], **_: object) -> mock.Mock:
            if "scm:issue:list" in cmd:
                return _fake_proc(list_payload)
            if "scm:issue:view" in cmd:
                num = int(cmd[cmd.index("--") + 1])
                view_calls.append(num)
                return _fake_proc(json.dumps(_good_raw(number=num)))
            return _fake_proc("", returncode=1)

        monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
        monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
        report = cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            batch_size=10,
            delay_ms=0,
            cache_root=tmp_path,
        )
        assert report.succeeded == 1
        assert report.skipped == 1
        assert report.failed == 0
        # Issue 1 was fresh -> not viewed.
        assert view_calls == [2]

    def test_partial_failure_exit_shape(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        list_payload = json.dumps(
            [
                {"number": 1, "title": "a", "state": "OPEN", "updatedAt": "2026-05-05T00:00:00Z"},
                {"number": 2, "title": "b", "state": "OPEN", "updatedAt": "2026-05-05T00:00:00Z"},
            ]
        )

        def fake_run(cmd: list[str], **_: object) -> mock.Mock:
            if "scm:issue:list" in cmd:
                return _fake_proc(list_payload)
            if "scm:issue:view" in cmd:
                num = int(cmd[cmd.index("--") + 1])
                if num == 2:
                    # Hard 500-style failure (no rate-limit signal).
                    return _fake_proc(
                        "", stderr="HTTP 500 server error", returncode=1
                    )
                return _fake_proc(json.dumps(_good_raw(number=num)))
            return _fake_proc("", returncode=1)

        monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
        monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
        report = cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            batch_size=10,
            delay_ms=0,
            cache_root=tmp_path,
        )
        assert report.succeeded == 1
        assert report.failed == 1
        assert report.skipped == 0
        assert any("deftai/directive/2" in f["key"] for f in report.failures)
        # JSON shape is structured.
        payload = json.loads(report.to_json())
        assert payload["succeeded"] == 1
        assert payload["failed"] == 1

    def test_429_retry_with_retry_after(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        list_payload = json.dumps(
            [
                {
                    "number": 5,
                    "title": "rate",
                    "state": "OPEN",
                    "updatedAt": "2026-05-05T00:00:00Z",
                }
            ]
        )
        attempts = {"view": 0}

        def fake_run(cmd: list[str], **_: object) -> mock.Mock:
            if "scm:issue:list" in cmd:
                return _fake_proc(list_payload)
            if "scm:issue:view" in cmd:
                attempts["view"] += 1
                if attempts["view"] == 1:
                    return _fake_proc(
                        "",
                        stderr="HTTP 429 too many requests\nRetry-After: 7\n",
                        returncode=1,
                    )
                return _fake_proc(json.dumps(_good_raw(number=5)))
            return _fake_proc("", returncode=1)

        sleeps: list[float] = []
        monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
        monkeypatch.setattr(_cache_fetch, "_sleep", lambda s: sleeps.append(s))
        report = cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            batch_size=10,
            delay_ms=0,
            cache_root=tmp_path,
        )
        assert report.succeeded == 1
        assert report.failed == 0
        # The 7s Retry-After header was honored.
        assert 7 in sleeps

    def test_429_no_retry_after_uses_fallback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        list_payload = json.dumps(
            [
                {
                    "number": 6,
                    "title": "ratenoheader",
                    "state": "OPEN",
                    "updatedAt": "2026-05-05T00:00:00Z",
                }
            ]
        )
        attempts = {"view": 0}

        def fake_run(cmd: list[str], **_: object) -> mock.Mock:
            if "scm:issue:list" in cmd:
                return _fake_proc(list_payload)
            if "scm:issue:view" in cmd:
                attempts["view"] += 1
                if attempts["view"] == 1:
                    return _fake_proc(
                        "", stderr="API rate limit exceeded", returncode=1
                    )
                return _fake_proc(json.dumps(_good_raw(number=6)))
            return _fake_proc("", returncode=1)

        sleeps: list[float] = []
        monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
        monkeypatch.setattr(_cache_fetch, "_sleep", lambda s: sleeps.append(s))
        cache.cache_fetch_all(
            source="github-issue",
            repo="deftai/directive",
            batch_size=10,
            delay_ms=0,
            cache_root=tmp_path,
        )
        # Fallback constant is 60s -- present in the sleeps list.
        assert _cache_fetch.DEFAULT_RETRY_AFTER_FALLBACK_S in sleeps

    def test_detect_rate_limit_helper(self) -> None:
        is_rl, retry = _cache_fetch.detect_rate_limit("HTTP 429\nRetry-After: 12\n")
        assert is_rl is True
        assert retry == 12
        # No 429 -> not rate-limited.
        is_rl2, _ = _cache_fetch.detect_rate_limit("404 not found")
        assert is_rl2 is False


# ---------------------------------------------------------------------------
# cache.cache_prune
# ---------------------------------------------------------------------------


class TestCachePrune:
    """Expired-only filter, dry-run, source filter."""

    def test_prune_empty_root_noop(self, tmp_path: Path) -> None:
        removed = cache.cache_prune(cache_root=tmp_path)
        assert removed == []

    def test_prune_removes_expired_only(self, tmp_path: Path) -> None:
        old = datetime.now(UTC) - timedelta(days=60)
        # Old entry: expires_at older than the 30d cutoff.
        cache.cache_put(
            "github-issue",
            "deftai/directive/300",
            _good_raw(number=300),
            ttl_seconds=0,
            cache_root=tmp_path,
            fetched_at=old,
        )
        # Fresh entry: expires_at > now, never pruned.
        cache.cache_put(
            "github-issue",
            "deftai/directive/301",
            _good_raw(number=301),
            cache_root=tmp_path,
        )
        removed = cache.cache_prune(older_than_days=30, cache_root=tmp_path)
        assert len(removed) == 1
        kept = cache.entry_dir(
            "github-issue", "deftai/directive/301", cache_root=tmp_path
        )
        assert kept.exists()

    def test_prune_dry_run_does_not_delete(self, tmp_path: Path) -> None:
        old = datetime.now(UTC) - timedelta(days=60)
        cache.cache_put(
            "github-issue",
            "deftai/directive/302",
            _good_raw(number=302),
            ttl_seconds=0,
            cache_root=tmp_path,
            fetched_at=old,
        )
        removed = cache.cache_prune(
            older_than_days=30, dry_run=True, cache_root=tmp_path
        )
        assert len(removed) == 1
        assert cache.entry_dir(
            "github-issue", "deftai/directive/302", cache_root=tmp_path
        ).exists()

    def test_prune_source_filter(self, tmp_path: Path) -> None:
        # Mock a non-github-issue source folder; prune --source=github-issue
        # should leave it alone.
        (tmp_path / "github-pr").mkdir(parents=True)
        old = datetime.now(UTC) - timedelta(days=60)
        cache.cache_put(
            "github-issue",
            "deftai/directive/303",
            _good_raw(number=303),
            ttl_seconds=0,
            cache_root=tmp_path,
            fetched_at=old,
        )
        removed = cache.cache_prune(
            older_than_days=30, source="github-issue", cache_root=tmp_path
        )
        assert len(removed) == 1

    def test_prune_negative_threshold_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(cache.CacheError, match="older-than-days"):
            cache.cache_prune(older_than_days=-1, cache_root=tmp_path)


# ---------------------------------------------------------------------------
# CLI exit-code contract
# ---------------------------------------------------------------------------


class TestCLI:
    """End-to-end argv exit-code contract."""

    def test_put_clean_returns_0(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.chdir(tmp_path)
        raw = tmp_path / "raw.json"
        raw.write_text(json.dumps(_good_raw(number=1)), encoding="utf-8")
        rc = cache.main(["put", "github-issue", "deftai/directive/1", "--raw-file", str(raw)])
        assert rc == 0

    def test_put_credentials_returns_2(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
        raw = tmp_path / "raw.json"
        raw.write_text(
            json.dumps(_good_raw(number=2, body=f"AKIA{'A' * 16}")),
            encoding="utf-8",
        )
        rc = cache.main(["put", "github-issue", "deftai/directive/2", "--raw-file", str(raw)])
        assert rc == 2

    def test_get_miss_returns_1(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
        rc = cache.main(["get", "github-issue", "deftai/directive/9999"])
        assert rc == 1

    def test_invalidate_idempotent_returns_0(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.chdir(tmp_path)
        rc = cache.main(["invalidate", "github-issue", "deftai/directive/9999"])
        assert rc == 0

    def test_fetch_all_list_failure_returns_clean_error(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """CacheFetchError from the scm:issue:list enumeration phase must surface
        as ``cache: error: ...`` with exit-code 1, not as a raw Python traceback.

        ``CacheFetchError`` extends ``RuntimeError`` directly (sibling of
        ``CacheError``, not subclass) to keep ``_cache_fetch.py`` free of a
        circular import. ``main()`` catches both so a ``task scm:issue:list``
        failure -- network down, ``task`` not on PATH, non-JSON output --
        produces the same clean exit shape every other failure path emits.
        Regression for the Greptile P1 finding on a480d88 (#883 Story 2).
        """
        monkeypatch.chdir(tmp_path)

        def fake_run(cmd: list[str], **_: object) -> mock.Mock:
            if "scm:issue:list" in cmd:
                return _fake_proc("", stderr="task: not found", returncode=127)
            return _fake_proc("", returncode=1)

        monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)
        monkeypatch.setattr(_cache_fetch, "_sleep", lambda _s: None)
        rc = cache.main(
            ["fetch-all", "--source", "github-issue", "--repo", "deftai/directive"]
        )
        assert rc == 1
        captured = capsys.readouterr()
        assert "cache: error:" in captured.err
        assert "scm:issue:list" in captured.err
        assert "Traceback" not in captured.err


# ---------------------------------------------------------------------------
# Schema-file vs in-module validator alignment
# ---------------------------------------------------------------------------


class TestSchemaAlignment:
    """Regression guard: the JSON schema file and the in-module validator must agree."""

    @pytest.fixture(scope="class")
    def schema(self) -> dict[str, Any]:
        path = REPO_ROOT / "vbrief" / "schemas" / "cache-meta.schema.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_top_level_required_fields_match(self, schema: dict[str, Any]) -> None:
        schema_required = set(schema["required"])
        assert schema_required == set(_cache_validate._META_REQUIRED), (
            "drift between cache-meta.schema.json required[] and "
            "_cache_validate._META_REQUIRED -- update both"
        )

    def test_scan_result_required_fields_match(self, schema: dict[str, Any]) -> None:
        sr = schema["$defs"]["ScanResult"]
        assert set(sr["required"]) == set(_cache_validate._SCAN_RESULT_REQUIRED)

    def test_scan_flag_required_fields_match(self, schema: dict[str, Any]) -> None:
        sf = schema["$defs"]["ScanFlag"]
        assert set(sf["required"]) == set(_cache_validate._SCAN_FLAG_REQUIRED)

    def test_scan_flag_categories_match(self, schema: dict[str, Any]) -> None:
        sf = schema["$defs"]["ScanFlag"]
        assert (
            set(sf["properties"]["category"]["enum"])
            == _cache_validate._SCAN_FLAG_CATEGORIES
        )

    def test_scan_flag_severities_match(self, schema: dict[str, Any]) -> None:
        sf = schema["$defs"]["ScanFlag"]
        assert (
            set(sf["properties"]["severity"]["enum"])
            == _cache_validate._SCAN_FLAG_SEVERITIES
        )

    def test_source_enum_matches_v1_allowed(self, schema: dict[str, Any]) -> None:
        assert set(schema["properties"]["source"]["enum"]) == set(cache.ALLOWED_SOURCES)
