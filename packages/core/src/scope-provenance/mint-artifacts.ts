/**
 * One mint writes record + preimage + both digests (#3376 R7 / #3385).
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  type ApprovedScopeRecord,
  approvedScopeDir,
  approvedScopeIntentPath,
  approvedScopeRecordPath,
  buildApprovedScopeRecord,
  writeApprovedScopeRecord,
} from "./digest.js";
import {
  type ExtractIntentOptions,
  extractIntentFromRaw,
  type IntentPreimage,
} from "./extract-intent.js";
import { computeIntentDigest, INTENT_DIGEST_ALGO } from "./intent-digest.js";

export { approvedScopeIntentPath, approvedScopeRecordPath };

export interface MintArtifactsInput {
  readonly xbriefRelPath: string;
  readonly payload: unknown;
  readonly rawText: string;
  readonly projectRoot: string;
  readonly humanApproval?: ApprovedScopeRecord["humanApproval"];
  readonly approvedAt?: string;
  readonly extract?: ExtractIntentOptions;
}

export interface MintArtifactsResult {
  readonly record: ApprovedScopeRecord;
  readonly preimage: IntentPreimage;
  readonly recordPath: string;
  readonly intentPath: string;
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
  const dir = approvedScopeDir(input.projectRoot);
  mkdirSync(dir, { recursive: true });
  const intentPath = approvedScopeIntentPath(input.projectRoot, record.planId);
  // Preimage first. A later record-write failure leaves a preimage without
  // intentDigest, which verify ignores. The reverse (record then failed
  // preimage) would publish a digest with no authority file.
  containedWrite({
    root: resolve(input.projectRoot),
    target: intentPath,
    data: `${JSON.stringify(extracted.preimage, null, 2)}\n`,
    mode: "replace",
  });
  const recordPath = writeApprovedScopeRecord(input.projectRoot, record);
  return { record, preimage: extracted.preimage, recordPath, intentPath };
}
