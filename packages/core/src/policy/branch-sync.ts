/**
 * Shared branch-sync detector (#3388 / #3377 Wave 1).
 *
 * Dest = deliveryBranch. Source = typed baseBranch (unset equals dest → not a
 * sync). Predicate: PR base is dest AND head is already on origin/<source>
 * after fetch (tip or ancestor). Name-only and label-only exemptions are not
 * implemented. origin/develop is never load-bearing identity.
 *
 * This module is the only is-this-a-sync source for later children (#3390/#3391)
 * and for core-guard.
 */

import { defaultGitRunner, type GitRunner, gitIsAncestor } from "../session/git.js";
import { ORIGIN_DEVELOP_HINT } from "./base-branch.js";
import { resolveGitDefaultDeliveryBranch } from "./delivery-branch.js";
import { readPlanPolicy } from "./plan-extensions.js";

/** Dest-ref blob used for dest/source. Never the PR working tree (#3388 P1). */
export const BRANCH_SYNC_POLICY_BLOB = "xbrief/PROJECT-DEFINITION.xbrief.json";

export const BRANCH_SYNC_EXEMPTION_PREFIX =
  "sync PR detected: all commits already guard-checked on";

export type BranchSyncReason =
  | "source-equals-dest"
  | "base-is-not-dest"
  | "fetch-failed"
  | "head-not-on-integration"
  | "sync";

export interface BranchSyncDetection {
  readonly isSync: boolean;
  readonly dest: string;
  readonly source: string;
  readonly sourceTyped: boolean;
  readonly reason: BranchSyncReason;
  readonly message: string;
  readonly developHint: string | null;
}

export interface DetectBranchSyncInput {
  readonly dest: string;
  readonly source: string;
  readonly sourceTyped: boolean;
  readonly prBase: string;
  readonly headSha: string;
  readonly projectRoot: string;
  readonly developHint?: string | null;
  readonly runGit?: GitRunner;
}

export function formatBranchSyncExemptionMessage(integrationBranch: string): string {
  return `${BRANCH_SYNC_EXEMPTION_PREFIX} ${integrationBranch}`;
}

function notSync(
  input: DetectBranchSyncInput,
  reason: Exclude<BranchSyncReason, "sync">,
): BranchSyncDetection {
  return {
    isSync: false,
    dest: input.dest,
    source: input.source,
    sourceTyped: input.sourceTyped,
    reason,
    message: "",
    developHint: input.developHint ?? null,
  };
}

/**
 * Evidence-based sync predicate (#3388 Q3). Fetch first. Do not trust PR
 * branch names or labels.
 */
export function detectBranchSync(input: DetectBranchSyncInput): BranchSyncDetection {
  const dest = input.dest.trim();
  const source = input.source.trim();
  if (source.length === 0 || dest.length === 0 || source === dest) {
    return notSync({ ...input, dest, source }, "source-equals-dest");
  }
  if (input.prBase.trim() !== dest) {
    return notSync({ ...input, dest, source }, "base-is-not-dest");
  }

  const runGit = input.runGit ?? defaultGitRunner;
  const fetched = runGit(input.projectRoot, ["fetch", "--quiet", "origin", source]);
  if (fetched.code !== 0) {
    return notSync({ ...input, dest, source }, "fetch-failed");
  }

  const onIntegration = gitIsAncestor(input.projectRoot, input.headSha, `origin/${source}`, runGit);
  if (onIntegration !== true) {
    return notSync({ ...input, dest, source }, "head-not-on-integration");
  }

  return {
    isSync: true,
    dest,
    source,
    sourceTyped: input.sourceTyped,
    reason: "sync",
    message: formatBranchSyncExemptionMessage(source),
    developHint: input.developHint ?? null,
  };
}

function parseTypedPolicyBranches(jsonText: string): {
  dest: string | null;
  source: string | null;
} {
  try {
    const data = JSON.parse(jsonText) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { dest: null, source: null };
    }
    const policyBlock = readPlanPolicy((data as Record<string, unknown>).plan);
    if (typeof policyBlock !== "object" || policyBlock === null || Array.isArray(policyBlock)) {
      return { dest: null, source: null };
    }
    const rec = policyBlock as Record<string, unknown>;
    const destRaw = rec.deliveryBranch;
    const sourceRaw = rec.baseBranch;
    return {
      dest: typeof destRaw === "string" && destRaw.trim().length > 0 ? destRaw.trim() : null,
      source:
        typeof sourceRaw === "string" && sourceRaw.trim().length > 0 ? sourceRaw.trim() : null,
    };
  } catch {
    return { dest: null, source: null };
  }
}

export interface DestRefSyncPolicy {
  readonly dest: string;
  readonly source: string;
  readonly sourceTyped: boolean;
  readonly developHint: string | null;
}

/**
 * Load dest/source from origin/<prBase>, not the PR checkout.
 *
 * A feature PR that rewrites working-tree baseBranch cannot become a sync.
 */
