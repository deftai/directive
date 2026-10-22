/**
 * Pre-push stdin policy for default-branch create/update/delete (#1019 / #4384)
 * and enrolled bound pre-PR push admission (#5804).
 *
 * Hook path: .githooks/pre-push passes sole-stdin to enrolled verify; empty /
 * unreadable / malformed stdin denies when the enrolled arm is active.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { resolveAllowDestructiveGhVerbs } from "../policy/destructive-gh-verbs.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import { getDefaultPrePrStore } from "../pre-pr-controller/store.js";
import {
  PRE_PR_PUSH_STAGE_MARKER,
  sha256Hex,
} from "../pre-pr-controller/types.js";
import { DEFAULT_BRANCHES, ENV_BYPASS } from "./classifier.js";

export interface PrePushRef {
  readonly localRef: string;
  readonly localOid: string;
  readonly remoteRef: string;
  readonly remoteOid: string;
}

const ZERO_OID_RE = /^0+$/;
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Inert path extensions / known inert filenames for enrolled docs-only skip. */
const INERT_EXT_RE = /\.(md|mdx|txt|rst)$/i;
const INERT_NAME_RE = /^(CHANGELOG\.md|LICENSE(\..+)?)$/i;

type GitPathsResult =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly error: string };

type GitRevResult =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly error: string };

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

