/**
 * Owner Continuity / L4 owner gate (#3090).
 *
 * Exit 0 only when a fresh sticky review-owner lease exists on the PR,
 * or the caller asserts `review_cycle: done` after Step 6.
 * Freeform started/pending/initiated values are rejected.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_NOT_READY,
  EXIT_READY,
} from "./constants.js";
import type { ReviewOwnerGithubSeams } from "./github-lease.js";
import {
  fetchActiveMonitorFromGithub,
  type ReviewMonitorRecord,
} from "./record.js";

/** Allowed review_cycle evidence values (prefix form for in_progress/skipped). */
export type ReviewCycleEvidence =
  | "done"
  | "n/a"
  | `in_progress:${string}`
  | `skipped:${string}`;

export const L4_OWNER_HELP =
  "usage: task verify:l4-owner -- --pr <N> [options]\n" +
  "\n" +
  "Owner Continuity / L4 owner gate (#3090): after drive-to:merge-ready /\n" +
  "babysit / shepherd claims, exit 0 only when a sticky GitHub review-owner\n" +
  "lease is fresh on the PR, or the caller asserts --review-cycle done\n" +
  "(Step 6 fail-closed all-of on HEAD). Freeform started/pending/initiated\n" +
  "are rejected. Silent hold (no lease, no done) exits 1.\n" +
  "\n" +
  "options:\n" +
  "  -h, --help                 Show this help and exit 0\n" +
  "  --pr N                     Pull request number (required unless --help)\n" +
  "  --repo OWNER/REPO          Repository (optional; inferred from origin)\n" +
  "  --head-sha SHA             Expected HEAD SHA (optional freshness check)\n" +
  "  --project-root PATH        Project root (default: cwd)\n" +
  "  --review-cycle VALUE       done | in_progress:<pr>#<ref> | skipped:<reason> | n/a\n" +
  "  --json                     Emit structured JSON on stdout\n" +
  "\n" +
  "exit codes:\n" +
  "  0  READY       Fresh sticky lease, or --review-cycle done\n" +
  "  1  NOT READY   Silent hold / illegal evidence / lease missing\n" +
  "  2  CONFIG      Usage / path / GitHub fetch error\n";

const FORBIDDEN_FREEFORM = new Set(["started", "pending", "initiated", "start", "in_progress"]);

export function parseReviewCycleEvidence(
  raw: string | null | undefined,
): { ok: true; value: ReviewCycleEvidence | null } | { ok: false; reason: string } {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: true, value: null };
  }
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (FORBIDDEN_FREEFORM.has(lower)) {
    return {
      ok: false,
      reason:
        `illegal freeform review_cycle value '${value}' (#3090); ` +
        "use done | in_progress:<pr>#<ref> | skipped:<reason> | n/a",
    };
  }
  if (value === "done" || value === "n/a") {
    return { ok: true, value };
  }
  if (value.startsWith("in_progress:")) {
    const rest = value.slice("in_progress:".length);
    if (!rest.includes("#") || rest.endsWith("#") || rest.startsWith("#")) {
      return {
        ok: false,
        reason:
          "in_progress requires form in_progress:<pr>#<monitor_or_lease_ref> (#3090)",
      };
    }
    return { ok: true, value: value as ReviewCycleEvidence };
  }
  if (value.startsWith("skipped:")) {
    const rest = value.slice("skipped:".length).trim();
    if (rest.length === 0) {
      return { ok: false, reason: "skipped requires a non-empty reason (#3090)" };
    }
    return { ok: true, value: value as ReviewCycleEvidence };
  }
  return {
    ok: false,
    reason:
      `unknown review_cycle value '${value}' (#3090); ` +
      "use done | in_progress:<pr>#<ref> | skipped:<reason> | n/a",
  };
}

export interface VerifyL4OwnerArgs {
  readonly pr: number;
  readonly projectRoot: string;
  readonly repo?: string | null;
  readonly headSha?: string | null;
  readonly reviewCycle?: string | null;
  readonly now?: Date;
  readonly seams?: ReviewOwnerGithubSeams;
}

export interface VerifyL4OwnerResult {
  readonly exitCode: typeof EXIT_READY | typeof EXIT_NOT_READY | typeof EXIT_CONFIG_ERROR;
  readonly message: string;
  readonly monitorRecord: ReviewMonitorRecord | null;
  readonly reviewCycle: ReviewCycleEvidence | null;
  readonly path: "lease" | "done" | "none" | "illegal" | "config";
}

