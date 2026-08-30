# Hooks fixture corpus (#2950)

Shared **host × OS × tool** golden cases for PreToolUse classification and CLI stdin parse.

Phase A landed pure classify + skeleton corpus. **Phase B** expands the Cursor Write/ApplyPatch matrix, shares the corpus with `packages/cli/src/hook-dispatch.test.ts`, and documents decision codes as the stable external surface.

## Coupled surface (TPA thrash cluster)

Hooks classification and permission decisions form a **coupled surface**. When you change host payload handling or write-path gates, plan these three together — do not land a primary-only drive-by:

1. `packages/core/src/hooks/dispatcher.ts` (orchestration + policy)
2. `packages/core/src/hooks/dispatcher.test.ts` (core policy cases)
3. `packages/cli/src/hook-dispatch.test.ts` (CLI stdin / host adapter)

Pure parse/classify lives under `packages/core/src/hooks/classify/`. Prefer:

1. **Add or update a fixture** here for the new host edge case.
2. Fix the pure classifier (`classify/`) when the bug is identity/path shape.
3. Fix the dispatcher only for policy / ritual / scope / permission emission.
4. Keep CLI tests thin over `parseHookStdin` + `decideHook` + `renderHostDecision`.

New host edge bugs should land as a fixture first, then the classifier (or policy) fix.

## Cooperative host-session identity (#3611)

Occupancy identity is cooperative routing, not authentication. Hook stdin and local owner IDs are forgeable by another same-user process. A resolved host owner is authoritative for normal hook events and resolves to `host:<provider>:v1:<base64url(raw-id)>`:

