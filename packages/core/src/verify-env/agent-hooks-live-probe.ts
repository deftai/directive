import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOOK_HOSTS, type HookEvent, type HookHost } from "../hooks/dispatcher.js";
import { READ_ONLY_HOOK_ENV } from "../hooks/tools.js";
import { DEFT_HOOK_COMMAND_MARKER } from "../init-deposit/agent-hooks.js";
import { DEFT_DOCTOR_HOOK_DIAGNOSTIC } from "../install-health/constants.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import {
  quoteWin32CommandForShell,
  resolveCommandOnPath,
  shouldUseShellForCommand,
} from "./command-spawn.js";

/** One spawn attempt of one fixture. A loaded Windows node cold start often runs past 1.5 s (#7416). */
export const LIVE_PROBE_CASE_TIMEOUT_MS = 4_000;
/** Extra attempts after a timeout (#3570). */
export const LIVE_PROBE_CASE_RETRY_COUNT = 1;
/** The `tool.before` limit a host enforces on one hook call (#3570 / #7416). */
export const LIVE_PROBE_HOST_TOOL_BEFORE_LIMIT_MS = 30_000;
/** Safety margin kept under the host `tool.before` limit for the write-path work around the probe. */
export const LIVE_PROBE_TOOL_BEFORE_SAFETY_MARGIN_MS = 5_000;
/** Total probing allowed in one write: the host limit minus the margin (25 s). */
export const LIVE_PROBE_WRITE_BUDGET_MS =
  LIVE_PROBE_HOST_TOOL_BEFORE_LIMIT_MS - LIVE_PROBE_TOOL_BEFORE_SAFETY_MARGIN_MS;
/** Overall deadline for the unknown-applying-host fallback, which probes every enabled host. */
export const LIVE_PROBE_UNKNOWN_HOST_DEADLINE_MS = 20_000;
/** Fixtures run per host: one allow case and one deny case. */
export const LIVE_PROBE_FIXTURES_PER_HOST = 2;
/** Worst case for one known host: both fixtures, each retried. Must stay under the write budget. */
export const LIVE_PROBE_KNOWN_HOST_WORST_CASE_MS =
  LIVE_PROBE_FIXTURES_PER_HOST * (LIVE_PROBE_CASE_RETRY_COUNT + 1) * LIVE_PROBE_CASE_TIMEOUT_MS;
export const LIVE_PROBE_TIMEOUT_RECOVERY =
  "Recovery: retry when load is lower; each write re-checks its own host, so a passing session:ready is not what admits a write. Do not reinstall @deftai/directive or disable hostHooks for a timeout.";
export const LIVE_PROBE_BROKEN_RECOVERY =
  "Recovery: npm i -g @deftai/directive, then directive install --repair.";

export type AgentHookLiveProbeIssue =
  | "hook-command-missing"
  | "spawn-failed"
  | "timed-out"
  | "empty-stdout"
  | "unparseable-json"
  | "missing-allow"
  | "missing-deny";

export interface AgentHookLiveProbeCase {
  readonly host: HookHost;
  readonly event: HookEvent;
  readonly fixture: "allow" | "deny";
  readonly issue: AgentHookLiveProbeIssue;
  readonly detail: string;
}

export type AgentHookLiveProbeHostStatus =
  | "functional"
  | "non-functional"
  | "unavailable"
  | "timed-out";

export interface AgentHookLiveProbeHostResult {
  readonly host: HookHost;
  readonly status: AgentHookLiveProbeHostStatus;
}

/** Identity of the resolved hook command: path, size and mtime (#7416). */
export interface AgentHookCommandIdentity {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface AgentHookLiveProbeResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly cases: readonly AgentHookLiveProbeCase[];
  readonly hosts: readonly AgentHookLiveProbeHostResult[];
  readonly durationMs: number;
  /** Resolved hook command identity; null when the command was not resolved or not readable. */
  readonly commandIdentity?: AgentHookCommandIdentity | null;
}

export interface AgentHookLiveProbeSeams {
  /** Enabled hosts to probe. Defaults to every deposited host. */
  readonly hosts?: readonly HookHost[];
  readonly resolveCommand?: (name: string) => string | null;
  /** Size and mtime of the resolved command; null when unreadable. */
  readonly statCommand?: (
    path: string,
  ) => { readonly size: number; readonly mtimeMs: number } | null;
  /**
   * Overall deadline for the whole probe. When it runs out, every case that has
   * not finished is reported `timed-out`, never `non-functional` (#7416).
   */
  readonly deadlineMs?: number;
  /** Monotonic clock in ms; tests inject it. */
  readonly clockMs?: () => number;
  readonly spawnHook?: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly stdin: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    /** Per-attempt timeout, already clamped to the time left before the overall deadline. */
    readonly timeoutMs: number;
  }) => {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
  };
}

