#!/usr/bin/env python3
"""Classify a CI job's queue/start state for #2672 / #3168 capacity watchdog.

States (stdout, one line):
  missing              — no job matching needle in the jobs payload
  queued               — still queued with no runner claimed
  started              — in_progress or has started_at/runner_name (no failover; #2652)
  done                 — completed after a runner claim, or completed success/failure
  cancelled_unclaimed  — completed cancelled/skipped with no runner ever claimed
                         (capacity death — arm failover like queued past budget; #3168)
"""

from __future__ import annotations

import json
import sys
from typing import Any


def classify_job(match: dict[str, Any] | None) -> str:
    """Return the capacity-watchdog state for a single Actions job object."""
    if match is None:
        return "missing"

    status = str(match.get("status") or "")
    conclusion = str(match.get("conclusion") or "")
    started = match.get("started_at")
    runner = match.get("runner_name")
    claimed = bool(started or runner)

    if status == "completed":
        # Capacity death: cancelled/skipped without ever claiming a runner (#3168).
        # Do not treat as "done" — that wrongly skips GH-hosted failover.
        if conclusion in ("cancelled", "skipped") and not claimed:
            return "cancelled_unclaimed"
        return "done"

    if status == "in_progress" or claimed:
        # True execution start — never auto-failover (#2652).
        return "started"

    if status == "queued":
        return "queued"

    # waiting / requested / unknown without a claim → still capacity-stalled.
    return "queued" if not claimed else "started"


def classify_jobs_payload(needle: str, payload: dict[str, Any]) -> str:
    """Find first job whose name contains needle (case-insensitive) and classify it."""
    needle_l = needle.lower()
    jobs = payload.get("jobs") or []
    match = next(
        (j for j in jobs if needle_l in str(j.get("name") or "").lower()),
        None,
    )
    return classify_job(match)


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: classify-ci-job-state.py <needle> <jobs_json>", file=sys.stderr)
        raise SystemExit(2)
    needle = sys.argv[1]
    payload = json.loads(sys.argv[2])
    print(classify_jobs_payload(needle, payload))


if __name__ == "__main__":
    main()
