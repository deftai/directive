/**
 * Cohort babysit inventory (#5318 Prefer-A Bound).
 * Classifies each open merge-path PR as armed-live | halted-explicit | unarmed.
 * Anti-substitute: swarm:verify-review-clean CLEAN does not satisfy this gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { bindLivePhaseCorrectWait, evaluateMergePathArm } from "../pr-watch/main.js";
import { evaluateReviewMonitorGate, isTier1 } from "../review-monitor/index.js";
import { approach1BabysitterCommands } from "./approach1-babysitter.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import { swarmLaunchManifestPath } from "./launch.js";
import { resolveCohortFromVbriefs } from "./verify-review-clean.js";

export type CohortArmClass = "armed-live" | "halted-explicit" | "unarmed";

export interface CohortPrClassification {
  readonly pr: number;
  readonly classification: CohortArmClass;
  readonly message: string;
  readonly arm_reason: string | null;
}

export interface CohortReviewMonitorsResult {
  readonly exitCode: typeof EXIT_OK | typeof EXIT_GATE_FAILED | typeof EXIT_CONFIG_ERROR;
  readonly prs: readonly number[];
  readonly classifications: readonly CohortPrClassification[];
  readonly unarmed: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
  /** True when operator --prs omitted known cohort siblings that were unioned back in. */
  readonly expandedFromResolver: boolean;
  readonly omittedFromOperator: readonly number[];
}

/** Durable option-C / --explicit-finish attestation sink (#5318 / #4882). */
export function mergePathExplicitFinishRelPath(pr: number): string {
  return [".deft-scratch", "merge-path-arm", `pr-${pr}.explicit-finish.json`].join("/");
}

export type ExplicitFinishWriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Record durable option-C finish for a PR. Prose dual-stop alone is not this.
 */
export function writeMergePathExplicitFinishAttestation(
  projectRoot: string,
  pr: number,
  input: {
    readonly reason?: string;
    readonly source?: string;
    readonly now?: Date;
  } = {},
): ExplicitFinishWriteResult {
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, reason: `invalid pr for explicit-finish attestation: ${pr}` };
  }
  const rootAbs = resolve(projectRoot);
  const relTarget = mergePathExplicitFinishRelPath(pr);
  const path = join(rootAbs, relTarget);
  const escaped = relative(rootAbs, path);
  if (escaped.startsWith("..") || escaped.length === 0) {
    return { ok: false, reason: `explicit-finish path escapes project root: ${path}` };
  }
  const now = input.now ?? new Date();
  const payload = {
    schema: "deft.merge-path.explicit-finish.v1",
    pr_number: pr,
    finished_at: now.toISOString(),
    reason: input.reason ?? "option-C explicit finish",
    source: input.source ?? "explicit-finish",
  };
  try {
    containedWrite({
      root: rootAbs,
      target: relTarget,
      data: `${JSON.stringify(payload)}\n`,
      mode: "replace",
      mkdir: true,
    });
    return { ok: true, path };
  } catch (err) {
    const detail =
      err instanceof ContainedWriteError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: `explicit-finish write failed: ${detail}` };
  }
}

/** True when durable --explicit-finish / option-C attestation exists for this PR. */
export function hasMergePathExplicitFinishAttestation(projectRoot: string, pr: number): boolean {
  if (!Number.isInteger(pr) || pr <= 0) return false;
  const path = join(resolve(projectRoot), mergePathExplicitFinishRelPath(pr));
  try {
    const raw = readFileSync(path, "utf8");
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return false;
    }
    const rec = payload as Record<string, unknown>;
    return rec.pr_number === pr && typeof rec.finished_at === "string";
  } catch {
    return false;
  }
}

/**
 * Parse `--prs` CSV. Empty / malformed → fail closed (exit 2 caller).
 */
