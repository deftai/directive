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

export const FRAMEWORK_CHECK_GATES: readonly CheckGateSpec[] = [
  "ts:check-lane",
  "toolchain:check",
  "verify:stubs",
  "verify:links",
  "verify:rule-ownership",
  "verify:biome-config",
  "verify:content-manifest",
  "verify:license-sync",
  "verify:skill-external-fetch-gate",
  "verify:contract-drift",
  "verify:cursor-tier1",
  "verify:openclaw-tier1",
  "verify:go-freeze",
  "verify:bridge-drift",
  "verify:branch",
  "verify:encoding",
  "verify:forward-coverage",
  "verify:vbrief-conformance",
  "verify:destructive-gh-verbs",
  "verify:scm-boundary",
  "verify:xbrief-drift",
  "verify:no-task-runtime",
  "verify:cache-fresh",
  "verify:pack-drift",
  // Public surface for Taskfile verify-wip-cap-framework-self-check (#1124 / #2791)
  { task: "verify:wip-cap", args: ["--allow-over-cap"] },
  "verify:orphan-active",
  "verify:agents-md-budget",
  // Public surfaces for internal eval-relocation framework shims (#2791)
  { task: "verify:eval-health-relocation", args: ["--base-ref", "origin/master"] },
  { task: "verify:eval-triggers-relocation", args: ["--base-ref", "origin/master"] },
  "vbrief:validate",
  "codebase:validate-structure",
  "verify:codebase-map-fresh",
  "verify-strategy-output",
];

export const CONSUMER_CHECK_GATES: readonly CheckGateSpec[] = [
  "doctor",
  "toolchain:check-consumer",
  "verify:branch",
  "verify:cache-fresh",
  "verify:wip-cap",
  "verify:orphan-active",
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
