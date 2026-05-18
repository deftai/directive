#!/usr/bin/env python3
"""``task policy:show`` argparse shim (#1148 / N8 of #1119 Wave-2d-1).

Extracted from :mod:`scripts.policy` so the parent module stays well
under the 1000-line MUST cap from ``coding/coding.md``. The CLI delegates
to :func:`policy.inspect_all_policies` / :func:`policy.inspect_one_policy`
for every read; the render layer here is purely cosmetic.

Flags (mirror the #1148 issue body):

* ``--format=text|json`` -- ``text`` is the default human form (one block
  per field); ``json`` emits the stable schema
  ``{generated_at, fields: [{name, current, default, source}, ...]}``.
* ``--changed-only`` -- drop rows whose source is ``default`` so the
  output focuses on what the operator actually configured. Combines
  cleanly with ``--format=json`` for ``jq`` consumption.
* ``--field=<canonical-dotted-path>`` -- show exactly one registered
  field; exit 2 with the recognised-names list when ``<name>`` is not
  a registered field. Mutually compatible with ``--format=json``.
* ``--project-root <path>`` -- override the project root (defaults to
  ``Path.cwd()``); useful for tests + tools dispatching from outside
  the consumer working directory.

Exit codes:

* ``0`` -- success (including the "all defaults" + "missing
  PROJECT-DEFINITION" cases; the verb is informational).
* ``2`` -- argparse usage error OR unknown ``--field=<name>``.

Pure-stdlib; runs anywhere :mod:`scripts.policy` does.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked as
# ``python scripts/_policy_show_cli.py`` (the dispatch shape go-task uses).
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the rendered values for ``triageScope`` etc.
# can include non-ASCII characters that crash cp1252 on Windows.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")

import policy  # noqa: E402  (sibling import after sys.path tweak)

# ---------------------------------------------------------------------------
# Public helpers (test-injectable)
# ---------------------------------------------------------------------------


def _utc_iso(dt: datetime | None = None) -> str:
    """ISO-8601 UTC timestamp with seconds precision and ``Z`` suffix."""
    return (dt or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def field_to_dict(field: policy.PolicyField) -> dict[str, Any]:
    """Render one :class:`policy.PolicyField` as a JSON-stable dict.

    Stable key order: ``name``, ``current``, ``default``, ``source``.
    Stable across releases -- the JSON schema is the scripting contract.
    """
    return {
        "name": field.name,
        "current": field.current,
        "default": field.default,
        "source": field.source,
    }


def render_json(
    fields: list[policy.PolicyField],
    *,
    now: datetime | None = None,
) -> str:
    """Render the JSON envelope ``{generated_at, fields: [...]}``.

    ``ensure_ascii=False`` so non-ASCII operator values (rare but
    possible -- e.g. milestone names with em dashes) survive the
    serialisation round-trip without ``\\uXXXX`` escaping.
    """
    envelope = {
        "generated_at": _utc_iso(now),
        "fields": [field_to_dict(f) for f in fields],
    }
    return json.dumps(envelope, ensure_ascii=False, indent=2, sort_keys=False)


def _format_value(value: Any) -> str:
    """Render a value for the text format.

    Booleans render as ``true`` / ``false`` (the issue-body example output
    used lowercase JSON-style booleans). Lists and dicts round-trip
    through ``json.dumps`` for a stable, copy-pasteable shape. Strings
    render verbatim; numbers via ``repr`` so floats keep precision.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, sort_keys=False)
    if isinstance(value, str):
        return value
    return repr(value)


def render_text(fields: list[policy.PolicyField]) -> str:
    """Render the human-readable text format from the issue body.

    Each field renders as a four-line block:

    .. code-block:: text

        [policy] <name>
          current: <value>
          default: <value>
          source:  <typed|default|legacy>

    Blocks are separated by a blank line. An empty ``fields`` list
    (``--changed-only`` against an all-defaults config) renders a single
    informational line so the operator does not see a blank screen.
    """
    if not fields:
        return (
            "[policy] (no fields changed)\n"
            "  All registered policies are at their framework defaults. "
            "Re-run without `--changed-only` to inspect them."
        )
    blocks: list[str] = []
    for field in fields:
        block = (
            f"[policy] {field.name}\n"
            f"  current: {_format_value(field.current)}\n"
            f"  default: {_format_value(field.default)}\n"
            f"  source:  {field.source}"
        )
        blocks.append(block)
    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# argparse setup
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="task policy:show",
        description=(
            "Inspect every registered typed-policy field on "
            "vbrief/PROJECT-DEFINITION.vbrief.json (#1148 / N8 of #1119)."
        ),
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Output format (default: text). Use json for stable scripting schema.",
    )
    parser.add_argument(
        "--changed-only",
        action="store_true",
        help=(
            "Filter out fields whose source is 'default'. "
            "Keeps 'typed' and 'legacy' rows only."
        ),
    )
    parser.add_argument(
        "--field",
        dest="field",
        metavar="<name>",
        default=None,
        help=(
            "Show exactly one registered field by canonical dotted path "
            "(e.g. plan.policy.wipCap). Exits 2 on unknown name."
        ),
    )
    parser.add_argument(
        "--project-root",
        dest="project_root",
        metavar="<path>",
        default=None,
        help="Project root (default: current working directory).",
    )
    return parser


def run_cli(argv: list[str] | None = None) -> int:
    """Argparse + dispatch for ``task policy:show``.

    Exit 0 in every success path (including all-defaults and missing
    PROJECT-DEFINITION). Exit 2 for argparse usage errors and for
    ``--field=<name>`` where ``<name>`` is not a registered field.
    """
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse already emitted its error to stderr; preserve its code.
        return int(exc.code) if isinstance(exc.code, int) else 2

    project_root = (
        Path(args.project_root).resolve() if args.project_root else Path.cwd()
    )

    # Surface a friendly informational line on missing PROJECT-DEFINITION so
    # the operator understands why every row will be at default. Exit 0;
    # show is informational by contract.
    pd_path = project_root / policy.PROJECT_DEFINITION_REL_PATH
    if not pd_path.is_file():
        sys.stderr.write(
            f"[policy:show] PROJECT-DEFINITION not found at {pd_path}; "
            "rendering framework defaults.\n"
        )

    if args.field is not None:
        return _dispatch_single_field(args, project_root)
    return _dispatch_all_fields(args, project_root)


def _dispatch_single_field(args: argparse.Namespace, project_root: Path) -> int:
    field = policy.inspect_one_policy(args.field, project_root)
    if field is None:
        known = policy.registered_policy_names()
        sys.stderr.write(
            f"[policy:show] unknown --field={args.field!r}; "
            f"registered fields: {known}\n"
        )
        return 2
    # ``--changed-only`` against a single-field default is a no-op render --
    # operators asking for a single field by name almost always want to see
    # it regardless of source. The default branch keeps the row; the
    # ``--changed-only`` filter only fires across the all-fields surface.
    if args.format == "json":
        sys.stdout.write(render_json([field]) + "\n")
    else:
        sys.stdout.write(render_text([field]) + "\n")
    return 0


def _dispatch_all_fields(args: argparse.Namespace, project_root: Path) -> int:
    fields = policy.inspect_all_policies(project_root)
    if args.changed_only:
        fields = [f for f in fields if f.source != "default"]
    if args.format == "json":
        sys.stdout.write(render_json(fields) + "\n")
    else:
        sys.stdout.write(render_text(fields) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Alias for :func:`run_cli` so tests can patch it."""
    return run_cli(argv)


if __name__ == "__main__":
    sys.exit(main())
