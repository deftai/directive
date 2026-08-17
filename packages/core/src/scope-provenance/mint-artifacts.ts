/**
 * One mint writes record + preimage + both digests (#3376 R7 / #3385).
 * Dest publish is two-phase under a per-plan lock: both dests land as
 * `.next` first, then dests are copied from that pair. A crash leaves
 * `.next` and/or a bak journal; recover finishes the flip or restores
 * the prior pair (or neither dest) without waiting for a remint.
 * Caught write failures still restore or clear dests.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedRemove,
  containedWrite,
} from "../fs/contained-write.js";
import {
  type ApprovedScopeRecord,
  approvedScopeDir,
  approvedScopeIntentPath,
  approvedScopeRecordPath,
  buildApprovedScopeRecord,
} from "./digest.js";
import {
  type ExtractIntentOptions,
  extractIntentFromRaw,
  type IntentPreimage,
} from "./extract-intent.js";
import { computeIntentDigest, INTENT_DIGEST_ALGO } from "./intent-digest.js";

export { approvedScopeIntentPath, approvedScopeRecordPath };

export interface MintPublishDestInput {
  readonly root: string;
  readonly target: string;
  readonly data: string;
}

export interface MintRestoreDestInput {
  readonly root: string;
  readonly target: string;
  readonly snapshot: string | null;
}

export interface MintRemoveDestInput {
  readonly root: string;
  readonly target: string;
}

export class MintPairRollbackError extends Error {
  readonly writeError: unknown;
  readonly restoreError: unknown;
  readonly clearError: unknown | undefined;

  constructor(writeError: unknown, restoreError: unknown, clearError?: unknown) {
    const writeMsg = errorMessage(writeError);
    const restoreMsg = errorMessage(restoreError);
    const clearSuffix =
      clearError === undefined
        ? "; leftover dests were cleared"
        : `; leftover dests could not be cleared (${errorMessage(clearError)})`;
    super(
      `Mint dest publish failed (${writeMsg}); rollback also failed (${restoreMsg})${clearSuffix}. Do not commit a partial approved-scope pair.`,
    );
    this.name = "MintPairRollbackError";
    this.writeError = writeError;
    this.restoreError = restoreError;
    this.clearError = clearError;
    this.cause = writeError;
  }
}

export interface MintArtifactsInput {
  readonly xbriefRelPath: string;
  readonly payload: unknown;
  readonly rawText: string;
  readonly projectRoot: string;
  readonly humanApproval?: ApprovedScopeRecord["humanApproval"];
  readonly approvedAt?: string;
  readonly extract?: ExtractIntentOptions;
  /**
   * Test-only dest publish after both temp payloads exist.
   * Production uses containedWrite replace.
   */
  readonly publishDest?: (input: MintPublishDestInput) => void;
  /**
   * Test-only dest restore after a dest-publish failure.
   * Production restores via containedWrite replace / rmSync.
   */
  readonly restoreDest?: (input: MintRestoreDestInput) => void;
  /**
   * Test-only dest remove during rollback cleanup.
   * Production uses rmSync.
   */
  readonly removeDest?: (input: MintRemoveDestInput) => void;
  /** Test-only lock wait. Production waits 30s. */
  readonly lockWaitMs?: number;
}

