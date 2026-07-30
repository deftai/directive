# Contained write API (#2951)

Mandatory filesystem write primitive for **product** sinks in the TypeScript engine.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Why this exists

AppSec mediums kept reappearing as “N more symlink / path-escape write sinks” (#2470, #2521, #2632, #2668, #2710, #2766, #2807, #2847, #2869, …). Patching call sites one-by-one does not end the class. Epic **#2951** requires:

1. One **contained write contract** (resolve under root → refuse escape/symlink → write).
2. Migration of product sinks onto that API.
3. Enforcement so new raw `writeFileSync` / similar outside an allowlist cannot land silently.

Phase 1 landed the **TS API + tests + docs + fail-open inventory gate** and one product sink. **Phase 2** migrates additional high-risk product sinks onto `containedWrite`, shrinks the allowlist, and keeps `--enforce` as the fail-closed path (still optional until mass migration completes). Residual work (#2980) is **TS product sink migration + fail-closed inventory**; the **Go installer contained-write API is deferred/frozen** and is not required to close residual acceptance.

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
task verify:contained-writes -- --enforce   # fail closed on findings
```

- Scans `packages/core/src` for raw write patterns (`writeFileSync`, `appendFileSync`, `fs.writeFile`, `createWriteStream`, …).
- Skips `*.test.ts`, fixtures, and **non-product harness** path markers (`release-e2e/**`, `integration-e2e/**`, `**/parity-scenarios.ts`) so e2e/parity noise does not block `--enforce` (#2980).
- Skips a **shrinking allowlist** of residual implementation modules (containment primitives).
- **Default: fail-open** — prints an advisory report and exits **0** even when findings remain (mass migration incomplete).
- Pass `--enforce` to exit **1** on findings (Phase 2+ path; not yet wired into `task check`).
- Phase 2 removed `cache/io.ts` and `lifecycle/events.ts` from the allowlist after migration.
- Residual wave C (#2980) migrates eval ledgers, doctor-state, residual cache self-heal, xbrief-migrate product writes, and PROJECT-DEFINITION atomic write onto `containedWrite` (no allowlist growth). Lock/temp `openSync` patterns (e.g. project-definition mutation lock) remain residual for later hygiene.

Allowlist lives in `packages/core/src/verify-source/contained-writes.ts` (`CONTAINED_WRITES_ALLOWLIST`). Harness exclusions live in `NON_PRODUCT_HARNESS_PATH_MARKERS` (prefer exclusion over permanent product allowlist). New allowlist exceptions need a comment + entry with issue citation.

## Residual risk and scope (#2980)

- **Residual scope for epic close:** TypeScript **product** sinks under `packages/core/src` + fail-closed inventory (`--enforce`, then CI / `task check` when findings are near zero). E2E/parity harness paths are excluded by design (#2980 scanner hygiene), not treated as product.
- **Go installer / `cmd/deft-install` contained-write API is deferred/frozen.** It is **not** required to close residual #2980 / finish #2951 for the TS engine. A Go equivalent may return as a later optional issue if the freeze lifts.
- TOCTOU between check and open is mitigated on platforms that honor `O_NOFOLLOW` on open; residual races can remain on some Windows paths. Document rather than claim zero residual risk (epic non-goal).
- Reads are not covered by this API.

## Migration checklist

1. Inventory via `task verify:contained-writes`.
2. Migrate highest-risk AppSec-touched sinks (policy, migrate, deposit, scope/cache) — Phase 2 batch landed several of these.
3. Shrink allowlist further; enable `--enforce` in CI / `task check` when residual count is acceptable.
4. Remove remaining allowlist entries as migration completes.

## Related

- Epic: https://github.com/deftai/directive/issues/2951
- Residual (TS product + enforce; Go frozen): https://github.com/deftai/directive/issues/2980
- Projection containment: `packages/core/src/fs/projection-containment.ts`
- Security posture: [docs/security.md](../security.md)
- Contributing note: [CONTRIBUTING.md](../../CONTRIBUTING.md) § Contained writes
