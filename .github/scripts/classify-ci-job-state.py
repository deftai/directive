#!/usr/bin/env python3
"""Classify a CI job's queue/start state for #2672 capacity watchdog."""

from __future__ import annotations

import json
import sys


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: classify-ci-job-state.py <needle> <jobs_json>", file=sys.stderr)
        raise SystemExit(2)
    needle = sys.argv[1].lower()
    payload = json.loads(sys.argv[2])
    jobs = payload.get("jobs") or []
    match = next((j for j in jobs if needle in str(j.get("name") or "").lower()), None)
    if match is None:
        print("missing")
        return
    status = str(match.get("status") or "")
    started = match.get("started_at")
    runner = match.get("runner_name")
    if status == "completed":
        print("done")
    elif status == "in_progress" or started or runner:
        print("started")
    elif status == "queued":
        print("queued")
    else:
        print("started" if started or runner else "queued")


if __name__ == "__main__":
    main()
