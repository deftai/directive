/**
 * Fail-open run-summary JSONL emitter (#3282).
 *
 * Emission never changes exit codes, never throws to callers, and prints at
 * most one warning when an *explicit* DEFT_RUN_SUMMARY_PATH write fails.
 * Symlink destinations are refused (no-follow / containment) — fail-open.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
} from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { type ResolveRunSummaryDestinationOptions, resolveRunSummaryDestination } from "./path.js";
import {
  type AcceptanceRunSummaryPayload,
  type AcceptanceStampRunSummaryPayload,
  type CheckInvocationRunSummaryPayload,
  type DialEscalationEvaluationRunSummaryPayload,
  type DialTransitionRunSummaryPayload,
  ENV_TOTAL_TOOL_TURNS,
  RUN_SUMMARY_SCHEMA_VERSION,
  RUN_SUMMARY_STDOUT_PREFIX,
  RUN_SUMMARY_WRITE_WARNING,
  type RunSummaryDestination,
  type RunSummaryEventKind,
  type RunSummaryLine,
  type RunSummaryPayload,
  type SessionStartRunSummaryPayload,
  type ToolTurnDenominatorRunSummaryPayload,
  type VerificationRunSummaryPayload,
} from "./types.js";

export interface RunSummaryEmitterOptions extends ResolveRunSummaryDestinationOptions {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly frameworkVersion?: string;
  /** Clock seam for tests. */
  readonly now?: () => Date;
  /** Destination override (tests). */
  readonly destination?: RunSummaryDestination;
  /** stdout/stderr seams (tests). */
  readonly writeStdout?: (line: string) => void;
  readonly writeStderr?: (line: string) => void;
}

export interface EmitRunSummaryResult {
  readonly emitted: boolean;
  readonly destination: RunSummaryDestination;
  readonly line: RunSummaryLine | null;
  readonly warning: boolean;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function lineToJson(line: RunSummaryLine): string {
  return JSON.stringify(sortKeysDeep(line));
}

function isNestedUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Post-write realpath check: refuse parent-component TOCTOU where a parent was
 * replaced with a symlink between validation and open (#3282 Greptile residual).
 */
function assertRealpathStillContained(root: string, targetAbs: string): void {
  const realRoot = realpathSync(resolve(root));
  const realTarget = realpathSync(targetAbs);
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realTarget !== realRoot && !realTarget.startsWith(prefix)) {
    throw new Error(
      `run-summary write refused: realpath escaped containment (${realTarget} not under ${realRoot})`,
    );
  }
  // Re-assert path components are not symlinks after the write.
  assertWriteTargetSafe(realRoot, realTarget);
}

/**
 * Append (or replace) a run-summary line with symlink refusal + containment.
 * Mirrors lifecycle/events.ts appendEventLogLine (#2766 / #2951 / #3282 Greptile P1).
 * Post-write realpath re-check closes parent-replacement TOCTOU window.
 */
function writeRunSummaryLine(
  projectRoot: string,
  targetPath: string,
  textLine: string,
  mode: "append" | "replace",
): void {
  const targetAbs = resolve(targetPath);
  const data = `${textLine}\n`;
  if (isNestedUnder(projectRoot, targetAbs)) {
    const rootAbs = resolve(projectRoot);
    assertWriteTargetSafe(rootAbs, targetAbs);
    containedWrite({
      root: rootAbs,
      target: targetAbs,
      data,
      mode,
    });
    assertRealpathStillContained(rootAbs, targetAbs);
    return;
  }
  // Explicit path outside project: contain under the log parent (no symlink follow).
  const parent = dirname(targetAbs);
  mkdirSync(parent, { recursive: true });
  const parentAbs = resolve(parent);
  assertWriteTargetSafe(parentAbs, targetAbs);
  containedWrite({
    root: parentAbs,
    target: basename(targetAbs),
    data,
    mode,
  });
  assertRealpathStillContained(parentAbs, targetAbs);
}

/**
 * Count non-empty lines in an existing append-only JSONL. Missing/unreadable
 * files seed at 0 (fail-open). Used so a fresh CLI process continues seq
 * from the destination file instead of resetting to 1 (#3350).
 */
function countExistingJsonlLines(path: string): number {
  try {
    if (!existsSync(path)) {
      return 0;
    }
    const text = readFileSync(path, "utf8");
    if (text.length === 0) {
      return 0;
    }
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length > 0) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function seedSeqFromDestination(destination: RunSummaryDestination): number {
  if (destination.kind !== "file") {
    return 0;
  }
  return countExistingJsonlLines(destination.path);
}

const SEQ_LOCK_WAIT_MS = 2_000;
const SEQ_LOCK_SPIN_MS = 15;

/** Owner token stored in `.seq.lock` so reclaim is not age-based (#3361). */
export interface SeqLockOwner {
  readonly pid: number;
  readonly nonce: string;
}

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === code);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we cannot signal it — treat as live.
    return isErrno(err, "EPERM");
  }
}