export function resolveSyncPolicyFromDestRef(options: {
  readonly projectRoot: string;
  readonly prBase: string;
  readonly runGit?: GitRunner;
}): DestRefSyncPolicy {
  const runGit = options.runGit ?? defaultGitRunner;
  const prBase = options.prBase.trim();
  const fetched = runGit(options.projectRoot, ["fetch", "--quiet", "origin", prBase]);
  if (fetched.code !== 0) {
    const dest = resolveGitDefaultDeliveryBranch(options.projectRoot, runGit);
    const developHint =
      runGit(options.projectRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        "refs/remotes/origin/develop",
      ]).code === 0
        ? ORIGIN_DEVELOP_HINT
        : null;
    return { dest, source: dest, sourceTyped: false, developHint };
  }
  const shown = runGit(options.projectRoot, [
    "show",
    `origin/${prBase}:${BRANCH_SYNC_POLICY_BLOB}`,
  ]);
  const parsed =
    shown.code === 0 && shown.stdout.length > 0
      ? parseTypedPolicyBranches(shown.stdout)
      : { dest: null, source: null };
  const dest = parsed.dest ?? resolveGitDefaultDeliveryBranch(options.projectRoot, runGit);
  const sourceTyped = parsed.source !== null;
  const source = parsed.source ?? dest;
  const developHint =
    sourceTyped ||
    runGit(options.projectRoot, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/develop"])
      .code !== 0
      ? null
      : ORIGIN_DEVELOP_HINT;
  return { dest, source, sourceTyped, developHint };
}

/** Load dest/source from dest-ref policy, then run {@link detectBranchSync}. */
export function detectBranchSyncFromProject(options: {
  readonly projectRoot: string;
  readonly prBase: string;
  readonly headSha: string;
  readonly runGit?: GitRunner;
}): BranchSyncDetection {
  const runGit = options.runGit ?? defaultGitRunner;
  const policy = resolveSyncPolicyFromDestRef({
    projectRoot: options.projectRoot,
    prBase: options.prBase,
    runGit,
  });
  return detectBranchSync({
    dest: policy.dest,
    source: policy.source,
    sourceTyped: policy.sourceTyped,
    prBase: options.prBase,
    headSha: options.headSha,
    projectRoot: options.projectRoot,
    developHint: policy.developHint,
    runGit,
  });
}

export interface CoreGuardSyncExemption {
  readonly wouldFail: boolean;
  readonly loudMessage: string | null;
}

/**
 * Core-guard mix result after the shared sync predicate. Sync PRs pass
 * loudly; mixed feature PRs still fail.
 */
export function applyCoreGuardWithBranchSync(
  classification: { readonly wouldFail: boolean },
  sync: BranchSyncDetection,
): CoreGuardSyncExemption {
  if (!classification.wouldFail) {
    return { wouldFail: false, loudMessage: null };
  }
  if (sync.isSync) {
    return { wouldFail: false, loudMessage: formatBranchSyncExemptionMessage(sync.source) };
  }
  return { wouldFail: true, loudMessage: null };
}

/** Compact Python body for the deposited deft-core-guard (#3388). */
export function coreGuardBranchSyncPythonBody(): readonly string[] {
  return [
    "import json, subprocess, sys",
    "head_sha, pr_base = sys.argv[1], sys.argv[2]",
    "def git(*a):",
    "    return subprocess.run(['git', *a], capture_output=True, text=True)",
    "dest = source = None",
    "if git('fetch', '--quiet', 'origin', pr_base).returncode != 0: sys.exit(1)",
    `shown = git('show', 'origin/' + pr_base + ':${BRANCH_SYNC_POLICY_BLOB}')`,
    "if shown.returncode == 0:",
    "    try:",
    "        plan = json.loads(shown.stdout).get('plan')",
    "    except Exception:",
    "        plan = None",
    "    if isinstance(plan, dict):",
    "        pol = plan.get('x-directive/policy') or plan.get('policy') or {}",
    "        if isinstance(pol, dict):",
    "            d, s = pol.get('deliveryBranch'), pol.get('baseBranch')",
    "            if isinstance(d, str) and d.strip(): dest = d.strip()",
    "            if isinstance(s, str) and s.strip(): source = s.strip()",
    "if not dest:",
    "    r = git('symbolic-ref', 'refs/remotes/origin/HEAD', '--short')",
    "    if r.returncode == 0 and r.stdout.strip():",
    "        dest = r.stdout.strip().split('/', 1)[-1]",
    "    else:",
    "        for n in ('main', 'master'):",
    "            if git('show-ref', '--verify', '--quiet', 'refs/remotes/origin/' + n).returncode == 0:",
    "                dest = n",
    "                break",
    "        if not dest:",
    "            for n in ('main', 'master'):",
    "                if git('show-ref', '--verify', '--quiet', 'refs/heads/' + n).returncode == 0:",
    "                    dest = n",
    "                    break",
    "        if not dest: dest = 'master'",
    "if not source: source = dest",
    "if source == dest or pr_base != dest: sys.exit(1)",
    "if git('fetch', '--quiet', 'origin', source).returncode != 0: sys.exit(1)",
    "if git('merge-base', '--is-ancestor', head_sha, 'origin/' + source).returncode != 0: sys.exit(1)",
    `print('${BRANCH_SYNC_EXEMPTION_PREFIX} ' + source)`,
  ];
}

/** Indented `if` block: detector success exits 0 (loud print); else fall through. */
export function renderCoreGuardBranchSyncIfBlock(indent: string): string {
  return [
    `${indent}if python3 - "$HEAD_SHA" "$BASE_REF" <<'PY'`,
    ...coreGuardBranchSyncPythonBody().map((line) => `${indent}${line}`),
    `${indent}PY`,
    `${indent}then`,
    `${indent}  exit 0`,
    `${indent}fi`,
  ].join("\n");
}