/** True when stdin text has no parseable ref lines (empty / junk-only). */
export function prePushStdinIsEmptyOrMalformed(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return parsePrePushStdin(text).length === 0;
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
  /** When true, empty/malformed stdin denies (enrolled #5804 arm). */
  readonly enrolledBoundPrePr?: boolean;
  /** Raw stdin text for enrolled empty/malformed detection. */
  readonly rawStdin?: string;
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

/** Resolve plan.policy.requireBoundPrePrPush; missing → enrolledHookDefault. */
export function resolveRequireBoundPrePrPush(
  projectRoot: string | undefined,
  enrolledHookDefault = false,
): boolean {
  if (projectRoot === undefined || projectRoot.length === 0) return enrolledHookDefault;
  try {
    const pdPath = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    if (!existsSync(pdPath)) return enrolledHookDefault;
    const data = JSON.parse(readFileSync(pdPath, "utf8")) as { plan?: unknown };
    const policy = readPlanPolicy(data.plan);
    if (policy === null || typeof policy !== "object") return enrolledHookDefault;
    const raw = (policy as Record<string, unknown>).requireBoundPrePrPush;
    if (typeof raw === "boolean") return raw;
    return enrolledHookDefault;
  } catch {
    return enrolledHookDefault;
  }
}

function parseGitZPaths(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

function gitNameOnlyZ(projectRoot: string, args: readonly string[]): GitPathsResult {
  try {
    const out = execFileSync("git", [...args], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, paths: parseGitZPaths(out) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

function gitRevParse(projectRoot: string, args: readonly string[]): GitRevResult {
  try {
    const out = execFileSync("git", [...args], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sha = out.trim();
    if (sha.length === 0) return { ok: false, error: "empty rev-parse" };
    return { ok: true, sha };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

/**
 * Outgoing in-scope changed paths for one update (path containment set).
 * New-branch (zero remote OID) diffs against merge-base with delivery tip.
 * Git failures are distinct from a successful empty path list.
 */
export function outgoingChangedPaths(
  projectRoot: string,
  remoteOid: string,
  localOid: string,
): GitPathsResult {
  if (ZERO_OID_RE.test(localOid)) return { ok: true, paths: [] };
  if (!ZERO_OID_RE.test(remoteOid)) {
    return gitNameOnlyZ(projectRoot, [
      "diff",
      "-z",
      "--name-only",
      `${remoteOid}..${localOid}`,
    ]);
  }

  const delivery = resolveDeliveryBranch(projectRoot);
  const candidates: string[] = [];
  if (delivery.error === null && delivery.branch.trim().length > 0) {
    candidates.push(`refs/remotes/origin/${delivery.branch}`, delivery.branch);
  }
  candidates.push(
    "refs/remotes/origin/master",
    "refs/remotes/origin/main",
    "master",
    "main",
  );

  for (const tip of candidates) {
    const mb = gitRevParse(projectRoot, ["merge-base", localOid, tip]);
    if (!mb.ok) continue;
    return gitNameOnlyZ(projectRoot, [
      "diff",
      "-z",
      "--name-only",
      `${mb.sha}..${localOid}`,
    ]);
  }

  return {
    ok: false,
    error: `cannot resolve merge-base for new-branch push ${localOid.slice(0, 12)}`,
  };
}

export function isDocsOnlyPath(path: string): boolean {
  const n = path.replaceAll("\\", "/");
  if (INERT_NAME_RE.test(n)) return true;
  if (INERT_EXT_RE.test(n)) return true;
  return false;
}

export function isDocsOnlyOutgoing(paths: readonly string[]): boolean {
  if (paths.length === 0) return true;
  return paths.every((p) => isDocsOnlyPath(p));
}

function blobHashAtOid(projectRoot: string, oid: string, relPath: string): string | null {
  try {
    const raw = execFileSync("git", ["show", `${oid}:${relPath}`], {
      cwd: projectRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }) as Buffer;
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Same row format as computeControllerObservedHash, from committed blobs at oid.
 */
export function computeCommittedObservedHash(
  projectRoot: string,
  oid: string,
  reviewedFiles: readonly string[],
): string | null {
  const files = [...reviewedFiles];
  if (files.length === 0) return null;
  const rows: string[] = [];
  for (const rel of [...files].sort()) {
    const norm = rel.replaceAll("\\", "/");
    const digest = blobHashAtOid(projectRoot, oid, norm);
    if (digest === null) return null;
    rows.push(`${norm}:${digest}`);
  }
  return sha256Hex(JSON.stringify(rows));
}

/**
 * Enrolled push admission: outgoing ⊆ reviewed with matching committed content (#5804 P1).
 */
export function evaluateEnrolledBoundPrePrPush(
  refs: readonly PrePushRef[],
  options: {
    readonly projectRoot: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): [number, string] {
  const projectRoot = options.projectRoot;
  const liveRefs = refs.filter((r) => !ZERO_OID_RE.test(r.localOid));
  if (liveRefs.length > 1) {
    return [
      1,
      [
        "❌ deft bound pre-PR push gate: multi-ref push refused when enrolled.",
        "  Push one feature ref per invocation so each tip binds its own pre-PR pass (#5804).",
      ].join("\n"),
    ];
  }

  const resolvedHead =
    liveRefs[0]?.localOid ??
    (() => {
      const h = gitRevParse(projectRoot, ["rev-parse", "HEAD"]);
      return h.ok ? h.sha : "";
    })();
  if (resolvedHead.length === 0) {
    return [
      1,
      "❌ deft bound pre-PR push gate: cannot resolve local OID.\n  Recovery: deft pre-pr:run then retry push.",
    ];
  }

  const outgoing: string[] = [];
  for (const ref of refs) {
    if (ZERO_OID_RE.test(ref.localOid)) continue;
    const listed = outgoingChangedPaths(projectRoot, ref.remoteOid, ref.localOid);
    if (!listed.ok) {
      return [
        1,
        [
          "❌ deft bound pre-PR push gate: cannot derive outgoing changed paths.",
          `  Detail: ${listed.error}`,
          "  Recovery: fetch the remote tip / delivery branch, then retry push (#5804).",
        ].join("\n"),
      ];
    }
    for (const p of listed.paths) {
      outgoing.push(p.replaceAll("\\", "/"));
    }
  }
  const uniqOutgoing = [...new Set(outgoing)];
  if (isDocsOnlyOutgoing(uniqOutgoing)) {
    return [
      0,
      "✓ deft bound pre-PR push gate: docs-only/inert outgoing paths — enrolled skip (#5804).",
    ];
  }

  const store = getDefaultPrePrStore(projectRoot);
  const records = store
    .list()
    .filter(
      (r) =>
        r.outcome === "pass" &&
        r.state === "complete" &&
        r.publishedAt !== null &&
        r.headSha === resolvedHead &&
        r.pushBinding != null &&
        (r.pushBinding.pushStageMarker?.length ?? 0) > 0,
    )
    .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
  const record = records.at(-1);
  if (record === undefined || record.pushBinding == null) {
    return [
      1,
      [
        "❌ deft bound pre-PR push gate: no completed pre-PR pass bound to this HEAD with pushBinding.",
        "  Recovery: deft pre-pr:run then retry push (#5804).",
      ].join("\n"),
    ];
  }

  const reviewed = new Set(
    record.pushBinding.reviewedFileManifest.map((p) => p.replaceAll("\\", "/")),
  );
  const reviewedDeleted = new Set(
    (record.pushBinding.reviewedDeletedPaths ?? []).map((p) => p.replaceAll("\\", "/")),
  );

  const deletedOutgoing: string[] = [];
  const presentOutgoing: string[] = [];
  for (const p of uniqOutgoing) {
    if (blobHashAtOid(projectRoot, resolvedHead, p) === null) {
      deletedOutgoing.push(p);
    } else {
      presentOutgoing.push(p);
    }
  }

  const uncoveredPresent = presentOutgoing.filter((p) => !reviewed.has(p));
  if (uncoveredPresent.length > 0) {
    return [
      1,
      [
        "❌ deft bound pre-PR push gate: outgoing paths not covered by reviewed pushBinding.",
        `  Unreviewed: ${uncoveredPresent.join(", ")}`,
        "  Recovery: deft pre-pr:run (review those paths) then retry push (#5804).",
      ].join("\n"),
    ];
  }

  const uncoveredDeleted = deletedOutgoing.filter((p) => !reviewedDeleted.has(p));
  if (uncoveredDeleted.length > 0) {
    return [
      1,
      [
        "❌ deft bound pre-PR push gate: deleted outgoing paths not in reviewedDeletedPaths.",
        `  Unreviewed deletions: ${uncoveredDeleted.join(", ")}`,
        "  Recovery: deft pre-pr:run (include deletions) then retry push (#5804).",
      ].join("\n"),
    ];
  }

  const committed = computeCommittedObservedHash(
    projectRoot,
    resolvedHead,
    record.pushBinding.reviewedFileManifest,
  );
  if (committed === null || committed !== record.pushBinding.controllerObservedHash) {
    return [
      1,
      [
        "❌ deft bound pre-PR push gate: committed content does not match pushBinding.controllerObservedHash.",
        "  Recovery: deft pre-pr:run on the exact bytes being pushed, then retry (#5804).",
      ].join("\n"),
    ];
  }

  if (record.pushBinding.pushStageMarker !== PRE_PR_PUSH_STAGE_MARKER) {
    return [
      1,
      "❌ deft bound pre-PR push gate: pushBinding missing push-stage marker.\n  Recovery: deft pre-pr:run then retry push (#5804).",
    ];
  }

  return [
    0,
    `✓ deft bound pre-PR push gate: outgoing ⊆ reviewed pushBinding for ${resolvedHead.slice(0, 12)} (#5804).`,
  ];
}

/**
 * Evaluate pre-push stdin refs. Consults plan.policy.allowDestructiveGhVerbs
 * through --project-root when provided. Does not treat zero-OID create as empty-remote.
 * When projectRoot is set, union typed deliveryBranch into a per-invocation set (#5520).
 * Enrolled bound pre-PR arm (#5804): empty stdin denies; outgoing ⊆ reviewed required.
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
  const enrolledFlag = options.enrolledBoundPrePr === true;
  // Policy boolean wins; missing policy falls back to hook default (#5804 Greptile).
  const enrolled = resolveRequireBoundPrePrPush(options.projectRoot, enrolledFlag);

  if (enrolled) {
    const raw = options.rawStdin;
    if (raw !== undefined && prePushStdinIsEmptyOrMalformed(raw)) {
      return [
        1,
        [
          "❌ deft bound pre-PR push gate: empty or malformed pre-push stdin.",
          "  Enrolled arm requires sole-stdin ref lines (#5804).",
          "  Recovery: push via git (hook supplies stdin); deft pre-pr:run then retry.",
        ].join("\n"),
      ];
    }
    if (refs.length === 0) {
      return [
        1,
        [
          "❌ deft bound pre-PR push gate: no parseable refs in stdin.",
          "  Recovery: deft pre-pr:run then retry push (#5804).",
        ].join("\n"),
      ];
    }
  }

  if (refs.length === 0) {
    return [0, "✓ deft destructive-gh-verb gate (pre-push): no refs in stdin -- nothing to gate."];
  }

  const blocked = blockedDefaultBranchTouches(refs, branches);
  let defaultBranchAllowed = false;
  if (blocked.length > 0) {
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
        defaultBranchAllowed = true;
      } else {
        return [1, refuseMessage(blocked)];
      }
    } else {
      return [1, refuseMessage(blocked)];
    }
  }

  if (enrolled && options.projectRoot !== undefined && options.projectRoot.length > 0) {
    return evaluateEnrolledBoundPrePrPush(refs, {
      projectRoot: options.projectRoot,
      env,
    });
  }

  if (defaultBranchAllowed) {
    return [
      0,
      `⚠ deft destructive-gh-verb gate (pre-push): default-branch push detected (${blocked.join("; ")}) but plan.policy.allowDestructiveGhVerbs=true -- policy allowed for this invocation.`,
    ];
  }

  return [
    0,
    "✓ deft destructive-gh-verb gate (pre-push): no pushes to default branches detected -- proceeding.",
  ];
}
