# Contained write API (#2951)

Mandatory filesystem write primitive for **product** sinks in the TypeScript engine.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Why this exists

AppSec mediums kept reappearing as “N more symlink / path-escape write sinks” (#2470, #2521, #2632, #2668, #2710, #2766, #2807, #2847, #2869, …). Patching call sites one-by-one does not end the class. Epic **#2951** requires:

1. One **contained write contract** (resolve under root → refuse escape/symlink → write).
2. Migration of product sinks onto that API.
3. Enforcement so new raw `writeFileSync` / similar outside an allowlist cannot land silently.

Phase 1 lands the **TS API + tests + docs + fail-open inventory gate** and migrates at least one product sink. Later phases migrate remaining sinks and turn the gate fail-closed.

## Contract (normative)

```ts
import {
  containedWrite,
  ContainedWriteError,
  ContainedWriteErrorCode,
} from "@deftai/directive-core";

containedWrite({
  root: projectRoot,          // absolute containment root
  target: "path/under/root",  // relative preferred; absolute must stay under root
  data: "payload\n",          // string | Buffer
  mode: "create" | "replace" | "append",
});
```

### Hard rules

- ! Final write target MUST resolve **inside** `root` after path normalization (segment containment via `path.relative`, not string prefix).
- ! Symlink escape of the target or intermediate segments MUST fail closed (no write).
- ! Leaf symlink on the write path MUST fail closed (parity with `assertWriteTargetSafe`).
- ! Modes:
  - `create` — fail if the target already exists (`CONTAINED_WRITE_EXISTS`).
  - `replace` — create or truncate then write.
  - `append` — create if missing, then append.
- ! On refusal, throw `ContainedWriteError` with a **stable** `code` (machine-readable).
- ⊗ Silent fallback to raw `writeFileSync` / `appendFileSync` when containment fails.
- ⊗ Prefer bespoke per-sink symlink checks when `containedWrite` is equivalent — migrate the call site instead (epic #2951 goal).

### Stable error codes

| Code | Meaning |
| --- | --- |
| `CONTAINED_WRITE_ESCAPE` | Target not nested under root (`..` or absolute outside root). |
| `CONTAINED_WRITE_SYMLINK` | Symlink on the write path (leaf, parent, or escaping). |
| `CONTAINED_WRITE_EXISTS` | `mode: "create"` but target already exists. |
| `CONTAINED_WRITE_ROOT_MISSING` | Containment root does not exist. |
| `CONTAINED_WRITE_INVALID_MODE` | Unsupported mode / options. |
| `CONTAINED_WRITE_IO` | I/O failure after containment passed. |
| `CONTAINED_WRITE_NOT_FOUND` | Reserved for stricter missing-target modes. |

Implementation: `packages/core/src/fs/contained-write.ts`  
Containment helpers (escape/symlink walk): `packages/core/src/fs/projection-containment.ts`

## Who must use it

- ! **New product write sinks** under `packages/core/src/**` (policy, scope, cache, migrate, eval ledgers, session state, lifecycle logs owned by the project, etc.) MUST use `containedWrite` (or a thin wrapper that only calls it).
- ! **Agents** adding a write path MUST call `containedWrite` rather than `node:fs` write helpers, unless the file is:
  - a unit/integration **test** or fixture, or
  - an explicitly allowlisted implementation module (see below).
- ~ **AppSec “N mediums” issues** SHOULD prefer migrating the sink onto `containedWrite` over another one-off `assertWriteTargetSafe` + raw write pair when behavior is equivalent.
- ? Test-only temp-tree setup MAY keep using `writeFileSync` (tests are allowlisted by the inventory gate).

## Inventory gate (`task verify:contained-writes`)

```bash
task verify:contained-writes
task verify:contained-writes -- --enforce   # fail closed (later phases)
```

- Scans `packages/core/src` for raw write patterns (`writeFileSync`, `appendFileSync`, `fs.writeFile`, `createWriteStream`, …).
- Skips `*.test.ts` and a **seed allowlist** of implementation modules.
- **Phase 1 default: fail-open** — prints an advisory report and exits **0** even when findings remain. Documented so CI is not red while migration is incomplete.
- Pass `--enforce` to exit **1** on findings (intended for a later phase once the allowlist has shrunk).
- Not wired into `task check` in Phase 1.

Allowlist seed lives in `packages/core/src/verify-source/contained-writes.ts` (`CONTAINED_WRITES_ALLOWLIST`). New exceptions need a comment + allowlist entry with issue citation.

## Residual risk

- TOCTOU between check and open is mitigated on platforms that honor `O_NOFOLLOW` on open; residual races can remain on some Windows paths. Document rather than claim zero residual risk (epic non-goal).
- Go installer / `cmd/deft-install` sinks are **out of Phase 1** (epic still lists a Go equivalent for a later phase).
- Reads are not covered by this API.

## Migration checklist (later phases)

1. Inventory via `task verify:contained-writes`.
2. Migrate highest-risk AppSec-touched sinks (policy, migrate, deposit, scope/cache).
3. Shrink allowlist; enable `--enforce` in CI / `task check`.
4. Remove allowlist entries as migration completes.

## Related

- Epic: https://github.com/deftai/directive/issues/2951
- Projection containment: `packages/core/src/fs/projection-containment.ts`
- Security posture: [docs/security.md](../security.md)
- Contributing note: [CONTRIBUTING.md](../../CONTRIBUTING.md) § Contained writes
