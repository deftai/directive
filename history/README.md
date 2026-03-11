# History

Scoped change proposals and their archive.

## Directory Structure

```
history/
├── changes/             ← Active changes (in progress or awaiting review)
│   └── <name>/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.vbrief.json
│       └── specs/
│           └── <capability>/
│               └── spec.md
└── archive/             ← Completed changes (historical record)
    └── <date>-<name>/
        └── (same structure as above)
```

## Lifecycle

1. **Create** — `/deft:change <name>` creates `changes/<name>/`
2. **Review** — User reviews proposal.md, design.md, tasks
3. **Apply** — `/deft:change:apply` implements tasks
4. **Verify** — `/deft:change:verify` checks outcomes
5. **Archive** — `/deft:change:archive` moves to `archive/<date>-<name>/`

See [commands.md](../commands.md) for full workflow documentation.

## Conventions

- Change names use hyphens: `add-dark-mode`, `fix-auth-timeout`
- Archive entries are prefixed with `YYYY-MM-DD`
- Archived changes are never modified
- Each change is self-contained — all context needed to understand it lives in its folder

## Archive Merge

When a change is archived, its spec deltas are merged into the project's main `SPECIFICATION.md`. The archived copy remains as a historical record of *why* the spec changed. See [context/spec-deltas.md](../context/spec-deltas.md) for the merge protocol.

A CHANGELOG entry summarizing the change should also be added, using the change's `proposal.md` as the source.
