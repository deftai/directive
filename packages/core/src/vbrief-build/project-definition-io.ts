import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { containedWrite } from "../fs/contained-write.js";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { pythonJsonPretty } from "./json.js";
import type { JsonObject } from "./types.js";
import { ProjectDefinitionIOError } from "./types.js";

const mutationThreadLock = { held: false };

/** Setup override for a noncanonical PROJECT-DEFINITION path. */
export const ENV_PROJECT_PATH = "DEFT_PROJECT_PATH";

/**
 * Constant display label for a PROJECT-DEFINITION reached through the
 * `DEFT_PROJECT_PATH` override (#3796). A configured path is operator- or
 * environment-supplied data, so lock and loader diagnostics name this label
 * instead of interpolating the raw path. Matches the label already used by
 * `verify:vbrief-conformance` so one artifact reads the same way on every
 * diagnostic surface.
 */
export const CONFIGURED_PROJECT_DEFINITION_LABEL = "<configured PROJECT-DEFINITION>";

/**
 * Absolute path to the PROJECT-DEFINITION artifact. Layout-aware (#2302):
 * resolves `xbrief/PROJECT-DEFINITION.xbrief.json` on a migrated tree, else the
 * legacy `vbrief/PROJECT-DEFINITION.vbrief.json`, so loader not-found messages
 * name the path that actually applies to the project's layout.
 */
export function projectDefinitionPath(projectRoot: string): string {
  const override = process.env[ENV_PROJECT_PATH]?.trim();
  if (override) {
    const configuredPath = resolve(projectRoot, override);
    return existsSync(configuredPath) ? realpathSync(configuredPath) : configuredPath;
  }
  return resolveProjectDefinitionPath(resolve(projectRoot));
}

/**
 * Control-safe label for an artifact path in a human diagnostic (#3796).
 * A configured artifact collapses to {@link CONFIGURED_PROJECT_DEFINITION_LABEL};
 * a layout-resolved canonical artifact keeps its path because the layout
 * resolver derived it rather than reading it from configuration.
 */
