import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { HOOK_HOSTS, type HookEvent, type HookHost } from "../hooks/dispatcher.js";
import { READ_ONLY_HOOK_ENV } from "../hooks/tools.js";
import { DEFT_HOOK_COMMAND_MARKER } from "../init-deposit/agent-hooks.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import {
  quoteWin32CommandForShell,
  resolveCommandOnPath,
  shouldUseShellForCommand,
} from "./command-spawn.js";

export const LIVE_PROBE_CASE_TIMEOUT_MS = 1_500;
/** Extra attempts after a timeout. One retry keeps 4×2×1.5s×2 = 24s under Cursor 30s (#3570). */
export const LIVE_PROBE_CASE_RETRY_COUNT = 1;
export const LIVE_PROBE_TIMEOUT_RECOVERY =
  "Recovery: retry the gated ritual when load is lower. Do not reinstall @deftai/directive or disable hostHooks for a timeout.";
export const LIVE_PROBE_BROKEN_RECOVERY =
  "Recovery: reinstall @deftai/directive and run `deft update`.";

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

export interface AgentHookLiveProbeResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly cases: readonly AgentHookLiveProbeCase[];
  readonly hosts: readonly AgentHookLiveProbeHostResult[];
  readonly durationMs: number;
}

export interface AgentHookLiveProbeSeams {
  /** Enabled hosts to probe. Defaults to every deposited host. */
  readonly hosts?: readonly HookHost[];
  readonly resolveCommand?: (name: string) => string | null;
  readonly spawnHook?: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly stdin: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
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
    timeout: LIVE_PROBE_CASE_TIMEOUT_MS,
  });
  const timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: proc.status ?? (proc.error ? 2 : proc.signal ? 128 : 0),
    stdout: typeof proc.stdout === "string" ? proc.stdout : "",
    stderr: typeof proc.stderr === "string" ? proc.stderr : "",
    ...(timedOut ? { timedOut: true } : {}),
  };
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

function denyProbeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [READ_ONLY_HOOK_ENV]: "1" };
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
): AgentHookLiveProbeCase | null {
  const input = {
    command,
    args: ["--host", host, "--event", LIVE_PROBE_EVENT, "--project-root", projectRoot] as const,
    stdin: fixture === "allow" ? allowFixture(projectRoot) : denyFixture(projectRoot),
    cwd: projectRoot,
    env: fixture === "allow" ? process.env : denyProbeEnv(),
  };
  let spawned = spawnHook(input);
  for (
    let retry = 0;
    retry < LIVE_PROBE_CASE_RETRY_COUNT && spawned.timedOut === true;
    retry += 1
  ) {
    spawned = spawnHook(input);
  }
  if (spawned.timedOut === true) {
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

  const spawnHook =
    seams.spawnHook ??
    ((input) => spawnHookWithStdin(input.command, input.args, input.stdin, input.cwd, input.env));
  const failures: AgentHookLiveProbeCase[] = [];
  const hostResults: AgentHookLiveProbeHostResult[] = [];
  for (const host of hosts) {
    let hostFailure: AgentHookLiveProbeCase | null = null;
    for (const fixture of ["allow", "deny"] as const) {
      hostFailure = runFixtureProbe(command, host, root, fixture, spawnHook);
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
  };
}
