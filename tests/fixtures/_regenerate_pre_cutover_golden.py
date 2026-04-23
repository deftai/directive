"""Regenerate the ``pre_cutover_customized.expected`` golden fixture.

Run from the repo root:

    uv run python tests/fixtures/_regenerate_pre_cutover_golden.py

Copies ``tests/fixtures/pre_cutover_customized/`` into a scratch dir,
pins ``_TODAY`` / ``_MIGRATION_TIMESTAMP`` to the deterministic values the
byte-for-byte test expects, runs ``migrate()`` over the copy, then copies
the produced tree back to ``tests/fixtures/pre_cutover_customized.expected/``.

This is a maintainer-only helper -- NOT invoked by the test suite. Use it
whenever the migrator's canonical output shape changes on purpose (e.g.
#613 + #616) so the golden fixture keeps telling the truth.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import migrate_vbrief  # noqa: E402

FIXTURE_INPUT = REPO_ROOT / "tests" / "fixtures" / "pre_cutover_customized"
FIXTURE_EXPECTED = REPO_ROOT / "tests" / "fixtures" / "pre_cutover_customized.expected"
PINNED_DATE = "2026-04-21"
PINNED_TIMESTAMP = "2026-04-21T00:00:00Z"


def main() -> int:
    # Pin the date constants so the produced filenames / timestamps match
    # the deterministic expectations in test_every_emitted_json_matches_
    # expected_bytes.
    migrate_vbrief._TODAY = PINNED_DATE
    migrate_vbrief._MIGRATION_TIMESTAMP = PINNED_TIMESTAMP

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "work"
        shutil.copytree(FIXTURE_INPUT, work)
        ok, actions = migrate_vbrief.migrate(work)
        if not ok:
            print("migrate() failed:", actions, file=sys.stderr)
            return 1

        # Wipe the expected tree and recopy. We only regenerate the files
        # the test compares byte-for-byte; other markers (PROJECT.md,
        # SPECIFICATION.md, plus auxiliary vbrief roots) are copied too.
        if FIXTURE_EXPECTED.exists():
            shutil.rmtree(FIXTURE_EXPECTED)
        FIXTURE_EXPECTED.mkdir(parents=True, exist_ok=True)

        # Mirror the set of files the original expected tree carried.
        for src in work.rglob("*"):
            if not src.is_file():
                continue
            rel = src.relative_to(work)
            # Skip migrator backups + reconciliation reports -- not in
            # the tracked expected tree.
            if ".premigrate" in src.name:
                continue
            if rel.parts[:2] == ("vbrief", "migration"):
                continue
            if rel.parts[:2] == ("vbrief", "legacy"):
                continue
            if src.name == ".migrate_vbrief.safety.json":
                continue
            if src.name == ".gitignore":
                continue
            # ROADMAP.md is a pre-cutover input consumed by the migrator;
            # it survives the migration run unchanged and is NOT part of
            # the canonical expected tree.
            if src.name == "ROADMAP.md":
                continue
            dest = FIXTURE_EXPECTED / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
    print(f"regenerated {FIXTURE_EXPECTED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
