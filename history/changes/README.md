# history/changes/

Active change proposals live here. Each change is a self-contained folder created by `/deft:change <name>`.

## Directory Structure

```
history/changes/<name>/
├── proposal.md          ← Why this change, what's affected, scope
├── design.md            ← Technical approach, alternatives considered
├── tasks.vbrief.json    ← Implementation tasks in vBRIEF format
└── specs/               ← Spec deltas (how requirements change)
    └── <capability>/
        └── spec.md      ← New or modified requirements
```

## Lifecycle

1. **Create** — `/deft:change <name>` creates the folder with proposal, design, and task artifacts
2. **Propose** — Plan status moves from `draft` to `proposed` once submitted for review
3. **Approve** — User reviews and approves the proposal; plan status moves to `approved`
4. **Apply** — `/deft:change:apply` implements tasks following `blocks` edge ordering
5. **Verify** — `/deft:change:verify` checks acceptance criteria from task narratives
6. **Archive** — `/deft:change:archive` moves the folder to `history/archive/<date>-<name>/`

## Rules

- Each change folder is self-contained — all context needed to understand and implement lives inside it
- Only one change should be active at a time unless the user explicitly coordinates multiple
- Archived changes are immutable — never modify files in `history/archive/`
- Spec deltas are merged into the main specification before archiving

See [commands.md](../../commands.md) for the full command reference.
