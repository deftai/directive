# Host adapter: generic-terminal + cloud escape

Legend (RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

Descriptor: `generic-terminal` (no orchestration primitive) or explicit cloud escape.

Load this file only after detect selects generic-terminal, or the operator requests cloud.

### Step 2c: Cloud Agents (explicit user request only)

! Use `oz agent run-cloud` ONLY when the user explicitly requests cloud execution. Never default to this path.

```powershell
oz agent run-cloud --prompt "TASK: You must complete..."
```

Agents execute on remote VMs without local MCP servers, codebase indexing, or Warp Drive rules. Agents MUST use `gh` CLI for GitHub operations. `AGENTS.md` is the only behavioral control surface.

**Tradeoff:** Fully automated with zero tab management, but context-starved — no MCP, no Warp Drive rules, no codebase indexing. Best for self-contained tasks that don't need rich local context.

⊗ Default to cloud launch — it is an escape hatch, not a default path.
⊗ Use `oz agent run-cloud` when the user expects local execution — `run-cloud` routes to remote VMs with no local context.


## Serial self-execution / manual paste

When no orchestration primitive is detected, follow the `generic-terminal` branch in `references/core-phase-3.md` Step 1 (serial self-execution downgrade + manual paste fallback).

## Retained / continue-by-id (#3158)

! **One-shot only:** generic-terminal and cloud escape paths have no platform continue-by-agent-id. Treat every paste / serial self-execution / `oz agent run-cloud` run as **dispatch-and-collect**.
! Mid-scope user-approval gates MUST use **split-dispatch** (new paste / new run after approval) — never claim retained-child messaging on this descriptor.
~ Stance: orchestration only (#3164).
