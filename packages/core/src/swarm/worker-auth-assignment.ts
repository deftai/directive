/**
 * Cooperative local worker GitHub-auth assignment registry (#3663).
 *
 * PREP writes a non-secret per-destination record under the Git common
 * directory. The worker reads it from the current worktree. This is not
 * protection against a same-user process deleting the files.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { ContainedWriteError, containedRemove, containedWrite } from "../fs/contained-write.js";
import {
  type ExpectedGithubWorkerPrincipal,
  GITHUB_AUTH_MODE_HOST_GH,
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  PRINCIPAL_KIND_USER,
} from "../intake/github-auth-modes.js";
import { hasArtifactSuffix, stripArtifactSuffix } from "../layout/resolve.js";
import {
  defaultGitRunner,
  type GitRunner,
  gitCommonDir,
  worktreePathOrNull,
} from "../session/git.js";

export const WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION = Number.parseInt("1", 10);
export const WORKER_AUTH_STORE_DIR = "deft-worker-auth";
export const WORKER_AUTH_INDEX_NAME = "index.json";
export const WORKER_AUTH_LOCK_NAME = "index.lock";
export const ENV_WORKER_CREDENTIAL_DELIVERY_ID = "DEFT_WORKER_CREDENTIAL_DELIVERY_ID";
/**
 * Crash leftover with no PID: writers may steal a lock older than this.
 * Live owner PIDs are never time-reclaimed.
 */
export const WORKER_AUTH_LOCK_STALE_MS = 5 * 60 * 1000;

export const FAILURE_MISSING_ASSIGNMENT = "missing_assignment";
export const FAILURE_MALFORMED_ASSIGNMENT = "malformed_assignment";
export const FAILURE_ORPHAN_ASSIGNMENT = "orphan_assignment";
export const FAILURE_DUPLICATE_ASSIGNMENT = "duplicate_assignment";
export const FAILURE_REGISTRY_CORRUPTION = "registry_corruption";
export const FAILURE_MISSING_DELIVERY = "missing_delivery";
export const FAILURE_DELIVERY_MISMATCH = "delivery_mismatch";
export const FAILURE_RUNTIME_MODE_DENIED = "runtime_mode_denied";
export const FAILURE_AMBIENT_TOKEN_CONFLICT = "ambient_token_conflict";
export const FAILURE_MISSING_WORKER_AUTH_MODE = "missing_worker_github_auth_mode";
export const FAILURE_MISSING_WORKER_LOGIN = "missing_expected_worker_login";

export interface WorkerAuthAssignment {
  readonly schema_version: number;
  readonly dispatch_id: string;
  readonly story_id: string;
  readonly worktree_path: string;
  readonly github_auth_mode:
    | typeof GITHUB_AUTH_MODE_HOST_GH
    | typeof GITHUB_AUTH_MODE_INJECTED_TOKEN;
  readonly expected_principal: ExpectedGithubWorkerPrincipal;
  readonly credential_delivery_id: string | null;
}

export interface WorkerAuthIndexEntry {
  readonly worktree_path: string;
  readonly record_name: string;
}

export interface WorkerAuthIndex {
  readonly schema_version: number;
  readonly entries: readonly WorkerAuthIndexEntry[];
}

export interface WriteWorkerAuthAssignmentInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly dispatchId: string;
  readonly storyId: string;
  readonly githubAuthMode: string;
  readonly expectedPrincipal: ExpectedGithubWorkerPrincipal;
  readonly credentialDeliveryId: string | null;
  readonly runGit?: GitRunner;
}

export type WorkerAuthAssignmentError = {
  readonly ok: false;
  readonly failureKind: string;
  readonly detail: string;
  readonly dispatchId: string | null;
  readonly expectedLogin: string | null;
  readonly observedLogin: string | null;
};

export type WriteWorkerAuthAssignmentResult =
  | { readonly ok: true; readonly assignment: WorkerAuthAssignment; readonly commonDir: string }
  | WorkerAuthAssignmentError;

export type ReadWorkerAuthAssignmentResult =
  | {
      readonly ok: true;
      readonly assignment: WorkerAuthAssignment | null;
      readonly commonDir: string | null;
    }
  | WorkerAuthAssignmentError;

