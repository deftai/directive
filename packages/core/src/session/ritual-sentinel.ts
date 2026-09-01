import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
} from "../layout/resolve.js";
import { assertAppendLockOwned, type LockDeps, withAppendLock } from "../slice/lock.js";
import { stableJson } from "./json.js";
import { RITUAL_STATE_CONTRACT } from "./posture.js";
import { parseTimestamp, timestampIso } from "./time.js";

export const SCHEMA_VERSION = 1;
export const RITUAL_STATE_SCHEMA_VERSION = 1;
export { RITUAL_STATE_CONTRACT } from "./posture.js";
export const SENTINEL_RELPATH = [".deft", "last-session.json"] as const;
export const RITUAL_STATE_RELPATH = [".deft", "ritual-state.json"] as const;
/**
 * Ritual lock wait must finish inside the nested-hook budget (#3872).
 * Occupancy restamp still needs the remaining seconds, so this is 2s of the 5s host cap.
 */
export const RITUAL_LOCK_BUDGET_MS = 2_000;

export const MIN_RESUME_AGE_MS = 2 * 60 * 60 * 1000;
export const ACTIVE_VBRIEF_PREFIX = `${MIGRATED_ARTIFACT_DIR}/active/`;

export interface Sentinel {
  readonly schemaVersion: number;
  readonly deftVersion: string;
  readonly timestamp: Date;
  readonly lastActiveVbrief: string;
  readonly lastBranch: string;
}

