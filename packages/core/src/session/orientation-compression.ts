/**
 * Orientation compression Now path (#3286 / dual-path #2899).
 *
 * Composes doctor + toolchain preflight into session:start as inline sections
 * with per-section status lines; offers deposit-sha fast-paths for
 * agents:refresh and verify:cache-fresh; formats compact (opt-in) vs verbose
 * (default). Does NOT implement unified `deft orient` (Later remains open).
 */

import { isFrameworkRepoRoot } from "../check/context.js";
import {
  decideThrottle,
  readState as readDoctorState,
  renderDoctorStatusLine,
} from "../doctor/doctor-state.js";
import { cmdDoctor } from "../doctor/main.js";
import type { DoctorSeams, DoctorState } from "../doctor/types.js";
import { checkRuntimeLinkOwner } from "../install-health/runtime-link.js";
import { applyAgentsRefresh } from "../platform/agents-md.js";
import {
  type EvaluateOptions,
  evaluate as evaluateCacheFresh,
} from "../preflight-cache/evaluate.js";
import {
  type ComputeDepositShaOptions,
  computeDepositSha,
  DEPOSIT_SHA_MATCH_NOOP,
  formatDepositShaMatchLine,
} from "./deposit-sha.js";
import {
  type OrientationState,
  type OrientationSurfaceRecord,
  readOrientationState,
  surfaceRecord,
  writeOrientationState,
} from "./orientation-state.js";
import {
  runToolchainPreflight,
  type ToolchainPreflightOptions,
  type ToolchainPreflightResult,
  toolchainPreflightToDict,
} from "./toolchain-preflight.js";

/**
 * Env opt-in for compact orientation *section* formatting (#3286).
 * #4966: not the whole-stdout volume gate — that is `--verbose` /
 * `DEFT_SESSION_VERBOSE`. Tip `--compact` / this env are deprecated as
 * volume controls (no-op for human stdout selection).
 */
export const ENV_SESSION_COMPACT = "DEFT_SESSION_COMPACT";

/** Env opt-in restoring full session:start ceremony dump (#4966). */
export const ENV_SESSION_VERBOSE = "DEFT_SESSION_VERBOSE";

/** Dual-path Later graduation status — Now ships without closing Later (#2899). */
export const ORIENTATION_LATER_STATUS = "open" as const;
export const ORIENTATION_LATER_COMMAND = "deft orient";
export const ORIENTATION_GRADUATION_TRIGGER =
  "post-#3282 run-summary telemetry shows ritual+gate share >= 25% of tool calls " +
  "on a benchmark-suite run AFTER Now ships (starting threshold, tunable)";

export type OrientationSectionName = "doctor" | "preflight" | "agents_refresh" | "cache_fresh";

export type OrientationSectionStatus =
  | "ok"
  | "dirty"
  | "degraded"
  | "error"
  | "skipped"
  | "sha_match";

export interface OrientationSectionResult {
  readonly name: OrientationSectionName;
  readonly status: OrientationSectionStatus;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly shaMatch: boolean;
  readonly depositSha?: string;
  readonly durationMs: number;
  readonly detail?: Record<string, unknown>;
}

export interface OrientationBundle {
  readonly depositSha: string;
  readonly compact: boolean;
  readonly sections: readonly OrientationSectionResult[];
  readonly lines: readonly string[];
  /** Count of orientation surfaces touched this session (for run-summary #3282 trigger). */
  readonly orientationCallCount: number;
  readonly later: {
    readonly status: typeof ORIENTATION_LATER_STATUS;
    readonly command: typeof ORIENTATION_LATER_COMMAND;
    readonly trigger: typeof ORIENTATION_GRADUATION_TRIGGER;
  };
  readonly preflight: ToolchainPreflightResult | null;
  readonly state: OrientationState;
}

