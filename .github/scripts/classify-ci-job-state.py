#!/usr/bin/env python3
"""Classify a CI job's queue/start state for #2672 / #3168 / #3340 capacity watchdog.

States (stdout, one line):
  missing              — no job matching needle in the jobs payload
  queued               — still unclaimed (no runner_name), including started_at-only
  started              — runner_name set (no failover; #2652)
  done                 — completed after a runner claim, or completed success/failure
  cancelled_unclaimed  — completed cancelled/skipped with no runner ever claimed
                         (capacity death — arm failover like queued past budget; #3168)
"""

from __future__ import annotations

import json
import sys
from typing import Any


def runner_claimed(job: dict[str, Any] | None) -> bool:
    """True only when Actions assigned a runner_name. started_at is not a claim (#3340)."""
    if job is None:
        return False
    runner = job.get("runner_name")
    if runner is None:
        return False
    return bool(str(runner).strip())


def matching_jobs(needle: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Jobs whose name contains needle (case-insensitive)."""
    needle_l = needle.lower()
    return [
        j
        for j in (payload.get("jobs") or [])
        if needle_l in str(j.get("name") or "").lower()
    ]


def select_suite_job(needle: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Prefer the reusable-workflow inner `/run` job over the caller wrapper (#3340)."""
    matches = matching_jobs(needle, payload)
    if not matches:
        return None
    inner = [j for j in matches if " / " in str(j.get("name") or "")]
    pool = inner or matches
    claimed = [j for j in pool if runner_claimed(j)]
    if claimed:
        return claimed[0]
    completed = [j for j in pool if str(j.get("status") or "") == "completed"]
    if completed:
        return completed[0]
    return pool[0]


def classify_job(match: dict[str, Any] | None) -> str:
    """Return the capacity-watchdog state for a single Actions job object."""
    if match is None:
        return "missing"

    status = str(match.get("status") or "")
    conclusion = str(match.get("conclusion") or "")
    claimed = runner_claimed(match)

    if status == "completed":
        # Capacity death: cancelled/skipped without ever claiming a runner (#3168).
        # Do not treat as "done" — that wrongly skips GH-hosted failover.
        if conclusion in ("cancelled", "skipped") and not claimed:
            return "cancelled_unclaimed"
        return "done"

    if claimed:
        # True execution start — never auto-failover (#2652).
        return "started"

    # queued / in_progress / waiting / requested without runner_name are unclaimed.
    # started_at or reusable-workflow caller in_progress is not a claim (#3340).
    return "queued"


def classify_jobs_payload(needle: str, payload: dict[str, Any]) -> str:
    """Classify the authoritative matching job (inner `/run` preferred)."""
    return classify_job(select_suite_job(needle, payload))


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: classify-ci-job-state.py <needle> <jobs_json>", file=sys.stderr)
        raise SystemExit(2)
    needle = sys.argv[1]
    payload = json.loads(sys.argv[2])
    print(classify_jobs_payload(needle, payload))


if __name__ == "__main__":
    main()
