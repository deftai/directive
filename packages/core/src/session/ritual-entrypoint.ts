import { cmdDoctor } from "../doctor/main.js";
import { HOOK_HOSTS, type HookHost } from "../hooks/hook-hosts.js";
import { evaluate } from "../preflight-cache/evaluate.js";
import {
  type AgentHookReadinessOptions,
  type AgentHookReadinessResult,
  evaluateAgentHookReadinessSafely,
} from "../verify-env/agent-hook-readiness.js";
import {
  LIVE_PROBE_UNKNOWN_HOST_DEADLINE_MS,
  LIVE_PROBE_WRITE_BUDGET_MS,
} from "../verify-env/agent-hooks-live-probe.js";
import {
  type AgentHookAllowanceTake,
  type AgentHookHostEntry,
  type AgentHookHostStatus,
  nextAgentHookHostEntry,
  readAgentHookHostEntries,
  registrationDigest,
  resolveAgentHookAllowanceGraceMs,
  takeAgentHookTimeoutAllowance,
} from "./agent-hook-allowance.js";
import { readRitualState } from "./ritual-sentinel.js";

export const ENTRYPOINT_TIMEOUT_SECONDS = 300;
export const ENTRYPOINT_TIMEOUT_EXIT_CODE = 124;

export type RitualEntrypointFn = (argv: readonly string[]) => number;

/** What a gated step is running for (#7416). */
export interface RitualRunContext {
  /** `write` is the mutation write gate; `ritual` is session:ready and the CLI gated verify. */
  readonly surface: "write" | "ritual";
  /** Applying hook host on the write surface; absent or unrecognized means unknown. */
  readonly host?: string;
  readonly now: Date;
}

export interface DefaultRitualRunnerSeams {
  readonly evaluateAgentHookReadiness?: (
    projectRoot: string,
    options?: AgentHookReadinessOptions,
  ) => AgentHookReadinessResult;
  readonly takeAllowance?: typeof takeAgentHookTimeoutAllowance;
  readonly resolveGraceMs?: (projectRoot: string) => number;
}

export interface RitualRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Per-host `agent_hooks` entries this run produced (#7416). */
  readonly agentHookHosts?: Record<string, AgentHookHostEntry>;
}

function isHookHost(value: string | undefined): value is HookHost {
  return value !== undefined && (HOOK_HOSTS as readonly string[]).includes(value);
}

/** Run an in-process ritual entrypoint with stdout/stderr capture. */
export function callMain(
  mainFn: RitualEntrypointFn,
  argv: readonly string[],
  _options: { label?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const prevStdout = process.stdout.write.bind(process.stdout);
  const prevStderr = process.stderr.write.bind(process.stderr);
  const captureWrite =
    (chunks: string[]) =>
    (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      chunks.push(String(chunk));
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") {
        cb();
      }
      return true;
    };
  process.stdout.write = captureWrite(stdoutChunks) as typeof process.stdout.write;
  process.stderr.write = captureWrite(stderrChunks) as typeof process.stderr.write;

  try {
    const exitCode = mainFn(argv);
    return { code: exitCode || 0, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } catch (exc) {
    const message = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
    const captured = stderrChunks.join("");
    const stderr = captured ? `${captured}\n${message}` : message;
    return { code: 2, stdout: stdoutChunks.join(""), stderr };
  } finally {
    process.stdout.write = prevStdout;
    process.stderr.write = prevStderr;
  }
}

function parseProjectRoot(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      return argv[i + 1] ?? ".";
    }
    if (arg?.startsWith("--project-root=")) {
      return arg.slice("--project-root=".length);
    }
  }
  return ".";
}

