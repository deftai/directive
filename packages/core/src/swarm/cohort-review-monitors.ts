/**
 * Cohort babysit inventory (#5318 Prefer-A Bound).
 * Classifies each open merge-path PR as armed-live | halted-explicit | unarmed.
 * Anti-substitute: swarm:verify-review-clean CLEAN does not satisfy this gate.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { bindLivePhaseCorrectWait, evaluateMergePathArm } from "../pr-watch/main.js";
import { evaluateReviewMonitorGate, isTier1 } from "../review-monitor/index.js";
import { approach1BabysitterCommands } from "./approach1-babysitter.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import { swarmLaunchManifestPath } from "./launch.js";
import { resolveCohortFromVbriefs } from "./verify-review-clean.js";

export type CohortArmClass = "armed-live" | "halted-explicit" | "unarmed" | "config-error";

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

export type LaunchManifestPrsResult =
  | { readonly ok: true; readonly prs: number[] }
  | { readonly ok: false; readonly reason: string };

/**
 * PR numbers referenced by launch-manifest xBRIEF paths (Tracking / product links).
 * Unreadable briefs or briefs without PR refs fail closed (do not silently drop siblings).
 */
export function prsFromLaunchManifest(
  projectRoot: string,
  manifestPath: string | null = null,
): LaunchManifestPrsResult {
  const path = manifestPath ?? swarmLaunchManifestPath(projectRoot);
  if (!existsSync(path)) {
    return { ok: true, prs: [] };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `launch-manifest unreadable: ${detail}` };
  }
  if (!Array.isArray(payload)) {
    return { ok: false, reason: "launch-manifest payload is not an array" };
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
    return { ok: true, prs: [] };
  }
  const resolved = resolveCohortFromVbriefs(globs);
  if (resolved.failures.length > 0) {
    const detail = resolved.failures.map((f) => `${f.vbrief_path}: ${f.reason}`).join("; ");
    return { ok: false, reason: `launch-manifest brief resolution failed: ${detail}` };
  }
  return { ok: true, prs: resolved.prNumbers };
}

