#!/usr/bin/env python3
"""Node-toolchain-aware TypeScript lane for `task check` (#1530, #1790).

`task check` -> `check:framework-source` historically ran only the Python
suite + gates; the TypeScript engine (biome lint, tsc build, vitest) ran only
in the dedicated CI job. That split let a TS lint/format/test failure pass a
contributor's local `task check` and redden CI after push (PR #1780: a worker's
local gate was green while CI biome failed on unformatted files).

This helper closes the gap WITHOUT regressing the documented invariant that
`check:framework-source` must not hard-require a Node toolchain in Node-less
environments (the vendored-consumer guard pattern from #1474). When `pnpm` is on
PATH it runs `pnpm run lint`, `pnpm run build`, and `pnpm run test` in order,
failing fast on the first non-zero exit. When `pnpm` is absent it prints a clear
notice and exits 0 -- the TS lane stays validated by the CI job in that case.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess  # noqa: S404 -- fixed, non-shell pnpm invocations only
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

# Run order is deliberate: lint (cheapest, catches the PR #1780 biome class
# first), then build, then the test suite.
LANE_COMMANDS: tuple[tuple[str, ...], ...] = (
    ("run", "lint"),
    ("run", "build"),
    ("run", "test"),
)

SKIP_NOTICE = (
    "[ts:check-lane] pnpm not found on PATH -- skipping the TypeScript lane "
    "(build/lint/test). The TS engine stays validated by the dedicated CI job. "
    "Install the Node toolchain (pnpm) to run the TS lane locally."
)


def _resolve_pnpm() -> str | None:
    """Return the pnpm executable path, or None when it is not installed."""
    return shutil.which("pnpm")


def run_ts_lane(
    project_root: Path,
    *,
    pnpm: str | None,
    runner: Callable[..., Any] = subprocess.run,
    out: Callable[[str], Any] = print,
) -> int:
    """Run the TS lane when pnpm is available; skip (exit 0) when it is not.

    `pnpm`, `runner`, and `out` are injected so the guard logic is unit-testable
    without a real Node toolchain or real subprocess execution.
    """
    if not pnpm:
        out(SKIP_NOTICE)
        return 0

    for command in LANE_COMMANDS:
        argv: Sequence[str] = (pnpm, *command)
        result = runner(argv, cwd=str(project_root))
        code = getattr(result, "returncode", 0)
        if code != 0:
            out(f"[ts:check-lane] `pnpm {' '.join(command)}` failed (exit {code}).")
            return code
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        default=".",
        help="Repo root that owns the pnpm workspace (default: cwd).",
    )
    args = parser.parse_args(argv)
    return run_ts_lane(Path(args.project_root), pnpm=_resolve_pnpm())


if __name__ == "__main__":
    sys.exit(main())