| Host | Source | Owner | Granularity |
|------|--------|-------|-------------|
| Codex | payload | `session_id` | Parent session and its subagents share one owner. |
| Claude Code | payload | `session_id` | Session-family owner; `agent_id` is not substituted. |
| Cursor | payload | `conversation_id` | Conversation owner; simultaneous `session_id` must agree. Subagent granularity is not asserted without host verification. |
| Grok | host env | `GROK_SESSION_ID` | Host session owner (#3873). The payload `session_id` is unverified and is never read. |

`host-env` sources exist because the hook is a sibling process the host spawns, not a descendant of the agent's shell: an agent's `export` cannot reach it, so a variable found there was put there by the host. That is the same trust class as a payload field, and it is the only identity a host without a verified payload contract publishes.

Absence of a `host-env` variable is the pre-#3873 state, not a broken contract: the host keeps the explicit `--session-id` / `DEFT_SESSION_ID` flow and, with no explicit owner, the write gate still denies. A **malformed** variable fails closed as `occupancy-identity-unavailable`, and an ambient `DEFT_SESSION_ID` that contradicts a resolved host owner fails closed as `occupancy-identity-conflict`.

`CANONICAL_OWNER_PATTERN` is derived from the provider list, so a provider added to the identity surface is added to the lifecycle-rewrite surface in the same edit. Drift between the two is what left a host able to resolve an owner it could never bind a claim under (#3873).

No host-to-lease map or credential file is persisted; supported hooks re-derive the canonical owner from every payload or host environment.

PreToolUse may add the canonical owner to exact, simple lifecycle commands only. Direct `deft` / `directive` spellings are `session:start`, `session:ready`, `session:end`, `occupancy:steal`, `occupancy:release`, and `swarm-launch`; source-repo Task uses `task <verb> [-- ...]`, with `swarm:launch` as the Task spelling. Path-bearing/destination flags, consumer-repo Task indirection, and compound, redirected, quoted, aliased, wrapped, or ambiguous shell commands are not auto-rewritten. Recognized forms outside that narrow surface must carry the explicit matching owner before normal host permission handling continues. Fixtures for this surface must cover identity resolution, conflicting fields, exact-command rewrite, ambiguous-command rewrite refusal, and the host-rendered updated-input field.

An existing live UUID lease needs an explicit confirmed `session:start --steal` transition to the host owner. Bare `occupancy:steal` changes the lease only; writes remain denied unless ritual state already names that owner. When it does not, align the same ID with re-arm if eligible, or cold `session:start` otherwise. Heartbeat renewal is #3599; missing/drifted hook delivery is #3742; spawn occupancy bypass is #3755.

## Layout

```
fixtures/
  cases.ts          # typed corpus + helpers (HOOK_FIXTURE_CASES, fixtureCasesFor, fixtureCaseById)
  cases.test.ts     # matrix coverage + pure-classify golden assertions
  README.md         # this file (coupled surface + decision codes)
```

Each case records: `id`, `host`, `os`, `tool`, `regression` (issue tags), `raw` or `payload`, and expected classification fields (`toolName`, `writeIntent`, `writeTargetPath`, optional stdin parse flags, optional `hostIdentity`, and optional lifecycle classification/rewrite fields).

Import path (core + CLI tests):

```ts
import {
  fixtureCaseById,
  fixtureCasesFor,
  HOOK_FIXTURE_CASES,
} from "@deftai/directive-core/hooks";
// or relative: from "../fixtures/index.js" inside packages/core
```

## Decision codes (stable external surface)

Agents, host adapters, and tests **must** key permission outcomes off `HookDecisionCode` (`packages/core/src/hooks/dispatcher.ts`), not English `message` / `user_message` strings alone. Cursor failClosed deposits put `code` on the wire with `permission`.

| Code | Typical verdict | Meaning |
|------|-----------------|---------|
| `session-start` | allow | SessionStart completed / noop success path |
| `session-start-disabled` | allow | SessionStart skipped by policy / opt-out / test kill-switch |
| `directive-disabled` | allow | PreToolUse/compact skipped by `.deft-directive-disable` (#3039) |
| `session-start-degraded` | allow | SessionStart best-effort path with degraded note |
| `session-compact-rearm` | allow | Compact event rearmed ritual state |
| `session-compact-rearm-degraded` | allow | Compact rearm degraded |
| `session-compact-noop` | allow | Compact host skip / noop |
| `not-direct-write` | allow | Tool is not a direct-write / spawn gate class |
| `invalid-input` | deny | Malformed / missing tool identity (host-integration) |
| `stdin-empty` | deny | Host closed stdin with zero bytes (#2864) |
| `ritual-not-ready` | deny | Gated session ritual not fresh |
| `occupancy-occupied` | deny | Product-path write while another live session occupies the worktree (#3433) |
| `occupancy-identity-unavailable` | deny | A payload-supported host omitted/malformed its owner, or a recognized owner-requiring lifecycle form cannot be safely rewritten and lacks an explicit owner (#3611) |
| `occupancy-identity-conflict` | deny | Payload owner, lifecycle owner syntax/duplicates, environment, or execution root conflict (#3611) |
| `occupancy-ritual-mismatch` | deny | Live lease and exact verified ritual state name different owners (#3611) |
| `foreign-repository-deny` | deny | Write target resolved to a Git repository that does not share git-common-dir with payloadRoot (#3794) |
| `scope-not-ready` | deny | No active running scope for in-root write |
| `write-propose-ready` | allow | Write to proposed lifecycle path allowed |
| `write-assist-scratch-ready` | allow | Allowlisted assist/scratch write without active xBRIEF (#1802) |
| `write-ready` | allow | Direct write allowed under ready gates |
| `read-only-deny` | deny | `DEFT_HOOK_READ_ONLY` / read-only posture |
| `spawn-explore-ready` | allow | Explore-class spawn allowed |
| `spawn-ephemeral-ready` | allow | Ephemeral/docs/assist spawn allowed without active xBRIEF (#3080) |
| `spawn-ready` | allow | Spawn / Task allowed under ready gates |
| `spawn-not-ready` | deny | Spawn blocked by ritual/scope |
| `runtime-policy-deny-path` | deny | runtimeAuthority / write-fence path deny |
| `runtime-policy-deny-scope` | deny | runtimeAuthority scope deny |
| `shell-op-ready` | allow | Classifiable shell/MCP push/merge allowed |
| `shell-op-unclassifiable` | allow | Shell/MCP seen but not classifiable (fail-open class) |
| `authz-uat-deny` | deny | UAT lease blocks mutation |
| `authz-grant-missing` | deny | Human-origin grant required but missing |
| `authz-grant-origin-reject` | deny | Grant origin binding reject |
| `authz-grant-scope-deny` | deny | Grant surface/scope mismatch |
| `authz-grant-expired` | deny | Grant past expiry |
| `authz-grant-revoked` | deny | Grant revoked |
| `authz-grant-single-use-spent` | deny | Single-use grant already spent |
| `intent-ceiling-deny` | deny | Slash-command intent ceiling (#1193) |

**Stability rule:** new host edge bugs that change allow/deny class should introduce or assert a code above (or extend the typed union intentionally). Do not teach agents to parse free-form English denial prose.

Classification fixtures (`HOOK_FIXTURE_CASES`) freeze **payload → tool identity / write intent / path**. Policy fixtures live in `dispatcher.test.ts` and assert **decision codes**. CLI tests may re-use the classify corpus for stdin parse parity and assert wire `code` for Cursor outcomes.
