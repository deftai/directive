---
name: deft-directive-pre-pr
description: >
  Iterative pre-PR quality improvement loop. Use before pushing a branch
  for PR creation -- after completing implementation but before task check.
  Cycles through Read-Write-Lint-Diff until a full pass produces zero changes.
---

# Deft Directive Pre-PR -- Read, Write, Lint, Diff, Loop

Structured self-review loop agents run before submitting a PR. Catches inconsistencies, missing enforcement markers, incomplete acceptance criteria, scope creep, and unintended changes before they reach the reviewer.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [deft-directive-review-cycle](../deft-directive-review-cycle/SKILL.md) | [deft-directive-build](../deft-directive-build/SKILL.md) | [RWLDL tool](../../tools/RWLDL.md)

> **Formerly `deft-rwldl`** -- renamed to clearly communicate the skill's purpose (iterative pre-PR quality loop).

## When to Use

- ! Before pushing a branch for PR creation
- ! After completing implementation but before the final `task check` gate
- ~ After addressing bot reviewer findings (run one RWLDL pass before pushing the fix batch)
- ? During mid-implementation checkpoints on large changes

## Loop Phases

Each iteration proceeds through all phases in order. Do NOT skip phases or reorder them.

### Phase 1 -- Read

! Re-read each changed file end-to-end (`git diff master --name-only` to get the list).

- ! Read every changed file in full -- do not skim or skip sections
- ! Compare each file against its scope vBRIEF acceptance criteria in `vbrief/active/`
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
- ! Fix all failures before proceeding to Phase 3b
- ~ If a lint fix requires changing a file, that counts as a change for the Loop phase

### Phase 3b -- Auto-Render Exports

! If `vbrief/specification.vbrief.json` exists, refresh rendered exports before the diff check:

- ! Run `task prd:render` if `PRD.md` already exists in the project root
- ! Run `task spec:render` if `SPECIFICATION.md` already exists and does not contain `<!-- deft:deprecated-redirect -->`
- ⊗ Create export files that don't already exist -- only refresh existing ones

### Phase 4 -- Diff

! Review the full diff against the base branch for unintended changes.

```
git --no-pager diff master
```

- ! Verify no files outside the task scope were modified
- ! Check for scope creep -- changes that go beyond the spec task acceptance criteria
- ! Verify no debug code, TODO comments, or temporary scaffolding remains
- ! Confirm no unintended whitespace-only changes or formatting drift
- ! **Run `task pr:check-closing-keywords -- --pr <N>` (or pass `--body-file` / `--commits-file` for offline checking) before opening the PR; refuse to push if findings (#737)**. The lint scans both the PR body AND every commit message for closing-keyword tokens (`close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved`) followed by `#\d+` in negation / quotation / example / code-block contexts. The recurrence record is the Layer 1 / Layer 2 / Layer 3 stack: #167 (post-merge close-verify), #697 / #698 (negation-context substring match), #401 / #700 (persistent `closingIssuesReferences` link), #735 (squash body containing `DOES NOT CLOSE #734` auto-closed #734). When the lint surfaces a known-safe occurrence (e.g. test fixtures that legitimately exercise the trigger token), pass `--allow-known-false-positives <issue-numbers>` to suppress -- DO NOT silently delete the lint invocation
- ~ Verify the diff tells a coherent story -- a reviewer reading it top-to-bottom should understand the change

### Phase 5 -- Loop

! Decide whether to restart or exit.

- ! If ANY fixes were made in Phase 2 (Write) or Phase 3 (Lint): restart from Phase 1 (Read)
- ~ Phase 3b auto-renders are intentional output refreshes; they do NOT trigger a loop restart
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
- ⊗ Skip `task pr:check-closing-keywords` (#737) before pushing a PR. The negation-context substring match is the Layer 0 (prevention) gate that prevents the recurring auto-close of umbrella / staying-OPEN issues observed in #697 (closed #642), #401 (closed #642), #700 (closed #233), and #735 (closed #734) -- each incident required manual reopen and downstream cleanup. The lint's three-state exit (0 clean / 1 hits found / 2 config error) MUST be treated as a hard refusal: rewrite the PR body / commit messages until clean, OR pass `--allow-known-false-positives` ONLY for legitimately-quoted occurrences (test fixtures, documentation that discusses the trigger token literally). See `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 for the corresponding Layer 3 (recovery) `pr:check-protected-issues` rule (#701)