export function parsePrsCsv(raw: string | null | undefined):
  | {
      readonly ok: true;
      readonly prs: number[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "missing --prs value" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty --prs value" };
  }
  const parts = trimmed.split(/[,\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { ok: false, reason: "empty --prs value" };
  }
  const prs: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return { ok: false, reason: `malformed --prs token: ${part}` };
    }
    const n = Number.parseInt(part, 10);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, reason: `invalid PR number in --prs: ${part}` };
    }
    if (!seen.has(n)) {
      seen.add(n);
      prs.push(n);
    }
  }
  return { ok: true, prs };
}

/**
 * PR numbers referenced by launch-manifest xBRIEF paths (Tracking / product links).
 */
export function prsFromLaunchManifest(
  projectRoot: string,
  manifestPath: string | null = null,
): number[] {
  const path = manifestPath ?? swarmLaunchManifestPath(projectRoot);
  if (!existsSync(path)) {
    return [];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) {
    return [];
  }
  const globs: string[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const rel =
      typeof rec.vbrief_path === "string"
        ? rec.vbrief_path
        : typeof rec.xbrief_path === "string"
          ? rec.xbrief_path
          : null;
    if (rel !== null && rel.trim().length > 0) {
      globs.push(resolve(projectRoot, rel.trim()));
    }
  }
  if (globs.length === 0) {
    return [];
  }
  return resolveCohortFromVbriefs(globs).prNumbers;
}

/**
 * Default denominator = launch-manifest ∪ open linked Tracking ∪ operator --prs.
 * Operator list must not silently shrink below the known union (#5318 F4).
 */
export function resolveCohortPrSet(input: {
  readonly operatorPrs: readonly number[];
  readonly launchManifestPrs?: readonly number[];
  readonly openTrackingPrs?: readonly number[];
}): {
  readonly prs: number[];
  readonly expandedFromResolver: boolean;
  readonly omittedFromOperator: number[];
} {
  const base = new Set<number>();
  for (const pr of input.launchManifestPrs ?? []) {
    if (Number.isInteger(pr) && pr > 0) base.add(pr);
  }
  for (const pr of input.openTrackingPrs ?? []) {
    if (Number.isInteger(pr) && pr > 0) base.add(pr);
  }
  const operator = new Set<number>();
  for (const pr of input.operatorPrs) {
    if (Number.isInteger(pr) && pr > 0) operator.add(pr);
  }
  const omittedFromOperator: number[] = [];
  for (const pr of base) {
    if (!operator.has(pr)) omittedFromOperator.push(pr);
  }
  omittedFromOperator.sort((a, b) => a - b);
  const union = new Set<number>([...base, ...operator]);
  const prs = [...union].sort((a, b) => a - b);
  return {
    prs,
    expandedFromResolver: omittedFromOperator.length > 0 && operator.size > 0,
    omittedFromOperator,
  };
}

/**
 * Classify one PR using durable explicit-finish then per-PR live-wait SoT.
 */
export function classifyCohortPrArm(
  projectRoot: string,
  pr: number,
  options: {
    readonly environ?: NodeJS.ProcessEnv;
    readonly hasExplicitFinish?: boolean;
    /** Inject live-arm result for hermetic tests. */
    readonly liveArmOverride?: boolean | null;
  } = {},
): CohortPrClassification {
  const explicit =
    options.hasExplicitFinish ?? hasMergePathExplicitFinishAttestation(projectRoot, pr);
  if (explicit) {
    return {
      pr,
      classification: "halted-explicit",
      message: `PR #${pr}: halted-explicit (durable --explicit-finish / option-C attestation) (#5318)`,
      arm_reason: "explicit_finish",
    };
  }

  if (options.liveArmOverride === false) {
    return {
      pr,
      classification: "unarmed",
      message: `PR #${pr}: unarmed (no live Approach 1 wait; no durable explicit finish) (#5318)`,
      arm_reason: "unarmed_stand_down",
    };
  }
  if (options.liveArmOverride === true) {
    return {
      pr,
      classification: "armed-live",
      message: `PR #${pr}: armed-live (verify:review-monitor --merge-path-arm --live-wait) (#5318)`,
      arm_reason: "live_wait",
    };
  }

  const root = resolve(projectRoot);
  const gate = evaluateReviewMonitorGate({
    pr,
    projectRoot: root,
    environ: options.environ ?? process.env,
  });
  if (gate.exitCode === 2) {
    return {
      pr,
      classification: "unarmed",
      message: `PR #${pr}: unarmed (review-monitor config: ${gate.message})`,
      arm_reason: "unarmed_stand_down",
    };
  }
  const liveBind = bindLivePhaseCorrectWait({
    liveWaitFlag: true,
    tierIs1: isTier1(gate.tier),
    leaseEvidence: gate.monitorRecord !== null,
    heartbeatActive: gate.heartbeatActive,
    pr,
  });
  const arm = evaluateMergePathArm({
    livePhaseCorrectWait: liveBind.livePhaseCorrectWait,
    explicitFinish: false,
    stickyLeaseActive: gate.monitorRecord !== null,
  });
  if (arm.armed && arm.reason === "live_wait") {
    return {
      pr,
      classification: "armed-live",
      message: `PR #${pr}: armed-live (${arm.message})`,
      arm_reason: arm.reason,
    };
  }
  return {
    pr,
    classification: "unarmed",
    message:
      liveBind.message ??
      arm.message ??
      `PR #${pr}: unarmed (no live Approach 1 wait; no durable explicit finish) (#5318)`,
    arm_reason: arm.reason,
  };
}

