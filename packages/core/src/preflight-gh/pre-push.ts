/**
 * Pre-push stdin policy for default-branch create/update/delete (#1019 / #4384).
 *
 * Hook path: .githooks/pre-push passes --pre-push-stdin --project-root.
 * Empty-remote / zero-OID create of master/main is not an exemption.
 */

import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { resolveAllowDestructiveGhVerbs } from "../policy/destructive-gh-verbs.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import { DEFAULT_BRANCHES, ENV_BYPASS } from "./classifier.js";

export interface PrePushRef {
  readonly localRef: string;
  readonly localOid: string;
  readonly remoteRef: string;
  readonly remoteOid: string;
}

const ZERO_OID_RE = /^0+$/;
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function parsePrePushStdin(text: string): PrePushRef[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .flatMap((l) => {
      const parts = l.split(/\s+/);
      if (parts.length !== 4) return [];
      return [
        {
          localRef: parts[0] ?? "",
          localOid: parts[1] ?? "",
          remoteRef: parts[2] ?? "",
          remoteOid: parts[3] ?? "",
        },
      ];
    });
}

function envBypassActive(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[ENV_BYPASS] ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

function blockedDefaultBranchTouches(
  refs: readonly PrePushRef[],
  branches: ReadonlySet<string>,
): string[] {
  const branchesLower = new Set([...branches].map((b) => b.toLowerCase()));
  const blocked: string[] = [];
  for (const { localRef, localOid, remoteRef, remoteOid } of refs) {
    const branch = remoteRef.replace(/^refs\/heads\//, "");
    if (!branchesLower.has(branch.toLowerCase())) continue;
    if (ZERO_OID_RE.test(remoteOid)) {
      blocked.push(`create ${branch} (local=${localRef})`);
    } else if (ZERO_OID_RE.test(localOid)) {
      blocked.push(`delete ${branch}`);
    } else {
      blocked.push(`update ${branch} (local=${localRef})`);
    }
  }
  return blocked;
}

function refuseMessage(blocked: readonly string[]): string {
  return [
    "❌ deft destructive-gh-verb gate (pre-push): refusing to push directly to the default branch.",
    `  Detail: ${blocked.join("; ")}`,
    "",
    "  How to proceed:",
    "    • push to a feature branch and open a PR",
    "    • or opt out via the typed surface:",
    `        ${policyColonInvocation("allow-destructive-gh-verbs", " -- --confirm")}`,
    `    • or set the env-var override for this invocation:  ${ENV_BYPASS}=1`,
    "  See scm/github.md (## Destructive gh verbs (#1019)).",
  ].join("\n");
}

export interface EvaluatePrePushOptions {
  readonly branches?: ReadonlySet<string>;
  readonly projectRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Per-invocation union of typed plan.policy.deliveryBranch (#5520).
 * Does not mutate exported DEFAULT_BRANCHES. Hostile/empty typed skips.
 */
export function unionTypedDeliveryBranches(
  projectRoot: string | undefined,
  branches: ReadonlySet<string>,
): ReadonlySet<string> {
  if (projectRoot === undefined || projectRoot.length === 0) return branches;
  const delivery = resolveDeliveryBranch(projectRoot);
  if (delivery.source === "typed" && delivery.error === null && delivery.branch.trim().length > 0) {
    const next = new Set(branches);
    next.add(delivery.branch);
    return next;
  }
  return branches;
}

/**
 * Evaluate pre-push stdin refs. Consults plan.policy.allowDestructiveGhVerbs
 * through --project-root when provided. Does not treat zero-OID create as empty-remote.
 * When projectRoot is set, union typed deliveryBranch into a per-invocation set (#5520).
 */
export function evaluatePrePush(
  refs: readonly PrePushRef[],
  options: EvaluatePrePushOptions = {},
): [number, string] {
  const branches = unionTypedDeliveryBranches(
    options.projectRoot,
    options.branches ?? DEFAULT_BRANCHES,
  );
  const env = options.env ?? process.env;

  if (refs.length === 0) {
    return [0, "✓ deft destructive-gh-verb gate (pre-push): no refs in stdin -- nothing to gate."];
  }

  const blocked = blockedDefaultBranchTouches(refs, branches);
  if (blocked.length === 0) {
    return [
      0,
      "✓ deft destructive-gh-verb gate (pre-push): no pushes to default branches detected -- proceeding.",
    ];
  }

  if (envBypassActive(env)) {
    return [
      0,
      `⚠ deft destructive-gh-verb gate (pre-push): default-branch push detected (${blocked.join("; ")}) but ${ENV_BYPASS}=1 is set -- policy bypassed for this invocation.`,
    ];
  }

  const projectRoot = options.projectRoot;
  if (projectRoot !== undefined && projectRoot.length > 0) {
    const policy = resolveAllowDestructiveGhVerbs(projectRoot);
    if (policy.error) {
      return [
        2,
        [
          "❌ deft destructive-gh-verb gate (pre-push): PROJECT-DEFINITION cannot be resolved.",
          `  Detail: ${policy.error}`,
        ].join("\n"),
      ];
    }
    if (policy.allowDestructiveGhVerbs) {
      return [
        0,
        `⚠ deft destructive-gh-verb gate (pre-push): default-branch push detected (${blocked.join("; ")}) but plan.policy.allowDestructiveGhVerbs=true -- policy allowed for this invocation.`,
      ];
    }
  }

  return [1, refuseMessage(blocked)];
}
