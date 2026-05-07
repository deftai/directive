"""Unit tests for ``scripts/candidates_log.py`` (#845 Story 2).

Test cases (mirroring the vBRIEF Test narrative):

1. ``test_append_and_read_round_trip`` -- writer/reader symmetry; parent dir
   auto-created; returned ``decision_id`` matches the entry on disk.
2. ``test_malformed_line_tolerance`` -- ``read_all`` skips junk lines and
   logs a warning instead of crashing.
3. ``test_concurrent_append_thread_safety`` -- 8 threads x 25 appends; every
   line is intact, every ``decision_id`` is unique, line count matches.
4. ``test_schema_rejection_on_invalid_entry`` -- missing required fields,
   bad UUIDs, bad enums, and conditional-dependency violations all raise
   :class:`CandidatesLogError` and write nothing.
5. ``test_latest_decision_returns_most_recent`` -- sort by timestamp not
   insertion order; per-repo + per-issue filter; ``None`` for unknown.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import uuid
from pathlib import Path

import pytest

# Mirror the slug_normalize test pattern: scripts/ is not a package, so
# inject the directory onto sys.path before importing the module under test.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from candidates_log import (  # noqa: E402  -- sys.path mutated above
    CandidatesLogError,
    append,
    find_by_issue,
    latest_decision,
    new_decision_id,
    read_all,
)


def _entry(**overrides: object) -> dict:
    """Return a minimal valid entry dict, overridable per-test."""
    base: dict = {
        "decision_id": str(uuid.uuid4()),
        "timestamp": "2026-05-03T16:32:54Z",
        "repo": "deftai/directive",
        "issue_number": 845,
        "decision": "accept",
        "actor": "agent:test",
    }
    base.update(overrides)
    return base


# -- AC 1: round-trip ---------------------------------------------------------


def test_append_and_read_round_trip(tmp_path: Path) -> None:
    log = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    e1 = _entry(issue_number=1, decision="defer", reason="not enough info")
    e2 = _entry(issue_number=2, decision="reject")

    id1 = append(e1, path=log)
    id2 = append(e2, path=log)

    assert id1 == e1["decision_id"]
    assert id2 == e2["decision_id"]
    assert log.exists(), "append must auto-create parent directory"

    rows = read_all(path=log)
    assert [r["decision_id"] for r in rows] == [id1, id2]
    assert rows[0]["reason"] == "not enough info"
    assert rows[1]["decision"] == "reject"

    # repo filter is honoured even when only one repo is present.
    assert read_all(repo="deftai/directive", path=log) == rows
    assert read_all(repo="other/repo", path=log) == []


# -- AC 2: malformed-line tolerance -------------------------------------------


def test_malformed_line_tolerance(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    log = tmp_path / "candidates.jsonl"
    valid_a = _entry(issue_number=10)
    valid_b = _entry(issue_number=11)
    # Mix valid lines with three failure modes a crashed appender could
    # leave behind: free-form text, truncated JSON, and a non-object value.
    payload = (
        json.dumps(valid_a) + "\n"
        "this line is not json\n"
        "{ \"partial\": tru\n"
        "[\"array-not-object\"]\n"
        + json.dumps(valid_b) + "\n"
        "\n"  # blank line is silently skipped, NOT a warning
    )
    log.write_text(payload, encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="candidates_log"):
        rows = read_all(path=log)

    assert [r["issue_number"] for r in rows] == [10, 11]
    # Two malformed JSON lines + one non-object line = 3 warnings.
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 3
    assert all("candidates.jsonl" in r.getMessage() for r in warnings)


# -- AC 3: concurrent-append thread safety ------------------------------------


def test_concurrent_append_thread_safety(tmp_path: Path) -> None:
    log = tmp_path / "candidates.jsonl"
    n_threads = 8
    n_per_thread = 25

    def worker(tid: int) -> None:
        for i in range(n_per_thread):
            append(
                _entry(
                    decision_id=str(uuid.uuid4()),
                    issue_number=tid * 1000 + i + 1,
                ),
                path=log,
            )

    threads = [
        threading.Thread(target=worker, args=(t,)) for t in range(n_threads)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    expected = n_threads * n_per_thread
    rows = read_all(path=log)
    assert len(rows) == expected, "every append must produce exactly one row"

    ids = [r["decision_id"] for r in rows]
    assert len(set(ids)) == expected, "decision_ids must be unique"

    # Every on-disk line must be a complete, parseable JSON object -- no torn
    # writes interleaved between threads.
    raw = log.read_text(encoding="utf-8").splitlines()
    assert len(raw) == expected
    for line in raw:
        json.loads(line)


# -- AC 4: schema rejection ---------------------------------------------------


def test_schema_rejection_on_invalid_entry(tmp_path: Path) -> None:
    log = tmp_path / "candidates.jsonl"

    # (1) missing required field
    bad_missing = _entry()
    del bad_missing["decision"]
    with pytest.raises(CandidatesLogError, match="missing required"):
        append(bad_missing, path=log)

    # (2) malformed UUID
    with pytest.raises(CandidatesLogError, match="UUID"):
        append(_entry(decision_id="not-a-uuid"), path=log)

    # (3) malformed timestamp
    with pytest.raises(CandidatesLogError, match="ISO-8601"):
        append(_entry(timestamp="yesterday"), path=log)

    # (4) bad repo coordinate
    with pytest.raises(CandidatesLogError, match="owner/name"):
        append(_entry(repo="just-a-name"), path=log)

    # (5) invalid decision verb
    with pytest.raises(CandidatesLogError, match="decision must be one of"):
        append(_entry(decision="approve"), path=log)

    # (6) mark-duplicate without linked_to
    with pytest.raises(CandidatesLogError, match="linked_to"):
        append(_entry(decision="mark-duplicate"), path=log)

    # (7) reset without prior_decision_id
    with pytest.raises(CandidatesLogError, match="prior_decision_id"):
        append(_entry(decision="reset"), path=log)

    # (8) linked_to forbidden when not mark-duplicate
    with pytest.raises(CandidatesLogError, match="linked_to.*mark-duplicate"):
        append(_entry(linked_to=12), path=log)

    # (8b) prior_decision_id forbidden when not reset (symmetric guard for
    # the conditional surface; Greptile #876 P2 pinned the gap).
    with pytest.raises(CandidatesLogError, match="prior_decision_id.*reset"):
        append(_entry(prior_decision_id=str(uuid.uuid4())), path=log)

    # (9) unknown extra field
    with pytest.raises(CandidatesLogError, match="unknown field"):
        append(_entry(rogue_key="nope"), path=log)

    # (10) issue_number rejects bool (int subclass) and zero
    with pytest.raises(CandidatesLogError, match="issue_number"):
        append(_entry(issue_number=True), path=log)
    with pytest.raises(CandidatesLogError, match="issue_number"):
        append(_entry(issue_number=0), path=log)

    # (11) timestamp must use the Z (UTC) suffix -- non-UTC offsets are
    # rejected at the validator boundary so latest_decision()'s lexicographic
    # sort cannot be silently broken by mixed-zone entries (Greptile #876 P1).
    with pytest.raises(CandidatesLogError, match="ISO-8601 UTC"):
        append(_entry(timestamp="2026-05-03T00:00:00+05:30"), path=log)
    with pytest.raises(CandidatesLogError, match="ISO-8601 UTC"):
        append(_entry(timestamp="2026-05-03T00:00:00-08:00"), path=log)

    # No invalid bytes leaked to disk -- file must not exist (or be empty
    # if the platform created it ahead of an aborted write).
    assert not log.exists() or log.read_text(encoding="utf-8") == ""


def test_mark_duplicate_and_reset_happy_path(tmp_path: Path) -> None:
    """Conditional fields validate correctly when supplied together."""
    log = tmp_path / "candidates.jsonl"
    # mark-duplicate carries linked_to.
    md = _entry(
        issue_number=42, decision="mark-duplicate", linked_to=41
    )
    append(md, path=log)
    # reset carries prior_decision_id pointing at the first row.
    rs = _entry(
        issue_number=42,
        decision="reset",
        prior_decision_id=md["decision_id"],
        timestamp="2026-05-04T10:00:00Z",
    )
    append(rs, path=log)
    rows = read_all(path=log)
    assert rows[0]["linked_to"] == 41
    assert rows[1]["prior_decision_id"] == md["decision_id"]


# -- AC 5: latest_decision sorted by timestamp -------------------------------


def test_latest_decision_returns_most_recent(tmp_path: Path) -> None:
    log = tmp_path / "candidates.jsonl"
    early = _entry(
        issue_number=42, timestamp="2026-05-01T10:00:00Z", decision="defer"
    )
    middle = _entry(
        issue_number=42, timestamp="2026-05-02T10:00:00Z", decision="needs-ac"
    )
    late = _entry(
        issue_number=42, timestamp="2026-05-03T10:00:00Z", decision="accept"
    )
    other_repo = _entry(
        repo="other/repo",
        issue_number=42,
        timestamp="2026-05-04T10:00:00Z",
        decision="reject",
    )
    other_issue = _entry(
        issue_number=99, timestamp="2026-05-04T10:00:00Z", decision="accept"
    )

    # Append out of timestamp order to confirm sort, not insertion order, drives
    # the "latest" semantic.
    append(middle, path=log)
    append(late, path=log)
    append(early, path=log)
    append(other_repo, path=log)
    append(other_issue, path=log)

    result = latest_decision(42, "deftai/directive", path=log)
    assert result is not None
    assert result["decision"] == "accept"
    assert result["timestamp"] == "2026-05-03T10:00:00Z"

    found = find_by_issue(42, "deftai/directive", path=log)
    assert {r["timestamp"] for r in found} == {
        "2026-05-01T10:00:00Z",
        "2026-05-02T10:00:00Z",
        "2026-05-03T10:00:00Z",
    }
    # other_repo's #42 entry must NOT leak into the deftai/directive view.
    assert all(r["repo"] == "deftai/directive" for r in found)

    # Unknown issue -> None.
    assert latest_decision(123, "deftai/directive", path=log) is None
    # Read against an empty path returns [].
    empty = tmp_path / "does-not-exist.jsonl"
    assert read_all(path=empty) == []
    assert latest_decision(1, "deftai/directive", path=empty) is None


# -- helper smoke -------------------------------------------------------------


def test_new_decision_id_returns_uuid4_string() -> None:
    val = new_decision_id()
    parsed = uuid.UUID(val)
    assert str(parsed) == val
