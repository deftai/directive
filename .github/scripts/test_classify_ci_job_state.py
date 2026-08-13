#!/usr/bin/env python3
"""Unit tests for classify-ci-job-state.py (#2672 / #3168 / #3340)."""

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

    def test_started_at_alone_is_unclaimed(self) -> None:
        """#3340 — started_at without runner_name is still unclaimed."""
        job = {
            "name": "TypeScript (Blacksmith primary) / run",
            "status": "in_progress",
            "started_at": "2026-08-06T12:00:00Z",
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "queued")

    def test_queued_with_started_at_no_runner_is_unclaimed(self) -> None:
        job = {
            "name": "Merge gate (Blacksmith primary)",
            "status": "queued",
            "started_at": "2026-08-13T15:20:00Z",
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "queued")

    def test_empty_runner_name_is_unclaimed(self) -> None:
        job = {
            "name": "Go (Blacksmith primary) / run",
            "status": "in_progress",
            "started_at": "2026-08-13T15:20:00Z",
            "runner_name": "  ",
        }
        self.assertEqual(mod.classify_job(job), "queued")
        self.assertFalse(mod.runner_claimed(job))

    def test_reusable_caller_in_progress_without_inner_runner_is_unclaimed(self) -> None:
        """Caller in_progress is not a claim; inner still waiting → queued (#3340)."""
        payload = {
            "jobs": [
                {
                    "name": "TypeScript (Blacksmith primary)",
                    "status": "in_progress",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": None,
                },
                {
                    "name": "TypeScript (Blacksmith primary) / run",
                    "status": "queued",
                    "started_at": None,
                    "runner_name": None,
                },
            ]
        }
        self.assertEqual(
            mod.classify_jobs_payload("typescript (blacksmith primary)", payload),
            "queued",
        )

    def test_reusable_inner_runner_is_claimed(self) -> None:
        payload = {
            "jobs": [
                {
                    "name": "TypeScript (Blacksmith primary)",
                    "status": "in_progress",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": None,
                },
                {
                    "name": "TypeScript (Blacksmith primary) / run",
                    "status": "in_progress",
                    "started_at": "2026-08-13T15:21:00Z",
                    "runner_name": "blacksmith-abc",
                },
            ]
        }
        self.assertEqual(
            mod.classify_jobs_payload("typescript (blacksmith primary)", payload),
            "started",
        )

    def test_cancelled_with_started_at_no_runner_is_capacity_death(self) -> None:
        job = {
            "name": "Merge gate (Blacksmith primary)",
            "status": "completed",
            "conclusion": "cancelled",
            "started_at": "2026-08-13T15:20:00Z",
            "runner_name": None,
        }
        self.assertEqual(mod.classify_job(job), "cancelled_unclaimed")

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
