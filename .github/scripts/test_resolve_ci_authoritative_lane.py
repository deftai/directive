#!/usr/bin/env python3
"""Unit tests for resolve-ci-authoritative-lane.py helpers (#3340)."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).with_name("resolve-ci-authoritative-lane.py")
    spec = importlib.util.spec_from_file_location("resolve_ci_authoritative_lane", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load()


class TestRunnerClaimed(unittest.TestCase):
    def test_started_at_alone_is_not_claimed(self) -> None:
        self.assertFalse(
            mod.runner_claimed(
                {
                    "status": "in_progress",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": None,
                }
            )
        )

    def test_runner_name_is_claimed(self) -> None:
        self.assertTrue(
            mod.runner_claimed(
                {
                    "status": "in_progress",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": "blacksmith-abc",
                }
            )
        )


class TestCapacityDeath(unittest.TestCase):
    def test_cancelled_with_started_at_no_runner(self) -> None:
        self.assertTrue(
            mod.is_capacity_death(
                {
                    "status": "completed",
                    "conclusion": "cancelled",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": None,
                }
            )
        )

    def test_cancelled_after_claim_is_not_capacity_death(self) -> None:
        self.assertFalse(
            mod.is_capacity_death(
                {
                    "status": "completed",
                    "conclusion": "cancelled",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": "blacksmith-abc",
                }
            )
        )


class TestSelectPrimary(unittest.TestCase):
    def test_prefers_inner_run_job(self) -> None:
        payload = {
            "jobs": [
                {
                    "name": "Merge gate (Blacksmith primary)",
                    "status": "in_progress",
                    "started_at": "2026-08-13T15:20:00Z",
                    "runner_name": None,
                },
                {
                    "name": "Merge gate (Blacksmith primary) / run",
                    "status": "queued",
                    "started_at": None,
                    "runner_name": None,
                },
            ]
        }
        match = mod.select_primary_job("merge gate (blacksmith primary)", payload)
        assert match is not None
        self.assertIn(" / run", match["name"])
        self.assertFalse(mod.runner_claimed(match))

    def test_prefers_claimed_inner(self) -> None:
        payload = {
            "jobs": [
                {
                    "name": "Go (Blacksmith primary)",
                    "status": "in_progress",
                    "runner_name": None,
                },
                {
                    "name": "Go (Blacksmith primary) / run",
                    "status": "in_progress",
                    "runner_name": "blacksmith-abc",
                },
            ]
        }
        match = mod.select_primary_job("go (blacksmith primary)", payload)
        assert match is not None
        self.assertEqual(match["runner_name"], "blacksmith-abc")


if __name__ == "__main__":
    unittest.main()