/** Parsed `.deft/ritual-state.json` — diagnostic gate outcomes only (#2180). */
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
  /** Wall-clock ms for this step when measured (#2991). */
  readonly durationMs?: number | null;
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
  if (input.durationMs !== null && input.durationMs !== undefined) {
    payload.duration_ms = Math.max(0, Math.round(input.durationMs));
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
    contract: RITUAL_STATE_CONTRACT,
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

/**
 * Contained atomic JSON write for ritual/sentinel state (#3042).
 * Containment root is projectRoot (not dirname(target)) so a force-added `.deft`
 * directory symlink fails closed before temp+rename.
 */
function atomicWriteJson(
  projectRoot: string,
  targetPath: string,
  payload: Record<string, unknown>,
  prefix: string,
): void {
  const root = resolve(projectRoot);
  const abs = resolve(targetPath);
  // Refuse leaf/parent symlinks on the final path before temp+rename publish.
  assertWriteTargetSafe(root, abs);
  const dir = dirname(abs);
  const tmpBase = `${prefix}${process.pid}.${basename(abs)}.tmp`;
  const tmpName = join(dir, tmpBase);
  const text = `${stableJson(payload, 2)}\n`;
  try {
    // #2980 wave D / #3042: product write routes through containedWrite under projectRoot.
    containedWrite({
      root,
      target: tmpName,
      data: text,
      mode: "create",
    });
    renameSync(tmpName, abs);
  } catch (err) {
    try {
      rmSync(tmpName, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
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

function asStepMap(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, step] of Object.entries(value as Record<string, unknown>)) {
    if (typeof step === "object" && step !== null && !Array.isArray(step)) {
      out[name] = step as Record<string, Record<string, unknown>>[string];
    }
  }
  return out;
}

const DRIFT_PROBE_SKIP = "skipped-no-work-selection";

/**
 * Co-member persist (#3872): step maps union. Incoming omission deletes
 * `drift_probe`. A stale snapshot that still carries the skip token cannot
 * restore it after a later verifier already published a live cache-fresh.
 */
export function mergeSameOwnerRitualPayload(
  disk: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...disk,
    ...incoming,
    quick_steps: { ...asStepMap(disk.quick_steps), ...asStepMap(incoming.quick_steps) },
    gated_steps: { ...asStepMap(disk.gated_steps), ...asStepMap(incoming.gated_steps) },
  };
  if (!Object.hasOwn(incoming, "drift_probe")) {
    delete merged.drift_probe;
  } else if (incoming.drift_probe === DRIFT_PROBE_SKIP && !Object.hasOwn(disk, "drift_probe")) {
    const cache = asStepMap(disk.gated_steps).cache_fresh;
    if (cache?.ok === true && cache.deferred_reason === undefined) {
      delete merged.drift_probe;
    }
  }
  return merged;
}

/**
 * Occupancy sidecar lock + fence, keyed on ritual-state.json (#3872).
 * Must not run inside withOccupancyLock: withAppendLock is process-global non-reentrant.
 */
export function withRitualStateLock<T>(
  projectRoot: string,
  fn: (fence: () => void) => T,
  deps: LockDeps = {},
): T {
  const root = resolve(projectRoot);
  const stateFile = ritualStatePath(root);
  return withAppendLock(
    stateFile,
    (held) => {
      const fence = (): void => {
        assertAppendLockOwned(held);
      };
      return fn(fence);
    },
    {
      acquisitionBudgetMs: RITUAL_LOCK_BUDGET_MS,
      containmentRoot: root,
      ...deps,
    },
  );
}

function publishRitualState(
  projectRoot: string,
  payload: Record<string, unknown>,
  fence: () => void,
): string {
  const stateFile = ritualStatePath(projectRoot);
  fence();
  atomicWriteJson(projectRoot, stateFile, payload, ".ritual-state.");
  return stateFile;
}

/** Claiming write (session:start / re-arm). Serialised; no owner compare. */
export function writeRitualState(projectRoot: string, payload: Record<string, unknown>): string {
  return withRitualStateLock(projectRoot, (fence) =>
    publishRitualState(projectRoot, payload, fence),
  );
}

/**
 * Persist a payload only while the on-disk owner still matches `expected` (#3769 / #3872).
 * Same-owner writes merge gated_steps/quick_steps rather than republishing a stale snapshot.
 * Returns null on success, or the reason the write was refused.
 */
export function writeRitualStateIfStillOwned(
  projectRoot: string,
  payload: Record<string, unknown>,
  expected: { sessionId?: string; startedAt: Date },
  deps: LockDeps = {},
): string | null {
  try {
    return withRitualStateLock(
      projectRoot,
      (fence) => {
        const [current] = readRitualState(projectRoot);
        if (current === null) {
          return "session ritual state was removed while this verification was running";
        }
        if (
          current.sessionId !== expected.sessionId ||
          current.startedAt.getTime() !== expected.startedAt.getTime()
        ) {
          return (
            `session ritual state was re-armed by ${current.sessionId ?? "<unbound>"} while this ` +
            "verification was running; refusing to overwrite the current owner record"
          );
        }
        const merged = mergeSameOwnerRitualPayload(current.raw, payload);
        try {
          publishRitualState(projectRoot, merged, fence);
        } catch (exc) {
          return String(exc);
        }
        return null;
      },
      deps,
    );
  } catch (exc) {
    return String(exc);
  }
}

/** Instant guaranteed to fail `evaluateLoadedState` age checks on any policy horizon. */
export const RITUAL_STALE_EPOCH = new Date("1970-01-01T00:00:00Z");

export interface MarkRitualStaleAfterCompactResult {
  readonly changed: boolean;
  readonly statePath: string;
  readonly message: string;
}

/**
 * Invalidate an existing mutation ritual after host context compaction/resume (#2113).
 * Reuses ritual-state age semantics — no parallel policy stack.
 * Marks rearm_needed so recovery messaging prefers session:start --rearm when cold is unnecessary (#2992).
 *
 * Fail-open on an unbindable actor (#3769, operator amend 2026-08-28): compact
 * carries no acting identity and runs inside a hook budget, so a skipped write
 * has no surface a human reliably sees. The accepted cost is that an
 * unidentified compact re-arms whoever owns the record.
 */
export function markRitualStaleAfterCompact(
  projectRoot: string,
  input: { now?: Date } = {},
): MarkRitualStaleAfterCompactResult {
  const now = input.now ?? new Date();
  const statePath = ritualStatePath(projectRoot);
  return withRitualStateLock(projectRoot, (fence) => {
    const [state, err] = readRitualState(projectRoot);
    if (state === null) {
      return {
        changed: false,
        statePath,
        message: err ?? "no ritual state to invalidate after compaction",
      };
    }
    const payload = { ...state.raw };
    payload.started_at = timestampIso(RITUAL_STALE_EPOCH);
    payload.compact_resume_at = timestampIso(now);
    // #2992: compact invalidates the ritual clock only — prefer re-arm recovery when worktree/HEAD allow.
    payload.rearm_needed = true;
    // Compact is the recorded fail-open exception: no owner compare (#3769 item 2).
    // Still serialised so it cannot interleave with a compare+publish (#3872).
    publishRitualState(projectRoot, payload, fence);
    return {
      changed: true,
      statePath,
      message:
        "Marked session ritual re-arm needed after context compaction; run " +
        "session:start --rearm (or full session:start if worktree/HEAD changed) and " +
        "verify:session-ritual -- --tier=gated before direct writes.",
    };
  });
}

/** Whether ritual-state.json marks compact/age recovery as re-arm preferred (#2992). */
export function ritualStateMarksRearmNeeded(state: RitualState): boolean {
  return state.raw.rearm_needed === true || typeof state.raw.compact_resume_at === "string";
}

export function recordRitualStep(
  projectRoot: string,
  input: { tier: "quick" | "gated"; stepName: string; step: Record<string, unknown> },
): string {
  return withRitualStateLock(projectRoot, (fence) => {
    const [state, err] = readRitualState(projectRoot);
    if (state === null) {
      throw new Error(err ?? "ritual state missing");
    }
    if (input.tier !== "quick" && input.tier !== "gated") {
      throw new Error(`tier must be 'quick' or 'gated', got ${JSON.stringify(input.tier)}`);
    }
    const owner = { sessionId: state.sessionId, startedAt: state.startedAt };
    const [fresh] = readRitualState(projectRoot);
    if (
      fresh === null ||
      fresh.sessionId !== owner.sessionId ||
      fresh.startedAt.getTime() !== owner.startedAt.getTime()
    ) {
      throw new Error("session ritual state owner changed while recording a step");
    }
    const payload = { ...fresh.raw };
    const key = input.tier === "quick" ? "quick_steps" : "gated_steps";
    const steps = { ...asStepMap(payload[key]) };
    steps[input.stepName] = input.step;
    payload[key] = steps;
    return publishRitualState(projectRoot, payload, fence);
  });
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
    lastActiveVbrief: input.lastActiveVbrief
      .replace(/\\/g, "/")
      .replace(`${LEGACY_ARTIFACT_DIR}/active/`, `${MIGRATED_ARTIFACT_DIR}/active/`),
    lastBranch: input.lastBranch,
  };
  atomicWriteJson(projectRoot, sentinelFile, payload, ".last-session.");
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
  const activeDir = join(resolve(projectRoot), MIGRATED_ARTIFACT_DIR, "active");
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
    if (!hasArtifactSuffix(name)) {
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