export function projectDefinitionArtifactLabel(artifactPath: string): string {
  return process.env[ENV_PROJECT_PATH]?.trim() ? CONFIGURED_PROJECT_DEFINITION_LABEL : artifactPath;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function defaultSleep(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/** Result of probing whether a recorded lock owner PID is still running. */
export type ProcessLiveness = "dead" | "alive" | "unknown";

/**
 * Why an acquisition attempt could not take the lock. Only `contended` is
 * ordinary traffic; the rest fail closed to manual recovery (#3796).
 */
export type LockBlockedReason =
  | "contended"
  | "owner-alive"
  | "owner-liveness-unknown"
  | "malformed-lock-directory"
  | "legacy-file-sidecar";

const DEFAULT_ACQUISITION_BUDGET_MS = 30_000;
const LOCK_OWNER_ENTRY_RE = /^([1-9]\d*)-([a-f0-9]{32})$/;
const RENAME_CONTENTION_CODES = new Set([
  "EACCES",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
]);

export interface MutationLockDeps {
  readonly sleepMs?: (ms: number) => void;
  /**
   * Monotonic millisecond clock. One budget is derived from a single reading of
   * this clock and shared by every retry and recovery branch (#3796), so a
   * wall-clock step or a recovery detour cannot extend the acquisition window.
   */
  readonly monotonicNowMs?: () => number;
  /** Total acquisition budget in milliseconds. */
  readonly acquisitionBudgetMs?: number;
  /**
   * Three-state liveness oracle. Only `dead` authorises an automatic reap;
   * `alive` (including possible PID reuse) and `unknown` fail closed.
   */
  readonly probeProcess?: (pid: number) => ProcessLiveness;
  readonly writeOwner?: (fd: number, payload: string) => number;
  readonly renameLock?: (source: string, destination: string) => void;
  /** Test seam: fires after the stale owner entry is unlinked, before `rmdir`. */
  readonly beforeLockDirRemove?: (lockPath: string) => void;
}

/** Acquisition failed within the shared budget. `reason` names the blocker. */
export class ProjectDefinitionLockError extends Error {
  readonly reason: LockBlockedReason;

  constructor(message: string, reason: LockBlockedReason) {
    super(message);
    this.name = "ProjectDefinitionLockError";
    this.reason = reason;
  }
}

function defaultProbeProcess(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM proves a process holds the PID but not that we may signal it. That
    // is indistinguishable from a live owner, so it is never a reap licence.
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

interface AcquisitionBudget {
  readonly expired: () => boolean;
  readonly totalMs: number;
}

function createAcquisitionBudget(monotonicNowMs: () => number, totalMs: number): AcquisitionBudget {
  const startedAt = monotonicNowMs();
  return {
    expired: () => monotonicNowMs() - startedAt >= totalMs,
    totalMs,
  };
}

interface DirectoryLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly entryName: string;
}

function lstatIfExists(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

function parseDirectoryLockOwnerEntry(entryName: string): DirectoryLockOwner | null {
  const match = LOCK_OWNER_ENTRY_RE.exec(entryName);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || match[2] === undefined) return null;
  return { pid, token: match[2], entryName };
}

/**
 * Read the single owner entry of a well-formed lock directory. Any other shape
 * (empty, multiple entries, unparseable name) is deliberately `null` -- the
 * caller must then fail closed rather than guess which entry owns the lock.
 */
function readDirectoryLockOwner(lockPath: string): DirectoryLockOwner | null {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (entries.length !== 1) return null;
  return parseDirectoryLockOwnerEntry(entries[0] ?? "");
}

type ReapOutcome = { reaped: true } | { reaped: false; reason: LockBlockedReason };

/**
 * Reap a current-version directory lock whose owner is unambiguously dead.
 *
 * The unique owner entry is removed first: exactly one contender can win that
 * unlink, and only the winner may `rmdir`. Because every published lock
 * directory is non-empty at the instant it becomes visible, a delayed `rmdir`
 * from an older generation cannot remove a replacement -- it fails `ENOTEMPTY`.
 *
 * Reaping is automatic only for a `dead` liveness result. `alive` (which cannot
 * be distinguished from PID reuse) and `unknown` fail closed, as does any
 * malformed directory: age is not evidence of safety (#3796).
 */
function reapDirectoryLock(
  lockPath: string,
  probeProcess: (pid: number) => ProcessLiveness,
  beforeLockDirRemove: (lockPath: string) => void,
): ReapOutcome {
  const owner = readDirectoryLockOwner(lockPath);
  if (owner === null) {
    return { reaped: false, reason: "malformed-lock-directory" };
  }
  const liveness = probeProcess(owner.pid);
  if (liveness === "alive") return { reaped: false, reason: "owner-alive" };
  if (liveness === "unknown") return { reaped: false, reason: "owner-liveness-unknown" };

  try {
    unlinkSync(join(lockPath, owner.entryName));
  } catch (err: unknown) {
    // Another contender won the entry unlink; only that winner may rmdir.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { reaped: false, reason: "contended" };
    }
    throw err;
  }
  beforeLockDirRemove(lockPath);
  try {
    rmdirSync(lockPath);
    return { reaped: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { reaped: true };
    // A replacement generation was published into this pathname while the
    // rmdir was delayed. It is non-empty, so the rmdir cannot destroy it.
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return { reaped: false, reason: "contended" };
    }
    throw err;
  }
}

function describeLockFailure(
  artifactLabel: string,
  lockPath: string,
  reason: LockBlockedReason,
  budgetMs: number,
): string {
  // The sidecar name is derived from the artifact name, so naming it would leak
  // a configured filename back into a message that is supposed to be labelled.
  const sidecarName =
    artifactLabel === CONFIGURED_PROJECT_DEFINITION_LABEL ? ".lock" : basename(lockPath);
  const header =
    `timed out acquiring the PROJECT-DEFINITION mutation lock for ${artifactLabel} ` +
    `after ${budgetMs}ms (blocked by: ${reason}).`;
  if (reason === "legacy-file-sidecar") {
    return [
      header,
      "A legacy single-file lock sidecar holds the public lock pathname. It is",
      "never removed or moved automatically: releasing that pathname would let a",
      "new waiter enter while the legacy holder's descriptor and critical section",
      "are still live.",
      "Manual recovery:",
      "  1. Stop every legacy deft client that mutates this project.",
      "  2. Confirm no PROJECT-DEFINITION mutation is running.",
      `  3. Remove the '${sidecarName}' sidecar beside ${artifactLabel}.`,
    ].join("\n");
  }
  if (reason === "malformed-lock-directory" || reason === "owner-liveness-unknown") {
    return [
      header,
      "The lock state cannot be attributed to a known owner, so it is never",
      "recovered automatically -- elapsed time is not evidence that the owner is",
      "gone.",
      "Manual recovery:",
      "  1. Stop every deft client that mutates this project.",
      "  2. Confirm no PROJECT-DEFINITION mutation is running.",
      `  3. Remove the '${sidecarName}' lock directory beside ${artifactLabel}.`,
    ].join("\n");
  }
  return [
    header,
    "Another PROJECT-DEFINITION mutation still holds the lock. Retry once it",
    "completes; if the owner has gone without releasing, stop all deft clients",
    `and remove the '${sidecarName}' lock directory beside ${artifactLabel}.`,
  ].join("\n");
}

/**
 * Serialise PROJECT-DEFINITION read-modify-write critical sections.
 *
 * Acquisition publishes a fully-materialised, non-empty owner directory by
 * renaming it onto the public lock pathname, so no contender can observe a
 * partial lock. Prefer {@link withProjectDefinitionMutation} in
 * `project-definition-mutation.ts`: it binds load/parse/persist to the captured
 * artifact path so a caller cannot lock one identity and write another (#3796).
 */
export function projectDefinitionMutationLock<T>(
  projectRoot: string,
  fn: (artifactPath: string) => T,
  deps: MutationLockDeps = {},
): T {
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const monotonicNowMs = deps.monotonicNowMs ?? (() => performance.now());
  const budgetMs = deps.acquisitionBudgetMs ?? DEFAULT_ACQUISITION_BUDGET_MS;
  const probeProcess = deps.probeProcess ?? defaultProbeProcess;
  const writeOwner = deps.writeOwner ?? writeSync;
  const renameLock = deps.renameLock ?? renameSync;
  const beforeLockDirRemove = deps.beforeLockDirRemove ?? (() => undefined);
  // Derive the sidecar lock path from the layout-aware resolved PROJECT-DEFINITION
  // path (xbrief/ when migrated, else vbrief/) so the lock lives next to the real
  // artifact and every mutator sharing a project root contends on the same lock,
  // instead of the constant vbrief/ path which would strand a stray lock (#1260).
  const path = projectDefinitionPath(projectRoot);
  const artifactLabel = projectDefinitionArtifactLabel(path);
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  if (mutationThreadLock.held) {
    throw new Error("project definition mutation lock is not reentrant");
  }
  mutationThreadLock.held = true;
  let fd: number | undefined;
  let ownerEntryPath: string | undefined;
  let ownerToken: string | undefined;
  let preparedEntryPath: string | undefined;
  let preparedLockPath: string | undefined;
  let acquired = false;
  try {
    // Fully materialize owner metadata in a unique sibling directory before
    // publishing it. Renaming the non-empty directory is the exclusive claim: no
    // contender can observe an empty or partial lock, and a stale reaper cannot
    // remove a replacement because replacements are non-empty when they become
    // visible.
    ownerToken = randomBytes(16).toString("hex");
    const ownerEntryName = `${process.pid}-${ownerToken}`;
    const preparedPath = `${lockPath}.claim-${ownerEntryName}`;
    preparedLockPath = preparedPath;
    preparedEntryPath = join(preparedPath, ownerEntryName);
    mkdirSync(preparedPath);
    const payload = `${JSON.stringify({ pid: process.pid, token: ownerToken })}\n`;
    try {
      fd = openSync(preparedEntryPath, "wx");
      const written = writeOwner(fd, payload);
      if (written !== Buffer.byteLength(payload)) {
        throw new Error("short write while recording project definition lock owner");
      }
      closeSync(fd);
      fd = undefined;
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
        fd = undefined;
      }
      throw err;
    }

    // One budget, read once from the monotonic clock, shared by every retry and
    // recovery branch below. Callback execution happens after acquisition and is
    // deliberately outside this budget.
    const budget = createAcquisitionBudget(monotonicNowMs, budgetMs);
    let lastReason: LockBlockedReason = "contended";
    while (true) {
      // Check for a legacy file BEFORE attempting to publish. POSIX `rename`
      // refuses to move a directory onto a file (ENOTDIR), but Windows
      // `MoveFileEx` is called with MOVEFILE_REPLACE_EXISTING and will happily
      // replace the file -- which would destroy the legacy sidecar this
      // protocol exists to preserve. So absence of a non-directory at the
      // public pathname is a precondition of publication, not a side effect of
      // it. (A legacy client that creates the sidecar inside the window between
      // this check and the rename is still a Windows-only residual; nothing in
      // portable Node makes the publish itself conditional on the destination.)
      const existing = lstatIfExists(lockPath);
      if (existing !== null && !existing.isDirectory()) {
        lastReason = "legacy-file-sidecar";
        if (budget.expired()) {
          throw new ProjectDefinitionLockError(
            describeLockFailure(artifactLabel, lockPath, lastReason, budget.totalMs),
            lastReason,
          );
        }
        sleepMs(20);
        continue;
      }
      try {
        renameLock(preparedPath, lockPath);
        acquired = true;
        preparedLockPath = undefined;
        preparedEntryPath = undefined;
        ownerEntryPath = join(lockPath, ownerEntryName);
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === undefined || !RENAME_CONTENTION_CODES.has(code)) {
          throw err;
        }
        const lockStat = lstatIfExists(lockPath);
        if (lockStat === null) {
          // Windows may surface destination collisions as EACCES/EPERM, but
          // without a destination these are permission failures rather than
          // contention. Propagate them instead of spinning until timeout.
          if (code === "EACCES" || code === "EPERM") throw err;
          // The observed owner released between rename and inspection.
          lastReason = "contended";
          continue;
        }
        if (lockStat.isDirectory()) {
          const outcome = reapDirectoryLock(lockPath, probeProcess, beforeLockDirRemove);
          if (outcome.reaped) {
            lastReason = "contended";
            continue;
          }
          lastReason = outcome.reason;
        } else {
          // A legacy client took the public lock pathname with a plain file
          // between the pre-check above and this rename. `rename` is atomic name
          // movement, not compare-and-remove: vacating this name -- by unlink or
          // by quarantine -- hands it to a non-cooperating `open(..., "wx")`
          // waiter while the displaced holder's descriptor and critical section
          // stay live. So the file is preserved and recovery is manual (#3796).
          lastReason = "legacy-file-sidecar";
        }
        if (budget.expired()) {
          throw new ProjectDefinitionLockError(
            describeLockFailure(artifactLabel, lockPath, lastReason, budget.totalMs),
            lastReason,
          );
        }
        sleepMs(20);
      }
    }
    return fn(path);
  } finally {
    try {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
      if (acquired) {
        try {
          if (ownerEntryPath !== undefined && ownerToken !== undefined) {
            const current = readDirectoryLockOwner(lockPath);
            if (
              current?.token === ownerToken &&
              join(lockPath, current.entryName) === ownerEntryPath
            ) {
              unlinkSync(ownerEntryPath);
              rmdirSync(lockPath);
            }
          }
        } catch {
          /* best-effort */
        }
      } else {
        // Publication never happened: drop the prepared owner so a crash-free
        // failure path leaves no litter. Surviving litter from a crash stays
        // fail-closed rather than being age-guessed into safety.
        try {
          if (preparedEntryPath !== undefined) unlinkSync(preparedEntryPath);
        } catch {
          /* best-effort */
        }
        try {
          if (preparedLockPath !== undefined) rmdirSync(preparedLockPath);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      mutationThreadLock.held = false;
    }
  }
}

/** Read PROJECT-DEFINITION.vbrief.json and return ``(data, path)``. */
export function loadProjectDefinitionForMutation(projectRoot: string): [JsonObject, string] {
  const path = projectDefinitionPath(projectRoot);
  return [parseProjectDefinitionAt(path), path];
}

/**
 * Load and parse the PROJECT-DEFINITION at an already-captured path (#3796).
 * Diagnostics name the artifact through {@link projectDefinitionArtifactLabel}
 * so a configured path is never interpolated raw.
 */
export function parseProjectDefinitionAt(path: string): JsonObject {
  const label = projectDefinitionArtifactLabel(path);
  if (!existsSync(path)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION not found at ${label}; run task triage:welcome / ` +
        "task triage:bootstrap to scaffold one first.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectDefinitionIOError(`Could not read PROJECT-DEFINITION at ${label}: ${msg}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectDefinitionIOError(`PROJECT-DEFINITION at ${label} is not valid JSON: ${msg}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION at ${label} top-level value is not a JSON object`,
    );
  }
  return structuredClone(data) as JsonObject;
}

/** Atomically write ``data`` to ``path`` as pretty-printed JSON. */
export function atomicWriteProjectDefinition(path: string, data: JsonObject): void {
  // #2980 wave C: product write sink routes through containedWrite (temp under parent).
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload = pythonJsonPretty(data).replace(/\n$/, "");
  const body = payload.endsWith("\n") ? payload : `${payload}\n`;
  const tmpName = `${basename(path)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmp = join(dir, tmpName);
  try {
    containedWrite({
      root: resolve(dir),
      target: tmpName,
      data: body,
      mode: "create",
    });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
