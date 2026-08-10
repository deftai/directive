/** Gate execution order mirrors Taskfile.yml check targets (#1713 dogfood). */

/**
 * A check gate is either a bare Taskfile task name, or a public task plus CLI
 * args (after `--`). Framework-only shims that are `internal: true` in
 * Taskfile.yml cannot be shelled by name under go-task 3.50 (#2791) — use the
 * public surface with the shim's flags instead.
 */
export type CheckGateSpec =
  | string
  | {
      readonly task: string;
      readonly args?: readonly string[];
    };

export function checkGateId(spec: CheckGateSpec): string {
  return typeof spec === "string" ? spec : spec.task;
}

/** Args for `task … --taskfile <path>` (optional `--` + public CLI flags). */
export function checkGateSpawnArgs(spec: CheckGateSpec, taskfilePath: string): string[] {
  const task = checkGateId(spec);
  const extra = typeof spec === "string" ? undefined : spec.args;
  if (extra !== undefined && extra.length > 0) {
    return [task, "--taskfile", taskfilePath, "--", ...extra];
  }
  return [task, "--taskfile", taskfilePath];
}

/**
 * Gates that own the long vitest+coverage (or equivalent) suite path.
 * Shared `task check` composition runs every non-suite gate first so cheap
 * failures never pay suite wall-clock (#3188). Release suite stamp/resume
 * remains #3187 / release-scoped.
 */
export const SUITE_CHECK_GATE_IDS: readonly string[] = ["ts:check-lane"];

export function isSuiteCheckGate(spec: CheckGateSpec | string): boolean {
  const id = typeof spec === "string" ? spec : checkGateId(spec);
  return (SUITE_CHECK_GATE_IDS as readonly string[]).includes(id);
}

/**
 * True when every suite gate appears after all non-suite gates (#3188).
 * Empty lists and suite-only lists are valid; a non-suite after a suite is not.
 */
export function isFastBeforeSlowOrder(gates: readonly CheckGateSpec[]): boolean {
  let sawSuite = false;
  for (const gate of gates) {
    if (isSuiteCheckGate(gate)) {
      sawSuite = true;
    } else if (sawSuite) {
      return false;
    }
  }
  return true;
}

/**
 * Framework-source check composition (#1713 / #3188).
 *
 * Order contract: cheap preflight gates first; `ts:check-lane` (lint+build+
 * vitest coverage suite) last so a stale cache / orphan-active / branch miss
 * fails in seconds without starting the suite.
 */
export const FRAMEWORK_CHECK_GATES: readonly CheckGateSpec[] = [
  // --- Fast preflight (seconds–few min) — #3188 ---
  "verify:branch",
  "verify:encoding",
  "verify:cache-fresh",
  "verify:orphan-active",
  "verify:completed-tracked",
  "verify:license-sync",
  "verify:contract-drift",
  "toolchain:check",
  "verify:stubs",
  "verify:links",
  "verify:rule-ownership",
  "verify:biome-config",
  "verify:content-manifest",
  "verify:skill-external-fetch-gate",
  "verify:cursor-tier1",
  "verify:openclaw-tier1",
  "verify:go-freeze",
  "verify:bridge-drift",
  "verify:forward-coverage",
  // #3145: test/source boundary + approved-scope provenance + consumer gate composition
  "verify:test-boundary",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
  "verify:vbrief-conformance",
  "verify:destructive-gh-verbs",
  "verify:scm-boundary",
  "verify:xbrief-drift",
  "verify:no-task-runtime",
  "verify:pack-drift",
  // Public surface for Taskfile verify-wip-cap-framework-self-check (#1124 / #2791)
  { task: "verify:wip-cap", args: ["--allow-over-cap"] },
  "verify:agents-md-budget",
  // Public surfaces for internal eval-relocation framework shims (#2791)
  { task: "verify:eval-health-relocation", args: ["--base-ref", "origin/master"] },
  { task: "verify:eval-triggers-relocation", args: ["--base-ref", "origin/master"] },
  "vbrief:validate",
  "codebase:validate-structure",
  "verify:codebase-map-fresh",
  "verify-strategy-output",
  // --- Suite last: vitest + coverage via ts:check-lane (#3188) ---
  "ts:check-lane",
];

export const CONSUMER_CHECK_GATES: readonly CheckGateSpec[] = [
  // Cheap lifecycle / policy first (no suite co-list today; keep fail-fast order)
  "verify:branch",
  "verify:cache-fresh",
  "verify:wip-cap",
  "verify:orphan-active",
  "verify:completed-tracked",
  "doctor",
  "toolchain:check-consumer",
  // #3145 enforcement trio (test placement, scope provenance, gate composition)
  "verify:test-boundary",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
  "vbrief:validate",
  "verify-strategy-output",
];

export function gatesForCheckTarget(target: string): readonly CheckGateSpec[] {
  if (target === "check:framework-source") {
    return FRAMEWORK_CHECK_GATES;
  }
  if (target === "check:consumer") {
    return CONSUMER_CHECK_GATES;
  }
  return [];
}
