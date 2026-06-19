import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { stableJson } from "./json.js";
import { parseTimestamp, timestampIso } from "./time.js";

export const SCHEMA_VERSION = 1;
export const RITUAL_STATE_SCHEMA_VERSION = 1;
export const SENTINEL_RELPATH = [".deft", "last-session.json"] as const;
export const RITUAL_STATE_RELPATH = [".deft", "ritual-state.json"] as const;
export const MIN_RESUME_AGE_MS = 2 * 60 * 60 * 1000;
export const ACTIVE_VBRIEF_PREFIX = "vbrief/active/";

export interface Sentinel {
  readonly schemaVersion: number;
  readonly deftVersion: string;
  readonly timestamp: Date;
  readonly lastActiveVbrief: string;
  readonly lastBranch: string;
}

export interface RitualState {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly gitHead: string;
  readonly worktreePath: string;
  readonly startedAt: Date;
  readonly quickSteps: Record<string, Record<string, unknown>>;
  readonly gatedSteps: Record<string, Record<string, unknown>>;
  readonly raw: Record<string, unknown>;
}

export interface RitualStepInput {
  readonly ok: boolean;
  readonly ts?: Date;
  readonly deferredReason?: string | null;
  readonly exitCode?: number | null;
  readonly message?: string | null;
  readonly command?: readonly string[] | null;
}

export function ritualStatePath(projectRoot: string): string {
  return join(resolve(projectRoot), ...RITUAL_STATE_RELPATH);
}

function sentinelPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...SENTINEL_RELPATH);
}

export function ritualStep(input: RitualStepInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ok: input.ok,
    ts: timestampIso(input.ts),
  };
  if (input.deferredReason) {
    payload.deferred_reason = input.deferredReason;
  }
  if (input.exitCode !== null && input.exitCode !== undefined) {
    payload.exit_code = input.exitCode;
  }
  if (input.message) {
    payload.message = input.message;
  }
  if (input.command && input.command.length > 0) {
    payload.command = input.command.map(String);
  }
  return payload;
}

export function newRitualStatePayload(input: {
  sessionId: string;
  gitHead: string;
  worktreePath: string;
  startedAt?: Date;
  quickSteps?: Record<string, Record<string, unknown>>;
  gatedSteps?: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    schemaVersion: RITUAL_STATE_SCHEMA_VERSION,
    session_id: input.sessionId,
    git_head: input.gitHead,
    worktree_path: input.worktreePath,
    started_at: timestampIso(input.startedAt),
    quick_steps: input.quickSteps ?? {},
    gated_steps: input.gatedSteps ?? {},
  };
}

function validateSteps(
  raw: unknown,
  key: string,
): [Record<string, Record<string, unknown>> | null, string | null] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [null, `${key} must be an object`];
  }
  const steps: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name !== "string" || name.length === 0) {
      return [null, `${key} contains a non-string step name`];
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [null, `${key}.${name} must be an object`];
    }
    const step = value as Record<string, unknown>;
    if (typeof step.ok !== "boolean") {
      return [null, `${key}.${name}.ok must be a boolean`];
    }
    if (parseTimestamp(step.ts) === null) {
      return [null, `${key}.${name}.ts must be an ISO-8601 timestamp`];
    }
    const deferred = step.deferred_reason;
    if (deferred !== undefined && deferred !== null && typeof deferred !== "string") {
      return [null, `${key}.${name}.deferred_reason must be a string`];
    }
    const exitCode = step.exit_code;
    if (
      exitCode !== undefined &&
      exitCode !== null &&
      (typeof exitCode !== "number" || !Number.isInteger(exitCode))
    ) {
      return [null, `${key}.${name}.exit_code must be an integer`];
    }
    const message = step.message;
    if (message !== undefined && message !== null && typeof message !== "string") {
      return [null, `${key}.${name}.message must be a string`];
    }
    const command = step.command;
    if (
      command !== undefined &&
      command !== null &&
      (!Array.isArray(command) || !command.every((part) => typeof part === "string"))
    ) {
      return [null, `${key}.${name}.command must be an array of strings`];
    }
    steps[name] = { ...step };
  }
  return [steps, null];
}

