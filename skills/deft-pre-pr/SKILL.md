---
name: deft-pre-pr
description: >
  Iterative pre-PR quality improvement loop. Use before pushing a branch
  for PR creation -- after completing implementation but before task check.
  Cycles through Read-Write-Lint-Diff until a full pass produces zero changes.
---

# Deft Pre-PR -- Read, Write, Lint, Diff, Loop

Structured self-review loop agents run before submitting a PR. Catches inconsistencies, missing enforcement markers, incomplete acceptance criteria, scope creep, and unintended changes before they reach the reviewer.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [deft-review-cycle](../deft-review-cycle/SKILL.md) | [deft-build](../deft-build/SKILL.md) | [RWLDL tool](../../tools/RWLDL.md)

> **Formerly `deft-rwldl`** -- renamed to clearly communicate the skill's purpose (iterative pre-PR quality loop).

## When to Use

- ! Before pushing a branch for PR creation
- ! After completing implementation but before the final `task check` gate
- ~ After addressing bot reviewer findings (run one RWLDL pass before pushing the fix batch)
- ? During mid-implementation checkpoints on large changes

## Loop Phases

Each iteration proceeds through all five phases in order. Do NOT skip phases or reorder them.

### Phase 1 -- Read

! Re-read each changed file end-to-end (`git diff master --name-only` to get the list).

- ! Read every changed file in full -- do not skim or skip sections
- ! Compare each file against its spec task acceptance criteria in `SPECIFICATION.md`
- ! When adding a `!` or `⊗` rule that prohibits a specific command, pattern, or behavior, search the same file for any `~`, `≉`, or prose that recommends or permits the same command/pattern -- resolve all contradictions in the same commit before pushing
- ! When strengthening a rule (e.g. upgrading `~` to `!`), grep for the term in the full file and verify no weaker-strength duplicate remains
- ~ Note any inconsistencies, missing RFC2119 markers, stale cross-references, or incomplete sections
- ~ Check that CHANGELOG.md entries match the actual changes made

### Phase 2 -- Write

! Fix any issues found in the Read phase.

- ! Fix inconsistencies, add missing RFC2119 enforcement markers (`!`, `~`, `⊗`)
- ! Complete any incomplete acceptance criteria or missing content
- ! Update stale cross-references
- ~ Improve clarity where intent is ambiguous
- ⊗ Make changes beyond the scope of the current task -- if you notice unrelated issues, file them as ideas or future work, do not fix them now

### Phase 3 -- Lint

! Run `task check` and fix any failures.

- ! Run `task check` (fmt + lint + typecheck + tests + coverage)
- ! Fix all failures before proceeding to Phase 4
- ~ If a lint fix requires changing a file, that counts as a change for the Loop phase

### Phase 4 -- Diff

! Review the full diff against the base branch for unintended changes.

```
git --no-pager diff master
```

- ! Verify no files outside the task scope were modified
- ! Check for scope creep -- changes that go beyond the spec task acceptance criteria
- ! Verify no debug code, TODO comments, or temporary scaffolding remains
- ! Confirm no unintended whitespace-only changes or formatting drift
- ~ Verify the diff tells a coherent story -- a reviewer reading it top-to-bottom should understand the change

### Phase 5 -- Loop

! Decide whether to restart or exit.

- ! If ANY fixes were made in Phase 2 (Write) or Phase 3 (Lint): restart from Phase 1 (Read)
- ! If a full Read-Write-Lint-Diff cycle produced zero changes: exit the loop
- ~ Track iteration count -- if you exceed 3 iterations, pause and assess whether you are oscillating between competing fixes

## Exit Condition

! Exit when a complete Read-Write-Lint-Diff cycle produces **zero changes** -- no file edits in Write, no lint fixes in Lint, and no scope issues in Diff.

After exiting:
- ! Run `task check` one final time to confirm clean state
- ~ The branch is now ready for push and PR creation

## Anti-Patterns

- ⊗ Submit a PR without running the RWLDL loop -- every PR branch should pass at least one full cycle
- ⊗ Exit the loop after the Lint phase without completing the Diff phase -- Diff catches scope creep and unintended changes that Lint cannot detect
- ⊗ Skip the Read phase and jump directly to Lint -- Read catches semantic issues (missing content, wrong RFC2119 markers, incomplete acceptance criteria) that linters do not check
- ⊗ Make out-of-scope fixes during Write -- this introduces scope creep that Diff will flag, forcing another iteration
- ⊗ Ignore the iteration count -- more than 3 iterations usually indicates oscillating fixes or an unclear spec task
- ⊗ Add a prohibition (`!` or `⊗`) without scanning the same file for conflicting softer-strength rules (`~`, `≉`) that reference the same term
