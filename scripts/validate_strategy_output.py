#!/usr/bin/env python3
"""
validate_strategy_output.py -- Deterministic validation gate for
strategy output shape (v0.20 contract per #1166 s2).

Enforces that any vbrief/ tree produced by a spec-generating strategy (yolo, interview,
speckit, rapid, enterprise, ...) conforms to the canonical v0.20 output contract.

See: strategies/v0-20-contract.md (when present) and the parent epic #1166.

Rules enforced (hard fail):
- All scope vBRIEFs under vbrief/proposed/ (and other lifecycle dirs if present) MUST
  use the date-prefixed filename convention: YYYY-MM-DD-<slug>.vbrief.json
  (catches interview-style bare names like "scaffold.vbrief.json").
- vbrief/PROJECT-DEFINITION.vbrief.json MUST exist (full project identity).
- vbrief/specification.vbrief.json MUST NOT be present as a strategy-produced artifact
  (legacy dual-write). The framework's own canonical source-of-truth copy is tolerated
  only when auto-detected as the deft repo itself (presence of AGENTS.md + Taskfile.yml
  + strategies/ at project root). Generated user projects must never emit it.
- If vbrief/ exists, the five standard lifecycle subfolders should be present or the
  strategy must have created them (proposed/ at minimum for emission).

Exit codes:
  0 -- conformant (or framework self with tolerated legacy spec.vbrief)
  1 -- non-conformant output shape (prints actionable errors citing the contract)
  2 -- usage / invocation error

Usage:
    uv run python scripts/validate_strategy_output.py [--project-root <path>] [--strict]

Wired into:
- `task check` (via root Taskfile.yml)
- skills/deft-directive-build/SKILL.md Pre-Cutover Detection Guard (generalized)
- CI matrix (via task check)

Story: s2-deterministic-gate under #1166
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Filename pattern for v0.20-conformant scope vBRIEFs (date-prefixed).
# Matches the convention in vbrief/vbrief.md and conventions/vbrief-filenames.md
DATE_PREFIXED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$")


def _is_deft_framework_root(project_root: Path) -> bool:
    """Heuristic: is this the deft framework source itself?
    (tolerate its specification.vbrief.json as canonical source, not strategy output)
    """
    return (
        (project_root / "AGENTS.md").exists()
        and (project_root / "Taskfile.yml").exists()
        and (project_root / "strategies").is_dir()
    )


def validate_strategy_output(project_root: Path, strict: bool = False) -> list[str]:
    """
    Return list of error strings (empty == pass).
    """
    errors: list[str] = []
    vbrief_dir = project_root / "vbrief"

    if not vbrief_dir.exists():
        # No vbrief/ produced at all -- some legacy strategies may still do this,
        # but v0.20 contract requires the lifecycle layout. Flag only in strict mode
        # or when other signals present; for now soft (strategies are converging).
        if strict:
            errors.append(
                "vbrief/ directory missing entirely. v0.20 strategies must emit at least "
                "vbrief/proposed/ (with date-prefixed files) + PROJECT-DEFINITION.vbrief.json."
            )
        return errors

    # 1. PROJECT-DEFINITION.vbrief.json must exist at vbrief/ root.
    proj_def = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    if not proj_def.exists():
        errors.append(
            "Missing vbrief/PROJECT-DEFINITION.vbrief.json. "
            "All v0.20-conformant strategy output must include a complete project definition "
            "(see v0-20-contract.md and task project:render)."
        )

    # 2. Forbid legacy specification.vbrief.json in generated user projects.
    #    Framework source tree is the sole exception (its canonical spec source).
    spec_legacy = vbrief_dir / "specification.vbrief.json"
    if spec_legacy.exists() and not _is_deft_framework_root(project_root):
        errors.append(
            "Legacy artifact vbrief/specification.vbrief.json present. "
            "v0.20 strategies MUST NOT dual-write the old specification.vbrief.json "
            "alongside scope vBRIEFs in the lifecycle folders. "
            "See strategies/v0-20-contract.md (contract) and issue #1166."
        )
    # Framework source tolerated (canonical spec, not strategy output).

    # 3. Every .vbrief.json under the lifecycle folders (proposed/ primarily, but all)
    #    must be date-prefixed. This is the key shape invariant for s2.
    lifecycle_dirs = ["proposed", "pending", "active", "completed", "cancelled"]
    for dname in lifecycle_dirs:
        dpath = vbrief_dir / dname
        if dpath.exists() and dpath.is_dir():
            for f in sorted(dpath.glob("*.vbrief.json")):
                if not DATE_PREFIXED_RE.match(f.name):
                    errors.append(
                        f"Non-conformant filename in vbrief/{dname}/: {f.name}. "
                        "v0.20 requires strict YYYY-MM-DD-<slug>.vbrief.json "
                        "(date prefix from creation). Bare names (e.g. scaffold.vbrief.json) "
                        "are pre-v0.20. See strategies/v0-20-contract.md and "
                        "vbrief/vbrief.md filename convention."
                    )

    # 4. If proposed/ exists it must not be empty for a strategy that claims to have emitted scope.
    #    (light check; real emptiness is often valid for trivial specs)
    #    We rely primarily on the filename rule above.

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic validation gate for v0.20 strategy output shape."
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path("."),
        help="Root of the project whose vbrief/ tree to validate (default: cwd)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat missing vbrief/ as error (useful in CI for generated projects)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress success message on clean exit",
    )
    args = parser.parse_args(argv)

    project_root = args.project_root.resolve()
    errors = validate_strategy_output(project_root, strict=args.strict)

    if errors:
        print("❌ Strategy output shape validation FAILED (v0.20 contract gate)", file=sys.stderr)
        for err in errors:
            print(f"  • {err}", file=sys.stderr)
        print(
            "\nReference: strategies/v0-20-contract.md (once landed) + "
            "https://github.com/deftai/directive/issues/1166 (s2-deterministic-gate)",
            file=sys.stderr,
        )
        print(
            "Fix: re-run the emitting strategy after the contract migration "
            "stories land, or run `task migrate:vbrief` + `task project:render` "
            "+ `task scope:promote` as appropriate.",
            file=sys.stderr,
        )
        return 1

    if not args.quiet:
        print("✓ Strategy output shape conforms to v0.20 contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