export type ActiveBriefsDiscoverResult =
  | { readonly ok: true; readonly prs: number[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Extract a PR number only when the URI names the expected owner/repo (when provided).
 * Bare /pull/N without repo context is accepted only when expectedRepo is null.
 * Enterprise hosts require expectedHost match so a foreign GHE with the same
 * owner/repo path cannot enter the local cohort inventory (#5318 Greptile P1).
 */
export function extractRepoScopedPullNumber(
  uri: string,
  expectedRepo: string | null = null,
  expectedHost: string | null = null,
): number | null {
  const pullIdx = uri.indexOf("/pull/");
  const pullsIdx = uri.indexOf("/pulls/");
  const idx = pullIdx >= 0 ? pullIdx : pullsIdx;
  const markerLen = pullIdx >= 0 ? "/pull/".length : "/pulls/".length;
  if (idx < 0) return null;
  if (expectedRepo !== null && expectedRepo.includes("/")) {
    const repoNeedle = expectedRepo.toLowerCase();
    const lower = uri.toLowerCase();
    let host: string | null = null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) {
      try {
        host = new URL(uri).hostname.toLowerCase();
      } catch {
        host = null;
      }
    }
    const normalizedExpectedHost = expectedHost?.trim().toLowerCase() || null;
    // github.com / api.github.com (scheme URL or path substring).
    const githubDotComHost = host === "github.com" || host === "api.github.com";
    const githubDotComPath =
      lower.includes(`github.com/${repoNeedle}/`) || lower.includes(`repos/${repoNeedle}/`);
    const githubDotCom =
      (host === null && githubDotComPath) || (githubDotComHost && githubDotComPath);
    // Scheme-less API path repos/<owner>/<repo>/pulls/<n>.
    const apiPathOnly = host === null && lower.includes(`repos/${repoNeedle}/`);
    // Enterprise: host must match configured GH host; path-only owner/repo is not enough.
    const enterprisePath =
      host !== null &&
      normalizedExpectedHost !== null &&
      host === normalizedExpectedHost &&
      !githubDotComHost &&
      (lower.includes(`/${repoNeedle}/pull/`) || lower.includes(`/${repoNeedle}/pulls/`));
    if (!(githubDotCom || apiPathOnly || enterprisePath)) {
      return null;
    }
  }
  let i = idx + markerLen;
  const digits: string[] = [];
  while (i < uri.length) {
    const ch = uri.charAt(i);
    if (ch >= "0" && ch <= "9") {
      digits.push(ch);
      i += 1;
    } else {
      break;
    }
  }
  if (digits.length === 0) return null;
  const n = Number.parseInt(digits.join(""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Discover Tracking/product PR refs from xbrief/active (and legacy vbrief/active).
 * Always consulted and unioned into the cohort denominator (does not replace --open-tracking-prs).
 * Briefs without PR refs are skipped; unreadable dirs/files and unexpected parse failures fail closed.
 * When expectedRepo is set, cross-repo PR URLs are ignored.
 * When expectedHost is set, foreign-host URLs with the same owner/repo are ignored.
 * When openPrNumbers is set, closed/unknown PRs are dropped from the discovery result.
 */
export function prsFromActiveBriefsSoft(
  projectRoot: string,
  options: {
    readonly expectedRepo?: string | null;
    readonly expectedHost?: string | null;
    readonly openPrNumbers?: ReadonlySet<number> | null;
  } = {},
): ActiveBriefsDiscoverResult {
  const root = resolve(projectRoot);
  const files: string[] = [];
  for (const rel of ["xbrief/active", "vbrief/active"]) {
    const dir = join(root, rel);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!/\.(x|v)brief\.json$/i.test(name)) continue;
        files.push(join(dir, name));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `active brief dir unreadable (${rel}): ${detail}` };
    }
  }
  if (files.length === 0) return { ok: true, prs: [] };

  const expectedRepo = options.expectedRepo ?? null;
  const expectedHost = options.expectedHost ?? null;
  const openPrNumbers = options.openPrNumbers ?? null;
  const seen = new Set<number>();
  const prs: number[] = [];
  for (const file of files) {
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `active brief unreadable (${file}): ${detail}` };
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { ok: false, reason: `active brief payload is not an object (${file})` };
    }
    const plan = (payload as Record<string, unknown>).plan;
    const references =
      typeof plan === "object" && plan !== null && !Array.isArray(plan)
        ? ((plan as Record<string, unknown>).references as unknown)
        : [];
    const refs = Array.isArray(references) ? references : [];
    let found = 0;
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
      const uri = (ref as Record<string, unknown>).uri;
      if (typeof uri !== "string" || uri.length === 0) continue;
      const pr = extractRepoScopedPullNumber(uri, expectedRepo, expectedHost);
      if (pr === null) continue;
      if (openPrNumbers !== null && !openPrNumbers.has(pr)) continue;
      found += 1;
      if (!seen.has(pr)) {
        seen.add(pr);
        prs.push(pr);
      }
    }
    // no PR refs → skip (not a Tracking brief); do not fail closed
    void found;
  }
  prs.sort((a, b) => a - b);
  return { ok: true, prs };
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
      classification: "config-error",
      message: `PR #${pr}: config-error (review-monitor config: ${gate.message})`,
      arm_reason: "config_error",
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
  /** When set, soft-discovered active-brief PRs are intersected with this open set. */
  readonly openPrNumbers?: ReadonlySet<number> | null;
  /** owner/repo used to ignore cross-repo PR URLs during active-brief discovery. */
  readonly expectedRepo?: string | null;
  /** Hostname (e.g. github.com / ghe.example.com) for foreign-host rejection. */
  readonly expectedHost?: string | null;
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
  const configErrors = result.classifications
    .filter((c) => c.classification === "config-error")
    .map((c) => c.pr);
  if (configErrors.length > 0) {
    lines.push(
      `Result: COHORT CONFIG ERROR — PR(s) ${configErrors.join(",")} failed review-monitor config (exit 2)`,
    );
    for (const c of result.classifications.filter((x) => x.classification === "config-error")) {
      lines.push(`  ${c.message}`);
    }
  } else if (result.unarmed.length === 0) {
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
  } else if (args.prsCsv === null || args.prsCsv === undefined) {
    // Omitted --prs: resolver (launch-manifest ∪ open Tracking) may still yield a set.
    operatorPrs = [];
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
            ? `${JSON.stringify({ error: parsed.reason, prs: [] }, null, 2)}
`
            : "",
        stderr:
          args.emitJson === true
            ? ""
            : `${msg}
`,
        expandedFromResolver: false,
        omittedFromOperator: [],
      };
    }
    operatorPrs = parsed.prs;
  }

  let launchManifestPrs: number[];
  if (args.launchManifestPrs !== undefined) {
    launchManifestPrs = [...args.launchManifestPrs];
  } else {
    const fromManifest = prsFromLaunchManifest(projectRoot, args.launchManifestPath ?? null);
    if (!fromManifest.ok) {
      const msg = `Error: ${fromManifest.reason}`;
      return {
        exitCode: EXIT_CONFIG_ERROR,
        prs: [],
        classifications: [],
        unarmed: [],
        stdout:
          args.emitJson === true
            ? `${JSON.stringify({ error: fromManifest.reason, prs: [] }, null, 2)}
`
            : "",
        stderr:
          args.emitJson === true
            ? ""
            : `${msg}
`,
        expandedFromResolver: false,
        omittedFromOperator: [],
      };
    }
    launchManifestPrs = fromManifest.prs;
  }
  // Soft-discover active briefs always (union); --open-tracking-prs never hides siblings.
  const discovered = prsFromActiveBriefsSoft(projectRoot, {
    expectedRepo: args.expectedRepo ?? null,
    expectedHost: args.expectedHost ?? null,
    openPrNumbers: args.openPrNumbers ?? null,
  });
  if (!discovered.ok) {
    const msg = `Error: ${discovered.reason}`;
    return {
      exitCode: EXIT_CONFIG_ERROR,
      prs: [],
      classifications: [],
      unarmed: [],
      stdout:
        args.emitJson === true
          ? `${JSON.stringify({ error: discovered.reason, prs: [] }, null, 2)}
`
          : "",
      stderr:
        args.emitJson === true
          ? ""
          : `${msg}
`,
      expandedFromResolver: false,
      omittedFromOperator: [],
    };
  }
  const openTrackingPrs = [
    ...new Set<number>([...(args.openTrackingPrs ?? []), ...discovered.prs]),
  ].sort((a, b) => a - b);
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

  const configErrors = classifications
    .filter((c) => c.classification === "config-error")
    .map((c) => c.pr);
  const unarmed = classifications.filter((c) => c.classification === "unarmed").map((c) => c.pr);
  const exitCode =
    configErrors.length > 0 ? EXIT_CONFIG_ERROR : unarmed.length === 0 ? EXIT_OK : EXIT_GATE_FAILED;
  const body = {
    schema: "deft.verify.cohort-review-monitors.v1",
    exit_code: exitCode,
    prs: resolved.prs,
    classifications,
    unarmed,
    config_errors: configErrors,
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