function atomicWriteJson(
  targetPath: string,
  payload: Record<string, unknown>,
  prefix: string,
): void {
  mkdirSync(join(targetPath, ".."), { recursive: true });
  const dir = join(targetPath, "..");
  const tmpName = join(dir, `${prefix}${process.pid}.json.tmp`);
  const fd = openSync(tmpName, "w");
  try {
    const text = `${stableJson(payload, 2)}\n`;
    writeSync(fd, text, undefined, "utf8");
    try {
      fdatasyncSync(fd);
    } catch {
      // best-effort
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpName, targetPath);
}

export function readRitualState(projectRoot: string): [RitualState | null, string | null] {
  const stateFile = ritualStatePath(projectRoot);
  try {
    if (!existsSync(stateFile)) {
      return [null, `ritual state missing at ${stateFile}`];
    }
  } catch (exc) {
    return [null, `ritual state unreadable at ${stateFile}: ${String(exc)}`];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(stateFile, { encoding: "utf8" }));
  } catch (exc) {
    if (exc instanceof SyntaxError) {
      return [null, `ritual state is not valid JSON: ${exc.message}`];
    }
    return [null, `ritual state cannot be read: ${String(exc)}`];
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [null, "ritual state top-level value must be an object"];
  }
  const obj = payload as Record<string, unknown>;
  if (obj.schemaVersion !== RITUAL_STATE_SCHEMA_VERSION) {
    return [
      null,
      `ritual state schemaVersion mismatch (got ${String(obj.schemaVersion)}, want ${RITUAL_STATE_SCHEMA_VERSION})`,
    ];
  }
  const sessionId = obj.session_id;
  const gitHead = obj.git_head;
  const worktreePathValue = obj.worktree_path;
  const startedAt = parseTimestamp(obj.started_at);
  for (const [fieldName, value] of [
    ["session_id", sessionId],
    ["git_head", gitHead],
    ["worktree_path", worktreePathValue],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      return [null, `ritual state ${fieldName} must be a non-empty string`];
    }
  }
  if (startedAt === null) {
    return [null, "ritual state started_at must be an ISO-8601 timestamp"];
  }
  const [quickSteps, quickErr] = validateSteps(obj.quick_steps, "quick_steps");
  if (quickErr !== null || quickSteps === null) {
    return [null, quickErr ?? "quick_steps invalid"];
  }
  const [gatedSteps, gatedErr] = validateSteps(obj.gated_steps, "gated_steps");
  if (gatedErr !== null || gatedSteps === null) {
    return [null, gatedErr ?? "gated_steps invalid"];
  }
  return [
    {
      schemaVersion: RITUAL_STATE_SCHEMA_VERSION,
      sessionId: sessionId as string,
      gitHead: gitHead as string,
      worktreePath: worktreePathValue as string,
      startedAt,
      quickSteps,
      gatedSteps,
      raw: { ...obj },
    },
    null,
  ];
}

export function writeRitualState(projectRoot: string, payload: Record<string, unknown>): string {
  const stateFile = ritualStatePath(projectRoot);
  atomicWriteJson(stateFile, payload, ".ritual-state.");
  return stateFile;
}

export function recordRitualStep(
  projectRoot: string,
  input: { tier: "quick" | "gated"; stepName: string; step: Record<string, unknown> },
): string {
  const [state, err] = readRitualState(projectRoot);
  if (state === null) {
    throw new Error(err ?? "ritual state missing");
  }
  if (input.tier !== "quick" && input.tier !== "gated") {
    throw new Error(`tier must be 'quick' or 'gated', got ${JSON.stringify(input.tier)}`);
  }
  const payload = { ...state.raw };
  const key = input.tier === "quick" ? "quick_steps" : "gated_steps";
  const steps = { ...(payload[key] as Record<string, Record<string, unknown>>) };
  steps[input.stepName] = input.step;
  payload[key] = steps;
  return writeRitualState(projectRoot, payload);
}