/** Remediation: Approach 1 babysitter commands per unarmed PR (parallel OK). */
export function remediationCommandsForUnarmed(
  unarmedPrs: readonly number[],
  monitorAgentIdFor: (pr: number) => string = (pr) => `approach1-${pr}`,
): readonly string[] {
  const out: string[] = [];
  for (const pr of unarmedPrs) {
    out.push(...approach1BabysitterCommands(pr, monitorAgentIdFor(pr)));
  }
  return out;
}

/**
 * Anti-substitute assert: Greptile CLEAN cohort verifier is not babysit inventory.
 * Inventory is arm-class over the PR set (#5318 / #1364).
 */
export function cohortInventorySatisfiedByReviewClean(): boolean {
  return false;
}

export interface VerifyCohortReviewMonitorsArgs {
  readonly projectRoot?: string;
  readonly prsCsv?: string | null;
  readonly operatorPrs?: readonly number[];
  readonly launchManifestPath?: string | null;
  readonly launchManifestPrs?: readonly number[];
  readonly openTrackingPrs?: readonly number[];
  readonly emitJson?: boolean;
  readonly environ?: NodeJS.ProcessEnv;
  /** Hermetic per-PR live-arm map; omit to use live gate. */
  readonly liveArmByPr?: Readonly<Record<number, boolean>>;
  /** Hermetic explicit-finish map; omit to read durable attestation. */
  readonly explicitFinishByPr?: Readonly<Record<number, boolean>>;
}

