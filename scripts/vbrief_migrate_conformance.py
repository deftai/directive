#!/usr/bin/env python3
"""vbrief_migrate_conformance.py -- idempotent Category A vBRIEF 0.6 conformance
migration (#1620).

directive is the vBRIEF reference implementation, yet its own corpus emits a
handful of bare, non-namespaced keys that are misused / misspelled CORE fields.
0.6 *permits* unknown fields (they MUST be preserved), so these are not hard
spec breaks -- but they violate directive's own discipline (consumer usage must
be core-correct or ``x-directive/`` / ``x-vbrief/`` namespaced, never bare) and
produced the statusreport #34 false-RED.

This script migrates the **Category A** correctness bugs to their correct core
home. Category B namespacing (``plan.policy`` -> ``plan["x-directive/policy"]``)
is DEFERRED to a follow-up because it depends on upstream vBRIEF #12; it is NOT
touched here.

Migrations (Category A only)
----------------------------

1. ``plan.planRef`` (plan-LEVEL) that is a bare GitHub ISSUE ref ``"#1348"`` ->
   append a deduped ``plan.references[]`` entry ``{ "uri":
   "https://github.com/deftai/directive/issues/1348", "type":
   "x-vbrief/github-issue", "title": "Issue #1348" }``, then delete ``planRef``.
   This is the misused-as-issue-pointer pattern that produced the statusreport
   #34 false-RED.

   IMPORTANT -- what is LEFT UNTOUCHED:

   - A PATH-style plan-level ``planRef`` (e.g. ``"completed/...vbrief.json"``)
     is the directive epic<->story child->parent linkage that
     ``scripts/vbrief_validate.py`` D4 validates bidirectionally. Migrating it
     to ``references[]`` breaks D4 (which reads the back-pointer from
     ``planRef``), so it is deliberately NOT migrated here. Reconciling that
     linkage onto ``references[]`` (and reworking D4) is deferred to the
     Category B follow-up (#1650).
   - item-LEVEL ``planRef`` is a legitimate 0.6 core field
     (``PlanItem.planRef``) and is LEFT UNTOUCHED.

   A ``#``-prefixed plan-level ``planRef`` that is NOT a numeric issue ref
   (e.g. a stale symbolic slug) carries no valid issue/path target and is
   simply deleted -- the real references already live in ``references[]``.

2. item-level ``description`` (prose) -> item-level ``narrative`` (the core
   field). ``narrative`` is an object in 0.6, so a string ``description`` is
   wrapped as ``{ "Description": <prose> }``. When the item already has a
   ``narrative`` the existing keys win and ``description`` is folded in
   non-destructively.

3. item-level ``narratives`` (PLURAL -- a copy-paste typo at item level) ->
   item-level ``narrative`` (SINGULAR). The plan-LEVEL ``narratives`` (plural)
   is the correct/expected key and is LEFT UNTOUCHED -- only the item-level
   typo is migrated.

Formatting
----------
Files are read / written via ``pathlib.Path.read_text(encoding="utf-8")`` /
``write_text(..., encoding="utf-8")`` per the #798 PowerShell/encoding rule.
The output preserves key order (``json.load`` / ``json.dump`` are
order-preserving) and matches each file's existing formatting -- 2-space
indent, a trailing newline, and the file's original ``ensure_ascii`` style
(detected per file) -- so an unchanged file is never rewritten and a changed
file produces a minimal diff.

Modes
-----
- default (write): apply every needed change, print a per-file summary, exit 0.
- ``--check`` (dry-run): mutate nothing; exit 0 when the corpus is already
  conformant (a no-op second run), else print the per-file summary and exit 1.

Exit codes
----------
- ``0`` -- write mode succeeded, OR ``--check`` found no needed changes.
- ``1`` -- ``--check`` found needed changes (drift).
- ``2`` -- config error (``--project-root`` has no ``vbrief/`` directory).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

#: A plan-level ``planRef`` that is a bare GitHub issue ref, e.g. ``"#1348"``.
_ISSUE_REF = re.compile(r"^#(\d+)$")

#: Canonical issue-URL base for directive. The corpus is single-repo, so a
#: bare ``#N`` always resolves to deftai/directive (mirrors the existing
#: ``x-vbrief/github-issue`` references already present across the corpus).
_ISSUE_URL_BASE = "https://github.com/deftai/directive/issues"


def _rename_key_inplace(d: dict, old: str, new: str, new_value: object) -> None:
    """Replace ``old`` key with ``new`` (value ``new_value``) preserving order.

    Rebuilds the dict so ``new`` occupies ``old``'s position. Caller guarantees
    ``new`` is not already present (else the existing ``new`` would be dropped).
    """
    rebuilt = {}
    for key, value in d.items():
        if key == old:
            rebuilt[new] = new_value
        else:
            rebuilt[key] = value
    d.clear()
    d.update(rebuilt)


def _issue_reference(number: str) -> tuple[dict, str]:
    """Build the ``x-vbrief/github-issue`` ``references[]`` entry + dedupe-uri."""
    uri = f"{_ISSUE_URL_BASE}/{number}"
    return (
        {"uri": uri, "type": "x-vbrief/github-issue", "title": f"Issue #{number}"},
        uri,
    )


def _migrate_plan_ref(plan: dict, changes: list[str]) -> None:
    """Migrate / clean a plan-level ``planRef`` per its value shape.

    - ``"#1348"`` (numeric issue ref) -> deduped ``references[]`` entry, delete.
    - ``"#some-slug"`` (``#``-prefixed, non-numeric junk) -> delete (the real
      references already live in ``references[]``).
    - anything else (a PATH-style child->parent link) -> LEFT UNTOUCHED: it is
      the D4 epic<->story linkage read by ``scripts/vbrief_validate.py``;
      migrating it would break that bidirectional check (deferred to #1650).
    """
    if "planRef" not in plan:
        return
    value = plan["planRef"]
    sval = value.strip() if isinstance(value, str) else ""
    match = _ISSUE_REF.match(sval)

    if match is not None:
        entry, dedupe_uri = _issue_reference(match.group(1))
        refs = plan.get("references")
        if isinstance(refs, list):
            existing = {
                r.get("uri") for r in refs if isinstance(r, dict) and "uri" in r
            }
            if dedupe_uri in existing:
                del plan["planRef"]
                changes.append(
                    f"planRef {value!r} dropped (references[] already has {dedupe_uri})"
                )
            else:
                refs.append(entry)
                del plan["planRef"]
                changes.append(f"planRef {value!r} -> references[] (x-vbrief/github-issue)")
        else:
            # No references[] yet: put it where planRef was for a minimal diff.
            _rename_key_inplace(plan, "planRef", "references", [entry])
            changes.append(
                f"planRef {value!r} -> new references[] (x-vbrief/github-issue)"
            )
        return

    if sval.startswith("#"):
        del plan["planRef"]
        changes.append(f"planRef {value!r} removed (non-issue, non-path bare ref)")
        return

    # Path-style child->parent link: leave it for the D4 validator (see #1650).


def _fold_into_narrative(item: dict, source_key: str, changes: list[str]) -> None:
    """Migrate item-level ``description`` / ``narratives`` -> ``narrative``.

    ``narrative`` is a 0.6 object field. A string source is wrapped under a
    sensible key; an object source is renamed / merged. An existing
    ``narrative`` wins on key conflicts (the source is folded in
    non-destructively).
    """
    if source_key not in item:
        return
    source = item[source_key]
    # The wrapper key used when the source is a bare string.
    wrap_key = "Description" if source_key == "description" else "Narrative"

    if "narrative" not in item:
        if isinstance(source, dict):
            new_value: object = dict(source)
        else:
            new_value = {wrap_key: source}
        _rename_key_inplace(item, source_key, "narrative", new_value)
        changes.append(f"item {source_key} -> narrative")
        return

    # narrative already present: fold the source in, prefer existing keys.
    narrative = item["narrative"]
    if isinstance(narrative, dict):
        if isinstance(source, dict):
            for key, value in source.items():
                narrative.setdefault(key, value)
        else:
            narrative.setdefault(wrap_key, source)
    del item[source_key]
    changes.append(f"item {source_key} folded into existing narrative")


def _walk_items(items: list, changes: list[str]) -> None:
    """Recurse item / subItem trees applying the item-level migrations."""
    for item in items:
        if not isinstance(item, dict):
            continue
        _fold_into_narrative(item, "description", changes)
        _fold_into_narrative(item, "narratives", changes)
        for nested_key in ("items", "subItems"):
            nested = item.get(nested_key)
            if isinstance(nested, list):
                _walk_items(nested, changes)


def migrate_data(data: dict) -> list[str]:
    """Apply all Category A migrations to ``data`` in place; return change log."""
    changes: list[str] = []
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return changes
    _migrate_plan_ref(plan, changes)
    items = plan.get("items")
    if isinstance(items, list):
        _walk_items(items, changes)
    return changes


def _detect_indent_ensure_ascii(original: str, data: dict) -> bool:
    """Return the ``ensure_ascii`` value that reproduces ``original``.

    617/618 corpus files use ``ensure_ascii=False``; one historical file uses
    ASCII-escaped unicode. Detecting per file keeps a changed file's diff
    minimal (it is never re-escaped / un-escaped as a side effect).
    """
    if json.dumps(data, indent=2, ensure_ascii=False) + "\n" == original:
        return False
    # Default to ensure_ascii=False (canonical) unless the ASCII-escaped form
    # is the exact reproduction of the original.
    return json.dumps(data, indent=2, ensure_ascii=True) + "\n" == original


def _serialize(data: dict, ensure_ascii: bool) -> str:
    return json.dumps(data, indent=2, ensure_ascii=ensure_ascii) + "\n"


def iter_vbrief_files(project_root: Path) -> list[Path]:
    """Return sorted ``vbrief/**/*.vbrief.json`` paths under ``project_root``."""
    vbrief_dir = project_root / "vbrief"
    if not vbrief_dir.is_dir():
        return []
    return sorted(vbrief_dir.rglob("*.vbrief.json"))


def evaluate(
    project_root: Path,
    *,
    check: bool = False,
) -> tuple[int, list[tuple[str, list[str]]], str]:
    """Pure driver returning ``(exit_code, per_file_changes, human_message)``.

    Separated from :func:`main` so tests can drive every state without CLI
    plumbing. In write mode (``check=False``) changed files are persisted.
    """
    vbrief_dir = project_root / "vbrief"
    if not vbrief_dir.is_dir():
        return (
            2,
            [],
            (
                f"\u274c vbrief_migrate_conformance: no vbrief/ directory under "
                f"{project_root}.\n"
                "  Recovery: run from a project root that contains vbrief/."
            ),
        )

    per_file: list[tuple[str, list[str]]] = []
    for path in iter_vbrief_files(project_root):
        original = path.read_text(encoding="utf-8")
        try:
            data = json.loads(original)
        except json.JSONDecodeError:
            # Leave unparseable files alone; the conformance gate / encoding
            # gate own malformed-file reporting.
            continue
        changes = migrate_data(data)
        if not changes:
            continue
        rel = path.relative_to(project_root).as_posix()
        per_file.append((rel, changes))
        if not check:
            ensure_ascii = _detect_indent_ensure_ascii(original, json.loads(original))
            path.write_text(_serialize(data, ensure_ascii), encoding="utf-8")

    if not per_file:
        msg = (
            "\u2713 vbrief_migrate_conformance: corpus already conformant "
            "(no Category A migrations needed) (#1620)."
        )
        return 0, per_file, msg

    verb = "would change" if check else "changed"
    marker = "\u26a0" if check else "\u2713"
    lines = [
        f"{marker} vbrief_migrate_conformance: "
        f"{verb} {len(per_file)} file(s) (Category A, #1620)."
    ]
    for rel, changes in per_file:
        lines.append(f"  {rel}")
        for change in changes:
            lines.append(f"    - {change}")
    message = "\n".join(lines)
    # --check signals drift with exit 1; write mode reports success with exit 0.
    return (1 if check else 0), per_file, message


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vbrief_migrate_conformance.py",
        description=(
            "Idempotent Category A vBRIEF 0.6 conformance migration (#1620): "
            "plan.planRef -> plan.references[], item description/narratives -> "
            "item narrative."
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Dry-run: mutate nothing. Exit 0 when no changes are needed, "
            "else print a per-file summary and exit 1."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing vbrief/ (default: current directory).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the success message (drift/errors still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # Force UTF-8 stdout/stderr so the non-ASCII status glyphs survive a
    # Windows cp1252/cp437 console (mirrors scripts/verify_encoding.py #814).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()

    code, _per_file, message = evaluate(project_root, check=args.check)
    if code == 0:
        if not args.quiet:
            print(message)
    else:
        print(message, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
