#!/usr/bin/env python3
"""Cancel still-queued Blacksmith primary jobs before GH-hosted failover (#2672)."""

from __future__ import annotations

import json
import os
import subprocess
import sys


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: cancel-queued-ci-primary.py <needle> <jobs_json>", file=sys.stderr)
        raise SystemExit(2)
    needle = sys.argv[1].lower()
    payload = json.loads(sys.argv[2])
    repo = os.environ["REPO"]
    for job in payload.get("jobs") or []:
        name = str(job.get("name") or "")
        if needle not in name.lower():
            continue
        if job.get("status") != "queued":
            continue
        jid = job.get("id")
        if not jid:
            continue
        print(f"canceling queued primary job id={jid} name={name}")
        subprocess.run(
            ["gh", "api", "-X", "POST", f"repos/{repo}/actions/jobs/{jid}/cancel"],
            check=False,
        )


if __name__ == "__main__":
    main()
