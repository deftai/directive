/**
 * One mint writes record + preimage + both digests (#3376 R7 / #3385).
 * Dest publish is fail-closed as a pair: rollback is armed before the first
 * dest write. A write failure restores the prior pair or leaves neither dest.
 * Restore failures are not swallowed: leftover dests are cleared as a pair
 * (a partial cleanup puts removed dests back) and the error names both the
 * write and rollback failures.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
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
  if (snapshot === null) {
    rmSync(path, { force: true });
    return;
  }
  containedWrite({
    root,
    target: path,
    data: snapshot,
    mode: "replace",
  });
}

function publishDestDefault(input: MintPublishDestInput): void {
  containedWrite({
    root: input.root,
    target: input.target,
    data: input.data,
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
 * Temps land first; dests publish only after both temps exist.
 * Rollback is armed before the first dest write so a partial first
 * dest cannot skip restore. Dest-publish failure restores the
 * snapshotted pair. Restore failure clears leftover dests as a pair
 * (partial cleanup puts removed dests back) and names both errors.
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
}): void {
  const root = resolve(input.projectRoot);
  const dir = approvedScopeDir(input.projectRoot);
  mkdirSync(dir, { recursive: true });
  const prevIntent = snapshotText(input.intentPath);
  const prevRecord = snapshotText(input.recordPath);
  const nonce = randomBytes(4).toString("hex");
  const intentTmp = join(dir, `.${basename(input.intentPath)}.${process.pid}.${nonce}.tmp`);
  const recordTmp = join(dir, `.${basename(input.recordPath)}.${process.pid}.${nonce}.tmp`);
  const publish = input.publishDest ?? publishDestDefault;
  const restore = input.restoreDest ?? restoreDestDefault;
  const remove = input.removeDest ?? removeDestDefault;
  const dests: readonly MintRestoreDestInput[] = [
    { root, target: input.intentPath, snapshot: prevIntent },
    { root, target: input.recordPath, snapshot: prevRecord },
  ];
  let destPublished = false;
  try {
    writeTempPayload(root, intentTmp, input.intentData);
    writeTempPayload(root, recordTmp, input.recordData);
    destPublished = true;
    publish({ root, target: input.intentPath, data: input.intentData });
    publish({ root, target: input.recordPath, data: input.recordData });
  } catch (err) {
    if (destPublished) {
      try {
        restorePair(restore, dests);
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
        } catch (clearErr) {
          throw new MintPairRollbackError(err, restoreErr, clearErr);
        }
        throw new MintPairRollbackError(err, restoreErr);
      }
    }
    throw err;
  } finally {
    rmSync(intentTmp, { force: true });
    rmSync(recordTmp, { force: true });
  }
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
  });
  return { record, preimage: extracted.preimage, recordPath, intentPath };
}
