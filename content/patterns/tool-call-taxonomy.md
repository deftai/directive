# Tool-call taxonomy — explore / commit / verify (#2967)

Deterministic activity buckets for swarm and review-cycle operators. Use
this taxonomy when skimming tool logs, monitor status lines, or batch
briefs so “ran N tools” becomes a structured mix.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** writing swarm monitor status, review-cycle batch briefs,
PR evidence one-liners, usage metrics that group tool events, or any
harness surface that aggregates agent tool calls.

**Implementation:** pure rule-first API in
`packages/core/src/tool-events/` (`classifyToolEvent`,
`summarizeToolEvents`). No LLM per event.

**Related but distinct:**
- `packages/core/src/hooks/classify/` (#2950) — PreToolUse write-intent
  and host payload identity. Share vocabulary only; do not merge.
- Causal graph work (#2966) may consume these buckets as node kinds.

**⚠️ See also**:
- [../swarm/swarm.md](../swarm/swarm.md) — multi-agent coordination
- [../skills/deft-directive-swarm/references/core-phase-4.md](../skills/deft-directive-swarm/references/core-phase-4.md) — monitor status line consumer
- [../skills/deft-directive-review-cycle/SKILL.md](../skills/deft-directive-review-cycle/SKILL.md) — review batch surfaces

## Buckets

| Bucket | Meaning | Typical tools / commands |
|--------|---------|---------------------------|
| `explore` | Read / search / fetch-for-analysis | `Read`, `Grep`, `Glob`, `list_dir`, `SemanticSearch`, `web_search`, `git status`/`log`/`diff`, `gh … view`/`list`, `rg`, `ghx` |
| `commit` | Mutate product or SCM state | `Write`, `Edit`, `StrReplace`, `ApplyPatch`, `Delete`, `git add`/`commit`/`push`, `gh pr create`, mutating `gh api -X POST` |
| `verify` | Run a **proven** gate or test | `vitest`, `pytest`, `go test`, `cargo test`, `npm test`, `task check`, `task verify:*`, `tsc`, `biome`, `eslint`, `task pr:watch` |
| `coordinate` | Session / swarm / handoff | `Task`, `spawn_subagent`, `start_agent`, `sessions_spawn`, `TodoWrite`, `AskQuestion`, `task swarm:*`, `task scope:*` |
| `unknown` | Explicit residual | Missing name, shell without command, ambiguous names, unlisted bins |

## Misclassification policy

- ! MUST prefer `unknown` over a wrong `verify`. False-positive verify
  hides “shipped without gates”; residual unknown is recoverable.
- ! MUST classify as `verify` only when the tool name or shell command
  **honestly proves** a test/lint/typecheck/doctor/check/watch gate.
- ⊗ MUST NOT map bare names that merely contain `test` / `lint` /
  `check` (e.g. `TestHelper`, `npm run build`, `make install`, custom
  scripts) to `verify`.
- ~ SHOULD leave novel MCP server tools as `unknown` until a nested
  segment matches a known name (`mcp__host__Read` → explore).

## Anomalies (derived from counts)

`summarizeToolEvents` derives conservative anomaly codes:

| Code | When |
|------|------|
| `commit-without-explore` | `commit > 0` and `explore === 0` |
| `verify-skipped` | `commit > 0` and `verify === 0` |
| `explore-only` | `explore > 0`, `commit === 0`, `verify === 0`, and total events ≥ 3 |

## Status line format

```
tools: explore=N commit=N verify=N coordinate=N unknown=N
tools: explore=0 commit=2 verify=0 coordinate=0 unknown=0 | anomalies: commit-without-explore,verify-skipped
```

Produced by `formatToolEventStatusLine` / `summarizeToolEvents`.statusLine.

## Non-goals

- ⊗ LLM classification per tool event (cost/drift kills ROI)
- ⊗ Proving a verify command was the *correct* test suite
- ⊗ Semantic code understanding of what was written
- ⊗ Replacing hooks write-path / authz classifiers (#2950 / #2944)