function fail(
  failureKind: string,
  detail: string,
  extras: {
    dispatchId?: string | null;
    expectedLogin?: string | null;
    observedLogin?: string | null;
  } = {},
): WorkerAuthAssignmentError {
  return {
    ok: false,
    failureKind,
    detail,
    dispatchId: extras.dispatchId ?? null,
    expectedLogin: extras.expectedLogin ?? null,
    observedLogin: extras.observedLogin ?? null,
  };
}

/**
 * Story id a brief carries in a worker-auth assignment (#6233). Swarm launch
 * records this value and the write-fence matcher compares against it, so both
 * use this one derivation: a non-empty `plan.id`, else the brief filename
 * without its lifecycle artifact suffix.
 */
export function storyIdForBrief(path: string, plan: Record<string, unknown> | null): string {
  const value = plan?.id;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  const name = basename(path);
  return hasArtifactSuffix(name) ? stripArtifactSuffix(name) : name.replace(/\.[^.]+$/, "");
}

export function mintCredentialDeliveryId(): string {
  return randomUUID();
}

export function canonicalWorktreePath(worktreePath: string): string {
  const abs = resolve(worktreePath);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function workerAuthRecordName(canonicalPath: string): string {
  return `${createHash("sha256").update(canonicalPath).digest("hex")}.json`;
}

export function resolveWorkerAuthCommonDir(
  startDir: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  return gitCommonDir(startDir, runGit);
}

/**
 * Assignment keys hash the Git worktree root, not the invoking cwd.
 * PREP writes under the dest root; workers may run from a subdirectory.
 */
export function resolveWorkerAuthDestPath(
  startDir: string,
  runGit: GitRunner = defaultGitRunner,
): string {
  const root = worktreePathOrNull(startDir, runGit);
  return canonicalWorktreePath(root ?? startDir);
}

function indexPathRel(): string {
  return join(WORKER_AUTH_STORE_DIR, WORKER_AUTH_INDEX_NAME);
}

function recordPathRel(recordName: string): string {
  return join(WORKER_AUTH_STORE_DIR, recordName);
}

function lockPathRel(): string {
  return join(WORKER_AUTH_STORE_DIR, WORKER_AUTH_LOCK_NAME);
}

function parsePrincipal(value: unknown): ExpectedGithubWorkerPrincipal | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.kind !== PRINCIPAL_KIND_USER) {
    return null;
  }
  if (typeof rec.login !== "string" || rec.login.trim().length === 0) {
    return null;
  }
  return { kind: PRINCIPAL_KIND_USER, login: rec.login.trim() };
}

function parseAssignment(value: unknown): WorkerAuthAssignment | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.schema_version !== WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION) {
    return null;
  }
  if (typeof rec.dispatch_id !== "string" || rec.dispatch_id.trim().length === 0) {
    return null;
  }
  if (typeof rec.story_id !== "string" || rec.story_id.trim().length === 0) {
    return null;
  }
  if (typeof rec.worktree_path !== "string" || rec.worktree_path.trim().length === 0) {
    return null;
  }
  if (
    rec.github_auth_mode !== GITHUB_AUTH_MODE_HOST_GH &&
    rec.github_auth_mode !== GITHUB_AUTH_MODE_INJECTED_TOKEN
  ) {
    return null;
  }
  const principal = parsePrincipal(rec.expected_principal);
  if (principal === null) {
    return null;
  }
  if (rec.credential_delivery_id !== null && typeof rec.credential_delivery_id !== "string") {
    return null;
  }
  if (
    typeof rec.credential_delivery_id === "string" &&
    rec.credential_delivery_id.trim().length === 0
  ) {
    return null;
  }
  return {
    schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION,
    dispatch_id: rec.dispatch_id.trim(),
    story_id: rec.story_id.trim(),
    worktree_path: rec.worktree_path,
    github_auth_mode: rec.github_auth_mode,
    expected_principal: principal,
    credential_delivery_id: rec.credential_delivery_id,
  };
}

