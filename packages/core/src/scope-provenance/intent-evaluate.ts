/**
 * Verify-time intent pin evaluation (#3376 R2–R6 / #3385).
 *
 * Reads base-committed record + preimage (never working-tree copies).
 * Legacy records (no intentDigest) authorize paths only; intent edits warn.
 * xbriefBodyDigest is never authority.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareExtractedIntent, type IntentCompareFinding } from "./compare-intent.js";
import { type ApprovedScopeRecord, approvedScopeIntentRel } from "./digest.js";
import {
  extractIntentFromPayload,
  extractIntentFromRaw,
  type IntentPreimage,
} from "./extract-intent.js";
import { computeIntentDigest, INTENT_DIGEST_ALGO } from "./intent-digest.js";
import { parseJsonRejectingDuplicateKeys } from "./json-tokenizer.js";

export type IntentViolationKind =
  | "intent-drift"
  | "unclassified-key"
  | "intent-digest-mismatch"
  | "duplicate-key"
  | "duplicate-item-id"
  | "same-pr-intent-rewrite"
  | "first-activation-missing-intent-pin"
  | "legacy-intent-edit"
  | "intent-parse-error";

export interface IntentFinding {
  readonly kind: IntentViolationKind;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly detail: string;
  readonly remediation: string;
  readonly warnOnly: boolean;
}

export interface IntentEvaluateInput {
  readonly projectRoot: string;
  readonly xbriefRelPath: string;
  readonly liveRaw: string;
  readonly livePayload: unknown;
  readonly planId: string;
  readonly approved: ApprovedScopeRecord | null;
  readonly xbriefModified: boolean;
  readonly approvalRewritten: boolean;
  readonly preimageRewritten: boolean;
  readonly currentScopeNonEmpty: boolean;
  readonly baseRef: string | null;
  readonly changedFiles: readonly string[];
  /**
   * Merge-base file read. Return text, `null` for a true missing path, or throw
   * on Git/read failure — errors must not be collapsed to `null` (#4956).
   */
  readonly readAtBase?: (relPath: string) => string | null;
  readonly approvedReposSeed?: readonly string[];
}

type IntentBaseContent =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly message: string };

export function parseIntentPreimageRaw(raw: string): IntentPreimage | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const rec = data as Record<string, unknown>;
    if (rec.schemaVersion !== 1) return null;
    if (rec.algo !== INTENT_DIGEST_ALGO) return null;
    if (rec.plan === null || typeof rec.plan !== "object" || Array.isArray(rec.plan)) return null;
    if (!Array.isArray(rec.approvedRepos)) return null;
    return data as IntentPreimage;
  } catch {
    return null;
  }
}

function remint(): string {
  return (
    "Remint via `deft scope:record-approved-scope -- <xbrief-path> --actor <you> --confirm` " +
    "and commit `.deft/approved-scope/<plan-id>.json` plus `.intent.json` on the merge base. " +
    "Read the preimage before committing (#3385)."
  );
}

function mapCompare(f: IntentCompareFinding): IntentViolationKind {
  if (f.kind === "unclassified-key") return "unclassified-key";
  return "intent-drift";
}

function finding(
  input: IntentEvaluateInput,
  kind: IntentViolationKind,
  detail: string,
  warnOnly = false,
): IntentFinding {
  return {
    kind,
    planId: input.planId,
    xbriefRelPath: input.xbriefRelPath,
    detail,
    remediation: remint(),
    warnOnly,
  };
}

