# Change Proposal: agent-auto-alignment

## Problem

Two complementary gaps mean agents never auto-align with deft on startup and skip the correct workflow even when they do:

1. **No auto-discovery** — agents must be manually told to read AGENTS.md every new session. Any improvement to `main.md`, strategy files, or teaching behavior (#84) is invisible until the agent happens to load deft. This is the primary adoption blocker post #54.

2. **No prescriptive change lifecycle rule** — even when an agent fully loads deft, it skips `/deft:change` before implementing planned work. `main.md` lists the commands but doesn't mandate their use — it's descriptive, not prescriptive. Agents go straight to code.

These are inseparable: gap 1 without gap 2 means the agent loads deft but still skips workflow steps. Gap 2 without gap 1 means the rule never fires.

## Change

- Create `.agents/skills/deft/`, `.agents/skills/deft-setup/`, `.agents/skills/deft-build/` in the deft repo with thin pointer `SKILL.md` files — committed static files, never change on deft updates, redirect agents to canonical skill files (root-relative paths)
- Update `deft-install` to write the same `.agents/skills/` structure in user project root during install (`deft/`-prefixed paths), via a new `WriteAgentsSkills` function
- Remove the `Skills:` line from `agentsMDEntry` (`.agents/skills/` now handles discovery — this was the TODO pending #75/#94)
- Add prescriptive change lifecycle rule to `main.md`: before implementing any planned change touching 3+ files or with an accepted plan artifact, propose `/deft:change <name>` and wait for confirmation
- Remove Skills line from in-repo `AGENTS.md` (redundant once `.agents/skills/` exists)
- Update `PrintNextSteps` to reflect auto-discovery (no longer needs explicit "tell your agent to read AGENTS.md")
- Add `TestWriteAgentsSkills_CreateNew` and `TestWriteAgentsSkills_Idempotent` tests

## Scope

**In:**
- `.agents/skills/` directory in deft repo (3 thin pointer files)
- `cmd/deft-install/setup.go` — `WriteAgentsSkills` + remove Skills line from `agentsMDEntry` + update `PrintNextSteps`
- `cmd/deft-install/main_test.go` — 2 new tests
- `main.md` — prescriptive change lifecycle rule
- `AGENTS.md` (in-repo) — remove Skills line

**Out:**
- Global `~/.agents/skills/` install — needs fixed global deft path (Phase 4 / #56 / #11)
- Other skill directories (`.warp/skills/`, `.claude/skills/`, etc.) — `.agents/skills/` is universal; Warp scans all
- `agentsMDSentinel` or `WriteAgentsMD` idempotency logic — unaffected

## Impact

- Users who install via the new binary will get `.agents/skills/` created automatically
- Existing installs are unaffected (no `.agents/skills/` until re-install)
- Developers working in the deft repo get auto-alignment immediately on next Warp session after this merges

## Risks

- Thin pointer content must have correct YAML frontmatter (name + description) matching the real SKILL.md so Warp discovers it with the right metadata
- The `Skills:` line removal from `agentsMDEntry` changes the sentinel check indirectly — must verify `agentsMDSentinel` ("deft/main.md") still appears in the new content
