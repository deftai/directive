/**
 * Canonical encoding for signed approvals (#6945).
 *
 * One encoding for both payloads: JSON with object keys sorted by UTF-16 code
 * unit, no whitespace, UTF-8 bytes, base64url for binary. Integers only (no
 * floats). This module imports nothing from Node so the ceremony page can
 * bundle it; the shared vectors in `fixtures/canonical-vectors.json` pin the
 * output on both sides.
 *
 * Domain separation: every payload carries its schema tag, and the two tags
 * differ, so a record approval can never be read as a trust-file transition.
 * Proofs sit outside the bytes they sign.
 */
import {
  APPROVAL_RECORD_KINDS,
  APPROVERS_TRANSITION_SCHEMA,
  type ApprovalRecordKind,
  RECORD_APPROVAL_SCHEMA,
  REGISTRATION_CHALLENGE_SCHEMA,
  type RecordApprovalEntry,
  type RecordApprovalPayload,
  type RegistrationChallengePayload,
  type TransitionPayload,
} from "./types.js";

/** Thrown when a value has no canonical encoding. */
export class CanonicalEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalEncodingError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Canonical JSON text of `value`. Throws on floats, undefined and non-plain objects. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalEncodingError("only safe integers have a canonical encoding");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = value[key];
      if (item === undefined) {
        throw new CanonicalEncodingError(`key ${key} is undefined`);
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new CanonicalEncodingError(`type ${typeof value} has no canonical encoding`);
}

/** UTF-8 bytes of the canonical JSON text. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX: Record<string, number> = Object.fromEntries(
  [...B64URL].map((ch, i) => [ch, i]),
);

/** base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
    out += B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Strict base64url decode: no padding, no other alphabet, and the trailing
 * bits must be zero, so each byte string has exactly one text form.
 * Returns null on any deviation.
 */
export function base64urlDecode(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64URL_INDEX[ch];
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** Lowercase `owner/repo`; the one repo form every payload uses. */
export function normalizeRepoSlug(repo: string): string {
  return repo.trim().toLowerCase();
}

const REPO_SLUG = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** True for a lowercase `owner/repo` slug. */
export function isRepoSlug(repo: unknown): repo is string {
  return typeof repo === "string" && REPO_SLUG.test(repo);
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;

function entryError(entry: unknown): string | null {
  if (!isPlainObject(entry)) return "entry must be an object";
  const keys = Object.keys(entry).sort();
  const want = ["changeKind", "contractDigest", "kind", "planId", "recordRel", "xbriefRelPath"];
  if (keys.join(",") !== want.join(",")) return `entry keys must be exactly ${want.join(", ")}`;
  if (!(APPROVAL_RECORD_KINDS as readonly string[]).includes(String(entry.kind))) {
    return "entry kind must be observable-scope or intent-constraint";
  }
  for (const key of ["planId", "xbriefRelPath", "recordRel"] as const) {
    const v = entry[key];
    if (typeof v !== "string" || v.length === 0 || v !== v.trim()) {
      return `entry ${key} must be a non-empty trimmed string`;
    }
  }
  if (String(entry.recordRel).includes("\\") || String(entry.xbriefRelPath).includes("\\")) {
    return "entry paths use forward slashes";
  }
  if (entry.kind === "intent-constraint" && entry.changeKind !== null) {
    return "intent-constraint entry changeKind must be null";
  }
  if (entry.kind === "observable-scope" && typeof entry.changeKind !== "string") {
    return "observable-scope entry changeKind must be a string";
  }
  if (typeof entry.contractDigest !== "string" || !HEX_DIGEST.test(entry.contractDigest)) {
    return "entry contractDigest must be 64 lowercase hex characters";
  }
  return null;
}

/** Sort order of entries: by record path, which is unique per record. */
function compareEntries(a: RecordApprovalEntry, b: RecordApprovalEntry): number {
  return a.recordRel < b.recordRel ? -1 : a.recordRel > b.recordRel ? 1 : 0;
}

/** Build a record approval payload: entries sorted, duplicates refused. */
export function buildRecordApprovalPayload(
  repo: string,
  entries: readonly RecordApprovalEntry[],
): RecordApprovalPayload {
  const payload: RecordApprovalPayload = {
    schema: RECORD_APPROVAL_SCHEMA,
    repo: normalizeRepoSlug(repo),
    entries: [...entries].map((e) => ({ ...e })).sort(compareEntries),
  };
  const error = recordApprovalPayloadError(payload);
  if (error !== null) throw new CanonicalEncodingError(error);
  return payload;
}

/**
 * Null when `raw` is a well-formed record approval payload: exact keys, a
 * lowercase repo slug, at least one entry, entries sorted by record path and
 * free of duplicates. Otherwise the reason.
 */
export function recordApprovalPayloadError(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "payload must be an object";
  if (Object.keys(raw).sort().join(",") !== "entries,repo,schema") {
    return "payload keys must be exactly schema, repo, entries";
  }
  if (raw.schema !== RECORD_APPROVAL_SCHEMA)
    return `payload schema must be ${RECORD_APPROVAL_SCHEMA}`;
  if (!isRepoSlug(raw.repo)) return "payload repo must be a lowercase owner/repo slug";
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    return "payload entries must be a non-empty array";
  }
  for (const entry of raw.entries) {
    const error = entryError(entry);
    if (error !== null) return error;
  }
  const entries = raw.entries as RecordApprovalEntry[];
  for (let i = 1; i < entries.length; i += 1) {
    const order = compareEntries(entries[i - 1]!, entries[i]!);
    if (order === 0) return `payload names record ${entries[i]!.recordRel} twice`;
    if (order > 0) return "payload entries must be sorted by recordRel";
  }
  return null;
}

/** True when `entries` holds an entry equal to `entry` in every field. */
export function payloadHasEntry(
  payload: RecordApprovalPayload,
  entry: RecordApprovalEntry,
): boolean {
  const want = canonicalJson(entry);
  return payload.entries.some((e) => canonicalJson(e) === want);
}

/** Build the transition payload a trust-file version's proof signs. */
export function buildTransitionPayload(input: {
  readonly repo: string;
  readonly predecessorDigest: string | null;
  readonly bodyDigest: string;
}): TransitionPayload {
  return {
    schema: APPROVERS_TRANSITION_SCHEMA,
    repo: normalizeRepoSlug(input.repo),
    predecessorDigest: input.predecessorDigest,
    bodyDigest: input.bodyDigest,
  };
}

/**
 * Build the create() challenge for a root or re-root. The credential id is
 * not an input: create() has not returned yet.
 */
export function buildRegistrationChallengePayload(input: {
  readonly repo: string;
  readonly rpId: string;
  readonly name: string;
  readonly predecessorDigest: string | null;
}): RegistrationChallengePayload {
  return {
    schema: REGISTRATION_CHALLENGE_SCHEMA,
    repo: normalizeRepoSlug(input.repo),
    rpId: input.rpId,
    name: input.name,
    predecessorDigest: input.predecessorDigest,
  };
}

/** Build one entry, normalizing path separators. */
export function buildRecordApprovalEntry(input: {
  readonly kind: ApprovalRecordKind;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly recordRel: string;
  readonly changeKind: string | null;
  readonly contractDigest: string;
}): RecordApprovalEntry {
  return {
    kind: input.kind,
    planId: input.planId.trim(),
    xbriefRelPath: input.xbriefRelPath.replace(/\\/g, "/"),
    recordRel: input.recordRel.replace(/\\/g, "/"),
    changeKind: input.kind === "intent-constraint" ? null : input.changeKind,
    contractDigest: input.contractDigest,
  };
}
