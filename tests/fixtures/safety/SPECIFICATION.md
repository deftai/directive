# Safety Fixture SPECIFICATION

Synthetic pre-cutover SPECIFICATION.md used exclusively by safety tests for
`scripts/migrate_vbrief.py` (#497).  Intentionally tiny and version-agnostic
so it does not drift as the live project spec evolves.

## Problem Statement

Operators need preview, backup, and rollback affordances before running a
destructive migration step.

## Goals

- Prove that backups capture the exact bytes that existed before migration.
- Prove that --dry-run never writes.
- Prove that --rollback restores the pre-migration tree.

## Requirements

- FR-1: Every pre-cutover input has a `.premigrate.*` sibling after migrate.
- FR-2: `git status --porcelain` non-empty refuses to run without `--force`.
