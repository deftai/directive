# Launcher–runtime Contract 1

| | |
| --- | --- |
| Contract | **1** |
| Authority | deftai/directive#5490 · `UNIFIED-GITHUB-V2.md` §§A5.5, R4, AC4.* |
| Status | **YOLO-DRAFT pending operator sign-off** |
| Named suite | `packages/core/src/install-contract/contract-v1.test.ts` (AC4.1) |

Freezeable draft under YOLO #5490 Wave 1 slice 1c. Operator sign-off is asynchronous; do not change entry-point shapes or discriminants after freeze without a contract bump (AC4.8).

---

## 1. Purpose

A launcher of one version must work with runtimes of many versions. The interface is small, written down, and numbered. This document is Contract 1 (AC4.1).

## 2. How the launcher learns about a runtime (no code load)

Two fields in the runtime package's `package.json` only — the launcher loads **no** runtime code (A5.5, AC3.9):

```json
{
  "name": "@deftai/directive-runtime",
  "version": "1.2.3",
  "directive": { "contract": 1 }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Exact installed runtime version |
| `directive.contract` | Integer contract number this runtime speaks |

Constants: `CONTRACT_NUMBER = 1`, package.json key `directive`.

## 3. How the launcher starts the runtime (AC4.2)

- Separate `node` process on the runtime's entry file under the verified project's `node_modules`.
- Never via `PATH`; never via a mechanism that can download a substitute (INIT-14).
- User arguments unchanged; project root and launcher version passed explicitly.
- stdio and exit code passed through.

## 4. Entry points (AC4.3)

Ordinary commands pass through as typed. Beyond pass-through, Contract 1 defines:

| Entry point | Called when | Runtime obligation |
| --- | --- | --- |
| `setup --operation install\|repair\|upgrade --from <version\|old-style\|none> --root <path>` | After launcher verification **or** eligible runtime automatic setup (same entry point and obligations) | Write/refresh wiring; record itself in `GENERATION.json`; run the in-sync check; do everything safe; name every conflict; exit 1 if any; may read settings; create missing initial seed project-data files only for `--operation install` (AC8.4); **never** migrate existing data |
| `migrate --from <version> --root <path>` | By upgrade after setup for a version change; after setup when equal-version wiring was stale; or directly for equal-version data migration when wiring is already current | Migrate supported `xbrief`/`vbrief` schemas to current; return actual changes and outcomes; retries preserve completed work |
| `uninstall --root <path>` | Before the launcher removes the package, when the runtime can run safely under a compatible contract | Remove owned hook entries first, then owned files/sections; return removals and what remains for continued launcher cleanup |
| `doctor` | Any time; also before the equal-version upgrade decision | Full read-only diagnosis; supply a contract result distinguishing data current, migration needed, and diagnosis failed |

Who calls whom:

- **Launcher → runtime** for bookends (`setup`, `migrate`, `uninstall`) and for equal-version `doctor` data-status.
- **Runtime → (self)** for eligible automatic setup using the same `setup` entry point.
- Hand-off never recursively invokes the launcher's `install` flow; the approved operation survives without a second discovery (AC4.4).

## 5. Exit codes (AC4.5 / INIT-23)

| Code | Meaning |
| --- | --- |
| `0` | Success / nothing to do / explicit cancel |
| `1` | Operational or validation failure (including named conflicts) |
| `2` | Invalid arguments or a missing choice in non-interactive use |
| `130` | Interrupted |

Apply everywhere: launcher and runtime.

## 6. Equal-version data-status diagnostic (AC4.10)

For equal-version upgrade, the launcher obtains data status from the verified pinned runtime's **read-only** diagnostic before choosing:

- no-write no-op,
- migration-only, or
- setup-then-migration (when wiring / `GENERATION` / readiness is stale for the pin).

Discriminants (`DataStatus`):

| Value | Meaning |
| --- | --- |
| `current` | Data already on the current schema |
| `migration_needed` | Data behind; migration required after any needed setup |
| `diagnosis_failed` | Diagnostic could not decide; **error**, never treated as current |

Rules:

- Diagnostic failure exits nonzero and is never treated as current data.
- The exchange itself performs **no** setup or migration (including during discovery and `--dry-run`).
- No new public command; no schema knowledge in the launcher.

### Serialization (Contract 1 choice)

**JSON over stdout** (single line). The runtime's `doctor` path that supplies the contract diagnostic emits exactly one JSON object on stdout:

```json
{ "contract": 1, "dataStatus": "current" }
```

| Field | Type | Required |
| --- | --- | --- |
| `contract` | number | yes — must equal `CONTRACT_NUMBER` |
| `dataStatus` | `"current" \| "migration_needed" \| "diagnosis_failed"` | yes |

Parse failure or unknown discriminant → launcher treats as diagnostic failure (nonzero), never as `current`. Transport alternative (file) is out of Contract 1; do not invent a second channel without a bump.

## 7. Contract bump and compatibility (AC4.6–AC4.8)

- A launcher supports every contract number from **1** up to its own maximum (`LAUNCHER_MAX_SUPPORTED_CONTRACT`). Newer launcher + older runtime is always OK.
- A launcher meeting a **higher** contract number than it supports **never** starts that runtime or chooses another release (AC4.7 / INIT-02). Delegation/upgrade stop and explain which launcher update is required (`npm i -g @deftai/directive@latest`). Uninstall instead uses launcher fallback (R11) without requiring install/repair/upgrade of either package. Upgrade-target preflight of published contract happens **before** modifying pin/lockfile; too-new leaves them unchanged.
- The contract number increases **only** when launcher behaviour must change; the release checklist says so (AC4.8). Adding runtime-only commands does not bump it.

## 8. Post-execution reporting (AC4.9)

After execution, the verified target runtime returns actual created, modified, removed and migrated paths, outcomes and failures to the launcher for completion / partial-failure reporting. No target-supplied preapproval planner or temporary target execution is required. Concrete result serialization for bookend outcomes beyond data-status is specified when those bodies are implemented (Wave 2); Contract 1 freezes the entry points, exit codes, and data-status channel above.

## 9. TypeScript spine

Exported from `packages/core/src/install-contract/`:

- `CONTRACT_NUMBER`, `CONTRACT_PACKAGE_JSON_KEY`, `LAUNCHER_MAX_SUPPORTED_CONTRACT`
- `EXIT_CODES`, `ENTRY_POINTS`, `SETUP_OPERATIONS`, `SETUP_FROM_VALUES`
- `DataStatus` / `DATA_STATUS_VALUES`
- `serializeDataStatusJson` / `parseDataStatusJson`
- `readRuntimeContractFromPackageJson` / `isContractSupportedByLauncher`
- Argv types: `SetupArgv`, `MigrateArgv`, `UninstallArgv`, `DoctorArgv`

Real `setup` / `migrate` / `uninstall` bodies are **out of scope** for this draft (stubs/types/doc only).