export function readSentinel(projectRoot: string): Sentinel | null {
  const sentinelFile = sentinelPath(projectRoot);
  try {
    if (!existsSync(sentinelFile)) {
      return null;
    }
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(sentinelFile, { encoding: "utf8" }));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    return null;
  }
  const timestamp = parseTimestamp(obj.timestamp);
  if (timestamp === null) {
    return null;
  }
  const lastActiveVbrief = obj.lastActiveVbrief;
  const lastBranch = obj.lastBranch;
  if (typeof lastActiveVbrief !== "string" || lastActiveVbrief.length === 0) {
    return null;
  }
  if (typeof lastBranch !== "string" || lastBranch.length === 0) {
    return null;
  }
  const deftVersionRaw = obj.deftVersion;
  const deftVersion = typeof deftVersionRaw === "string" ? deftVersionRaw : "";
  return {
    schemaVersion: SCHEMA_VERSION,
    deftVersion,
    timestamp,
    lastActiveVbrief,
    lastBranch,
  };
}

export function writeSentinel(
  projectRoot: string,
  input: {
    deftVersion: string;
    lastActiveVbrief: string;
    lastBranch: string;
    now?: Date;
  },
): string {
  const sentinelFile = sentinelPath(projectRoot);
  const instant = input.now ?? new Date();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    deftVersion: input.deftVersion,
    timestamp: timestampIso(instant),
    lastActiveVbrief: input.lastActiveVbrief.replace(/\\/g, "/"),
    lastBranch: input.lastBranch,
  };
  atomicWriteJson(sentinelFile, payload, ".last-session.");
  return sentinelFile;
}

function formatElapsed(deltaMs: number): string {
  const totalSeconds = Math.floor(deltaMs / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.max(Math.floor(totalSeconds / 60), 1);
    return `${minutes}m`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours}h`;
}

export function computeResumeSignal(
  sentinel: Sentinel | null,
  now: Date,
  projectRoot: string,
): string | null {
  if (sentinel === null) {
    return null;
  }
  const lastActive = sentinel.lastActiveVbrief.replace(/\\/g, "/");
  if (!lastActive.startsWith(ACTIVE_VBRIEF_PREFIX)) {
    return null;
  }
  const elapsedMs = now.getTime() - sentinel.timestamp.getTime();
  if (elapsedMs < MIN_RESUME_AGE_MS) {
    return null;
  }
  const vbriefPath = join(resolve(projectRoot), lastActive);
  try {
    if (!statSync(vbriefPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const elapsedLabel = formatElapsed(elapsedMs);
  return (
    `[deft] Last session: ${lastActive} (branch: ${sentinel.lastBranch}), ` +
    `${elapsedLabel} ago. Resume? Run \`task vbrief:show ${lastActive}\`.`
  );
}

export function detectLatestActiveVbrief(projectRoot: string): string | null {
  const activeDir = join(resolve(projectRoot), "vbrief", "active");
  try {
    if (!existsSync(activeDir)) {
      return null;
    }
  } catch {
    return null;
  }
  let children: string[];
  try {
    children = readdirSync(activeDir);
  } catch {
    return null;
  }
  const candidates: Array<[number, string]> = [];
  for (const name of children) {
    if (!name.endsWith(".vbrief.json")) {
      continue;
    }
    const full = join(activeDir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) {
        continue;
      }
      candidates.push([st.mtimeMs, full]);
    } catch {}
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b[0] - a[0]);
  const latest = candidates[0]?.[1];
  if (!latest) {
    return null;
  }
  try {
    return relative(resolve(projectRoot), latest).replace(/\\/g, "/");
  } catch {
    return null;
  }
}