function readBase(input: IntentEvaluateInput, rel: string): IntentBaseContent {
  if (input.readAtBase === undefined) return { status: "missing" };
  try {
    const raw = input.readAtBase(rel);
    if (raw === null) return { status: "missing" };
    return { status: "ok", text: raw };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function baseReadFailed(input: IntentEvaluateInput, rel: string, message: string): IntentFinding {
  return finding(
    input,
    "intent-parse-error",
    `merge-base read failed for ${rel}: ${message}; fail closed (#4956)`,
  );
}

function decisionExists(input: IntentEvaluateInput, rel: string): boolean {
  const fromBase = readBase(input, rel);
  if (fromBase.status === "ok") return true;
  // Read/Git errors are not authoritative absence; fall through to the
  // working tree. Missing both ways may surface as intent-drift (fail closed).
  const full = join(resolve(input.projectRoot), ...rel.split("/"));
  return existsSync(full);
}

/**
 * Evaluate intent pin for one modified active xBRIEF.
 * Returns [] when intent is not in play (unmodified, or nothing to check).
 */
export function evaluateIntentForXbrief(input: IntentEvaluateInput): IntentFinding[] {
  if (!input.xbriefModified) return [];

  const parsed = parseJsonRejectingDuplicateKeys(input.liveRaw);
  if (!parsed.ok) {
    return [finding(input, "duplicate-key", parsed.error)];
  }

  const liveExtract = extractIntentFromPayload(parsed.value, {
    projectRoot: input.projectRoot,
    approvedReposSeed: input.approvedReposSeed,
  });
  if (!liveExtract.ok) {
    if (liveExtract.error.includes("duplicate items[].id")) {
      return [finding(input, "duplicate-item-id", liveExtract.error)];
    }
    return [finding(input, "intent-parse-error", liveExtract.error)];
  }

  if (input.approvalRewritten || input.preimageRewritten) {
    return [
      finding(
        input,
        "same-pr-intent-rewrite",
        "approved-scope record or preimage rewritten in the same change set; " +
          "cannot self-authorize intent",
      ),
    ];
  }

  const hasIntent =
    input.approved !== null &&
    typeof input.approved.intentDigest === "string" &&
    input.approved.intentDigest.length > 0;

  if (!hasIntent) {
    return evaluateLegacyIntent(input, liveExtract.preimage);
  }

  const preimageRel = approvedScopeIntentRel(input.planId);
  const basePreimageRead = readBase(input, preimageRel);
  if (basePreimageRead.status === "error") {
    return [baseReadFailed(input, preimageRel, basePreimageRead.message)];
  }
  if (basePreimageRead.status === "missing") {
    if (input.currentScopeNonEmpty) {
      return [
        finding(
          input,
          "first-activation-missing-intent-pin",
          "first activation with nonempty scope requires a base-committed record + preimage",
        ),
      ];
    }
    return [];
  }

  const basePreimage = parseIntentPreimageRaw(basePreimageRead.text);
  if (basePreimage === null) {
    return [finding(input, "intent-digest-mismatch", "base preimage is malformed")];
  }
  const expected = computeIntentDigest(basePreimage);
  if (expected !== input.approved?.intentDigest) {
    return [
      finding(
        input,
        "intent-digest-mismatch",
        "base preimage digest does not match record intentDigest",
      ),
    ];
  }

  const compared = compareExtractedIntent(basePreimage, liveExtract.preimage, {
    changedFiles: input.changedFiles,
    decisionExists: (rel) => decisionExists(input, rel),
  });
  return compared.findings.map((f) => finding(input, mapCompare(f), f.detail));
}

function evaluateLegacyIntent(input: IntentEvaluateInput, live: IntentPreimage): IntentFinding[] {
  const baseRead = readBase(input, input.xbriefRelPath);
  if (baseRead.status === "error") {
    return [baseReadFailed(input, input.xbriefRelPath, baseRead.message)];
  }
  if (baseRead.status === "missing") {
    return [];
  }
  const baseExtract = extractIntentFromRaw(baseRead.text, {
    projectRoot: input.projectRoot,
    approvedReposSeed: input.approvedReposSeed,
  });
  if (!baseExtract.ok) return [];
  const compared = compareExtractedIntent(baseExtract.preimage, live, {
    changedFiles: input.changedFiles,
    decisionExists: (rel) => decisionExists(input, rel),
  });
  if (compared.ok) return [];
  return compared.findings.map((f) => finding(input, "legacy-intent-edit", f.detail, true));
}

/** Explicit: never treat xbriefBodyDigest as authority. */
export function bodyDigestIsAuthority(_rec: ApprovedScopeRecord | null): false {
  return false;
}