interface ParsedJson {
  readonly value: Record<string, unknown> | null;
  readonly issue: "empty-stdout" | "unparseable-json" | null;
  readonly detail: string;
}

const LIVE_PROBE_EVENT: HookEvent = "tool.before";

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function resolveHookCommand(seams: AgentHookLiveProbeSeams): string | null {
  return (seams.resolveCommand ?? resolveCommandOnPath)(DEFT_HOOK_COMMAND_MARKER);
}

function defaultStatCommand(path: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function readCommandIdentity(
  command: string,
  seams: AgentHookLiveProbeSeams,
): AgentHookCommandIdentity | null {
  try {
    const stat = (seams.statCommand ?? defaultStatCommand)(command);
    return stat === null
      ? null
      : { path: command, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch {
    return null;
  }
}

interface ProbeBudget {
  readonly clockMs: () => number;
  /** Absolute deadline on `clockMs`, or null when the probe has no overall deadline. */
  readonly deadlineAt: number | null;
  readonly deadlineMs: number | null;
}

function remainingMs(budget: ProbeBudget): number {
  return budget.deadlineAt === null
    ? Number.POSITIVE_INFINITY
    : budget.deadlineAt - budget.clockMs();
}

/** Quote one Windows cmd.exe argument used by the installed hook shim. */
export function quoteWindowsCmdArg(value: string): string {
  const escaped = value.replace(/%/g, "%%");
  if (!/[\s"&|<>^()]/.test(escaped)) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

function spawnHookWithStdin(
  command: string,
  args: readonly string[],
  stdin: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = LIVE_PROBE_CASE_TIMEOUT_MS,
): { status: number; stdout: string; stderr: string; timedOut?: boolean } {
  const shell = shouldUseShellForCommand(command);
  const commandArgs =
    shell && process.platform === "win32"
      ? [[quoteWin32CommandForShell(command), ...args.map(quoteWindowsCmdArg)].join(" "), []]
      : [command, [...args]];
  const proc = spawnSync(commandArgs[0] as string, commandArgs[1] as string[], {
    input: stdin,
    cwd,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    timeout: timeoutMs,
  });
  const timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: proc.status ?? (proc.error ? 2 : proc.signal ? 128 : 0),
    stdout: typeof proc.stdout === "string" ? proc.stdout : "",
    stderr: typeof proc.stderr === "string" ? proc.stderr : "",
    ...(timedOut ? { timedOut: true } : {}),
  };
}

/** agy payload shape (camelCase, `toolCall.args`): a read is allowed, a native spawn is denied (#7347). */
function agyFixture(projectRoot: string, fixture: "allow" | "deny"): string {
  return JSON.stringify({
    hookEventName: "PreToolUse",
    conversationId: "deft-live-probe",
    cwd: projectRoot,
    workspacePaths: [projectRoot],
    toolCall:
      fixture === "allow"
        ? {
            id: "probe-allow",
            name: "read_file",
            args: { Path: join(projectRoot, "package.json") },
          }
        : {
            id: "probe-deny",
            name: "invoke_subagent",
            args: { TypeName: "generalPurpose", Role: "worker", Prompt: "implement" },
          },
  });
}

function allowFixture(projectRoot: string): string {
  return JSON.stringify({
    tool_name: "Read",
    cwd: projectRoot,
    workspace_roots: [projectRoot],
  });
}

function denyFixture(projectRoot: string): string {
  return JSON.stringify({
    tool_name: "Task",
    cwd: projectRoot,
    workspace_roots: [projectRoot],
    tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
  });
}

/** Doctor probe env: suppress self-completing setup (AC9.10) and force read-only deny. */
function doctorProbeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "1",
    ...extra,
  };
}

function denyProbeEnv(): NodeJS.ProcessEnv {
  return doctorProbeEnv({ [READ_ONLY_HOOK_ENV]: "1" });
}

function allowProbeEnv(): NodeJS.ProcessEnv {
  return doctorProbeEnv();
}

function parseJsonObject(stdout: string): ParsedJson {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { value: null, issue: "empty-stdout", detail: "empty stdout" };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, issue: null, detail: "valid JSON object" };
    }
    return { value: null, issue: "unparseable-json", detail: "stdout JSON is not an object" };
  } catch {
    return { value: null, issue: "unparseable-json", detail: "stdout is not valid JSON" };
  }
}

