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
import { resolveBaseBranch } from "./base-branch.js";
import { resolveDeliveryBranch } from "./delivery-branch.js";

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

/** Load dest/source from project policy, then run {@link detectBranchSync}. */
export function detectBranchSyncFromProject(options: {
  readonly projectRoot: string;
  readonly prBase: string;
  readonly headSha: string;
  readonly runGit?: GitRunner;
}): BranchSyncDetection {
  const runGit = options.runGit ?? defaultGitRunner;
  const dest = resolveDeliveryBranch(options.projectRoot, runGit).branch;
  const base = resolveBaseBranch(options.projectRoot, runGit);
  return detectBranchSync({
    dest,
    source: base.branch,
    sourceTyped: base.typed,
    prBase: options.prBase,
    headSha: options.headSha,
    projectRoot: options.projectRoot,
    developHint: base.developHint,
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
    "import json, pathlib, subprocess, sys",
    "head_sha, pr_base = sys.argv[1], sys.argv[2]",
    "def git(*a):",
    "    return subprocess.run(['git', *a], capture_output=True, text=True)",
    "dest = source = None",
    "p = pathlib.Path('xbrief/PROJECT-DEFINITION.xbrief.json')",
    "if p.is_file():",
    "    try:",
    "        plan = json.loads(p.read_text(encoding='utf-8')).get('plan')",
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
    "    dest = r.stdout.strip().split('/', 1)[-1] if r.returncode == 0 and r.stdout.strip() else 'master'",
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