function parseOptionalForIssue(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--for-issue") continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) return null;
    const parsed = Number.parseInt(next, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** CLI-shaped cache-fresh entrypoint (mirrors scripts/preflight_cache.py main). */
export function runCacheFreshMain(argv: readonly string[]): number {
  const projectRoot = parseProjectRoot(argv);
  const allowMissingBootstrap = argv.includes("--allow-missing-bootstrap");
  const quiet = argv.includes("--quiet");
  const workSelection = argv.includes("--work-selection");
  const skipDriftProbe = argv.includes("--skip-drift-probe") && !workSelection;
  const forIssue = parseOptionalForIssue(argv);
  const result = evaluate(projectRoot, { allowMissingBootstrap, skipDriftProbe, forIssue });
  if (result.code === 0) {
    if (!quiet) {
      if (result.message.startsWith("⚠")) {
        process.stderr.write(`${result.message}\n`);
      } else {
        process.stdout.write(`${result.message}\n`);
      }
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

function priorHostEntries(projectRoot: string): Record<string, AgentHookHostEntry> {
  try {
    const [state] = readRitualState(projectRoot);
    return readAgentHookHostEntries(state?.gatedSteps.agent_hooks);
  } catch {
    return {};
  }
}

function warningFirstLine(message: string): string {
  return message.replace(/^❌/, "⚠");
}

/**
 * Gated `agent_hooks` step (#7416). The write surface probes only the applying host; an unknown
 * host probes every enabled host under an overall deadline and gets no timeout allowance. The
 * ritual surface (session:ready, CLI gated verify) probes every enabled host and passes with a
 * warning when the only failures are timeouts.
 */
function runAgentHooksStep(
  projectRoot: string,
  seams: DefaultRitualRunnerSeams,
  context: RitualRunContext | undefined,
): RitualRunResult {
  const surface = context?.surface ?? "ritual";
  const now = context?.now ?? new Date();
  const applying: HookHost | null =
    surface === "write" && isHookHost(context?.host) ? context.host : null;
  const scope: AgentHookReadinessOptions =
    applying !== null
      ? { hosts: [applying], probeDeadlineMs: LIVE_PROBE_WRITE_BUDGET_MS }
      : surface === "write"
        ? { probeDeadlineMs: LIVE_PROBE_UNKNOWN_HOST_DEADLINE_MS }
        : {};
  const readiness = evaluateAgentHookReadinessSafely(
    projectRoot,
    seams.evaluateAgentHookReadiness,
    scope,
  );
  const finish = (
    code: number,
    message: string,
    hosts?: Record<string, AgentHookHostEntry>,
  ): RitualRunResult => {
    const output = `${message}\n`;
    return {
      code,
      stdout: code === 0 ? output : "",
      stderr: code === 0 ? "" : output,
      ...(hosts === undefined || Object.keys(hosts).length === 0 ? {} : { agentHookHosts: hosts }),
    };
  };
  if (readiness.skipped) return finish(readiness.code, readiness.message);

  const prior = priorHostEntries(projectRoot);
  const probe = readiness.liveProbe;
  const inScope: readonly string[] =
    applying !== null
      ? [applying]
      : readiness.hosts.filter((entry) => entry.functionality !== "disabled").map((e) => e.host);
  const statuses = new Map<string, AgentHookHostStatus>();
  for (const host of inScope) {
    if (probe === null) {
      const registration = readiness.registrations.find((entry) => entry.host === host);
      if (registration !== undefined && registration.status !== "healthy") {
        statuses.set(host, "structural");
      } else if (readiness.registrations.length === 0 && applying !== null) {
        statuses.set(host, "unavailable");
      }
      continue;
    }
    const functionality = readiness.hosts.find((entry) => entry.host === host)?.functionality;
    if (
      functionality === "functional" ||
      functionality === "non-functional" ||
      functionality === "unavailable" ||
      functionality === "timed-out"
    ) {
      statuses.set(host, functionality);
    }
  }
  const identity = probe?.commandIdentity ?? null;
  const entryFor = (
    host: string,
    status: AgentHookHostStatus,
    ok: boolean,
    warning?: string,
  ): AgentHookHostEntry =>
    nextAgentHookHostEntry(
      prior[host] ?? null,
      {
        status,
        ok,
        identity,
        registrationDigest: registrationDigest(host, readiness.registrations),
        ...(warning === undefined ? {} : { warning }),
      },
      now,
    );
  const entries: Record<string, AgentHookHostEntry> = {};

  // Ritual surface: a host whose only failure is a timeout passes with a warning.
  if (surface === "ritual" && readiness.code !== 0 && readiness.liveStatus === "timed-out") {
    const warning =
      "live probe timed out; recorded timed-out, not failed. Each write re-checks its own host.";
    for (const [host, status] of statuses) {
      entries[host] = entryFor(host, status, true, status === "timed-out" ? warning : undefined);
    }
    return finish(0, warningFirstLine(readiness.message), entries);
  }

  if (
    applying !== null &&
    readiness.code !== 0 &&
    readiness.liveStatus === "timed-out" &&
    statuses.get(applying) === "timed-out"
  ) {
    const take: AgentHookAllowanceTake = (seams.takeAllowance ?? takeAgentHookTimeoutAllowance)(
      projectRoot,
      applying,
      { identity, registrationDigest: registrationDigest(applying, readiness.registrations) },
      now,
      (seams.resolveGraceMs ?? resolveAgentHookAllowanceGraceMs)(projectRoot),
    );
    if (take.admitted && take.entry !== null) {
      entries[applying] = take.entry;
      return finish(
        0,
        `⚠ deft agent hook readiness: ${applying} live probe timed out; admitted once after a ` +
          `recent functional result on the same hook command and registration. A second ` +
          `timeout before a new functional result blocks.`,
        entries,
      );
    }
    entries[applying] = entryFor(applying, "timed-out", false);
    const why = take.saveFailed
      ? `the write is refused: ${take.reason}`
      : `no timeout allowance: ${take.reason}`;
    return finish(readiness.code, `${readiness.message}\n  ${why}`, entries);
  }

  for (const [host, status] of statuses) {
    entries[host] = entryFor(host, status, status === "functional");
  }
  if (readiness.code !== 0) {
    // A failure that names no result for a host still closes that host's allowance: this covers a
    // throwing evaluator (no hosts named) and a failure that skipped the host's probe.
    const unnamed = applying !== null ? [applying] : [...inScope, ...Object.keys(prior)];
    for (const host of unnamed) {
      if (entries[host] === undefined) entries[host] = entryFor(host, "unavailable", false);
    }
  }
  return finish(readiness.code, readiness.message, entries);
}

/** Default gated-tier runner: in-process hook readiness, doctor, and cache freshness. */
export function defaultRitualRunner(
  command: readonly string[],
  projectRoot: string,
  seams: DefaultRitualRunnerSeams = {},
  context?: RitualRunContext,
): RitualRunResult {
  const [verb, ...rest] = command;
  if (verb === "verify:hooks-installed") {
    return runAgentHooksStep(projectRoot, seams, context);
  }
  if (verb === "doctor") {
    return callMain((argv) => cmdDoctor(argv), ["--project-root", projectRoot, ...rest]);
  }
  if (verb === "verify:cache-fresh") {
    return callMain(runCacheFreshMain, [
      "--allow-missing-bootstrap",
      "--project-root",
      projectRoot,
      ...rest,
    ]);
  }
  const label = verb ?? "entrypoint";
  return { code: 2, stdout: "", stderr: `unknown session ritual command: ${label}` };
}
