#!/usr/bin/env python3
"""Unit tests for cancel-queued-ci-primary.py (#2672 / #3168)."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from typing import Any


def _load():
    path = Path(__file__).with_name("cancel-queued-ci-primary.py")
    spec = importlib.util.spec_from_file_location("cancel_queued_ci_primary", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load()


class TestIsCancelable(unittest.TestCase):
    def test_queued_unclaimed(self) -> None:
        self.assertTrue(
            mod.is_cancelable_unclaimed(
                {"status": "queued", "started_at": None, "runner_name": None}
            )
        )

    def test_waiting_unclaimed(self) -> None:
        self.assertTrue(
            mod.is_cancelable_unclaimed(
                {"status": "waiting", "started_at": None, "runner_name": None}
            )
        )

    def test_in_progress_with_runner_not_cancelable(self) -> None:
        """#2652 — do not cancel a claimed runner."""
        self.assertFalse(
            mod.is_cancelable_unclaimed(
                {
                    "status": "in_progress",
                    "started_at": "2026-08-06T12:00:00Z",
                    "runner_name": "blacksmith-abc",
                }
            )
        )

    def test_completed_cancelled_not_cancelable(self) -> None:
        """Already cancelled — nothing to cancel; failover arms separately."""
        self.assertFalse(
            mod.is_cancelable_unclaimed(
                {
                    "status": "completed",
                    "conclusion": "cancelled",
                    "started_at": None,
                    "runner_name": None,
                }
            )
        )


class TestCancelMatching(unittest.TestCase):
    def test_cancels_only_matching_queued(self) -> None:
        calls: list[list[str]] = []

        def fake_run(argv: list[str], check: bool = False) -> Any:
            calls.append(list(argv))
            return None

        payload = {
            "jobs": [
                {
                    "id": 101,
                    "name": "TypeScript (Blacksmith primary) / run",
                    "status": "queued",
                    "started_at": None,
                    "runner_name": None,
                },
                {
                    "id": 102,
                    "name": "Go (Blacksmith primary) / run",
                    "status": "queued",
                    "started_at": None,
                    "runner_name": None,
                },
                {
                    "id": 103,
                    "name": "TypeScript (Blacksmith primary) / run",
                    "status": "in_progress",
                    "started_at": "2026-08-06T12:00:00Z",
                    "runner_name": "bs-1",
                },
                {
                    "id": 104,
                    "name": "TypeScript (Blacksmith primary) / run",
                    "status": "completed",
                    "conclusion": "cancelled",
                    "started_at": None,
                    "runner_name": None,
                },
            ]
        }
        cancelled = mod.cancel_matching_primaries(
            "typescript (blacksmith primary)",
            payload,
            repo="deftai/directive",
            runner=fake_run,
        )
        self.assertEqual(cancelled, [101])
        self.assertEqual(len(calls), 1)
        self.assertIn("repos/deftai/directive/actions/jobs/101/cancel", calls[0][-1])


if __name__ == "__main__":
    unittest.main()