export function evaluateL4OwnerGate(args: VerifyL4OwnerArgs): VerifyL4OwnerResult {
  const projectRoot = resolve(args.projectRoot);
  let isDir = false;
  try {
    isDir = existsSync(projectRoot) && statSync(projectRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `verify_l4_owner: --project-root is not a directory: ${projectRoot}`,
      monitorRecord: null,
      reviewCycle: null,
      path: "config",
    };
  }

  const parsed = parseReviewCycleEvidence(args.reviewCycle);
  if (!parsed.ok) {
    return {
      exitCode: EXIT_NOT_READY,
      message: `verify_l4_owner: ${parsed.reason}`,
      monitorRecord: null,
      reviewCycle: null,
      path: "illegal",
    };
  }

  if (parsed.value === "done") {
    return {
      exitCode: EXIT_READY,
      message:
        `verify_l4_owner: review_cycle=done asserted for PR #${args.pr} (#3090). ` +
        "Caller MUST have satisfied Step 6 fail-closed all-of on HEAD before this claim.",
      monitorRecord: null,
      reviewCycle: "done",
      path: "done",
    };
  }

  if (parsed.value === "n/a" || (parsed.value !== null && parsed.value.startsWith("skipped:"))) {
    return {
      exitCode: EXIT_READY,
      message: `verify_l4_owner: review_cycle=${parsed.value} for PR #${args.pr} — ownership gate not required.`,
      monitorRecord: null,
      reviewCycle: parsed.value,
      path: "done",
    };
  }

  const repo = resolveRepo(args.repo ?? null, projectRoot);
  if (repo === null) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message:
        "verify_l4_owner: could not resolve owner/repo — pass --repo OWNER/REPO or run inside a git repo with origin",
      monitorRecord: null,
      reviewCycle: parsed.value,
      path: "config",
    };
  }

  const now = args.now ?? new Date();
  const githubMonitor = fetchActiveMonitorFromGithub(repo, args.pr, {
    now,
    headSha: args.headSha ?? null,
    seams: args.seams,
  });
  if (githubMonitor !== null && typeof githubMonitor === "object" && "error" in githubMonitor) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `verify_l4_owner: ${githubMonitor.error}`,
      monitorRecord: null,
      reviewCycle: parsed.value,
      path: "config",
    };
  }

  if (githubMonitor !== null) {
    const ref =
      parsed.value ??
      (`in_progress:${args.pr}#${githubMonitor.monitor_agent_id}` as ReviewCycleEvidence);
    return {
      exitCode: EXIT_READY,
      message:
        `verify_l4_owner: active GitHub review-owner lease for PR #${args.pr} ` +
        `(monitor_agent_id=${githubMonitor.monitor_agent_id}, owner=${githubMonitor.owner}) ` +
        `— review_cycle path=lease (#3090).`,
      monitorRecord: githubMonitor,
      reviewCycle: ref,
      path: "lease",
    };
  }

  // in_progress without lease is only valid for documented parent-retained when evidence says so
  if (parsed.value !== null && parsed.value.startsWith("in_progress:")) {
    if (parsed.value.includes("#parent-retained")) {
      return {
        exitCode: EXIT_READY,
        message:
          `verify_l4_owner: parent-retained ownership asserted via ${parsed.value} for PR #${args.pr} (#3090). ` +
          "Next action MUST be dual-source poll/fix; do not emit L4 status:pass as terminal.",
        monitorRecord: null,
        reviewCycle: parsed.value,
        path: "lease",
      };
    }
    return {
      exitCode: EXIT_NOT_READY,
      message:
        `verify_l4_owner: review_cycle=${parsed.value} claims in_progress but no sticky ` +
        `<!-- deft:review-owner --> lease found for PR #${args.pr} (#3090 / #2797).\n` +
        "  Register: deft review-monitor:register --pr <N> --monitor-agent-id <id> --platform-primitive …\n" +
        "  Or use in_progress:<pr>#parent-retained when the parent keeps ownership.",
      monitorRecord: null,
      reviewCycle: parsed.value,
      path: "none",
    };
  }

  return {
    exitCode: EXIT_NOT_READY,
    message:
      `verify_l4_owner: silent hold on PR #${args.pr} — no fresh sticky lease and no ` +
      `review_cycle=done (#3090 Owner Continuity Gate).\n` +
      "  Same turn MUST end in A (monitor+lease), B (parent-retained + next dual-source action),\n" +
      "  or C (explicit BLOCKED/FAILED finish). Check-run SUCCESS alone is not CLEAN.",
    monitorRecord: null,
    reviewCycle: null,
    path: "none",
  };
}

export function l4OwnerResultToJson(result: VerifyL4OwnerResult): Record<string, unknown> {
  return {
    exit_code: result.exitCode,
    message: result.message,
    monitor_agent_id: result.monitorRecord?.monitor_agent_id ?? null,
    monitor_owner: result.monitorRecord?.owner ?? null,
    monitor_record: result.monitorRecord,
    path: result.path,
    ready: result.exitCode === EXIT_READY,
    review_cycle: result.reviewCycle,
  };
}