function parseSeqLockOwner(raw: string): SeqLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    const nonce = (parsed as { nonce?: unknown }).nonce;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    if (typeof nonce !== "string" || nonce.length === 0) {
      return null;
    }
    return { pid, nonce };
  } catch {
    return null;
  }
}

function newSeqLockOwner(): SeqLockOwner {
  return { pid: process.pid, nonce: randomBytes(8).toString("hex") };
}

function serializeSeqLockOwner(owner: SeqLockOwner): string {
  return `${JSON.stringify({ pid: owner.pid, nonce: owner.nonce })}\n`;
}

/**
 * Reclaim `.seq.lock` only when the owner process is dead or the token is
 * missing/unreadable/corrupt (unknown owner). Live holders are never stolen
 * by mtime (#3361).
 */
export function tryReclaimSeqLock(lockPath: string): boolean {
  try {
    const owner = parseSeqLockOwner(readFileSync(lockPath, "utf8"));
    if (owner !== null && isPidAlive(owner.pid)) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlink `.seq.lock` only when the on-disk token still matches this holder
 * (ownership-blind release must not delete a successor's lock).
 */
export function releaseSeqLockIfOwner(lockPath: string, owner: SeqLockOwner): boolean {
  try {
    const current = parseSeqLockOwner(readFileSync(lockPath, "utf8"));
    if (current === null || current.pid !== owner.pid || current.nonce !== owner.nonce) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-process exclusive lock so count-then-append is one critical section
 * (#3350 / #3361). Fail-open: if the lock cannot be acquired within the wait
 * window, emit still proceeds with a best-effort recount. Reclaim is allowed
 * only when the owner process is dead or the token is unknown — never by
 * mtime of a live holder.
 */
function acquireSeqLock(targetPath: string): () => void {
  const noop = () => {
    /* fail-open: no lock held */
  };
  try {
    const targetAbs = resolve(targetPath);
    const parent = dirname(targetAbs);
    mkdirSync(parent, { recursive: true });
    const lockPath = `${targetAbs}.seq.lock`;
    const deadline = Date.now() + SEQ_LOCK_WAIT_MS;
    while (true) {
      const owner = newSeqLockOwner();
      try {
        containedWrite({
          root: parent,
          target: lockPath,
          data: serializeSeqLockOwner(owner),
          mode: "create",
        });
        return () => {
          releaseSeqLockIfOwner(lockPath, owner);
        };
      } catch (err) {
        if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
          if (tryReclaimSeqLock(lockPath)) {
            continue;
          }
          if (Date.now() < deadline) {
            const spinEnd = Date.now() + SEQ_LOCK_SPIN_MS;
            while (Date.now() < spinEnd) {
              /* brief spin */
            }
            continue;
          }
        }
        return noop;
      }
    }
  } catch {
    return noop;
  }
}

/**
 * Stateful emitter: one instance tracks seq and write-warning once.
 * File destinations seed seq from the current JSONL line count so multiple
 * CLI processes appending to one DEFT_RUN_SUMMARY_PATH share 1..N (#3350).
 * Stdout destinations stay per-process (each constructor starts at 0).
 */
export class RunSummaryEmitter {
  private seq = 0;
  private warned = false;
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly frameworkVersion: string;
  private readonly now: () => Date;
  private readonly destination: RunSummaryDestination;
  private readonly env: NodeJS.ProcessEnv;
  private readonly writeStdout: (line: string) => void;
  private readonly writeStderr: (line: string) => void;

  constructor(options: RunSummaryEmitterOptions) {
    this.projectRoot = options.projectRoot;
    this.sessionId = options.sessionId;
    this.frameworkVersion = options.frameworkVersion ?? readCorePackageVersion();
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.destination =
      options.destination ??
      resolveRunSummaryDestination(options.projectRoot, {
        env: this.env,
        gitignoreCovers: options.gitignoreCovers,
      });
    this.seq = seedSeqFromDestination(this.destination);
    this.writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
    this.writeStderr = options.writeStderr ?? ((line) => process.stderr.write(`${line}\n`));
  }

  getDestination(): RunSummaryDestination {
    return this.destination;
  }

  private buildLine(event: RunSummaryEventKind, payload: RunSummaryPayload): RunSummaryLine {
    const denominator =
      readPayloadToolTurnDenominator(payload) ?? readEnvToolTurnDenominator(this.env);
    return {
      schema_version: RUN_SUMMARY_SCHEMA_VERSION,
      session_id: this.sessionId,
      framework_version: this.frameworkVersion,
      seq: this.seq,
      ts: this.now().toISOString(),
      event,
      payload,
      ...(denominator !== undefined ? { total_tool_turns: denominator } : {}),
    };
  }

  emit(event: RunSummaryEventKind, payload: RunSummaryPayload): EmitRunSummaryResult {
    try {
      if (this.destination.kind === "silent") {
        return { emitted: false, destination: this.destination, line: null, warning: false };
      }

      if (this.destination.kind === "stdout") {
        this.seq += 1;
        const line = this.buildLine(event, payload);
        this.writeStdout(`${RUN_SUMMARY_STDOUT_PREFIX}${lineToJson(line)}`);
        return { emitted: true, destination: this.destination, line, warning: false };
      }

      // file destination — lock count-then-append so concurrent CLI processes
      // cannot share the same next seq (#3350 Greptile P1).
      const { path, truncateOnSessionStart, explicit } = this.destination;
      const release = acquireSeqLock(path);
      try {
        const replace = event === "session_start" && truncateOnSessionStart;
        this.seq = replace ? 1 : countExistingJsonlLines(path) + 1;
        const line = this.buildLine(event, payload);
        writeRunSummaryLine(
          this.projectRoot,
          path,
          lineToJson(line),
          replace ? "replace" : "append",
        );
        return { emitted: true, destination: this.destination, line, warning: false };
      } catch {
        // Symlink / containment refusal and I/O both fail-open.
        const line = this.buildLine(event, payload);
        if (explicit && !this.warned) {
          this.warned = true;
          this.writeStderr(RUN_SUMMARY_WRITE_WARNING);
          return { emitted: false, destination: this.destination, line, warning: true };
        }
        return { emitted: false, destination: this.destination, line, warning: false };
      } finally {
        release();
      }
    } catch {
      return { emitted: false, destination: this.destination, line: null, warning: false };
    }
  }

  emitSessionStart(payload: SessionStartRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("session_start", payload);
  }

  emitDialTransition(payload: DialTransitionRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("dial_transition", payload);
  }

  emitDialEscalationEvaluation(
    payload: DialEscalationEvaluationRunSummaryPayload,
  ): EmitRunSummaryResult {
    return this.emit("dial_escalation_evaluation", payload);
  }

  emitCheckInvocation(payload: CheckInvocationRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("check_invocation", payload);
  }

  emitToolTurnDenominator(payload: ToolTurnDenominatorRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("tool_turn_denominator", payload);
  }

  emitVerification(payload: VerificationRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("verification", payload);
  }

  emitAcceptance(payload: AcceptanceRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("acceptance", payload);
  }

  emitAcceptanceStamp(payload: AcceptanceStampRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("acceptance_stamp", payload);
  }

  /** Emit the harness-supplied denominator when DEFT_TOTAL_TOOL_TURNS is set. */
  emitKnownToolTurnDenominator(): EmitRunSummaryResult {
    const n = readEnvToolTurnDenominator(this.env);
    if (n === undefined) {
      return { emitted: false, destination: this.destination, line: null, warning: false };
    }
    return this.emitToolTurnDenominator({ total_tool_turns: n });
  }

  /**
   * Always emit a session denominator when the destination is live (#3356).
   * `emitKnownToolTurnDenominator` stays silent unless DEFT_TOTAL_TOOL_TURNS is
   * set; this caller records host planned turns or the session:start CLI floor.
   */
  emitSessionToolTurnDenominator(hostMaxTurns?: number | null): EmitRunSummaryResult {
    return this.emitToolTurnDenominator({
      total_tool_turns: resolveSessionToolTurnDenominator(this.env, hostMaxTurns),
    });
  }
}

function readPayloadToolTurnDenominator(payload: RunSummaryPayload): number | undefined {
  if (!("total_tool_turns" in payload)) {
    return undefined;
  }
  const value = payload.total_tool_turns;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse harness-supplied DEFT_TOTAL_TOOL_TURNS (integer > 0). Invalid/unset → omit. */
export function readEnvToolTurnDenominator(env: NodeJS.ProcessEnv): number | undefined {
  return readPositiveIntegerEnv(env, ENV_TOTAL_TOOL_TURNS);
}

/** Canonical host planned-turn budget recorded at session:start (#3356). */
export const ENV_MAX_TURNS_DENOMINATOR = "DEFT_MAX_TURNS";

/** session:start is one CLI invocation when no host/harness count is known (#3356). */
export const SESSION_START_CLI_INVOCATION_DENOMINATOR = 1 as const;

function isPositiveIntegerDenominator(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
  );
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const n = Number(raw.trim());
  return isPositiveIntegerDenominator(n) ? n : undefined;
}

/**
 * Resolve the session tool/turn denominator (#3356).
 *
 * Prefer harness actuals (`DEFT_TOTAL_TOOL_TURNS`), then a host planned-turn
 * budget (`DEFT_MAX_TURNS` or `hostMaxTurns` from the session:start descriptor),
 * else this CLI invocation (1). An emitted proxy beats a perfect unused kind.
 */
export function resolveSessionToolTurnDenominator(
  env: NodeJS.ProcessEnv,
  hostMaxTurns?: number | null,
): number {
  const known = readEnvToolTurnDenominator(env);
  if (known !== undefined) {
    return known;
  }
  const planned = readPositiveIntegerEnv(env, ENV_MAX_TURNS_DENOMINATOR);
  if (planned !== undefined) {
    return planned;
  }
  if (isPositiveIntegerDenominator(hostMaxTurns)) {
    return hostMaxTurns;
  }
  return SESSION_START_CLI_INVOCATION_DENOMINATOR;
}

/**
 * One-shot helper for call sites that do not hold an emitter (e.g. dial escalate).
 * Still fail-open. File destinations seed seq from the existing JSONL line
 * count so successive one-shot calls into the same path continue 1..N (#3350).
 * Stdout destinations stay per-process (each call starts at seq=1).
 */
export function emitRunSummaryEvent(
  options: RunSummaryEmitterOptions & {
    readonly event: RunSummaryEventKind;
    readonly payload: RunSummaryPayload;
  },
): EmitRunSummaryResult {
  const emitter = new RunSummaryEmitter(options);
  return emitter.emit(options.event, options.payload);
}
