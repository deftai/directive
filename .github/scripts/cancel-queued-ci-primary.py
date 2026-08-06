#!/usr/bin/env python3
"""Cancel still-queued Blacksmith primary jobs before GH-hosted failover (#2672 / #3168).

Only cancels jobs that have not claimed a runner (status queued, or equivalent
unclaimed waiting state). Never cancels in_progress jobs with a runner (#2652).
Jobs already cancelled without a claim need no cancel — failover is armed instead.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any


def is_cancelable_unclaimed(job: dict[str, Any]) -> bool:
    """True when the job is still waiting for a runner and safe to cancel."""
    status = str(job.get("status") or "")
    started = job.get("started_at")
    runner = job.get("runner_name")
    if started or runner:
        return False
    # queued is the primary arm path; waiting/requested are unclaimed equivalents.
    return status in ("queued", "waiting", "requested")


def cancel_matching_primaries(
    needle: str,
    payload: dict[str, Any],
    *,
    repo: str,
    runner: Any = None,
) -> list[int]:
    """Cancel unclaimed primary jobs matching needle. Returns cancelled job ids."""
    run = runner or subprocess.run
    needle_l = needle.lower()
    cancelled: list[int] = []
    for job in payload.get("jobs") or []:
        name = str(job.get("name") or "")
        if needle_l not in name.lower():
            continue
        if not is_cancelable_unclaimed(job):
            continue
        jid = job.get("id")
        if not jid:
            continue
        print(f"canceling queued primary job id={jid} name={name}")
        run(
            ["gh", "api", "-X", "POST", f"repos/{repo}/actions/jobs/{jid}/cancel"],
            check=False,
        )
        cancelled.append(int(jid))
    return cancelled


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: cancel-queued-ci-primary.py <needle> <jobs_json>", file=sys.stderr)
        raise SystemExit(2)
    needle = sys.argv[1]
    payload = json.loads(sys.argv[2])
    repo = os.environ["REPO"]
    cancel_matching_primaries(needle, payload, repo=repo)


if __name__ == "__main__":
    main()
