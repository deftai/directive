/**
 * One mint writes record + preimage + both digests (#3376 R7 / #3385).
 * Dest publish is fail-closed as a pair: a write failure restores the prior
 * pair or leaves neither dest (no leftover mismatched authority artifacts).
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
   * Production uses containedWrite replace. Restore never uses this seam.
   */
  readonly publishDest?: (input: MintPublishDestInput) => void;
}

export interface MintArtifactsResult {
  readonly record: ApprovedScopeRecord;
  readonly preimage: IntentPreimage;
  readonly recordPath: string;
  readonly intentPath: string;
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

/**
 * Write record + preimage as one fail-closed pair.
 * Temps land first; dests publish only after both temps exist.
 * Any dest-publish failure restores the snapshotted pair (or deletes both).
 */
export function writeApprovedScopePair(input: {
  readonly projectRoot: string;
  readonly intentPath: string;
  readonly recordPath: string;
  readonly intentData: string;
  readonly recordData: string;
  readonly publishDest?: (input: MintPublishDestInput) => void;
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
  let destsTouched = false;
  try {
    writeTempPayload(root, intentTmp, input.intentData);
    writeTempPayload(root, recordTmp, input.recordData);
    destsTouched = true;
    publish({ root, target: input.intentPath, data: input.intentData });
    publish({ root, target: input.recordPath, data: input.recordData });
  } catch (err) {
    if (destsTouched) {
      try {
        restoreText(root, input.intentPath, prevIntent);
        restoreText(root, input.recordPath, prevRecord);
      } catch {
        /* keep the original write error */
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
  });
  return { record, preimage: extracted.preimage, recordPath, intentPath };
}
