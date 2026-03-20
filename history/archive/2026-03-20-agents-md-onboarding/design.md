# Technical Design: agents-md-onboarding

## Approach

### `agentsMDEntry` content

The new constant must:
1. Contain `deft/main.md` (sentinel string — idempotency guard)
2. Be platform-neutral (no OS-specific paths)
3. Stay under ~50 lines

Structure:
```
# Deft — AI Development Framework
<one-line description + pointer to deft/main.md>

## First Session
<check USER.md → Phase 1, PROJECT.md → Phase 2, SPECIFICATION.md → Phase 3>

## Returning Sessions
<read main.md, USER.md, PROJECT.md, continue task>

## Commands
<slash commands + CLI equivalents>

<!-- TODO: remove skills line when #75 (skill auto-discovery) lands -->
Skills: deft/SKILL.md, deft/skills/deft-setup/SKILL.md, deft/skills/deft-build/SKILL.md
```

The skills line is kept because some platforms (Warp) use it for skill discovery today. The Go comment above it flags it for removal when #75 ships.

### `PrintNextSteps` changes

Replace the three inaccurate steps with:
```
1. Open your AI coding assistant in <dir>
2. Tell your agent: "read AGENTS.md and follow it" to start the Deft setup
3. On first session, the agent will guide you through creating your USER.md and PROJECT.md
   (Agents do not read AGENTS.md automatically — auto-discovery is planned for a future release)
```

### README changes

- Line 377: replace "the agent automatically invokes the `deft-setup` skill" → "tell your agent `read AGENTS.md and follow it` to start the Deft setup flow"
- Line 353: "wires it into AGENTS.md" is fine; remove any implication of automatic reading
- Line 355 (manual clone): add the explicit kick-off instruction after the markdown block

### In-repo `AGENTS.md`

Same structure as install-generated but:
- Root-relative paths (`main.md` not `deft/main.md`, `SKILL.md` not `deft/SKILL.md`)
- Developer context: working on the deft framework itself
- No `deft/` prefix anywhere

### `TestPrintNextSteps`

Remove assertion for `"deft/main.md"` (line 585). Add assertions for new content:
- `"read AGENTS.md"` (or the exact phrase used in step 2)
- `"AGENTS.md"` (still present)
- `"Deft installed successfully"` (unchanged)
- `result.DeftDir` (unchanged)
- `"User config"` (unchanged)

## Alternatives Considered

**Keep AGENTS.md thin, fix only PrintNextSteps/README** — rejected. Fixes the lie but doesn't solve the agent experience once they do read it. Users still need to know what to do after "read AGENTS.md."

**Put full main.md content in AGENTS.md** — rejected. Context bloat on every session. Lazy loading exists for a reason.

## Dependencies

- `agentsMDSentinel = "deft/main.md"` must appear verbatim in the new `agentsMDEntry` content
- No external dependencies
