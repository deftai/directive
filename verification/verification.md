# Agent Work Verification

Goal-backward verification of agent output — check outcomes, not checklists.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [coding/testing.md](../coding/testing.md) | [verification/uat.md](./uat.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) verification model.

---

## Core Principle

"All steps done" is **not** verification. Checking actual outcomes is.

- ! Verify **observable results**, not process completion
- ⊗ Mark a task done because its steps were followed
- ! Every task defines **acceptance criteria** before work begins

---

## Acceptance Criteria

Three subcategories of verifiable outcomes:

### Truths (Behavioral)

Observable behaviors that must be true after task completion.

- ! State as testable assertions: "User can sign up with email and password"
- ! Require running commands, checking output, or observing behavior to confirm
- ~ Persist truths in the task's vBRIEF item narrative

### Artifacts (Files)

Files that must exist with real implementation.

- ! Specify: path, minimum substance (e.g., line count), required exports
- ⊗ Accept "file exists" alone — verify it has real content
- ! Check exports match what was promised

### Key Links (Wiring)

Connections between artifacts that must be present.

- ! Verify imports: `route.ts` imports `generateToken` from `auth.ts`
- ! Verify exports: modules expose what downstream consumers need
- ~ Check that wiring is functional, not just syntactically present

---

## Stub Detection

- ! Scan for incomplete implementations before marking done:
  - `TODO`, `FIXME`, `HACK`, `XXX` comments
  - `return null`, `return {}`, `return []`, `return ""` placeholders
  - `console.log` / `print` placeholders standing in for real logic
  - `pass` (Python), `unimplemented!()` (Rust), `panic("not implemented")` (Go)
  - Functions under ~8 lines that return hardcoded/empty values
- ⊗ Accept stubs as completed work

## Legacy and Deprecated Code Detection

- ~ When reviewing or modifying any file, scan for legacy indicators and file a hygiene task if found:
  - Comments: `LEGACY`, `COMPAT`, `OLD_`, `# old way`, `// deprecated`, `TODO: remove`
  - Commented-out code blocks (more than 1 line)
  - Feature flag branches where the flag is hardcoded to always-on or always-off
  - Parallel implementations: old and new approach coexisting without a documented migration path
- ⊗ Leave legacy markers in place after a migration is complete; remove them in the same commit as the migration
- ~ See [coding/hygiene.md](../coding/hygiene.md) for the full legacy removal protocol

---

## Verification Ladder (4 Tiers)

Pick the **strongest tier reachable** for each task.

### Tier 1 — Static

- Files exist, line counts met, exports present, imports wired, no stubs
- ! Always perform static verification — it is the minimum

### Tier 2 — Command

- Tests pass, build succeeds, lint clean
- ~ Prefer this tier for any task that produces executable code

### Tier 3 — Behavioral

- Browser flows work, API responses correct, CLI output matches spec
- ~ Use for user-facing features; run `curl`, browser checks, or CLI invocations

### Tier 4 — Human

- User manually verifies (see [uat.md](./uat.md))
- ! Use **only** when tiers 1–3 cannot confirm the outcome
- ⊗ Ask a human to verify what a `curl` or test command can check

---

## vBRIEF Integration

- ~ Record acceptance criteria in `./vbrief/plan.vbrief.json` task narrative before execution
- ~ Record verification tier reached in `./vbrief/plan.vbrief.json` task status/metadata
- ~ On verification failure, set task status to `blocked` in `./vbrief/plan.vbrief.json` with failure narrative
- ? Allow stubs only if explicitly marked as intentional scope deferral in `./vbrief/plan.vbrief.json`

---

## Anti-Patterns

- ⊗ Marking a task done because all code was written (verify outcomes)
- ⊗ Skipping static verification
- ⊗ Accepting stubs as complete
- ⊗ Asking a human to check what the agent can verify itself
- ⊗ Verifying process ("I did steps 1–5") instead of outcomes ("user can log in")
