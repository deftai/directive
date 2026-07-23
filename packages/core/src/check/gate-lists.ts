/** Gate execution order mirrors Taskfile.yml check targets (#1713 dogfood). */

export const FRAMEWORK_CHECK_GATES: readonly string[] = [
  "ts:check-lane",
  "toolchain:check",
  "verify:stubs",
  "verify:links",
  "verify:rule-ownership",
  "verify:biome-config",
  "verify:content-manifest",
  "verify:skill-external-fetch-gate",
  "verify:contract-drift",
  "verify:cursor-tier1",
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
  "verify-wip-cap-framework-self-check",
  "verify:orphan-active",
  "verify:agents-md-budget",
  "verify-eval-health-relocation-framework-check",
  "verify-eval-triggers-relocation-framework-check",
  "vbrief:validate",
  "codebase:validate-structure",
  "verify:codebase-map-fresh",
  "verify-strategy-output",
];

export const CONSUMER_CHECK_GATES: readonly string[] = [
  "doctor",
  "toolchain:check-consumer",
  "verify:branch",
  "verify:cache-fresh",
  "verify:wip-cap",
  "verify:orphan-active",
  "vbrief:validate",
  "verify-strategy-output",
];

export function gatesForCheckTarget(target: string): readonly string[] {
  if (target === "check:framework-source") {
    return FRAMEWORK_CHECK_GATES;
  }
  if (target === "check:consumer") {
    return CONSUMER_CHECK_GATES;
  }
  return [];
}