function renderText(result: {
  readonly classifications: readonly CohortPrClassification[];
  readonly unarmed: readonly number[];
  readonly expandedFromResolver: boolean;
  readonly omittedFromOperator: readonly number[];
}): string {
  const lines: string[] = ["cohort-review-monitors (#5318):"];
  if (result.expandedFromResolver) {
    lines.push(
      `  expanded --prs with resolver siblings (did not silently shrink): ${result.omittedFromOperator.join(",")}`,
    );
  }
  for (const c of result.classifications) {
    lines.push(`  PR #${c.pr}: ${c.classification}`);
  }
  if (result.unarmed.length === 0) {
    lines.push("Result: COHORT ARMED — all listed PRs armed-live or halted-explicit");
  } else {
    lines.push(`Result: COHORT UNARMED — ${result.unarmed.join(",")} lack live Approach 1 babysit`);
    lines.push("Remediation: spawn Approach 1 per unarmed (parallel OK):");
    for (const cmd of remediationCommandsForUnarmed(result.unarmed)) {
      lines.push(`  ${cmd}`);
    }
    lines.push(
      "Anti-substitute: swarm:verify-review-clean CLEAN does not satisfy this inventory (#5318 / #1364).",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function verifyCohortReviewMonitors(
  args: VerifyCohortReviewMonitorsArgs,
): CohortReviewMonitorsResult {
  const projectRoot = resolve(args.projectRoot ?? ".");
  let operatorPrs: number[];
  if (args.operatorPrs !== undefined) {
    operatorPrs = [...args.operatorPrs];
  } else {
    const parsed = parsePrsCsv(args.prsCsv);
    if (!parsed.ok) {
      const msg = `Error: ${parsed.reason}. Pass --prs <csv> of PR numbers.`;
      return {
        exitCode: EXIT_CONFIG_ERROR,
        prs: [],
        classifications: [],
        unarmed: [],
        stdout:
          args.emitJson === true
            ? `${JSON.stringify({ error: parsed.reason, prs: [] }, null, 2)}\n`
            : "",
        stderr: args.emitJson === true ? "" : `${msg}\n`,
        expandedFromResolver: false,
        omittedFromOperator: [],
      };
    }
    operatorPrs = parsed.prs;
  }

  const launchManifestPrs =
    args.launchManifestPrs ?? prsFromLaunchManifest(projectRoot, args.launchManifestPath ?? null);
  const openTrackingPrs = args.openTrackingPrs ?? [];
  const resolved = resolveCohortPrSet({
    operatorPrs,
    launchManifestPrs,
    openTrackingPrs,
  });

  if (resolved.prs.length === 0) {
    const msg =
      "Error: empty cohort PR set after resolver union. Pass --prs <csv> and/or ensure launch-manifest ∪ open Tracking PRs is non-empty.";
    return {
      exitCode: EXIT_CONFIG_ERROR,
      prs: [],
      classifications: [],
      unarmed: [],
      stdout:
        args.emitJson === true
          ? `${JSON.stringify({ error: "empty cohort", prs: [] }, null, 2)}\n`
          : "",
      stderr: args.emitJson === true ? "" : `${msg}\n`,
      expandedFromResolver: false,
      omittedFromOperator: [],
    };
  }

  const classifications: CohortPrClassification[] = [];
  for (const pr of resolved.prs) {
    const liveOverride =
      args.liveArmByPr !== undefined && Object.hasOwn(args.liveArmByPr, pr)
        ? args.liveArmByPr[pr]
        : null;
    const explicitOverride =
      args.explicitFinishByPr !== undefined && Object.hasOwn(args.explicitFinishByPr, pr)
        ? args.explicitFinishByPr[pr]
        : undefined;
    classifications.push(
      classifyCohortPrArm(projectRoot, pr, {
        environ: args.environ,
        hasExplicitFinish: explicitOverride,
        liveArmOverride: liveOverride ?? null,
      }),
    );
  }

  const unarmed = classifications.filter((c) => c.classification === "unarmed").map((c) => c.pr);
  const exitCode = unarmed.length === 0 ? EXIT_OK : EXIT_GATE_FAILED;
  const body = {
    schema: "deft.verify.cohort-review-monitors.v1",
    exit_code: exitCode,
    prs: resolved.prs,
    classifications,
    unarmed,
    expanded_from_resolver: resolved.expandedFromResolver,
    omitted_from_operator: resolved.omittedFromOperator,
    anti_substitute: {
      swarm_verify_review_clean_satisfies_inventory: cohortInventorySatisfiedByReviewClean(),
    },
  };

  if (args.emitJson === true) {
    return {
      exitCode,
      prs: resolved.prs,
      classifications,
      unarmed,
      stdout: `${JSON.stringify(body, null, 2)}\n`,
      stderr: "",
      expandedFromResolver: resolved.expandedFromResolver,
      omittedFromOperator: resolved.omittedFromOperator,
    };
  }

  const text = renderText({
    classifications,
    unarmed,
    expandedFromResolver: resolved.expandedFromResolver,
    omittedFromOperator: resolved.omittedFromOperator,
  });
  return {
    exitCode,
    prs: resolved.prs,
    classifications,
    unarmed,
    stdout: exitCode === EXIT_OK ? text : "",
    stderr: exitCode === EXIT_OK ? "" : text,
    expandedFromResolver: resolved.expandedFromResolver,
    omittedFromOperator: resolved.omittedFromOperator,
  };
}
