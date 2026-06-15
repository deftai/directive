#!/usr/bin/env python3
"""verify_vbrief_conformance.py -- deterministic vBRIEF 0.6 conformance gate (#1620).

directive is the vBRIEF reference implementation, so its own corpus must stay
conformant to the standard it anchors: every key at document, plan, and item
level MUST be either (a) a known 0.6 spec-core field, (b) prefixed
``x-directive/`` (a directive extension), or (c) prefixed ``x-vbrief/`` (a
vBRIEF extension). A bare key outside those three classes masquerades as
candidate-core and is exactly what produced the statusreport #34 false-RED.

This gate fails ``task check`` + the pre-commit hook when any tracked
``vbrief/**/*.vbrief.json`` carries such a bare key. It mirrors the structure
and UX of ``scripts/verify_encoding.py`` (#798): three-state exit, ``--all`` /
``--staged`` modes, and an ``--allow-list <path>`` file-glob override.

Core key sets
-------------
Built from the canonical vBRIEF 0.6 spec (``deftai/vBRIEF``
``docs/vbrief-spec-0.6.md`` + ``libvbrief/models.py``) and the in-repo mirror
``vbrief/schemas/vbrief-core.schema.json``. ``metadata`` is an arbitrary bag
per 0.6 (Design Goal #5) so the gate does NOT descend into it; likewise it does
not descend into ``vBRIEFInfo`` or narrative bodies -- only structural keys at
the document, plan, and item levels are checked.

Temporary Category B allow-list
-------------------------------
``plan.policy`` and ``plan.completedNote`` are genuine directive extensions
that SHOULD live under ``x-directive/`` but cannot be moved until upstream
vBRIEF #12 ratifies the ``x-<consumer>/`` namespace with round-trip
preservation. They are carved out via :data:`ALLOW_LIST` (a KEY allow-set,
distinct from the ``--allow-list`` file-glob override) and tracked by the
Category B follow-up issue cited below.

Plan-level ``planRef`` is handled specially (value-aware, see
:func:`_plan_planref_finding`): a PATH-style value is the load-bearing D4
epic<->story child->parent linkage and is allowed as a TEMPORARY carve-out
(its references[]-reconciliation + D4 rework is deferred to the same Category B
follow-up); a ``#``-prefixed value is the misused issue-pointer pattern behind
the statusreport #34 false-RED and IS flagged.

Exit codes (three-state, mirrors ``scripts/verify_encoding.py``)
----------------------------------------------------------------
- ``0`` -- clean: no bare keys detected.
- ``1`` -- violations: prints per-hit ``path [level] key`` diagnostics.
- ``2`` -- config error: no ``vbrief/`` directory, ``--allow-list`` path
  unreadable, ``--staged`` outside a git repo, or unrecognised CLI shape.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from collections.abc import Iterable
from pathlib import Path

# Route subprocess capture through the #1366 UTF-8-safe helper. The script
# lives in scripts/ alongside _safe_subprocess.py; add that dir to sys.path so
# the import resolves whether the module is run directly or loaded via
# importlib.spec_from_file_location in tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _safe_subprocess import run_text  # noqa: E402

#: Document-level (root) spec-core keys.
DOC_CORE: frozenset[str] = frozenset({"vBRIEFInfo", "plan"})

#: Plan-level spec-core keys (0.6). ``policy`` is DELIBERATELY EXCLUDED -- it is
#: a Category B directive extension carved out via :data:`ALLOW_LIST` so the
#: future ``plan.policy`` -> ``x-directive/policy`` migration stays enforceable
#: once the allow-list is removed.
PLAN_CORE: frozenset[str] = frozenset(
    {
        "id",
        "uid",
        "title",
        "status",
        "items",
        "narratives",
        "edges",
        "tags",
        "metadata",
        "created",
        "updated",
        "author",
        "reviewers",
        "uris",
        "references",
        "timezone",
        "agent",
        "lastModifiedBy",
        "changeLog",
        "sequence",
        "fork",
    }
)

#: Item-level (PlanItem) spec-core keys (0.6). ``planRef`` IS core here (it is a
#: legitimate item field for referencing plans); only the plan-LEVEL ``planRef``
#: misuse is non-conformant.
ITEM_CORE: frozenset[str] = frozenset(
    {
        "id",
        "uid",
        "title",
        "status",
        "narrative",
        "subItems",
        "planRef",
        "tags",
        "metadata",
        "created",
        "updated",
        "completed",
        "priority",
        "dueDate",
        "startDate",
        "endDate",
        "percentComplete",
        "participants",
        "location",
        "uris",
        "recurrence",
        "reminders",
        "classification",
        "relatedComments",
        "timezone",
        "sequence",
        "lastModifiedBy",
        "lockedBy",
        "items",
    }
)

#: Accepted extension-namespace prefixes. A key carrying either prefix is
#: conformant at any level (it is an explicitly-namespaced extension, not a
#: bare candidate-core key).
EXTENSION_PREFIXES: tuple[str, ...] = ("x-directive/", "x-vbrief/")

#: TEMPORARY Category B carve-outs (KEY allow-set, ``"<level>.<key>"`` form).
#: These are genuine directive extensions awaiting the ``x-<consumer>/``
#: namespace ratified by upstream vBRIEF #12; the migration that moves them to
#: ``x-directive/*`` and REMOVES this allow-list is tracked by directive #1650
#: (Category B follow-up to #1620).
ALLOW_LIST: frozenset[str] = frozenset({"plan.policy", "plan.completedNote"})


class Finding:
    """One bare-key conformance violation record."""

    __slots__ = ("path", "level", "key", "location")

    def __init__(self, path: str, level: str, key: str, location: str) -> None:
        self.path = path
        self.level = level
        self.key = key
        self.location = location

    def render(self) -> str:
        return f"  {self.path} [{self.level}] bare key {self.key!r} at {self.location}"


def _is_conformant(level: str, key: str, core: frozenset[str]) -> bool:
    """Return True when ``key`` is core, namespaced, or allow-listed at level."""
    if key in core:
        return True
    if key.startswith(EXTENSION_PREFIXES):
        return True
    return f"{level}.{key}" in ALLOW_LIST


def _plan_planref_finding(rel_path: str, value: object) -> Finding | None:
    """Value-aware check for the plan-LEVEL ``planRef`` key.

    Plan-level ``planRef`` is NOT 0.6 spec-core (``planRef`` is core only at the
    item level). directive carries two distinct shapes here:

    - A PATH-style value (``"completed/...vbrief.json"``) is the epic<->story
      child->parent linkage that ``scripts/vbrief_validate.py`` D4 validates
      bidirectionally. It is load-bearing and cannot move to ``references[]``
      without reworking D4, so it is a TEMPORARY carve-out tracked by the
      Category B follow-up (#1650) -- allowed (not flagged) here.
    - A ``#``-prefixed value (``"#1348"`` issue ref, or a stale ``#slug``) is
      the misused-as-issue-pointer pattern that produced the statusreport #34
      false-RED. It is FLAGGED so ``scripts/vbrief_migrate_conformance.py``
      (which routes it to ``references[]`` or deletes the junk) stays enforced.
    """
    if isinstance(value, str) and value.strip().startswith("#"):
        return Finding(
            rel_path, "plan", "planRef", "plan (issue-style -- migrate to references[])"
        )
    return None


def _scan_item(rel_path: str, item: dict, location: str) -> list[Finding]:
    """Scan one PlanItem dict (and its nested items / subItems) for bare keys."""
    findings: list[Finding] = []
    for key in item:
        if not _is_conformant("item", key, ITEM_CORE):
            findings.append(Finding(rel_path, "item", key, location))
    for nested_key in ("items", "subItems"):
        nested = item.get(nested_key)
        if isinstance(nested, list):
            for index, child in enumerate(nested):
                if isinstance(child, dict):
                    findings.extend(
                        _scan_item(
                            rel_path, child, f"{location}.{nested_key}[{index}]"
                        )
                    )
    return findings


def scan_vbrief(rel_path: str, data: object) -> list[Finding]:
    """Scan a parsed vBRIEF document for bare keys at doc / plan / item level.

    ``metadata`` (arbitrary bag), ``vBRIEFInfo``, and narrative bodies are NOT
    descended into -- only structural keys at the three checked levels.
    """
    findings: list[Finding] = []
    if not isinstance(data, dict):
        return findings

    for key in data:
        if not _is_conformant("document", key, DOC_CORE):
            findings.append(Finding(rel_path, "document", key, "<root>"))

    plan = data.get("plan")
    if not isinstance(plan, dict):
        return findings

    for key in plan:
        if key == "planRef":
            hit = _plan_planref_finding(rel_path, plan.get("planRef"))
            if hit is not None:
                findings.append(hit)
            continue
        if not _is_conformant("plan", key, PLAN_CORE):
            findings.append(Finding(rel_path, "plan", key, "plan"))

    items = plan.get("items")
    if isinstance(items, list):
        for index, item in enumerate(items):
            if isinstance(item, dict):
                findings.extend(
                    _scan_item(rel_path, item, f"plan.items[{index}]")
                )
    return findings


def _load_allow_list(path: Path | None) -> list[str]:
    """Read newline-separated file-glob patterns; ignore comments / blanks."""
    if path is None:
        return []
    raw = path.read_text(encoding="utf-8", errors="replace")
    out: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(stripped)
    return out


def _is_allow_listed(rel_path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(rel_path, pat) for pat in patterns)


def _git_files(project_root: Path, *, staged: bool) -> list[str]:
    """Return tracked (or staged) POSIX-form rel paths via git."""
    if staged:
        cmd = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    else:
        cmd = ["git", "ls-files"]
    proc = run_text(cmd, cwd=str(project_root))
    if proc.returncode != 0:
        raise RuntimeError(
            f"{' '.join(cmd)} failed (rc={proc.returncode}): {proc.stderr.strip()}"
        )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def _is_vbrief_path(posix: str) -> bool:
    """Return True for the project's root ``vbrief/**/*.vbrief.json`` corpus.

    Anchored at the project-root ``vbrief/`` directory (matching the scan scope
    of ``scripts/vbrief_migrate_conformance.py``) so the gate and the migration
    reason about exactly the same file set. This deliberately excludes
    ``.vbrief.json`` files nested under other directories -- most importantly
    intentionally-stale migration fixtures under ``tests/fixtures/**`` -- which
    are test artifacts, not the canonical corpus.
    """
    return posix.startswith("vbrief/") and posix.endswith(".vbrief.json")


def evaluate(
    project_root: Path,
    *,
    mode: str = "all",
    allow_list_path: Path | None = None,
) -> tuple[int, list[Finding], str]:
    """Pure driver returning ``(exit_code, findings, human_message)``."""
    if mode not in {"all", "staged"}:
        return (
            2,
            [],
            f"\u274c verify_vbrief_conformance: unrecognised mode {mode!r} "
            "(expected 'all' or 'staged').",
        )

    if not (project_root / "vbrief").is_dir():
        return (
            2,
            [],
            (
                "\u274c verify_vbrief_conformance: no vbrief/ directory under "
                f"{project_root}.\n"
                "  Recovery: run from a project root that contains vbrief/."
            ),
        )

    try:
        custom_globs = _load_allow_list(allow_list_path)
    except FileNotFoundError as exc:
        return (
            2,
            [],
            (
                f"\u274c verify_vbrief_conformance: --allow-list file not found: {exc}\n"
                "  Recovery: pass an existing path or omit the flag."
            ),
        )
    except OSError as exc:
        return (
            2,
            [],
            f"\u274c verify_vbrief_conformance: --allow-list unreadable: {exc}",
        )

    try:
        rel_paths = _git_files(project_root, staged=(mode == "staged"))
    except FileNotFoundError:
        return (
            2,
            [],
            "\u274c verify_vbrief_conformance: 'git' executable not found on PATH.",
        )
    except RuntimeError as exc:
        return (
            2,
            [],
            (
                f"\u274c verify_vbrief_conformance: git failed -- {exc}\n"
                "  Recovery: ensure --project-root points at a git working tree."
            ),
        )

    candidates = [
        posix
        for posix in (p.replace("\\", "/") for p in rel_paths)
        if _is_vbrief_path(posix) and not _is_allow_listed(posix, custom_globs)
    ]

    findings: list[Finding] = []
    for posix in candidates:
        full = project_root / posix
        try:
            text = full.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            # Malformed JSON is owned by vbrief:validate / verify:encoding; the
            # conformance gate only reasons about parseable documents.
            continue
        findings.extend(scan_vbrief(posix, data))

    if findings:
        header = (
            f"\u274c verify_vbrief_conformance: detected {len(findings)} bare "
            f"key(s) across {len({f.path for f in findings})} file(s) (#1620).\n"
            "  Every vBRIEF key MUST be 0.6 spec-core, x-directive/-namespaced, "
            "or x-vbrief/-namespaced -- never bare.\n"
            "  Fix: migrate misused/misspelled core fields to their core home "
            "(see scripts/vbrief_migrate_conformance.py), or namespace a genuine\n"
            "  extension under x-directive/. Allow-list a documented file "
            "exception via --allow-list <path> (newline-separated globs)."
        )
        body = "\n".join(f.render() for f in findings[:50])
        if len(findings) > 50:
            body += f"\n  ... and {len(findings) - 50} more"
        return 1, findings, f"{header}\n{body}"

    msg = (
        f"\u2713 verify_vbrief_conformance: {len(candidates)} vBRIEF file(s) "
        "clean -- no bare keys (#1620)."
    )
    return 0, findings, msg


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_vbrief_conformance.py",
        description=(
            "Deterministic vBRIEF 0.6 conformance gate (#1620). Flags any key "
            "at document/plan/item level that is not 0.6 spec-core, "
            "x-directive/-namespaced, or x-vbrief/-namespaced."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--all",
        dest="mode",
        action="store_const",
        const="all",
        help="Scan all tracked files via 'git ls-files' (default).",
    )
    mode.add_argument(
        "--staged",
        dest="mode",
        action="store_const",
        const="staged",
        help=(
            "Scan only staged files via 'git diff --cached --name-only' "
            "(used by .githooks/pre-commit)."
        ),
    )
    parser.set_defaults(mode="all")
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--allow-list",
        default=None,
        help=(
            "Path to a file with newline-separated glob patterns of "
            "documented file exceptions. Lines starting with # are comments."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # Force UTF-8 stdout/stderr at hook-script entry (mirrors #814).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    allow_list_path = Path(args.allow_list).resolve() if args.allow_list else None

    code, _findings, msg = evaluate(
        project_root,
        mode=args.mode,
        allow_list_path=allow_list_path,
    )
    if code == 0:
        if not args.quiet:
            print(msg)
    else:
        print(msg, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
