/**
 * Mechanical guard for probe artifact handoff (#1518c). Port of scripts/probe_session.py.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;
export const SESSION_RELPATH = [".deft", "probe-session.json"] as const;

export const STATE_INTERROGATE = "interrogate" as const;
export const STATE_COMPLETE = "complete" as const;
export type ProbeState = typeof STATE_INTERROGATE | typeof STATE_COMPLETE;

export const VALID_DECISION_STATUSES = new Set(["locked", "deferred", "risk-accepted"]);

export class ProbeHandoffBlockedError extends Error {
  readonly session: ProbeSession | null;

  constructor(message: string, session: ProbeSession | null = null) {
    super(message);
    this.name = "ProbeHandoffBlockedError";
    this.session = session;
  }
}

export interface ResolvedDecision {
  readonly question: string;
  readonly answer: string;
  readonly status: string;
}

export interface ProbeSession {
  readonly schema_version: number;
  readonly state: ProbeState;
  readonly target: string;
  readonly current_branch: string;
  readonly resolved_decisions: readonly ResolvedDecision[];
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

export function resolvedDecisionToDict(d: ResolvedDecision): Record<string, string> {
  return { question: d.question, answer: d.answer, status: d.status };
}

export function resolvedDecisionFromDict(raw: unknown): ResolvedDecision | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const question = obj.question;
  const answer = obj.answer;
  const status = obj.status;
  if (
    typeof question !== "string" ||
    typeof answer !== "string" ||
    typeof status !== "string" ||
    !question.trim() ||
    !answer.trim() ||
    !status.trim()
  ) {
    return null;
  }
  if (!VALID_DECISION_STATUSES.has(status.trim())) {
    return null;
  }
  return {
    question: question.trim(),
    answer: answer.trim(),
    status: status.trim(),
  };
}

export function sessionToDict(session: ProbeSession): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schemaVersion: session.schema_version,
    state: session.state,
    target: session.target,
    currentBranch: session.current_branch,
    resolvedDecisions: session.resolved_decisions.map(resolvedDecisionToDict),
    startedAt: formatTimestamp(session.started_at),
  };
  if (session.completed_at !== null) {
    payload.completedAt = formatTimestamp(session.completed_at);
  }
  return payload;
}

function sessionPath(projectRoot: string): string {
  return join(projectRoot, ...SESSION_RELPATH);
}

export function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) {
    return null;
  }
  const normalised = raw.endsWith("Z") ? `${raw.slice(0, -1)}+00:00` : raw;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function defaultExecGit(projectRoot: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: typeof stdout === "string" ? stdout : "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
    };
  }
}

/** Detect git branch (best effort, injectable for tests). */
export function detectGitBranch(
  projectRoot: string,
  execGit?: (args: string[]) => { status: number; stdout: string },
): string {
  const run = execGit ?? ((args: string[]) => defaultExecGit(projectRoot, args));
  try {
    const result = run(["symbolic-ref", "--short", "HEAD"]);
    if (result.status === 0) {
      const branch = result.stdout.trim();
      if (branch) {
        return branch;
      }
    }
  } catch {
    // fall through
  }
  try {
    const revResult = run(["rev-parse", "--short", "HEAD"]);
    if (revResult.status === 0) {
      const sha = revResult.stdout.trim();
      if (sha) {
        return `detached:${sha}`;
      }
    }
  } catch {
    // fall through
  }
  return "";
}

/** Read probe session from project root. */
export function readSession(projectRoot: string): ProbeSession | null {
  const sessionFile = sessionPath(projectRoot);
  if (!existsSync(sessionFile)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(sessionFile, "utf8")) as unknown;
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
  const state = obj.state;
  if (state !== STATE_INTERROGATE && state !== STATE_COMPLETE) {
    return null;
  }
  const target = obj.target;
  const currentBranch = obj.currentBranch;
  if (typeof target !== "string" || !target.trim()) {
    return null;
  }
  if (typeof currentBranch !== "string") {
    return null;
  }
  const startedAt = parseTimestamp(obj.startedAt);
  if (startedAt === null) {
    return null;
  }
  const completedAt = parseTimestamp(obj.completedAt);
  if (state === STATE_COMPLETE && completedAt === null) {
    return null;
  }
  if (state === STATE_INTERROGATE && completedAt !== null) {
    return null;
  }
  const rawDecisions = obj.resolvedDecisions;
  if (!Array.isArray(rawDecisions)) {
    return null;
  }
  const decisions: ResolvedDecision[] = [];
  for (const item of rawDecisions) {
    const parsed = resolvedDecisionFromDict(item);
    if (parsed === null) {
      return null;
    }
    decisions.push(parsed);
  }
  return {
    schema_version: SCHEMA_VERSION,
    state,
    target: target.trim(),
    current_branch: currentBranch.trim(),
    resolved_decisions: decisions,
    started_at: startedAt,
    completed_at: completedAt,
  };
}

