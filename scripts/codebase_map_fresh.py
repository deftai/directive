#!/usr/bin/env python3
"""Freshness check for the #1595 generated codebase MAP projection."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import code_structure_validate
from codebase_default_extractor import config_error_to_dict, default_code_structure_path
from codebase_map import GENERATED_SENTINEL, projection_output_path, render_codebase_map
from codebase_provider import select_codebase_map


def check_codebase_map_fresh(
    project_root: Path,
    *,
    output_path: Path,
    artifact_path: str | None = None,
) -> list[str]:
    """Return freshness errors for the generated MAP projection."""
    resolved_output = output_path if output_path.is_absolute() else project_root / output_path
    # #1932: the generated MAP is an on-demand, gitignored artifact. An absent
    # projection is OK (advisory) -- the gate must not force per-branch
    # regeneration + commit, which guaranteed mechanical MAP.md collisions across
    # concurrent branches. When a MAP IS present locally the freshness check below
    # still flags it if stale; the durable plan.architecture.codeStructure stays
    # gated by codebase:validate-structure.
    if not resolved_output.exists():
        return []
    try:
        current = resolved_output.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"generated codebase MAP could not be read: {exc}"]
    if GENERATED_SENTINEL not in current[:4096]:
        return [
            f"generated codebase MAP lacks the {GENERATED_SENTINEL!r} banner: "
            f"{resolved_output}"
        ]

    selection = select_codebase_map(project_root, artifact_path=artifact_path)
    expected = render_codebase_map(selection.artifact)
    if current != expected:
        return [
            "generated codebase MAP is stale; run `task codebase:map` "
            f"to refresh {resolved_output}"
        ]
    return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify generated codebase MAP freshness.")
    parser.add_argument("--project-root", default=".", help="Repository root to inspect.")
    parser.add_argument("--output", help="Projection output path.")
    parser.add_argument("--artifact-path", help="Read a provider artifact from this path.")
    parser.add_argument("--json", action="store_true", help="Emit a JSON result envelope.")
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    try:
        output_path = projection_output_path(project_root, args.output)
        errors = check_codebase_map_fresh(
            project_root,
            output_path=output_path,
            artifact_path=args.artifact_path,
        )
    except code_structure_validate.CodeStructureConfigError as exc:
        if args.json:
            print(
                json.dumps(
                    config_error_to_dict(default_code_structure_path(project_root, None), exc),
                    indent=2,
                    sort_keys=True,
                )
            )
        else:
            print(str(exc), file=sys.stderr)
        return 2

    if args.json:
        resolved_output = output_path if output_path.is_absolute() else project_root / output_path
        print(
            json.dumps(
                {
                    "ok": not errors,
                    "path": str(resolved_output),
                    "errors": errors,
                },
                indent=2,
                sort_keys=True,
            )
        )
    elif errors:
        for error in errors:
            print(f"Error: {error}", file=sys.stderr)
    else:
        print("OK: generated codebase MAP is fresh")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