export interface MintArtifactsResult {
  readonly record: ApprovedScopeRecord;
  readonly preimage: IntentPreimage;
  readonly recordPath: string;
  readonly intentPath: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function snapshotText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function restoreText(root: string, path: string, snapshot: string | null): void {
  rmSync(path, { force: true, recursive: true });
  if (snapshot === null) return;
  containedWrite({
    root,
    target: path,
    data: snapshot,
    mode: "replace",
  });
}

function writeTempPayload(root: string, target: string, data: string): void {
  containedWrite({
    root,
    target,
    data,
    mode: "create",
  });
}

function restoreDestDefault(input: MintRestoreDestInput): void {
  restoreText(input.root, input.target, input.snapshot);
}

function removeDestDefault(input: MintRemoveDestInput): void {
  rmSync(input.target, { force: true });
}

function pairStem(recordPath: string): string {
  return basename(recordPath).replace(/\.json$/i, "");
}

export function approvedScopePairLockPath(dir: string, recordPath: string): string {
  return join(dir, `.${pairStem(recordPath)}.pair.lock.tmp`);
}

export function approvedScopePairJournalPaths(
  dir: string,
  intentPath: string,
  recordPath: string,
): {
  readonly publishing: string;
  readonly intentBak: string;
  readonly recordBak: string;
} {
  return {
    publishing: join(dir, `.${pairStem(recordPath)}.publishing.bak`),
    intentBak: join(dir, `${basename(intentPath)}.bak`),
    recordBak: join(dir, `${basename(recordPath)}.bak`),
  };
}

export function approvedScopePairNextPaths(
  dir: string,
  intentPath: string,
  recordPath: string,
): {
  readonly intentNext: string;
  readonly recordNext: string;
} {
  return {
    intentNext: join(dir, `${basename(intentPath)}.next.tmp`),
    recordNext: join(dir, `${basename(recordPath)}.next.tmp`),
  };
}

function publishFromNext(root: string, next: string, dest: string): void {
  if (!existsSync(next)) {
    throw new Error(`mint pair next payload missing: ${basename(next)}`);
  }
  containedWrite({
    root,
    target: dest,
    data: readFileSync(next, "utf8"),
    mode: "replace",
  });
}

function writeBak(root: string, src: string, bak: string): void {
  if (!existsSync(src)) {
    rmSync(bak, { force: true });
    return;
  }
  containedWrite({
    root,
    target: bak,
    data: readFileSync(src, "utf8"),
    mode: "replace",
  });
}

function clearJournal(paths: { publishing: string; intentBak: string; recordBak: string }): void {
  rmSync(paths.publishing, { force: true });
  rmSync(paths.intentBak, { force: true });
  rmSync(paths.recordBak, { force: true });
}

function pairStemFromPublishingName(name: string): string | null {
  const match = name.match(/^\.(.+)\.publishing\.bak$/i);
  return match?.[1] ?? null;
}

function pairStemFromNextName(name: string): string | null {
  if (!name.endsWith(".next.tmp")) return null;
  const base = name.slice(0, -".next.tmp".length);
  if (base.endsWith(".intent.json")) return base.slice(0, -".intent.json".length);
  if (base.endsWith(".json")) return base.slice(0, -".json".length);
  return null;
}

/**
 * Finish a staged dest flip from `.next`, or restore the bak pair / clear dests.
 * Does not wait for a remint.
 */
export function recoverIncompleteApprovedScopePair(input: {
  readonly projectRoot: string;
  readonly intentPath: string;
  readonly recordPath: string;
}): boolean {
  const root = resolve(input.projectRoot);
  const dir = approvedScopeDir(input.projectRoot);
  const journal = approvedScopePairJournalPaths(dir, input.intentPath, input.recordPath);
  const next = approvedScopePairNextPaths(dir, input.intentPath, input.recordPath);
  const intentNext = snapshotText(next.intentNext);
  const recordNext = snapshotText(next.recordNext);
  if (intentNext !== null && recordNext !== null) {
    restoreText(root, input.intentPath, intentNext);
    restoreText(root, input.recordPath, recordNext);
    rmSync(next.intentNext, { force: true });
    rmSync(next.recordNext, { force: true });
    clearJournal(journal);
    return true;
  }
  if (!existsSync(journal.publishing)) {
    const leftover = intentNext !== null || recordNext !== null;
    rmSync(next.intentNext, { force: true });
    rmSync(next.recordNext, { force: true });
    return leftover;
  }
  const intentBak = snapshotText(journal.intentBak);
  const recordBak = snapshotText(journal.recordBak);
  if (intentBak !== null || recordBak !== null) {
    restoreText(root, input.intentPath, intentBak);
    restoreText(root, input.recordPath, recordBak);
  } else {
    rmSync(input.intentPath, { force: true });
    rmSync(input.recordPath, { force: true });
  }
  rmSync(next.intentNext, { force: true });
  rmSync(next.recordNext, { force: true });
  clearJournal(journal);
  return true;
}

/** Recover every incomplete pair under `.deft/approved-scope/`. */
export function recoverApprovedScopePairs(projectRoot: string): number {
  const dir = approvedScopeDir(projectRoot);
  if (!existsSync(dir)) return 0;
  const stems = new Set<string>();
  for (const name of readdirSync(dir)) {
    const fromPub = pairStemFromPublishingName(name);
    if (fromPub !== null) stems.add(fromPub);
    const fromNext = pairStemFromNextName(name);
    if (fromNext !== null) stems.add(fromNext);
  }
  let recovered = 0;
  for (const stem of stems) {
    const did = recoverIncompleteApprovedScopePair({
      projectRoot,
      intentPath: join(dir, `${stem}.intent.json`),
      recordPath: join(dir, `${stem}.json`),
    });
    if (did) recovered += 1;
  }
  return recovered;
}

function ownerPidAlive(lockPath: string): boolean {
  try {
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isInteger(owner) || owner <= 0) return true;
    process.kill(owner, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function reclaimDeadPairLock(lockPath: string): void {
  const stale = `${lockPath}.stale`;
  try {
    renameSync(lockPath, stale);
  } catch {
    return;
  }
  rmSync(stale, { force: true });
}

function isCreateExistsError(err: unknown): boolean {
  return err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS;
}

function withPairLock<T>(root: string, lockPath: string, waitMs: number, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try {
      containedWrite({
        root,
        target: lockPath,
        data: `${process.pid}\n`,
        mode: "create",
        mutation: false,
      });
      held = true;
    } catch (err) {
      if (!isCreateExistsError(err)) throw err;
      if (!ownerPidAlive(lockPath)) {
        reclaimDeadPairLock(lockPath);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring mint pair lock for ${basename(lockPath)}`);
      }
      const spinEnd = Date.now() + 20;
      while (Date.now() < spinEnd) {
        /* spin */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      containedRemove({ root, target: lockPath, mutation: false });
    } catch {
      rmSync(lockPath, { force: true });
    }
  }
}

function restorePair(
  restore: (input: MintRestoreDestInput) => void,
  dests: readonly MintRestoreDestInput[],
): void {
  const failures: string[] = [];
  for (const dest of dests) {
    try {
      restore(dest);
    } catch (err) {
      failures.push(`${basename(dest.target)}: ${errorMessage(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

function clearDestPair(input: {
  readonly root: string;
  readonly intentPath: string;
  readonly recordPath: string;
  readonly prevIntent: string | null;
  readonly prevRecord: string | null;
  readonly remove: (input: MintRemoveDestInput) => void;
}): void {
  const dests: readonly MintRestoreDestInput[] = [
    { root: input.root, target: input.intentPath, snapshot: input.prevIntent },
    { root: input.root, target: input.recordPath, snapshot: input.prevRecord },
  ];
  const removed: MintRestoreDestInput[] = [];
  const failures: string[] = [];
  for (const dest of dests) {
    try {
      input.remove({ root: dest.root, target: dest.target });
      removed.push(dest);
    } catch (err) {
      failures.push(`${basename(dest.target)}: ${errorMessage(err)}`);
    }
  }
  if (failures.length === 0) return;
  const putBackFailures: string[] = [];
  for (const dest of removed) {
    try {
      restoreDestDefault(dest);
    } catch (err) {
      putBackFailures.push(`${basename(dest.target)}: ${errorMessage(err)}`);
    }
  }
  const putBackSuffix =
    putBackFailures.length > 0
      ? `; removed dests could not be put back (${putBackFailures.join("; ")})`
      : "";
  throw new Error(`${failures.join("; ")}${putBackSuffix}`);
}

/**
 * Write record + preimage as one fail-closed pair.
 * Phase 1 writes both dests to `.next`. Phase 2 copies dests from that pair.
 * Recover finishes the flip or restores the bak pair without a remint.
 */
export function writeApprovedScopePair(input: {
  readonly projectRoot: string;
  readonly intentPath: string;
  readonly recordPath: string;
  readonly intentData: string;
  readonly recordData: string;
  readonly publishDest?: (input: MintPublishDestInput) => void;
  readonly restoreDest?: (input: MintRestoreDestInput) => void;
  readonly removeDest?: (input: MintRemoveDestInput) => void;
  readonly lockWaitMs?: number;
}): void {
  const root = resolve(input.projectRoot);
  const dir = approvedScopeDir(input.projectRoot);
  mkdirSync(dir, { recursive: true });
  const lockPath = approvedScopePairLockPath(dir, input.recordPath);
  const journal = approvedScopePairJournalPaths(dir, input.intentPath, input.recordPath);
  const restore = input.restoreDest ?? restoreDestDefault;
  const remove = input.removeDest ?? removeDestDefault;
  const customPublish = input.publishDest;
  const next = approvedScopePairNextPaths(dir, input.intentPath, input.recordPath);
  withPairLock(root, lockPath, input.lockWaitMs ?? 30_000, () => {
    recoverIncompleteApprovedScopePair({
      projectRoot: input.projectRoot,
      intentPath: input.intentPath,
      recordPath: input.recordPath,
    });
    const prevIntent = snapshotText(input.intentPath);
    const prevRecord = snapshotText(input.recordPath);
    const dests: readonly MintRestoreDestInput[] = [
      { root, target: input.intentPath, snapshot: prevIntent },
      { root, target: input.recordPath, snapshot: prevRecord },
    ];
    let destPublished = false;
    try {
      writeTempPayload(root, next.intentNext, input.intentData);
      writeTempPayload(root, next.recordNext, input.recordData);
      writeBak(root, input.intentPath, journal.intentBak);
      writeBak(root, input.recordPath, journal.recordBak);
      containedWrite({
        root,
        target: journal.publishing,
        data: "publishing\n",
        mode: "replace",
      });
      destPublished = true;
      if (customPublish) {
        customPublish({ root, target: input.intentPath, data: input.intentData });
        customPublish({ root, target: input.recordPath, data: input.recordData });
      } else {
        publishFromNext(root, next.intentNext, input.intentPath);
        publishFromNext(root, next.recordNext, input.recordPath);
      }
      clearJournal(journal);
    } catch (err) {
      if (destPublished) {
        try {
          restorePair(restore, dests);
          clearJournal(journal);
        } catch (restoreErr) {
          try {
            clearDestPair({
              root,
              intentPath: input.intentPath,
              recordPath: input.recordPath,
              prevIntent,
              prevRecord,
              remove,
            });
            clearJournal(journal);
          } catch (clearErr) {
            throw new MintPairRollbackError(err, restoreErr, clearErr);
          }
          throw new MintPairRollbackError(err, restoreErr);
        }
      }
      throw err;
    } finally {
      rmSync(next.intentNext, { force: true });
      rmSync(next.recordNext, { force: true });
    }
  });
}

export function mintApprovedScopeArtifacts(input: MintArtifactsInput): MintArtifactsResult {
  const extracted = extractIntentFromRaw(input.rawText, {
    projectRoot: input.projectRoot,
    ...input.extract,
  });
  if (!extracted.ok) {
    throw new Error(extracted.error);
  }
  const intentDigest = computeIntentDigest(extracted.preimage);
  const record = {
    ...buildApprovedScopeRecord({
      xbriefRelPath: input.xbriefRelPath,
      payload: input.payload,
      approvedAt: input.approvedAt,
      humanApproval: input.humanApproval,
    }),
    intentDigest,
    digestAlgo: INTENT_DIGEST_ALGO,
  };
  const intentPath = approvedScopeIntentPath(input.projectRoot, record.planId);
  const recordPath = approvedScopeRecordPath(input.projectRoot, record.planId);
  writeApprovedScopePair({
    projectRoot: input.projectRoot,
    intentPath,
    recordPath,
    intentData: `${JSON.stringify(extracted.preimage, null, 2)}\n`,
    recordData: `${JSON.stringify(record, null, 2)}\n`,
    publishDest: input.publishDest,
    restoreDest: input.restoreDest,
    removeDest: input.removeDest,
    lockWaitMs: input.lockWaitMs,
  });
  return { record, preimage: extracted.preimage, recordPath, intentPath };
}
