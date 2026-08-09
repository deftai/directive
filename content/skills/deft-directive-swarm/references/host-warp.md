# Host adapter: Warp

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `warp-orchestrated` (`start_agent`) or `warp-manual` (`WARP_*` without `start_agent`).

Load this file only after detect selects Warp. Do not load other host adapters.

### Step 2a: Orchestrated Launch (start_agent available)

! When `start_agent` is detected in the tool set, use it directly to launch each agent.

- ! Launch one agent per worktree using `start_agent` with the generated prompt and worktree path as the working directory
- ! Agents inherit the current environment's MCP servers, Warp Drive rules, and codebase index — equivalent to interactive Warp tabs but without manual tab management
- ! No user intervention needed — launch is fully automated
- ~ This is the preferred path: richest context with zero manual overhead

### Step 2b: Interactive Warp Tabs (start_agent unavailable, Warp detected)

! When `start_agent` is not available but Warp is detected (via `WARP_*` environment variables), fall back to manual Warp tab launch — briefly note that orchestrated launch is not available in this session, then proceed with the tab instructions below.

! **Warp tabs cannot be opened programmatically.** There is no API or CLI command to open a new Warp terminal tab from an agent or script.

Ask the user to open N new Warp terminal tabs. For each tab, the user:
1. Navigates to the worktree: `cd <worktree>`
2. Pastes the prompt directly into the **Warp agent chat input** (not the terminal)

**Context advantages of Warp tabs:**
- Global Warp Drive rules (personal rules auto-injected)
- MCP servers via UUID (GitHub, etc. — zero-config)
- Warp Drive notebooks, workflows, and other auto-injected context
- Warm codebase index from the active Warp session (no cold-start delay)
- Agent is interruptible and steerable mid-run

**Tradeoff:** Requires the user to manually open and manage one Warp tab per agent.

## Retained / continue-by-id (#3158)

! **Retain-capable when the tab or `start_agent` session stays live:** Warp agents are interruptible and steerable mid-run. Prefer **message-later / steer-mid-flight** on the same tab or agent handle rather than a second full dispatch for mid-scope gates.
! When a Warp agent has exited terminal with no resume handle, fall back to **one-shot / split-dispatch** (#954).
~ Record the retained handle (tab / agent id) in monitor notes. Stance: orchestration only (#3164) — not constitution self-edit.

? If not running inside Warp at all (no `WARP_*` variables, no `start_agent`), use the same tab approach but with any terminal emulator — the user pastes prompts into their preferred terminal or agent interface.
