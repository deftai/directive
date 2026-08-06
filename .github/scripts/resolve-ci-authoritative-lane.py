#!/usr/bin/env python3
"""Resolve the authoritative CI lane result for a required aggregator job (#2672 / #3168).

Env:
  REPO, RUN_ID, GH_TOKEN (via gh), WANT_FAILOVER, FAILOVER_RESULT,
  PRIMARY_NEEDLE (lowercase substring of primary job name), SUITE_LABEL

When WANT_FAILOVER=true, the GH-hosted failover job result is authoritative.
When WANT_FAILOVER=false, the Blacksmith primary is polled until completed.
Primary/failover lane job names are never branch-protection required names —
only the aggregator job names in ci.yml are.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time


def gh_api(path: str) -> dict:
    out = subprocess.check_output(
        ["gh", "api", path],
        text=True,
        encoding="utf-8",
    )
    return json.loads(out)


def main() -> int:
    repo = os.environ["REPO"]
    run_id = os.environ["RUN_ID"]
    want = os.environ.get("WANT_FAILOVER", "false") == "true"
    failover = os.environ.get("FAILOVER_RESULT", "skipped")
    needle = os.environ["PRIMARY_NEEDLE"]
    label = os.environ["SUITE_LABEL"]

    if want:
        if failover == "success":
            print(f"Authoritative {label} green via GH-hosted failover (#2672/#3168)")
            return 0
        print(
            f"::error::{label} failover requested but result={failover}",
            file=sys.stderr,
        )
        return 1

    deadline = time.time() + 6 * 60 * 60
    while time.time() < deadline:
        payload = gh_api(f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100")
        match = next(
            (
                job
                for job in (payload.get("jobs") or [])
                if needle in str(job.get("name") or "").lower()
            ),
            None,
        )
        if match is None:
            time.sleep(15)
            continue
        status = match.get("status")
        conclusion = match.get("conclusion")
        started = match.get("started_at")
        runner = match.get("runner_name")
        print(
            f"primary status={status} conclusion={conclusion} "
            f"started_at={started} runner_name={runner}"
        )
        if status == "completed":
            if conclusion == "success":
                print(f"Authoritative {label} green via Blacksmith primary (#2672)")
                return 0
            # Capacity-death without failover arm is a graph bug (#3168) — fail loud.
            if conclusion in ("cancelled", "skipped") and not (started or runner):
                print(
                    f"::error::{label} Blacksmith primary {conclusion} without a "
                    f"runner claim and failover was not armed — capacity-watchdog/"
                    f"capacity-arm should have set WANT_FAILOVER (#3168)",
                    file=sys.stderr,
                )
                return 1
            print(
                f"::error::Blacksmith {label} primary concluded {conclusion}",
                file=sys.stderr,
            )
            return 1
        time.sleep(15)

    print(f"::error::Timed out waiting for Blacksmith {label} primary", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