function validatesNestedDeny(value: Record<string, unknown>): boolean {
  const output = value.hookSpecificOutput;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return false;
  const nested = output as Record<string, unknown>;
  return (
    nested.hookEventName === "PreToolUse" &&
    nested.permissionDecision === "deny" &&
    typeof nested.permissionDecisionReason === "string"
  );
}

function validateFixtureOutput(
  host: HookHost,
  fixture: "allow" | "deny",
  stdout: string,
): { ok: true } | { ok: false; issue: AgentHookLiveProbeIssue; detail: string } {
  if (host === "agy") {
    // agy treats empty stdout as a host fail-open, so both fixtures need one explicit decision (#7378).
    const parsed = parseJsonObject(stdout);
    if (parsed.value === null) {
      return {
        ok: false,
        issue: parsed.issue as "empty-stdout" | "unparseable-json",
        detail: parsed.detail,
      };
    }
    if (fixture === "allow") {
      return parsed.value.decision === "allow"
        ? { ok: true }
        : { ok: false, issue: "missing-allow", detail: "expected agy decision allow" };
    }
    return parsed.value.decision === "deny" && typeof parsed.value.reason === "string"
      ? { ok: true }
      : { ok: false, issue: "missing-deny", detail: "expected agy deny with a reason" };
  }
  if (fixture === "allow" && host !== "cursor") {
    if (stdout.trim().length === 0) return { ok: true };
    const parsed = parseJsonObject(stdout);
    return {
      ok: false,
      issue: parsed.issue ?? "missing-allow",
      detail: "expected empty stdout so the host permission flow remains unchanged",
    };
  }

  const parsed = parseJsonObject(stdout);
  if (parsed.value === null) {
    return {
      ok: false,
      issue: parsed.issue as "empty-stdout" | "unparseable-json",
      detail: parsed.detail,
    };
  }
  const value = parsed.value;
  if (fixture === "allow") {
    return value.permission === "allow"
      ? { ok: true }
      : { ok: false, issue: "missing-allow", detail: "expected Cursor permission allow" };
  }

  const denied =
    host === "cursor"
      ? value.permission === "deny"
      : host === "grok"
        ? value.decision === "deny" && typeof value.reason === "string"
        : validatesNestedDeny(value);
  return denied
    ? { ok: true }
    : { ok: false, issue: "missing-deny", detail: `expected ${host} deny envelope` };
}

function liveProbeRecovery(cases: readonly AgentHookLiveProbeCase[]): string {
  if (cases.length > 0 && cases.every((entry) => entry.issue === "timed-out")) {
    return LIVE_PROBE_TIMEOUT_RECOVERY;
  }
  return LIVE_PROBE_BROKEN_RECOVERY;
}

function hostStatusFromFailure(
  hostFailure: AgentHookLiveProbeCase | null,
): AgentHookLiveProbeHostStatus {
  if (hostFailure === null) return "functional";
  if (hostFailure.issue === "timed-out") return "timed-out";
  return "non-functional";
}