/** Atomically persist session to .deft/probe-session.json. */
export function writeSession(projectRoot: string, session: ProbeSession): string {
  const sessionFile = sessionPath(projectRoot);
  mkdirSync(join(projectRoot, ".deft"), { recursive: true });
  const tmpName = join(
    projectRoot,
    ".deft",
    `.probe-session.${randomBytes(8).toString("hex")}.json.tmp`,
  );
  const sortedPayload = sessionToDict(session);
  const sortedKeys = Object.keys(sortedPayload).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sortedObj[k] = sortedPayload[k];
  }
  const finalContent = `${JSON.stringify(sortedObj, null, 2)}\n`;

  const fd = openSync(tmpName, "w");
  try {
    writeSync(fd, finalContent, undefined, "utf8");
    try {
      fdatasyncSync(fd);
    } catch {
      // best effort
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpName, sessionFile);
  return sessionFile;
}

export function startSession(
  projectRoot: string,
  options: {
    target: string;
    currentBranch?: string;
    now?: Date;
    detectBranch?: typeof detectGitBranch;
  },
): ProbeSession {
  const scope = options.target.trim();
  if (!scope) {
    throw new Error("target must be a non-empty scope name");
  }
  const branch =
    (options.currentBranch ?? "").trim() || (options.detectBranch ?? detectGitBranch)(projectRoot);
  const instant = options.now ?? new Date();
  const session: ProbeSession = {
    schema_version: SCHEMA_VERSION,
    state: STATE_INTERROGATE,
    target: scope,
    current_branch: branch,
    resolved_decisions: [],
    started_at: instant,
    completed_at: null,
  };
  writeSession(projectRoot, session);
  return session;
}

export function recordDecision(
  projectRoot: string,
  options: { question: string; answer: string; status: string },
): ProbeSession {
  const session = readSession(projectRoot);
  if (session === null) {
    throw new ProbeHandoffBlockedError(
      "No active probe session. Start one with `uv run python scripts/probe_session.py start --target <scope>`.",
    );
  }
  if (session.state !== STATE_INTERROGATE) {
    throw new ProbeHandoffBlockedError(
      "Probe session is already complete; decisions cannot be appended.",
      session,
    );
  }
  if (!VALID_DECISION_STATUSES.has(options.status)) {
    throw new Error(
      `status must be one of ${[...VALID_DECISION_STATUSES].sort().join(", ")}, got ${JSON.stringify(options.status)}`,
    );
  }
  const q = options.question.trim();
  const a = options.answer.trim();
  if (!q || !a) {
    throw new Error("question and answer must be non-empty strings");
  }
  const updated: ProbeSession = {
    ...session,
    resolved_decisions: [
      ...session.resolved_decisions,
      { question: q, answer: a, status: options.status },
    ],
  };
  writeSession(projectRoot, updated);
  return updated;
}

export function setCurrentBranch(projectRoot: string, branch: string): ProbeSession {
  const session = readSession(projectRoot);
  if (session === null) {
    throw new ProbeHandoffBlockedError(
      "No active probe session. Start one with `uv run python scripts/probe_session.py start --target <scope>`.",
    );
  }
  if (session.state !== STATE_INTERROGATE) {
    throw new ProbeHandoffBlockedError(
      "Probe session is already complete; current branch cannot change.",
      session,
    );
  }
  const updated: ProbeSession = { ...session, current_branch: branch.trim() };
  writeSession(projectRoot, updated);
  return updated;
}

export function markComplete(projectRoot: string, now?: Date): ProbeSession {
  const session = readSession(projectRoot);
  if (session === null) {
    throw new ProbeHandoffBlockedError(
      "No active probe session. Start one with `uv run python scripts/probe_session.py start --target <scope>`.",
    );
  }
  if (session.state === STATE_COMPLETE) {
    return session;
  }
  const instant = now ?? new Date();
  const updated: ProbeSession = {
    ...session,
    state: STATE_COMPLETE,
    completed_at: instant,
  };
  writeSession(projectRoot, updated);
  return updated;
}

function pythonRepr(value: string): string {
  return `'${value}'`;
}

function blockedMessage(session: ProbeSession | null, action: string): string {
  if (session === null) {
    return (
      `Probe handoff blocked for ${action}: no active probe session. ` +
      "Start interrogation with `uv run python scripts/probe_session.py start --target <scope>` " +
      "and finish with `... complete` only after transition criteria are met."
    );
  }
  return (
    `Probe handoff blocked for ${action}: session state is ` +
    `'${session.state}' (target=${pythonRepr(session.target)}, ` +
    `currentBranch=${pythonRepr(session.current_branch)}, ` +
    `resolvedDecisions=${session.resolved_decisions.length}). ` +
    "Continue interrogation until transition criteria are met, record decisions " +
    "with `uv run python scripts/probe_session.py record ...`, then run " +
    "`uv run python scripts/probe_session.py complete` before writing artifacts " +
    "or updating completedStrategies.probe in plan.vbrief.json."
  );
}

export function requireHandoffAllowed(projectRoot: string, action: string): ProbeSession {
  const session = readSession(projectRoot);
  if (session === null || session.state !== STATE_COMPLETE) {
    throw new ProbeHandoffBlockedError(blockedMessage(session, action), session);
  }
  return session;
}