export interface RunOrientationOptions {
  readonly projectRoot: string;
  readonly frameworkRoot?: string;
  readonly compact?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly depositShaOptions?: ComputeDepositShaOptions;
  readonly toolchainPreflight?: ToolchainPreflightResult | null;
  readonly toolchainPreflightOptions?: ToolchainPreflightOptions;
  /** Skip doctor (tests) or inject structured result. */
  readonly doctorSection?: OrientationSectionResult | null;
  readonly doctorSeams?: DoctorSeams;
  /** Skip agents:refresh or inject. */
  readonly agentsRefreshSection?: OrientationSectionResult | null;
  /** Skip cache_fresh or inject. */
  readonly cacheFreshSection?: OrientationSectionResult | null;
  readonly cacheFreshOptions?: EvaluateOptions;
  /**
   * When true (default), persist orientation-state for next-session fast-path.
   * Persistence remains local cache (#3911); ignore/untrack must not disable it.
   */
  readonly persistState?: boolean;
  /** Disable individual sections (tests / re-arm). */
  readonly includeDoctor?: boolean;
  readonly includePreflight?: boolean;
  readonly includeAgentsRefresh?: boolean;
  readonly includeCacheFresh?: boolean;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function truthyEnv(raw: string | undefined): boolean {
  return new Set(["1", "true", "yes", "on"]).has((raw ?? "").trim().toLowerCase());
}

/**
 * Resolve orientation compact formatting (#3286).
 * Explicit option wins, else DEFT_SESSION_COMPACT. Does not control whole-stdout
 * volume (#4966); use resolveSessionVerbose / DEFT_SESSION_VERBOSE for that.
 */
export function resolveSessionCompact(
  options: Pick<RunOrientationOptions, "compact" | "env"> = {},
): boolean {
  if (options.compact === true) return true;
  if (options.compact === false) return false;
  const env = options.env ?? process.env;
  return truthyEnv(env[ENV_SESSION_COMPACT]);
}

/** Resolve whole-stdout ceremony dump: explicit option wins, else DEFT_SESSION_VERBOSE. */
export function resolveSessionVerbose(
  options: { readonly verbose?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (options.verbose === true) return true;
  if (options.verbose === false) return false;
  const env = options.env ?? process.env;
  return truthyEnv(env[ENV_SESSION_VERBOSE]);
}

function statusLine(name: OrientationSectionName, status: OrientationSectionStatus): string {
  return `[deft orientation] ${name}: ${status}`;
}

/** Compact machine lines (one per section). Verbose default keeps prose. */
export function formatOrientationCompactLines(
  sections: readonly OrientationSectionResult[],
): string[] {
  const out: string[] = [];
  for (const s of sections) {
    const tag = s.shaMatch ? "sha_match" : s.status;
    out.push(`${s.name}=${tag}`);
    // #4966 P3: compact must still emit actionable repair detail so quiet
    // always-on can keep MISSING cause/remedy and dirty cache_fresh lines.
    if (s.status === "degraded" || s.status === "error" || s.status === "dirty") {
      for (const line of s.lines) {
        if (
          (line.startsWith("[deft preflight]") && /\bMISSING\b/.test(line)) ||
          line.startsWith("[deft doctor] foreign-runtime-link:") ||
          line.startsWith("❌ deft cache-fresh:") ||
          line.startsWith("⚠ deft cache-fresh:")
        ) {
          out.push(line);
        }
      }
    }
  }
  return out;
}

export function formatOrientationVerboseLines(
  sections: readonly OrientationSectionResult[],
): string[] {
  const out: string[] = [];
  for (const section of sections) {
    out.push(statusLine(section.name, section.status));
    for (const line of section.lines) {
      // Avoid duplicating the status header when the section already emitted it.
      if (line === statusLine(section.name, section.status)) continue;
      out.push(line);
    }
  }
  return out;
}

function parseRecordTs(ts: string): Date | null {
  const parsed = new Date(ts.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Throttle input from session start's own doctor record (#6617). Only a real
 * doctor result (exit 0 or 1) counts; an errored run (exit 2) never skips.
 */
export function doctorStateFromOrientationRecord(
  record: OrientationSurfaceRecord | undefined,
): DoctorState | null {
  if (!record) return null;
  if (record.exit_code !== 0 && record.exit_code !== 1) return null;
  const lastRunAt = parseRecordTs(record.ts);
  if (!lastRunAt) return null;
  const lastErrorCount = record.error_count ?? (record.exit_code === 0 ? 0 : 1);
  return {
    lastRunAt,
    lastExitCode: record.exit_code,
    lastErrorCount,
    lastFindingCount: Math.max(record.finding_count ?? lastErrorCount, lastErrorCount),
  };
}

/**
 * Which doctor run the session-start time window counts from (#6617).
 * Session start's own record wins. The legacy `doctor-state.json` (no longer
 * written by doctor, AC12.1) is read only when that record is absent.
 */
export function resolveDoctorThrottleState(
  projectRoot: string,
  prior: OrientationState | null,
): DoctorState | null {
  if (prior?.doctor) return doctorStateFromOrientationRecord(prior.doctor);
  return readDoctorState(projectRoot);
}

/** Error and finding counts from captured `doctor --json` output, when parseable. */
function doctorCountsFromJson(
  captured: string,
): { errorCount: number; findingCount: number } | null {
  const start = captured.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(captured.slice(start)) as Record<string, unknown>;
    const summary = parsed.summary as Record<string, unknown> | undefined;
    if (!summary || typeof summary.errors !== "number" || typeof summary.warnings !== "number") {
      return null;
    }
    return { errorCount: summary.errors, findingCount: summary.errors + summary.warnings };
  } catch {
    return null;
  }
}

/**
 * Doctor orientation section — throttle status when clean/recent; otherwise
 * run doctor and surface a per-section status line (#3286 compose).
 * The window comes from session start's own record (#6617); doctor itself
 * keeps no state.
 */
export function runDoctorOrientationSection(
  projectRoot: string,
  options: {
    now?: Date;
    seams?: DoctorSeams;
    doctorRunner?: (args: readonly string[], seams?: DoctorSeams) => number;
    /** Orientation state read at session start; defaults to reading it now. */
    prior?: OrientationState | null;
  } = {},
): OrientationSectionResult {
  const started = performance.now();
  const now = options.now ?? new Date();
  try {
    // #6185: runs even when the doctor run is throttle-skipped, so session:start
    // reports a runtime linked in from another checkout before the first refusal.
    const runtimeLink = (options.seams?.checkRuntimeLinkOwner ?? checkRuntimeLinkOwner)(
      projectRoot,
    );
    const runtimeLinkFailed = runtimeLink.status === "fail";
    const runtimeLinkLines = runtimeLinkFailed
      ? [`[deft doctor] ${runtimeLink.name}: fail -- ${runtimeLink.detail}`]
      : [];
    const prior = options.prior !== undefined ? options.prior : readOrientationState(projectRoot);
    const state = resolveDoctorThrottleState(projectRoot, prior);
    const decision = decideThrottle(state, now);
    if (decision.skip) {
      const dirty = decision.dirty || runtimeLinkFailed;
      const status: OrientationSectionStatus = dirty ? "dirty" : "ok";
      const line = renderDoctorStatusLine(decision, now);
      return {
        name: "doctor",
        status,
        ok: !dirty,
        exitCode: dirty ? 1 : 0,
        lines: [line, ...runtimeLinkLines],
        shaMatch: false,
        durationMs: elapsedMs(started),
        detail: {
          throttle_skipped: true,
          dirty,
          ...(runtimeLinkFailed ? { foreign_runtime_link: true } : {}),
        },
      };
    }

    const runner = options.doctorRunner ?? cmdDoctor;
    // Capture stdout/stderr from doctor JSON mode for a terse status.
    const captured: string[] = [];
    const prevOut = process.stdout.write.bind(process.stdout);
    const prevErr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: string | Uint8Array): boolean => {
      captured.push(String(chunk));
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    let code = 0;
    try {
      code = runner(["--project-root", projectRoot, "--json"], options.seams);
    } finally {
      process.stdout.write = prevOut;
      process.stderr.write = prevErr;
    }
    const counts = doctorCountsFromJson(captured.join(""));
    const status: OrientationSectionStatus = code === 0 ? "ok" : code === 1 ? "dirty" : "error";
    const summary =
      code === 0 ? "[deft doctor] status: ok" : `[deft doctor] status: ${status} (exit ${code})`;
    return {
      name: "doctor",
      status,
      ok: code === 0,
      exitCode: code,
      lines: [summary, ...runtimeLinkLines],
      shaMatch: false,
      durationMs: elapsedMs(started),
      detail: {
        throttle_skipped: false,
        captured_len: captured.join("").length,
        ...(counts ? { error_count: counts.errorCount, finding_count: counts.findingCount } : {}),
      },
    };
  } catch (exc) {
    // Session:start continues, but do not persist as a successful gated doctor
    // step (Greptile #3286) — next verify:session-ritual must re-run doctor.
    return {
      name: "doctor",
      status: "error",
      ok: false,
      exitCode: 2,
      lines: [`[deft doctor] status: error (session continues): ${String(exc)}`],
      shaMatch: false,
      durationMs: elapsedMs(started),
    };
  }
}

export function runPreflightOrientationSection(
  projectRoot: string,
  options: {
    frameworkRoot?: string;
    result?: ToolchainPreflightResult | null;
    preflightOptions?: ToolchainPreflightOptions;
  } = {},
): { section: OrientationSectionResult | null; preflight: ToolchainPreflightResult | null } {
  const started = performance.now();
  if (options.result === null) {
    return {
      section: {
        name: "preflight",
        status: "skipped",
        ok: true,
        exitCode: 0,
        lines: ["[deft preflight] toolchain status: skipped"],
        shaMatch: false,
        durationMs: 0,
      },
      preflight: null,
    };
  }
  try {
    const preflight =
      options.result ??
      runToolchainPreflight({
        projectRoot,
        frameworkRoot: options.frameworkRoot ?? projectRoot,
        ...options.preflightOptions,
      });
    const status: OrientationSectionStatus = preflight.ok
      ? "ok"
      : preflight.degraded
        ? "degraded"
        : "error";
    return {
      section: {
        name: "preflight",
        status,
        ok: preflight.ok || preflight.degraded,
        exitCode: preflight.ok ? 0 : 1,
        lines: [...preflight.lines],
        shaMatch: false,
        durationMs: elapsedMs(started),
        detail: toolchainPreflightToDict(preflight),
      },
      preflight,
    };
  } catch (exc) {
    return {
      section: {
        name: "preflight",
        status: "error",
        ok: false,
        exitCode: 2,
        lines: [`[deft preflight] toolchain status: error (session continues): ${String(exc)}`],
        shaMatch: false,
        durationMs: elapsedMs(started),
      },
      preflight: null,
    };
  }
}

/**
 * agents:refresh orientation section (#3286).
 * Always plans against live AGENTS.md so local managed-section edits are
 * detected (deposit fingerprint alone is insufficient). Content-current →
 * one-line sha-match phrasing; deposit-sha is recorded for orientation telemetry.
 */
export function runAgentsRefreshOrientationSection(
  projectRoot: string,
  options: {
    depositSha: string;
    prior?: OrientationState | null;
    now?: Date;
    apply?: typeof applyAgentsRefresh;
  },
): OrientationSectionResult {
  const started = performance.now();
  void options.prior;
  try {
    const apply = options.apply ?? applyAgentsRefresh;
    const result = apply(projectRoot, {});
    if (result.state === "current") {
      const line = formatDepositShaMatchLine("agents:refresh");
      return {
        name: "agents_refresh",
        status: "sha_match",
        ok: true,
        exitCode: 0,
        lines: [line],
        shaMatch: true,
        depositSha: options.depositSha,
        durationMs: elapsedMs(started),
        detail: { state: result.state, wrote: result.wrote },
      };
    }
    if (
      result.state === "template-missing" ||
      result.state === "template-malformed" ||
      result.state === "unreadable"
    ) {
      return {
        name: "agents_refresh",
        status: "error",
        ok: false,
        exitCode: 2,
        lines: [`[deft agents:refresh] failed: ${result.state}`],
        shaMatch: false,
        depositSha: options.depositSha,
        durationMs: elapsedMs(started),
        detail: { state: result.state },
      };
    }
    const wrote = result.wrote;
    const msg = wrote
      ? `[deft agents:refresh] updated (state=${result.state})`
      : `[deft agents:refresh] state=${result.state}`;
    return {
      name: "agents_refresh",
      status: "ok",
      ok: true,
      exitCode: 0,
      lines: [msg],
      shaMatch: false,
      depositSha: options.depositSha,
      durationMs: elapsedMs(started),
      detail: { state: result.state, wrote },
    };
  } catch (exc) {
    // Fail-open for session:start composition, but do NOT persist as ok —
    // next session must retry (Greptile #3286 P1).
    return {
      name: "agents_refresh",
      status: "error",
      ok: false,
      exitCode: 2,
      lines: [`[deft agents:refresh] error (session continues): ${String(exc)}`],
      shaMatch: false,
      depositSha: options.depositSha,
      durationMs: elapsedMs(started),
    };
  }
}

/**
 * verify:cache-fresh orientation section (#3286).
 * Always runs the live evaluate (age + drift). Deposit fingerprint is recorded
 * for orientation telemetry only — it must not suppress triage-cache freshness.
 * When evaluate is already clean, surface a one-line sha-match-style no-op only
 * if the message is the canonical deposit phrase (not used for shortcuts).
 */
export function runCacheFreshOrientationSection(
  projectRoot: string,
  options: {
    depositSha: string;
    prior?: OrientationState | null;
    now?: Date;
    evaluateOptions?: EvaluateOptions;
    evaluateFn?: typeof evaluateCacheFresh;
  },
): OrientationSectionResult {
  const started = performance.now();
  void options.prior;
  void options.now;
  try {
    const evaluate = options.evaluateFn ?? evaluateCacheFresh;
    const consumerDeposit = !isFrameworkRepoRoot(projectRoot);
    // Consumer deposits often have no triage cache. Treat that as a named
    // bootstrap cause (dirty), never a generic orientation `error` (#3335).
    // Framework source still evaluates live; missing cache stays non-green
    // (#3286) so gated verify re-runs cache_fresh.
    const result = evaluate(projectRoot, {
      allowMissingBootstrap: false,
      autoPopulateEmpty: false,
      ...options.evaluateOptions,
    });
    const ok = result.code === 0;
    const missingCache = result.code === 2 && /not found|bootstrap/i.test(result.message);
    const namedCause = missingCache
      ? consumerDeposit
        ? `[deft cache-fresh] triage cache not populated (consumer deposit) — not a toolchain failure. Recovery: run \`deft triage:bootstrap\` if you need the queue.`
        : result.message
      : result.message;
    // Tag as sha_match only when message already uses the canonical phrase
    // (e.g. tests inject it) — never invent a shortcut past evaluate.
    const shaMatch = ok && result.message.includes(DEPOSIT_SHA_MATCH_NOOP);
    const status: OrientationSectionStatus = shaMatch
      ? "sha_match"
      : ok
        ? "ok"
        : missingCache
          ? "dirty"
          : result.code === 2
            ? "error"
            : "dirty";
    return {
      name: "cache_fresh",
      status,
      ok,
      exitCode: result.code,
      lines: [namedCause],
      shaMatch,
      depositSha: options.depositSha,
      durationMs: elapsedMs(started),
      detail: { code: result.code, missing_cache: missingCache },
    };
  } catch (exc) {
    return {
      name: "cache_fresh",
      status: "error",
      ok: false,
      exitCode: 2,
      lines: [`[deft cache-fresh] error (session continues): ${String(exc)}`],
      shaMatch: false,
      depositSha: options.depositSha,
      durationMs: elapsedMs(started),
    };
  }
}

function toSurface(section: OrientationSectionResult, now: Date): OrientationSurfaceRecord {
  return surfaceRecord(section.ok, section.exitCode, now, section.lines[0]);
}

/**
 * Doctor record for the next session (#6617). A throttle-skipped section keeps
 * the previous record unchanged, so a skip never extends the window; a new
 * timestamp is stamped only when doctor actually ran.
 */
function doctorSurface(
  section: OrientationSectionResult,
  prior: OrientationState | null,
  now: Date,
): OrientationSurfaceRecord | null {
  if (section.detail?.throttle_skipped === true) {
    return prior?.doctor ?? null;
  }
  const base = toSurface(section, now);
  const errorCount = section.detail?.error_count;
  const findingCount = section.detail?.finding_count;
  return {
    ...base,
    ...(typeof errorCount === "number" ? { error_count: errorCount } : {}),
    ...(typeof findingCount === "number" ? { finding_count: findingCount } : {}),
  };
}

/**
 * Run the composed orientation sections for a mutation cold session:start.
 */
export function runOrientationCompression(options: RunOrientationOptions): OrientationBundle {
  const projectRoot = options.projectRoot;
  const now = options.now ?? new Date();
  const compact = resolveSessionCompact(options);
  const depositSha = computeDepositSha({
    projectRoot,
    frameworkRoot: options.frameworkRoot ?? projectRoot,
    ...options.depositShaOptions,
  });
  const prior = readOrientationState(projectRoot);
  const sections: OrientationSectionResult[] = [];
  let preflightResult: ToolchainPreflightResult | null = null;

  if (options.includeDoctor !== false) {
    const doctor =
      options.doctorSection !== undefined
        ? options.doctorSection
        : runDoctorOrientationSection(projectRoot, {
            now,
            seams: options.doctorSeams,
            prior,
          });
    if (doctor !== null) sections.push(doctor);
  }

  if (options.includePreflight !== false) {
    const { section, preflight } = runPreflightOrientationSection(projectRoot, {
      frameworkRoot: options.frameworkRoot,
      result: options.toolchainPreflight,
      preflightOptions: options.toolchainPreflightOptions,
    });
    preflightResult = preflight;
    if (section !== null) sections.push(section);
  }

  if (options.includeAgentsRefresh !== false) {
    const agents =
      options.agentsRefreshSection !== undefined
        ? options.agentsRefreshSection
        : runAgentsRefreshOrientationSection(projectRoot, {
            depositSha,
            prior,
            now,
          });
    if (agents !== null) sections.push(agents);
  }

  if (options.includeCacheFresh !== false) {
    const cache =
      options.cacheFreshSection !== undefined
        ? options.cacheFreshSection
        : runCacheFreshOrientationSection(projectRoot, {
            depositSha,
            prior,
            now,
            evaluateOptions: options.cacheFreshOptions,
          });
    if (cache !== null) sections.push(cache);
  }

  const lines = compact
    ? formatOrientationCompactLines(sections)
    : formatOrientationVerboseLines(sections);

  const byName = (n: OrientationSectionName) => sections.find((s) => s.name === n);
  const doctorSection = byName("doctor");
  const doctorRecord = doctorSection
    ? doctorSurface(doctorSection, prior, now)
    : (prior?.doctor ?? null);
  const state: OrientationState = {
    schema_version: 1,
    deposit_sha: depositSha,
    updated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(byName("agents_refresh")
      ? { agents_refresh: toSurface(byName("agents_refresh") as OrientationSectionResult, now) }
      : {}),
    ...(byName("cache_fresh")
      ? { cache_fresh: toSurface(byName("cache_fresh") as OrientationSectionResult, now) }
      : {}),
    ...(doctorRecord ? { doctor: doctorRecord } : {}),
    ...(byName("preflight")
      ? { preflight: toSurface(byName("preflight") as OrientationSectionResult, now) }
      : {}),
  };

  if (options.persistState !== false) {
    try {
      writeOrientationState(projectRoot, state);
    } catch {
      // fail-open
    }
  }

  return {
    depositSha,
    compact,
    sections,
    lines,
    orientationCallCount: sections.length,
    later: {
      status: ORIENTATION_LATER_STATUS,
      command: ORIENTATION_LATER_COMMAND,
      trigger: ORIENTATION_GRADUATION_TRIGGER,
    },
    preflight: preflightResult,
    state,
  };
}

export {
  computeDepositSha,
  DEPOSIT_SHA_MATCH_NOOP,
  depositShaMatches,
  formatDepositShaMatchLine,
} from "./deposit-sha.js";
