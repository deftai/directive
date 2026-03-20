# Change Proposal: agents-md-onboarding

## Problem

Three related failures in the post-install experience block new users from getting started:

1. **AGENTS.md is a two-line stub.** The install-generated `AGENTS.md` contains only `See deft/main.md` and a skills line. Agents that read it have no bootstrap logic, no commands reference, and no guidance — they stall at a blank prompt.

2. **`PrintNextSteps` lies.** The installer tells users "The agent will read deft/main.md automatically via AGENTS.md" — this is false on every platform. Users spend sessions confused about why nothing happens. (Reported in #85, absorbed into #54.)

3. **README implies automatic setup.** "On your next AI session the agent automatically invokes the `deft-setup` skill" — also false. Users who follow the README hit the same confusion.

Additionally, the in-repo `AGENTS.md` (for deft developers) has the same thin content with `deft/`-prefixed paths that are wrong when working inside the repo itself.

## Change

- Replace `agentsMDEntry` in `cmd/deft-install/setup.go` with self-contained onboarding content: what Deft is, first-session bootstrap logic (check USER.md → PROJECT.md → SPECIFICATION.md), returning-session guidance, and available commands
- Fix `PrintNextSteps` to give honest instructions: users must explicitly tell their agent to read AGENTS.md; auto-discovery is a future feature
- Update README Getting Started Step 2 to remove false-automatic claims and give the explicit kick-off instruction
- Replace in-repo `AGENTS.md` with developer-focused content using correct root-relative paths
- Update `TestPrintNextSteps` in `main_test.go` to match new output

## Scope

**In:**
- `cmd/deft-install/setup.go` — `agentsMDEntry` constant and `PrintNextSteps` function
- `cmd/deft-install/main_test.go` — `TestPrintNextSteps` assertions
- `README.md` — Getting Started section (step 2 + surrounding copy)
- `AGENTS.md` (repo root) — dev-facing onboarding content

**Out:**
- `agentsMDSentinel` — must not change; idempotency of existing installs depends on it
- Skill auto-discovery infrastructure — tracked in #75 (Phase 4)
- Native slash command registration — tracked in #55 (Phase 5)
- Any changes to `deft/` framework files (`main.md`, `SKILL.md`, etc.)

## Impact

- Users who already have `AGENTS.md` with the sentinel string (`deft/main.md`) are unaffected — the idempotency check prevents duplicate entries on re-install
- `TestWriteAgentsMD_*` tests are unaffected (they check for sentinel, not full content)
- `TestPrintNextSteps` will fail until updated — expected, tracked as a task

## Risks

- The new `agentsMDEntry` must contain the string `deft/main.md` (the sentinel) — if accidentally omitted, re-running the installer on an existing project will append a duplicate entry
- AGENTS.md content must stay under ~50 lines to avoid context bloat on every agent session