function parseIndex(value: unknown): WorkerAuthIndex | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (rec.schema_version !== WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(rec.entries)) {
    return null;
  }
  const entries: WorkerAuthIndexEntry[] = [];
  for (const raw of rec.entries) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.worktree_path !== "string" || entry.worktree_path.trim().length === 0) {
      return null;
    }
    if (typeof entry.record_name !== "string" || !/^[0-9a-f]{64}\.json$/i.test(entry.record_name)) {
      return null;
    }
    entries.push({ worktree_path: entry.worktree_path, record_name: entry.record_name });
  }
  return { schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION, entries };
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function loadIndex(commonDir: string): WorkerAuthIndex | "missing" | "corrupt" {
  const abs = join(commonDir, indexPathRel());
  if (!existsSync(abs)) {
    return "missing";
  }
  const raw = readJsonFile(abs);
  if (raw === undefined) {
    return "corrupt";
  }
  const parsed = parseIndex(raw);
  return parsed === null ? "corrupt" : parsed;
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

interface WorkerAuthLockRecord {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

type WorkerAuthLockTestHooks = {
  beforeReclaimRename?: (commonDir: string) => void;
  afterStaleReclaim?: (commonDir: string) => void;
  afterAcquire?: (commonDir: string) => void;
  beforeIndexWrite?: (commonDir: string) => void;
};

let workerAuthLockTestHooks: WorkerAuthLockTestHooks | undefined;

/** Test-only: reset in afterEach. Production stays unset. */
export function setWorkerAuthLockTestHooks(hooks: WorkerAuthLockTestHooks | undefined): void {
  workerAuthLockTestHooks = hooks;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM → exists but this user cannot signal it; treat as alive.
    return code === "EPERM";
  }
}

function readLockRecord(commonDir: string): WorkerAuthLockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(commonDir, lockPathRel()), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const rec = raw as Record<string, unknown>;
    const pid = typeof rec.pid === "number" ? rec.pid : Number.NaN;
    const token = typeof rec.token === "string" ? rec.token : "";
    const startedAt = typeof rec.startedAt === "string" ? rec.startedAt : "";
    if (!Number.isFinite(pid) || token.length === 0) {
      return null;
    }
    return { pid, token, startedAt };
  } catch {
    return null;
  }
}