export function guardProbeArtifact(projectRoot: string, artifactPath: string): ProbeSession {
  return requireHandoffAllowed(projectRoot, `probe artifact write (${artifactPath})`);
}

export function guardPlanProbeRegistration(projectRoot: string): ProbeSession {
  return requireHandoffAllowed(
    projectRoot,
    "completedStrategies.probe registration in plan.vbrief.json",
  );
}

export function sessionSummary(session: ProbeSession): Record<string, unknown> {
  return {
    state: session.state,
    target: session.target,
    currentBranch: session.current_branch,
    resolvedDecisions: session.resolved_decisions.map(resolvedDecisionToDict),
    startedAt: formatTimestamp(session.started_at),
    completedAt: session.completed_at !== null ? formatTimestamp(session.completed_at) : null,
  };
}

export interface ProbeSessionArgs {
  command?: string;
  projectRoot: string;
  target?: string;
  branch?: string;
  question?: string;
  answer?: string;
  status?: string;
  path?: string;
  json?: boolean;
  error?: string;
}

/** Parse probe-session CLI args (simplified subcommand parser). */
export function parseProbeSessionArgs(argv: string[]): ProbeSessionArgs {
  const parsed: ProbeSessionArgs = { projectRoot: "." };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      parsed.projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--json") {
      parsed.json = true;
    } else {
      rest.push(arg ?? "");
    }
  }
  if (rest.length === 0) {
    return { ...parsed, error: "command required" };
  }
  parsed.command = rest[0];
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--target") {
      parsed.target = rest[i + 1];
      i += 1;
    } else if (arg?.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg === "--branch") {
      parsed.branch = rest[i + 1];
      i += 1;
    } else if (arg?.startsWith("--branch=")) {
      parsed.branch = arg.slice("--branch=".length);
    } else if (arg === "--question") {
      parsed.question = rest[i + 1];
      i += 1;
    } else if (arg === "--answer") {
      parsed.answer = rest[i + 1];
      i += 1;
    } else if (arg === "--status") {
      parsed.status = rest[i + 1];
      i += 1;
    } else if (arg === "--path") {
      parsed.path = rest[i + 1];
      i += 1;
    }
  }
  return parsed;
}

/** Run probe-session CLI; returns exit code. */
export function cmdProbeSession(argv: string[]): number {
  const args = parseProbeSessionArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);

  try {
    if (args.command === "start") {
      if (!args.target) {
        process.stderr.write("target must be a non-empty scope name\n");
        return 2;
      }
      const session = startSession(projectRoot, {
        target: args.target,
        currentBranch: args.branch ?? "",
      });
      process.stdout.write(
        `Probe session started: state=${session.state}, target=${JSON.stringify(session.target)}, currentBranch=${JSON.stringify(session.current_branch)}\n`,
      );
      return 0;
    }
    if (args.command === "record") {
      const session = recordDecision(projectRoot, {
        question: args.question ?? "",
        answer: args.answer ?? "",
        status: args.status ?? "",
      });
      process.stdout.write(
        `Recorded decision (${session.resolved_decisions.length} total); state=${session.state}\n`,
      );
      return 0;
    }
    if (args.command === "set-branch") {
      const session = setCurrentBranch(projectRoot, args.branch ?? "");
      process.stdout.write(
        `Current branch set to ${JSON.stringify(session.current_branch)}; state=${session.state}\n`,
      );
      return 0;
    }
    if (args.command === "complete") {
      const session = markComplete(projectRoot);
      process.stdout.write(
        `Probe session marked complete for target=${JSON.stringify(session.target)}\n`,
      );
      return 0;
    }
    if (args.command === "status") {
      const session = readSession(projectRoot);
      if (session === null) {
        process.stdout.write("No active probe session.\n");
        return 0;
      }
      if (args.json) {
        const sorted = sessionSummary(session);
        process.stdout.write(`${JSON.stringify(sorted, Object.keys(sorted).sort(), 2)}\n`);
      } else {
        const summary = sessionSummary(session);
        process.stdout.write(`state: ${String(summary.state)}\n`);
        process.stdout.write(`target: ${String(summary.target)}\n`);
        process.stdout.write(`currentBranch: ${String(summary.currentBranch)}\n`);
        process.stdout.write(
          `resolvedDecisions: ${Array.isArray(summary.resolvedDecisions) ? summary.resolvedDecisions.length : 0}\n`,
        );
      }
      return 0;
    }
    if (args.command === "guard-artifact") {
      guardProbeArtifact(projectRoot, args.path ?? "");
      process.stdout.write(`Probe artifact handoff allowed: ${args.path}\n`);
      return 0;
    }
    if (args.command === "guard-plan-registration") {
      guardPlanProbeRegistration(projectRoot);
      process.stdout.write("completedStrategies.probe registration allowed\n");
      return 0;
    }
  } catch (err: unknown) {
    if (err instanceof ProbeHandoffBlockedError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof Error) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(String(err));
    return 2;
  }

  process.stderr.write(`Unknown command: ${args.command}\n`);
  return 2;
}