function runFixtureProbe(
  command: string,
  host: HookHost,
  projectRoot: string,
  fixture: "allow" | "deny",
  spawnHook: NonNullable<AgentHookLiveProbeSeams["spawnHook"]>,
  budget: ProbeBudget,
): AgentHookLiveProbeCase | null {
  const budgetExhausted = (): AgentHookLiveProbeCase => ({
    host,
    event: LIVE_PROBE_EVENT,
    fixture,
    issue: "timed-out",
    detail: `probe deadline of ${budget.deadlineMs}ms ran out before this case finished`,
  });
  const baseInput = {
    command,
    args: ["--host", host, "--event", LIVE_PROBE_EVENT, "--project-root", projectRoot] as const,
    stdin:
      host === "agy"
        ? agyFixture(projectRoot, fixture)
        : fixture === "allow"
          ? allowFixture(projectRoot)
          : denyFixture(projectRoot),
    cwd: projectRoot,
    env: fixture === "allow" ? allowProbeEnv() : denyProbeEnv(),
  };
  const attempt = () =>
    spawnHook({
      ...baseInput,
      timeoutMs: Math.max(1, Math.min(LIVE_PROBE_CASE_TIMEOUT_MS, Math.floor(remainingMs(budget)))),
    });
  if (remainingMs(budget) <= 0) return budgetExhausted();
  let spawned = attempt();
  for (
    let retry = 0;
    retry < LIVE_PROBE_CASE_RETRY_COUNT && spawned.timedOut === true;
    retry += 1
  ) {
    if (remainingMs(budget) <= 0) return budgetExhausted();
    spawned = attempt();
  }
  if (spawned.timedOut === true) {
    if (remainingMs(budget) <= 0) return budgetExhausted();
    return {
      host,
      event: LIVE_PROBE_EVENT,
      fixture,
      issue: "timed-out",
      detail: `hook command exceeded ${LIVE_PROBE_CASE_TIMEOUT_MS}ms after ${LIVE_PROBE_CASE_RETRY_COUNT + 1} attempts`,
    };
  }
  if (spawned.status !== 0) {
    return {
      host,
      event: LIVE_PROBE_EVENT,
      fixture,
      issue: "spawn-failed",
      detail: `hook command exited ${spawned.status}${spawned.stderr.trim() ? `: ${spawned.stderr.trim()}` : ""}`,
    };
  }
  const validation = validateFixtureOutput(host, fixture, spawned.stdout);
  return validation.ok
    ? null
    : {
        host,
        event: LIVE_PROBE_EVENT,
        fixture,
        issue: validation.issue,
        detail: validation.detail,
      };
}

/** Invoke the installed deft-hook shim and validate enabled host allow/deny codecs. */
export function probeAgentHooksLive(
  projectRoot: string,
  seams: AgentHookLiveProbeSeams = {},
): AgentHookLiveProbeResult {
  const started = performance.now();
  const root = resolve(projectRoot);
  const hosts = [...(seams.hosts ?? HOOK_HOSTS)];
  if (hosts.length === 0) {
    return {
      code: 0,
      message: "deft agent hooks live probe skipped: every host is intentionally disabled.",
      cases: [],
      hosts: [],
      durationMs: elapsedMs(started),
    };
  }

  const command = resolveHookCommand(seams);
  if (command === null) {
    return {
      code: 2,
      message: `deft agent hooks live probe unavailable: installed ${DEFT_HOOK_COMMAND_MARKER} is not on PATH.`,
      cases: [
        {
          host: hosts[0] as HookHost,
          event: LIVE_PROBE_EVENT,
          fixture: "allow",
          issue: "hook-command-missing",
          detail: `${DEFT_HOOK_COMMAND_MARKER} not found on PATH`,
        },
      ],
      hosts: hosts.map((host) => ({ host, status: "unavailable" })),
      durationMs: elapsedMs(started),
    };
  }

  const clockMs = seams.clockMs ?? (() => performance.now());
  const budget: ProbeBudget = {
    clockMs,
    deadlineAt: seams.deadlineMs === undefined ? null : clockMs() + seams.deadlineMs,
    deadlineMs: seams.deadlineMs ?? null,
  };
  const commandIdentity = readCommandIdentity(command, seams);
  const spawnHook =
    seams.spawnHook ??
    ((input) =>
      spawnHookWithStdin(
        input.command,
        input.args,
        input.stdin,
        input.cwd,
        input.env,
        input.timeoutMs,
      ));
  const failures: AgentHookLiveProbeCase[] = [];
  const hostResults: AgentHookLiveProbeHostResult[] = [];
  for (const host of hosts) {
    let hostFailure: AgentHookLiveProbeCase | null = null;
    for (const fixture of ["allow", "deny"] as const) {
      hostFailure = runFixtureProbe(command, host, root, fixture, spawnHook, budget);
      if (hostFailure !== null) {
        failures.push(hostFailure);
        break;
      }
    }
    hostResults.push({ host, status: hostStatusFromFailure(hostFailure) });
  }

  if (failures.length === 0) {
    return {
      code: 0,
      message: `deft agent hooks live probe passed allow/deny fixtures for ${hosts.join(", ")}.`,
      cases: [],
      hosts: hostResults,
      durationMs: elapsedMs(started),
      commandIdentity,
    };
  }
  const summary = failures
    .map((entry) => `${entry.host}/${entry.fixture}: ${entry.issue} (${entry.detail})`)
    .join("; ");
  return {
    code: 1,
    message: `deft agent hooks live probe FAILED: ${summary}. ${liveProbeRecovery(failures)}`,
    cases: failures,
    hosts: hostResults,
    durationMs: elapsedMs(started),
    commandIdentity,
  };
}
