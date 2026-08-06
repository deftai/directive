#!/usr/bin/env python3
"""Unit tests for classify-ci-job-state.py (#2672 / #3168)."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).with_name("classify-ci-job-state.py")
    spec = importlib.util.spec_from_file_location("classify_ci_job_state", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load()


class TestClassifyJob(unittest.TestCase):
    def test_missing(self) -> None:
        self.assertEqual(mod.classify_job(None), "missing")
        self.assertEqual(
            mod.classify_jobs_payload("typescript (blacksmith primary)", {"jobs": []}),
            "missing",
        )

    def test_queued(self) -> None:
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "queued",
            "started_at": None,
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "queued")

    def test_waiting_unclaimed_is_queued(self) -> None:
        job = {
            "name": "Go (Blacksmith primary) / run",
            "status": "waiting",
            "started_at": None,
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "queued")

    def test_started_in_progress_with_runner(self) -> None:
        """#2652 — never arm failover once a runner is claimed."""
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "in_progress",
            "started_at": "2026-08-06T12:00:00Z",
            "runner_name": "blacksmith-abc",
        }
        self.assertEqual(mod.classify_job(job), "started")

    def test_started_from_started_at_alone(self) -> None:
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "in_progress",
            "started_at": "2026-08-06T12:00:00Z",
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "started")

    def test_done_success(self) -> None:
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-08-06T12:00:00Z",
            "runner_name": "blacksmith-abc",
        }
        self.assertEqual(mod.classify_job(job), "done")

    def test_done_failure_after_claim(self) -> None:
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "completed",
            "conclusion": "failure",
            "started_at": "2026-08-06T12:00:00Z",
            "runner_name": "blacksmith-abc",
        }
        self.assertEqual(mod.classify_job(job), "done")

    def test_cancelled_unclaimed_arms_failover(self) -> None:
        """#3168 — cancelled without runner is capacity death, not done."""
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "completed",
            "conclusion": "cancelled",
            "started_at": None,
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "cancelled_unclaimed")

    def test_skipped_unclaimed_arms_failover(self) -> None:
        job = {
            "name": "Go (Blacksmith primary) / run",
            "status": "completed",
            "conclusion": "skipped",
            "started_at": None,
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "cancelled_unclaimed")

    def test_cancelled_after_runner_claim_is_done(self) -> None:
        """Cancelled mid-run after claim is not capacity death."""
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "completed",
            "conclusion": "cancelled",
            "started_at": "2026-08-06T12:00:00Z",
            "runner_name": "blacksmith-abc",
        }
        self.assertEqual(mod.classify_job(job), "done")

    def test_needle_match_case_insensitive(self) -> None:
        payload = {
            "jobs": [
                {
                    "name": "TypeScript (Blacksmith primary) / run",
                    "status": "queued",
                    "started_at": None,
                    "runner_name": None,
                }
            ]
        }
        self.assertEqual(
            mod.classify_jobs_payload("typescript (blacksmith primary)", payload),
            "queued",
        )


if __name__ == "__main__":
    unittest.main()
