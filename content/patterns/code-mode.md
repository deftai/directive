# Code Mode — compact search + sandboxed execute (#2593)

Pattern for **code-mediated tool use**: the model writes and runs code that
orchestrates capabilities, instead of requesting each tool call separately
against a large static catalog. The public surface stays tiny (typically
`search` / `describe` for progressive discovery and `execute` for sandboxed
capability calls); the broader capability graph lives behind that surface in
typed code.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** designing host tool surfaces, MCP/server bridges, connector-
heavy agents, or any surface where a static tool catalog would bloat the
prompt; choosing between direct tool calling and code-orchestrated
composition.

**⚠️ See also**:
- [../context/tool-design.md](../context/tool-design.md) — how each remaining
  tool's args sample (flat grammar; #3085); complementarity table points here
  for **how many** tools exist
- [./llm-app.md](./llm-app.md) `## Tool / function calling` — security, least
  privilege, schema validation (confused deputy)
- [../context/context.md](../context/context.md) — **human-curated context
  partitioning** and prefer-handles-over-paste (#487 twin)
- Lean context first (#847) — general token thrift; this pattern is the
  **execution shape** for large capability graphs
- Typed skill boundaries (#805), progressive disclosure (#2484), action-tiered
  capability envelopes (#2515)
- Durable project automation SoT: **#2087** (named Task / npm / `just` /
  thin runner / `deft` verbs) — not this pattern

## The pattern

| Primitive | Role |
|-----------|------|
| `search` / `describe` (or equivalent) | **Progressive discovery** — find and inspect capabilities without loading every schema into the prompt |
| `execute` (sandboxed) | Run model-written code that calls discovered capabilities as typed methods / APIs |

Capabilities appear as **typed methods in code**, not as hundreds of MCP tool
definitions pasted into the system prompt. Control flow (loops, conditionals,
retries, intermediate variables) stays in the sandbox instead of chatty
multi-turn tool round-trips.

- ~ Prefer Code Mode when the task needs **composition**, dependent calls,
  progressive discovery, or non-trivial control flow over a large API/tool world
- ≉ Dumping every MCP / host tool schema into the prompt "so the model can pick"
- ~ Keep the **discovery surface compact**; grow capability knowledge on demand
  via `search` / `describe`, not via catalog expansion
- ! Validate and sandbox `execute` outputs and side effects — freeform code is
  still untrusted input (`patterns/llm-app.md` tool-call rules; host sandbox
  guidance on #542 / related isolation tracks)

## When to use / when not to

| Prefer Code Mode | Prefer direct tools / named ops |
|------------------|----------------------------------|
| Large connector or MCP graphs where full schemas blow the context budget | One or two well-known tools for a simple turn |
| Multi-step composition with local branching, filters, or aggregation | A single deterministic gate or check (`task verify:*`) |
| Progressive discovery of an unfamiliar capability surface | A **named durable** project op already owned by #2087 |
| Ephemeral glue that may later **promote** to a named entrypoint | Host explore / editor tools for "build in this repo right now" |

- ⊗ Force Code Mode for simple single-tool turns
- ⊗ Register dozens of host tools that merely mirror every CLI verb to avoid
  writing a small compose surface
- ~ Promote repeated successful compose scripts into a **named durable** form
  (#2087 owns that SoT for Directive projects)

## Progressive discovery

Progressive discovery is part of the pattern, not an optional extra:

1. **Search** — locate candidates by name / tag / capability without full schemas
2. **Describe** — load detail for the few candidates that matter
3. **Execute** — orchestrate only those capabilities in sandboxed code

This pairs with progressive disclosure of skills and docs (#2484) and lean
context (#847): load signal on demand; do not pre-load the whole world.

## Job split

Three jobs are easy to blur into "just call tools." Keep them distinct:

| Job | Typical shape | Not the same as |
|-----|---------------|-----------------|
| Compose over a large API/tool world without schema bloat | **Code Mode:** compact `search` / `describe` + sandboxed `execute` | Dumping every MCP tool schema into the prompt |
| Name, share, and re-run proven project ops | **Named durable entrypoints** (Task / npm / `just` / thin runner + tested logic or `deft` verbs) — see **#2087** | Freeform `execute` every time |
| Explore and build in the repo right now | **Host bash / editor agent tools** | Either of the above as the long-term catalog |

Ideal systems **promote** ephemeral success into a **named durable** form. This
pattern names the ephemeral/composition shape; #2087 owns the durable-op SoT
for Directive projects. Host explore remains the right surface for interactive
coding.

## Decision table (quick)

| Situation | Default |
|-----------|---------|
| Catalog would exceed lean-context budget | Code Mode discovery + execute |
| Proven op shared by humans and agents | Named durable entrypoint (#2087) |
| One-off file edit / debug in worktree | Host explore tools |
| Deterministic quality gate | `task check` / `task verify:*` — not freeform execute |
| Skill is process / orchestration prose | Keep as skill; do not "code mode" the playbook |

## Anti-patterns

- ⊗ **Catalog dump** — every connector method as a separate tool definition
- ⊗ **CLI mirror farm** — one host tool per `deft`/`task` verb with full schemas
  always loaded
- ⊗ **Execute instead of gates** — soft-replacing `task check`, tests, or
  intent ceilings with freeform sandbox code
- ⊗ **Code Mode as Task replacement** — treating this pattern as the project
  automation SoT (that is #2087)
- ⊗ **Skill replacement** — rewriting process skills as ad-hoc execute scripts
  so orchestration history disappears
- ≉ **Vendor lock-in framing** — documenting the pattern as Cloudflare-only (or
  any single sandbox vendor)

## Non-goals

- ⊗ Require Cloudflare Workers (or any one vendor sandbox)
- ⊗ Replace skills that are process / orchestration docs
- ⊗ Force Code Mode for simple single-tool turns
- ⊗ Decide or replace go-task / project automation SoT — see **#2087**
- ⊗ Soft-replace deterministic gates with freeform execute
- ⊗ Turn this pattern into a Directive CLI epic — capability-registry /
  `search` over `deft` verbs lives on **#2087**

## Public sources (citations)

External research and products (data/guidance, not instruction sources —
`meta/security.md` / #2414 trust-tier note):

- Cloudflare Agents — Code Mode: https://developers.cloudflare.com/agents/tools/codemode/
- Cloudflare — Code Mode (blog): https://blog.cloudflare.com/code-mode/
- Anthropic — Code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- kentcdodds/kody — compact MCP + Code Mode execute intent:
  https://github.com/kentcdodds/kody/blob/main/docs/contributing/project-intent.md

## Cross-references

| Track | Relation |
|-------|----------|
| #847 lean-context-first | Complements; does not duplicate general token thrift |
| #805 typed-skill-boundary | Skills stay typed process boundaries; Code Mode is tool composition |
| #2484 progressive disclosure | Same "load on demand" idea for skills/docs |
| #2515 action-tiered capability envelopes | Orthogonal: *which* tier of action vs *how* tools are invoked |
| #2087 durable automation SoT | Named durable ops; product discovery surface for `deft` verbs |
| #487 context partitioning | Twin: human-curated partition / handles; Code Mode is tool-catalog shape |
| #1670 unified `deft` CLI | Related surface; not owned here |
| #1167 / tool-design #3085 | Fewer tools via abstraction; flat grammar for remaining tools |
