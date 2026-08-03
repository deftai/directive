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

## Layout

```
fixtures/
  cases.ts          # typed corpus + helpers (HOOK_FIXTURE_CASES, fixtureCasesFor, fixtureCaseById)
  cases.test.ts     # matrix coverage + pure-classify golden assertions
  README.md         # this file (coupled surface + decision codes)
```

Each case records: `id`, `host`, `os`, `tool`, `regression` (issue tags), `raw` or `payload`, and expected classification fields (`toolName`, `writeIntent`, `writeTargetPath`, optional stdin parse flags).

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
