# Article Review Session — May 1–3, 2026

Reviewed 11 articles, papers, and framework docs. Filed 48 issues on deftai/directive, 7 issues on
visionik/vBRIEF. Merged PR #827 (two-color Mermaid model). Confirmed ADR-001 (#742).

---

## Sources

| # | Source | Type | Weight |
|---|---|---|---|
| 1 | Karpathy AI Ascent talk transcript (external source -- transcript not vendored in this repo) | Practitioner interview | High |
| 2 | [@aerockrose tweet summary of AutoResearch / tight loops](https://x.com/aerockrose/status/2049839995452534820) | Practitioner summary | Medium |
| 3 | ["Extracting Signal from the Noise"](https://huggingface.co/spaces/huggingface/open-source-agent-contributions) — Burtenshaw, Smith, Solmaz (HuggingFace + OpenClaw, April 2026) | Research paper, empirical | High |
| 4 | [ADR-001 Empirical Validation](https://github.com/deftai/section-31/blob/main/strategy/2026-05-01-adr-001-empirical-validation.md) — internal | Strategic briefing | N/A (internal) |
| 5 | [withastro/flue README](https://github.com/withastro/flue#readme) — Sandbox Agent Framework | Framework documentation | High |
| 6 | [garrytan/gbrain README](https://github.com/garrytan/gbrain#readme) — YC CEO's production agent brain | Production system documentation | High |
| 7 | [lukilabs/beautiful-mermaid README](https://github.com/lukilabs/beautiful-mermaid) — SVG/ASCII Mermaid renderer | Library documentation | Medium |
| 8 | [@mem0ai tweet on Hermes Curator](https://x.com/mem0ai/status/2050351798142288050) — NousResearch v0.12.0 | Practitioner announcement | High |
| 9 | [NousResearch Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs/) — full docs | Framework documentation | High |
| 10 | [Capsule framework documentation](https://docs.capsule.new/) | Framework documentation | High |
| 11 | [@Mnilax thread](https://x.com/Mnilax/status/2050261839653556522) — 430 hours Claude Code instrumented study | Empirical study | High |

---

## Key Conceptual Contributions

### Agent architecture (cluster)

A coherent layered architecture for production agent apps emerged from Flue, gbrain, and Capsule:

- **One definition → multiple surfaces** — single app definition is source of truth for all surfaces
  (chat, pages, APIs, jobs, deploy config). Avoids premature service fragmentation.
- **Four-layer app** — message handler (conversational interpretation) / durable records /
  operator pages + settings / async tasks + schedules. Anti-pattern: monolithic message handler.
- **Three-tier state** — ephemeral session data / durable records / configuration settings.
  Decision rule: use the lightest tier that fits.
- **Per-user isolated runtime** — each app user gets their own persistent sandbox.
  Isolation unit is the user, not the request or the task.
- **Deterministic work → job queue; judgment → sub-agent** — empirically benchmarked:
  753ms vs >10,000ms, $0.00 vs $0.03/run, 100% vs 0% success under load.

### Memory architecture (cluster)

A complete agent memory model assembled across Hermes and Capsule:

- **Frozen snapshot** — memory is captured once at session start, frozen in system prompt.
  Mid-session writes persist to disk but don't mutate the current prompt. Preserves prefix cache.
- **Bounded hot store** — always-in-context memory has a hard character limit.
  80% capacity triggers proactive consolidation before adding new entries.
- **Two-tier** — hot (bounded, always in context) + cold (FTS/vector search, on demand).
  Hot for facts needed every session; cold for "did we discuss X last week?"
- **Memory write security** — entries scanned for prompt injection, credential exfiltration,
  and invisible Unicode before acceptance. Memory is injected into the system prompt;
  a poisoned entry persists across all future sessions.
- **Prompt assembly layer ordering** — cached stable prefix (identity, memory, skills, context)
  assembled once; ephemeral per-turn injections never touch the cached prefix.
  Mixing these destroys prefix cache effectiveness.

### Skill lifecycle (cluster)

A complete skill management system from Hermes Curator:

- **Lifecycle states** — active → stale (30 days untouched) → archived (90 days). Nothing deleted.
- **Telemetry sidecar** — view/use/patch counts per skill in one auditable file.
  Drives empirical lifecycle transitions rather than arbitrary age thresholds.
- **Pin mechanism** — pinned skills are immune to lifecycle demotion, curation review,
  AND agent edit tools. Protection enforced at invocation layer.
- **Idle-triggered curator** — weekly background pass using a cheap auxiliary model.
  Finds overlapping/drifted skills, proposes merges or archives. Never interrupts active work.
- **Self-improvement trigger** — after 5+ tool call tasks, agent SHOULD offer to skillify.

### Context efficiency (empirical)

From @Mnilax's 90-day instrumented study (430 hours, 6M tokens, $1,340):

- Only 27% of tokens were productive. 73% were 9 overhead patterns.
- **Lean context before cheap model** — switching to Haiku saved ~3%.
  Fixing context overhead saved 46 percentage points. Overhead is first-order; model tier is second.
- **Session ceiling at 20 messages** — re-read cost is quadratic in session length.
  Message 30 costs 30× message 1. Hard cap + summarize-and-restart is the fix.
- **MCP inventory rule** — 12 MCPs × ~600 tokens = 7,200 tokens per request regardless of task.
  Maximum 3 always-on; rest per-session only.

### vBRIEF spec improvements

Analysis of directive's vBRIEF usage (especially #762 phase taxonomy) revealed 7 missing primitives:

- `type` field on PlanItem (group/task/milestone/epic) + `status: "auto"` rollup
- `summary` string shorthand alongside `narrative`
- `planRefs` array for container items
- `context` object at root: `scope` (declarative ACL) + `runtime` (observed state)
- `Source` + `Confidence` narrative keys for provenance tracking
- Canonical `x-vbrief/*` reference type registry
- Delta/patch document type (`kind: "delta"`, RFC 6902 semantics)

---

## Issues Filed

### deftai/directive

#### Agentic engineering fundamentals — source: [1][2]

- **#778** — unique-ID-as-identity-anchor: never cross-correlate users by mutable attributes
- **#779** — agent-native-interface: design APIs and docs for agent consumption first
- **#780** — ai-first-design-audit: "does this component need to exist?"
- **#781** — verifiability-routing-heuristic: assess verifiability before choosing prompting vs fine-tuning
- **#782** — agent-loop pattern: bounded mutation + fixed evaluator + keep/discard (Karpathy Loop)
- **#783** — remove-bottleneck: maximize token throughput; human programs workflow contract

#### Agent PR triage at scale — source: [3]

- **#786** — cluster-and-combine swarm phase: deduplicate overlapping outputs before filing PRs
- **#787** — token-donation framing: rejected PRs are technical debt heatmaps
- **#788** — token cost as design constraint: estimate aggregate cost before building triage pipelines
- **#789** — pr-triage-stack: swarm-sweeper + pr-search-cli as standard project tooling
- **#790** — benchmark regression gate: fixed evaluator validates bulk agent merges (Thunderdome pattern)

#### Meta / governance — source: [2][3]

- **#785** — metadata-vs-spec decision rule + vBRIEF upstream review (cross-reference directive→vBRIEF)

#### Agent framework patterns — source: [5] (Flue)

- **#805** — typed-skill-boundary: orchestration skills must return schema-validated results
- **#806** — executor-layer-credentials: bind secrets at invocation layer, never in agent context
- **#807** — execution-env-sizing: lightweight for simple/frequent; full container for complex/rare
- **#808** — share-state-isolate-cognition: subagents share filesystem, never share context window
- **#809** — durable-session-storage: conversation state in external durable store
- **#816** — role-as-overlay: persona instructions are system prompt overlays, not message history
- **#817** — environment-as-code: agent environments declared in version-controlled code
- **#818** — per-call-model-selection: cheap models for subtasks, expensive for critical decisions
- **#819** — agent-trigger-declaration: every agent declares invocation mode and lifecycle semantics

#### Knowledge base architecture — source: [6] (gbrain)

- **#820** — compiled-truth-timeline: two-layer page structure for agent-maintained knowledge (directive)
- **#821** — mece-knowledge-resolver: every item has exactly one primary home via RESOLVER.md
- **#822** — minions-routing-rule: deterministic work → job queue; judgment → sub-agent
- **#823** — compiled-truth-timeline for projects directive creates

#### Mermaid rendering — source: [7] (beautiful-mermaid)

- **#824** — ascii-diagrams-for-agents: agent-consumed docs use ASCII, not Mermaid source
- **#825** — zero-dom-mermaid-rendering: synchronous DOM-free renderer for CI pipelines
- **#826** → **PR #827 merged** — two-color Mermaid model (`bg` + `fg` → derive all theme variables)

#### Skill lifecycle — source: [8][9] (Hermes Curator + Hermes full docs)

- **#828** — skill lifecycle states: active → stale → archived with telemetry-driven transitions
- **#829** — skill-usage telemetry sidecar: view/use/patch counts per skill, one auditable file
- **#830** — skill pin mechanism: pinned skills immune to demotion, review, and agent edit tools
- **#831** — skill-curator pattern: idle-triggered background maintenance umbrella pattern

#### Memory and prompt architecture — source: [9] (Hermes full docs)

- **#832** — frozen-memory-snapshot: capture once at session start; preserve prefix cache
- **#833** — bounded-agent-memory: hard token budget with 80% consolidation trigger
- **#834** — two-tier-agent-memory: hot (bounded, always-in) + cold (FTS on-demand)
- **#835** — memory-write-security-scan: scan for injection/exfiltration before persistence
- **#836** — prompt-assembly-layer-ordering: cached prefix vs ephemeral per-turn injections
- **#837** — skill self-improvement trigger: 5+ tool call tasks → offer to skillify
- **#838** — unified REFERENCES.md index: skills + docs in one Level 0 index; remove skill routing from AGENTS.md

#### Agent app architecture — source: [10] (Capsule)

- **#839** — one-definition-multiple-surfaces: one app definition as source of truth for all surfaces
- **#840** — per-user-isolated-runtime: isolation unit is user, not request; persistent across sessions
- **#841** — agent-app-state-taxonomy: ephemeral session / durable records / configuration
- **#842** — four-layer-agent-app: message handler / durable records / operator pages / async tasks
- **#843** — task-idempotency-lock: scoped lock key prevents duplicate concurrent task execution

#### Context efficiency — source: [11] (Mnilax empirical study)

- **#847** — lean-context-first: optimize context size before model tier; overhead is first-order
- **#848** — session-length-ceiling: hard cap at 20 messages; quadratic re-read cost math
- **#849** — mcp-inventory-rule: max 3 always-on MCP servers; rest per-session only
- **#644** — comment added: empirical data linking Mnilax findings to directive framework footprint

### visionik/vBRIEF — source: [analysis of deftai/directive issues]

- **#13** — `type` field on PlanItem (group/task/milestone/epic) + `status: "auto"` rollup
- **#14** — `summary` string shorthand on PlanItem
- **#15** — `planRefs` array for container items referencing multiple plans
- **#16** — `context` object at root: `scope` (declarative ACL) + `runtime` (observed state)
- **#17** — `Source` + `Confidence` recommended narrative keys for provenance tracking
- **#18** — canonical `x-vbrief/*` reference type registry (IANA analysis in follow-up comment)
- **#19** — delta/patch document type (`kind: "delta"`, RFC 6902 ops)

---

## What Was Implemented

**PR #827** (`feat/mermaid-two-color-model`, open for review):
Reformalized `languages/mermaid.md` around `bg=#ffffff` / `fg=#000000` as the two defining colors.
Replaced the opaque hex Color Palette list with a derivation table. Added `⊗` rule against setting
individual theme variables without reference to the derivation table. Init directive values unchanged
— they were already the correct derived values for the grayscale-on-white instance of this model.

**ADR-001 confirmation** posted on #742:
Confirmed D-V1 (two gates are the right interpretation of April 30 concerns) and
D-V2 (3–4 week calendar timeline accepted). Validation can proceed.

---

## Recommended Implementation Packages

The 48 issues cluster into four natural work packages:

### Package 1 — Memory architecture
`#836 → #832 → #833 → #834 → #835`
Start with prompt assembly ordering (#836) as the theoretical foundation; the others are consequences.
Requires no changes to existing skill or vBRIEF infrastructure.

### Package 2 — Skill system maturity
`#829 → #828 → #830 → #831 → #837 → #838`
Telemetry sidecar (#829) must land before lifecycle states (#828); pins (#830) depend on lifecycle.
REFERENCES.md unified index (#838) is independent and should ship first as it's a documentation change.

### Package 3 — Agent app architecture
`#839 + #840 + #841 + #842`
Coherent set for new project documentation. Could ship as a single
`patterns/agent-app-architecture/` directory grouping all four.

### Package 4 — Context efficiency (quickest wins)
`#847 + #848 + #849 + #644`
Behavioral rules and configuration standards. Can be added to existing docs
(`context/context.md`, `coding/coding.md`) without new patterns files.
Highest immediate impact relative to implementation cost.
