#!/usr/bin/env python3
"""Cancel still-unclaimed Blacksmith primary jobs before GH-hosted failover (#2672 / #3168 / #3340).

Unclaimed means no runner_name. started_at or reusable-workflow caller
in_progress is not a claim. Never cancels a job with runner_name (#2652).
Jobs already cancelled without a claim need no cancel — failover is armed instead.
"""

from __future__ import annotations

import json
import os
import subprocess
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


def is_cancelable_unclaimed(job: dict[str, Any]) -> bool:
    """True when the job has no runner_name and is still waiting (#3340 / #2652)."""
    status = str(job.get("status") or "")
    if runner_claimed(job):
        return False
    # in_progress without runner_name is still unclaimed (reusable-workflow caller
    # or started_at-only queue sit). Never cancel a completed job.
    return status in ("queued", "waiting", "requested", "in_progress")


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