function lockIsStale(commonDir: string): boolean {
  const abs = join(commonDir, lockPathRel());
  try {
    const info = lstatSync(abs);
    return Date.now() - info.mtimeMs >= WORKER_AUTH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function lockIdentityMatches(
  inspected: WorkerAuthLockRecord | null,
  current: WorkerAuthLockRecord | null,
): boolean {
  if (inspected === null) {
    return current === null;
  }
  return current !== null && current.pid === inspected.pid && current.token === inspected.token;
}

function releaseLock(commonDir: string, token: string): void {
  const rec = readLockRecord(commonDir);
  if (rec === null || rec.token !== token || rec.pid !== process.pid) {
    return;
  }
  containedRemove({ root: commonDir, target: lockPathRel() });
}

function acquireLock(commonDir: string): { token: string } | WorkerAuthAssignmentError {
  const token = randomUUID();
  const writeLock = (): void => {
    containedWrite({
      root: commonDir,
      target: lockPathRel(),
      data: `${JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      })}\n`,
      mode: "create",
    });
  };
  const locked = (): WorkerAuthAssignmentError =>
    fail(FAILURE_REGISTRY_CORRUPTION, "worker auth registry is locked");
  const failed = (err: unknown): WorkerAuthAssignmentError => {
    const message = err instanceof Error ? err.message : String(err);
    return fail(FAILURE_REGISTRY_CORRUPTION, `worker auth registry lock failed: ${message}`);
  };
  try {
    writeLock();
    workerAuthLockTestHooks?.afterAcquire?.(commonDir);
    return { token };
  } catch (err: unknown) {
    if (!(err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS")) {
      return failed(err);
    }
    const inspected = readLockRecord(commonDir);
    const reclaimable =
      inspected !== null ? !isProcessAlive(inspected.pid) : lockIsStale(commonDir);
    if (!reclaimable) {
      return locked();
    }
    // Reclaim only the inspected pid+token (or still-stale unreadable lock).
    // A live writer can occupy index.lock between that check and rename.
    workerAuthLockTestHooks?.beforeReclaimRename?.(commonDir);
    const current = readLockRecord(commonDir);
    const identityHolds = lockIdentityMatches(inspected, current);
    const stillReclaimable = inspected !== null || lockIsStale(commonDir);
    if (identityHolds && stillReclaimable) {
      const abs = join(commonDir, lockPathRel());
      const reclaimRel = join(
        WORKER_AUTH_STORE_DIR,
        `${WORKER_AUTH_LOCK_NAME}.reclaim.${randomUUID()}`,
      );
      try {
        renameSync(abs, join(commonDir, reclaimRel));
        containedRemove({ root: commonDir, target: reclaimRel });
      } catch {
        // Lost the rename race or the lock is already gone.
      }
      workerAuthLockTestHooks?.afterStaleReclaim?.(commonDir);
    }
    try {
      writeLock();
      workerAuthLockTestHooks?.afterAcquire?.(commonDir);
      return { token };
    } catch (retryErr: unknown) {
      if (retryErr instanceof ContainedWriteError && retryErr.code === "CONTAINED_WRITE_EXISTS") {
        return locked();
      }
      return failed(retryErr);
    }
  }
}

function withLock<T extends { readonly ok: boolean }>(
  commonDir: string,
  body: () => T | WorkerAuthAssignmentError,
): T | WorkerAuthAssignmentError {
  const acquired = acquireLock(commonDir);
  if ("failureKind" in acquired) {
    return acquired;
  }
  try {
    return body();
  } finally {
    releaseLock(commonDir, acquired.token);
  }
}

function persistIndexAndRecord(
  commonDir: string,
  assignment: WorkerAuthAssignment,
  recordName: string,
): WorkerAuthAssignmentError | null {
  const indexState = loadIndex(commonDir);
  if (indexState === "corrupt") {
    return fail(FAILURE_REGISTRY_CORRUPTION, "worker auth index is unreadable or malformed");
  }
  const existing = indexState === "missing" ? [] : [...indexState.entries];
  const nextEntries: WorkerAuthIndexEntry[] = [];
  let seen = false;
  for (const entry of existing) {
    if (samePath(entry.worktree_path, assignment.worktree_path)) {
      if (seen) {
        return fail(
          FAILURE_DUPLICATE_ASSIGNMENT,
          `duplicate worker auth index entries for ${assignment.worktree_path}`,
          {
            dispatchId: assignment.dispatch_id,
            expectedLogin: assignment.expected_principal.login,
          },
        );
      }
      seen = true;
      nextEntries.push({ worktree_path: assignment.worktree_path, record_name: recordName });
    } else {
      nextEntries.push(entry);
    }
  }
  if (!seen) {
    nextEntries.push({ worktree_path: assignment.worktree_path, record_name: recordName });
  }
  const index: WorkerAuthIndex = {
    schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION,
    entries: nextEntries,
  };
  const writeFailed = (err: unknown): WorkerAuthAssignmentError => {
    const message = err instanceof Error ? err.message : String(err);
    return fail(FAILURE_REGISTRY_CORRUPTION, `worker auth registry write failed: ${message}`, {
      dispatchId: assignment.dispatch_id,
    });
  };
  try {
    containedWrite({
      root: commonDir,
      target: recordPathRel(recordName),
      data: `${JSON.stringify(assignment, null, 2)}\n`,
      mode: "replace",
    });
  } catch (err: unknown) {
    return writeFailed(err);
  }
  workerAuthLockTestHooks?.beforeIndexWrite?.(commonDir);
  try {
    containedWrite({
      root: commonDir,
      target: indexPathRel(),
      data: `${JSON.stringify(index, null, 2)}\n`,
      mode: "replace",
    });
  } catch (indexErr: unknown) {
    containedRemove({ root: commonDir, target: recordPathRel(recordName) });
    return writeFailed(indexErr);
  }
  return null;
}

function stripIndexEntry(commonDir: string, worktreePath: string, recordName: string): void {
  containedRemove({ root: commonDir, target: recordPathRel(recordName) });
  const indexState = loadIndex(commonDir);
  if (indexState === "missing" || indexState === "corrupt") {
    return;
  }
  const nextEntries = indexState.entries.filter(
    (entry) => !(samePath(entry.worktree_path, worktreePath) || entry.record_name === recordName),
  );
  containedWrite({
    root: commonDir,
    target: indexPathRel(),
    data: `${JSON.stringify(
      { schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION, entries: nextEntries },
      null,
      2,
    )}\n`,
    mode: "replace",
  });
}

function recordsAgree(
  commonDir: string,
  assignment: WorkerAuthAssignment,
  recordName: string,
): boolean {
  const indexState = loadIndex(commonDir);
  if (indexState === "missing" || indexState === "corrupt") {
    return false;
  }
  const matches = indexState.entries.filter((entry) =>
    samePath(entry.worktree_path, assignment.worktree_path),
  );
  if (matches.length !== 1) {
    return false;
  }
  if (matches[0]?.record_name !== recordName) {
    return false;
  }
  const raw = readJsonFile(join(commonDir, recordPathRel(recordName)));
  const parsed = parseAssignment(raw);
  if (parsed === null) {
    return false;
  }
  return (
    parsed.dispatch_id === assignment.dispatch_id &&
    parsed.story_id === assignment.story_id &&
    samePath(parsed.worktree_path, assignment.worktree_path) &&
    parsed.github_auth_mode === assignment.github_auth_mode &&
    parsed.expected_principal.login === assignment.expected_principal.login &&
    parsed.credential_delivery_id === assignment.credential_delivery_id
  );
}

export function writeWorkerAuthAssignment(
  input: WriteWorkerAuthAssignmentInput,
): WriteWorkerAuthAssignmentResult {
  if (
    input.githubAuthMode !== GITHUB_AUTH_MODE_HOST_GH &&
    input.githubAuthMode !== GITHUB_AUTH_MODE_INJECTED_TOKEN
  ) {
    return fail(
      FAILURE_MISSING_WORKER_AUTH_MODE,
      `unknown --worker-github-auth-mode ${JSON.stringify(input.githubAuthMode)}; expected host-gh|injected-token`,
    );
  }
  const login = input.expectedPrincipal.login.trim();
  if (input.expectedPrincipal.kind !== PRINCIPAL_KIND_USER || login.length === 0) {
    return fail(
      FAILURE_MISSING_WORKER_LOGIN,
      "--expected-worker-login requires a non-empty user login",
    );
  }
  const start = existsSync(input.worktreePath) ? input.worktreePath : input.projectRoot;
  const commonDir = resolveWorkerAuthCommonDir(start, input.runGit ?? defaultGitRunner);
  if (commonDir === null) {
    return fail(
      FAILURE_REGISTRY_CORRUPTION,
      "cannot resolve Git common directory for worker auth assignment; dest must be a local linked worktree",
    );
  }
  const canonical = canonicalWorktreePath(input.worktreePath);
  const recordName = workerAuthRecordName(canonical);
  const assignment: WorkerAuthAssignment = {
    schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION,
    dispatch_id: input.dispatchId.trim(),
    story_id: input.storyId.trim(),
    worktree_path: canonical,
    github_auth_mode: input.githubAuthMode,
    expected_principal: { kind: PRINCIPAL_KIND_USER, login },
    credential_delivery_id: input.credentialDeliveryId,
  };
  if (assignment.dispatch_id.length === 0 || assignment.story_id.length === 0) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      "worker auth assignment requires dispatch_id and story_id",
    );
  }
  return withLock(commonDir, () => {
    const persistErr = persistIndexAndRecord(commonDir, assignment, recordName);
    if (persistErr !== null) {
      return persistErr;
    }
    if (!recordsAgree(commonDir, assignment, recordName)) {
      stripIndexEntry(commonDir, assignment.worktree_path, recordName);
      return fail(
        FAILURE_REGISTRY_CORRUPTION,
        "worker auth record and index do not agree after write",
        {
          dispatchId: assignment.dispatch_id,
        },
      );
    }
    return { ok: true, assignment, commonDir };
  });
}

export function readWorkerAuthAssignment(
  cwd: string = process.cwd(),
  runGit: GitRunner = defaultGitRunner,
): ReadWorkerAuthAssignmentResult {
  const commonDir = resolveWorkerAuthCommonDir(cwd, runGit);
  if (commonDir === null) {
    return { ok: true, assignment: null, commonDir: null };
  }
  const canonical = resolveWorkerAuthDestPath(cwd, runGit);
  const recordName = workerAuthRecordName(canonical);
  const recordAbs = join(commonDir, recordPathRel(recordName));
  const indexState = loadIndex(commonDir);
  if (indexState === "corrupt") {
    return fail(FAILURE_REGISTRY_CORRUPTION, "worker auth index is unreadable or malformed");
  }
  const registered =
    indexState === "missing"
      ? []
      : indexState.entries.filter((entry) => samePath(entry.worktree_path, canonical));
  const recordExists = existsSync(recordAbs);

  if (registered.length === 0 && !recordExists) {
    return { ok: true, assignment: null, commonDir };
  }
  if (registered.length === 0 && recordExists) {
    return fail(
      FAILURE_ORPHAN_ASSIGNMENT,
      `worker auth assignment exists without index registration for ${canonical}`,
    );
  }
  if (registered.length > 1) {
    return fail(
      FAILURE_DUPLICATE_ASSIGNMENT,
      `duplicate worker auth index entries for ${canonical}`,
    );
  }
  const indexRecordName = registered[0]?.record_name;
  if (indexRecordName !== recordName) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth index record name does not match dest hash for ${canonical}`,
    );
  }
  if (!recordExists) {
    return fail(
      FAILURE_MISSING_ASSIGNMENT,
      `registered worker dest ${canonical} is missing its assignment record`,
    );
  }
  const raw = readJsonFile(recordAbs);
  if (raw === undefined) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth assignment is unreadable for ${canonical}`,
    );
  }
  const parsed = parseAssignment(raw);
  if (parsed === null) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth assignment is malformed for ${canonical}`,
    );
  }
  if (!samePath(parsed.worktree_path, canonical)) {
    return fail(
      FAILURE_MALFORMED_ASSIGNMENT,
      `worker auth assignment worktree_path does not match dest ${canonical}`,
      { dispatchId: parsed.dispatch_id, expectedLogin: parsed.expected_principal.login },
    );
  }
  return { ok: true, assignment: parsed, commonDir };
}

export type RemoveWorkerAuthAssignmentResult =
  | { readonly ok: true; readonly removed: boolean; readonly commonDir: string }
  | WorkerAuthAssignmentError;

export type CleanupWorkerAuthAssignmentsResult =
  | { readonly ok: true; readonly removed: number; readonly commonDir: string }
  | WorkerAuthAssignmentError;

export interface RemoveWorkerAuthAssignmentInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly dispatchId: string;
  readonly runGit?: GitRunner;
}

export interface CleanupWorkerAuthAssignmentsInput {
  readonly projectRoot: string;
  readonly dispatchId: string;
  readonly runGit?: GitRunner;
}

function resolveCommonDirForProject(
  projectRoot: string,
  worktreePath: string | null,
  runGit: GitRunner,
): string | null {
  const start = worktreePath !== null && existsSync(worktreePath) ? worktreePath : projectRoot;
  return resolveWorkerAuthCommonDir(start, runGit);
}

/**
 * Owner-bound dest cleanup. Removes the dest record only when dispatch_id matches.
 */
export function removeWorkerAuthAssignment(
  input: RemoveWorkerAuthAssignmentInput,
): RemoveWorkerAuthAssignmentResult {
  const dispatchId = input.dispatchId.trim();
  if (dispatchId.length === 0) {
    return fail(FAILURE_MALFORMED_ASSIGNMENT, "worker auth cleanup requires dispatch_id");
  }
  const runGit = input.runGit ?? defaultGitRunner;
  const commonDir = resolveCommonDirForProject(input.projectRoot, input.worktreePath, runGit);
  if (commonDir === null) {
    return { ok: true, removed: false, commonDir: input.projectRoot };
  }
  if (!existsSync(join(commonDir, WORKER_AUTH_STORE_DIR))) {
    return { ok: true, removed: false, commonDir };
  }
  const canonical = canonicalWorktreePath(input.worktreePath);
  const recordName = workerAuthRecordName(canonical);
  return withLock(commonDir, () => {
    const recordAbs = join(commonDir, recordPathRel(recordName));
    const raw = existsSync(recordAbs) ? readJsonFile(recordAbs) : undefined;
    const parsed = raw === undefined ? null : parseAssignment(raw);
    if (parsed !== null && parsed.dispatch_id !== dispatchId) {
      return { ok: true, removed: false, commonDir };
    }
    const indexState = loadIndex(commonDir);
    const indexed =
      indexState !== "missing" && indexState !== "corrupt"
        ? indexState.entries.some(
            (entry) => samePath(entry.worktree_path, canonical) || entry.record_name === recordName,
          )
        : false;
    if (parsed === null && !indexed && !existsSync(recordAbs)) {
      return { ok: true, removed: false, commonDir };
    }
    stripIndexEntry(commonDir, canonical, recordName);
    return { ok: true, removed: true, commonDir };
  });
}

/**
 * Owner-bound terminal cleanup for every dest registered under dispatch_id.
 */
export function cleanupWorkerAuthAssignmentsForDispatch(
  input: CleanupWorkerAuthAssignmentsInput,
): CleanupWorkerAuthAssignmentsResult {
  const dispatchId = input.dispatchId.trim();
  if (dispatchId.length === 0) {
    return fail(FAILURE_MALFORMED_ASSIGNMENT, "worker auth cleanup requires dispatch_id");
  }
  const runGit = input.runGit ?? defaultGitRunner;
  const commonDir = resolveCommonDirForProject(input.projectRoot, null, runGit);
  if (commonDir === null) {
    return { ok: true, removed: 0, commonDir: input.projectRoot };
  }
  if (!existsSync(join(commonDir, WORKER_AUTH_STORE_DIR))) {
    return { ok: true, removed: 0, commonDir };
  }
  return withLock(commonDir, () => {
    const indexState = loadIndex(commonDir);
    if (indexState === "corrupt") {
      return fail(FAILURE_REGISTRY_CORRUPTION, "worker auth index is unreadable or malformed");
    }
    const entries = indexState === "missing" ? [] : [...indexState.entries];
    const keep: WorkerAuthIndexEntry[] = [];
    let removed = 0;
    const seenRecords = new Set<string>();
    for (const entry of entries) {
      const raw = readJsonFile(join(commonDir, recordPathRel(entry.record_name)));
      const parsed = parseAssignment(raw);
      seenRecords.add(entry.record_name);
      if (parsed !== null && parsed.dispatch_id === dispatchId) {
        containedRemove({ root: commonDir, target: recordPathRel(entry.record_name) });
        removed += 1;
      } else {
        keep.push(entry);
      }
    }
    const storeDir = join(commonDir, WORKER_AUTH_STORE_DIR);
    if (existsSync(storeDir)) {
      for (const name of readdirSync(storeDir)) {
        if (!/^[0-9a-f]{64}\.json$/i.test(name) || seenRecords.has(name)) {
          continue;
        }
        const parsed = parseAssignment(readJsonFile(join(storeDir, name)));
        if (parsed !== null && parsed.dispatch_id === dispatchId) {
          containedRemove({ root: commonDir, target: recordPathRel(name) });
          removed += 1;
        }
      }
    }
    containedWrite({
      root: commonDir,
      target: indexPathRel(),
      data: `${JSON.stringify(
        { schema_version: WORKER_AUTH_ASSIGNMENT_SCHEMA_VERSION, entries: keep },
        null,
        2,
      )}\n`,
      mode: "replace",
    });
    return { ok: true, removed, commonDir };
  });
}

export function observedCredentialDeliveryId(environ: NodeJS.ProcessEnv): string | null {
  const value = environ[ENV_WORKER_CREDENTIAL_DELIVERY_ID]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function workerAuthStoreDir(commonDir: string): string {
  return join(commonDir, WORKER_AUTH_STORE_DIR);
}
