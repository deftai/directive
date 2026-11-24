/**
 * `.deft/approvers.json` parse and per-version check (#6945).
 *
 * The first version's proof is a root: an attested registration of the one
 * approver it lists, plus an assertion by that credential over the transition
 * payload with a null predecessor. Every later version is either
 *   - a transition: an assertion by a credential of the immediately preceding
 *     version over `{repo, predecessorDigest, bodyDigest}`, or
 *   - a re-root: a newly attested credential that no earlier version enrolled
 *     (the lost-all-keys path). It starts a new epoch: its body lists only that
 *     credential, and no later transition may bring back a key from an earlier
 *     epoch, so earlier records stop verifying until re-approved.
 * Attested credentials are the ones a root or re-root introduced; a
 * transition that leaves none of them in the set is refused.
 */

import { type RegistrationVerifier, verifyAttestedRegistration } from "./attestation.js";
import {
  base64urlDecode,
  buildRegistrationChallengePayload,
  buildTransitionPayload,
  canonicalBytes,
  isRepoSlug,
} from "./canonical.js";
import {
  APPROVERS_FILE_REL,
  APPROVERS_FILE_SCHEMA,
  type Approver,
  type ApproversBody,
  type ApproversFile,
  type ApproversRp,
  type AssertionProof,
  type TrustProof,
} from "./types.js";
import {
  isSupportedAlg,
  publicKeyFromSpki,
  sha256,
  sha256Hex,
  verifyAssertion,
} from "./webauthn.js";

const AAGUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RP_ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string | null {
  const have = Object.keys(value).sort().join(",");
  const want = [...keys].sort().join(",");
  return have === want ? null : `${label} keys must be exactly ${[...keys].join(", ")}`;
}

function nonEmptyB64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const bytes = base64urlDecode(value);
  return bytes !== null && bytes.length > 0;
}

function originError(origin: unknown, rpId: string): string | null {
  if (typeof origin !== "string") return "rp.origins entries must be strings";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `rp origin ${origin} is not a URL`;
  }
  if (url.protocol !== "https:" || url.origin !== origin) {
    return `rp origin ${origin} must be an https origin with no path`;
  }
  const host = url.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    return `rp origin ${origin} is not on rp.id ${rpId}`;
  }
  return null;
}

function rpError(raw: unknown): string | null {
  if (!isObject(raw)) return "body.rp must be an object";
  const keys = exactKeys(raw, ["id", "origins"], "body.rp");
  if (keys !== null) return keys;
  if (typeof raw.id !== "string" || !RP_ID.test(raw.id))
    return "body.rp.id must be a lowercase host name";
  if (raw.id === "localhost" || raw.id.endsWith(".localhost"))
    return "body.rp.id must not be localhost";
  if (!Array.isArray(raw.origins) || raw.origins.length === 0) {
    return "body.rp.origins must be a non-empty array";
  }
  if (new Set(raw.origins).size !== raw.origins.length) return "body.rp.origins has a duplicate";
  for (const origin of raw.origins) {
    const error = originError(origin, raw.id);
    if (error !== null) return error;
  }
  return null;
}

function approverError(raw: unknown): string | null {
  if (!isObject(raw)) return "body.approvers entries must be objects";
  const keys = exactKeys(
    raw,
    ["name", "credentialId", "publicKey", "alg", "aaguid", "backupEligible"],
    "approver",
  );
  if (keys !== null) return keys;
  if (
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name !== raw.name.trim()
  ) {
    return "approver name must be a non-empty trimmed string";
  }
  if (!nonEmptyB64(raw.credentialId)) return "approver credentialId must be base64url";
  if (!isSupportedAlg(raw.alg))
    return "approver alg must be -7 (ES256), -257 (RS256) or -8 (EdDSA)";
  if (typeof raw.publicKey !== "string" || publicKeyFromSpki(raw.publicKey, raw.alg) === null) {
    return `approver ${String(raw.name)} publicKey does not parse for its alg`;
  }
  if (typeof raw.aaguid !== "string" || !AAGUID.test(raw.aaguid)) {
    return "approver aaguid must be a lowercase UUID";
  }
  if (typeof raw.backupEligible !== "boolean") return "approver backupEligible must be a boolean";
  return null;
}

function bodyError(raw: unknown): string | null {
  if (!isObject(raw)) return "body must be an object";
  const keys = exactKeys(raw, ["repo", "rp", "approvers"], "body");
  if (keys !== null) return keys;
  if (!isRepoSlug(raw.repo)) return "body.repo must be a lowercase owner/repo slug";
  const rp = rpError(raw.rp);
  if (rp !== null) return rp;
  if (!Array.isArray(raw.approvers) || raw.approvers.length === 0) {
    return "body.approvers must be a non-empty array";
  }
  const ids = new Set<string>();
  for (const approver of raw.approvers) {
    const error = approverError(approver);
    if (error !== null) return error;
    const id = (approver as Approver).credentialId;
    if (ids.has(id)) return `body.approvers lists credential ${id} twice`;
    ids.add(id);
  }
  return null;
}

function assertionError(raw: unknown, label: string): string | null {
  if (!isObject(raw)) return `${label} must be an object`;
  const keys = exactKeys(raw, ["authenticatorData", "clientDataJSON", "signature"], label);
  if (keys !== null) return keys;
  for (const field of ["authenticatorData", "clientDataJSON", "signature"]) {
    if (!nonEmptyB64(raw[field])) return `${label}.${field} must be base64url`;
  }
  return null;
}

function proofError(raw: unknown): string | null {
  if (!isObject(raw)) return "proof must be an object";
  if (raw.kind === "transition") {
    const keys = exactKeys(raw, ["kind", "credentialId", "assertion"], "transition proof");
    if (keys !== null) return keys;
  } else if (raw.kind === "root" || raw.kind === "re-root") {
    const keys = exactKeys(
      raw,
      ["kind", "credentialId", "registration", "assertion"],
      `${raw.kind} proof`,
    );
    if (keys !== null) return keys;
    const reg = raw.registration;
    if (!isObject(reg)) return "proof.registration must be an object";
    const regKeys = exactKeys(reg, ["attestationObject", "clientDataJSON"], "proof.registration");
    if (regKeys !== null) return regKeys;
    if (!nonEmptyB64(reg.attestationObject) || !nonEmptyB64(reg.clientDataJSON)) {
      return "proof.registration fields must be base64url";
    }
  } else {
    return "proof.kind must be root, re-root or transition";
  }
  if (!nonEmptyB64(raw.credentialId)) return "proof.credentialId must be base64url";
  return assertionError(raw.assertion, "proof.assertion");
}

/** Parse `.deft/approvers.json` text with exact keys at every level. */
export function parseApproversFile(text: string): ApproversFile | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    return { error: `${APPROVERS_FILE_REL} is not valid JSON: ${String(err)}` };
  }
  if (!isObject(raw)) return { error: `${APPROVERS_FILE_REL} must be a JSON object` };
  const keys = exactKeys(raw, ["schema", "body", "proof"], APPROVERS_FILE_REL);
  if (keys !== null) return { error: keys };
  if (raw.schema !== APPROVERS_FILE_SCHEMA)
    return { error: `schema must be ${APPROVERS_FILE_SCHEMA}` };
  const body = bodyError(raw.body);
  if (body !== null) return { error: body };
  const proof = proofError(raw.proof);
  if (proof !== null) return { error: proof };
  return raw as unknown as ApproversFile;
}

/** Lowercase hex sha256 of the canonical body. */
export function computeBodyDigest(body: ApproversBody): string {
  return sha256Hex(canonicalBytes(body));
}

/** Lowercase hex sha256 of the canonical whole document (body and proof). */
export function computeVersionDigest(file: ApproversFile): string {
  return sha256Hex(canonicalBytes(file));
}

/** The canonical bytes a version's proof signs. */
export function transitionPayloadBytes(
  file: ApproversFile,
  predecessor: ApproversFile | null,
): Uint8Array {
  return canonicalBytes(
    buildTransitionPayload({
      repo: file.body.repo,
      predecessorDigest: predecessor === null ? null : computeVersionDigest(predecessor),
      bodyDigest: computeBodyDigest(file.body),
    }),
  );
}

/** Chain state after a verified version. */
export interface TrustChainState {
  readonly file: ApproversFile;
  /** Attestation format of the current epoch's root (`packed`). */
  readonly rootKind: string;
  /** Commit (or label) of the version that started the current epoch. */
  readonly epochStart: string;
  /** Credential ids a root or re-root introduced and still enrolled. */
  readonly attested: ReadonlySet<string>;
  /** Every credential id any version so far enrolled. */
  readonly everEnrolled: ReadonlySet<string>;
  /** Credential ids enrolled before the current epoch. */
  readonly priorEpochs: ReadonlySet<string>;
}

export interface VersionContext {
  /** Commit that holds this version, for messages and the epoch start. */
  readonly at: string;
  readonly verifyRegistration?: RegistrationVerifier;
}

export type VersionResult =
  | { readonly ok: true; readonly state: TrustChainState }
  | { readonly ok: false; readonly reason: string };

function checkAssertion(
  assertion: AssertionProof,
  signer: Approver,
  rp: ApproversRp,
  payloadBytes: Uint8Array,
): string | null {
  return verifyAssertion({
    payloadBytes,
    rp,
    alg: signer.alg,
    publicKey: signer.publicKey,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
    signature: assertion.signature,
  });
}

function sameKey(a: Approver, b: Approver): boolean {
  return (
    a.credentialId === b.credentialId &&
    a.publicKey === b.publicKey &&
    a.alg === b.alg &&
    a.aaguid === b.aaguid &&
    a.backupEligible === b.backupEligible
  );
}

function verifyRootProof(
  file: ApproversFile,
  predecessor: ApproversFile | null,
  ctx: VersionContext,
): { ok: true; fmt: string } | { ok: false; reason: string } {
  const proof = file.proof as Extract<TrustProof, { kind: "root" | "re-root" }>;
  const label = proof.kind;
  if (file.body.approvers.length !== 1) {
    return { ok: false, reason: `a ${label} version lists exactly one approver, the attested key` };
  }
  const approver = file.body.approvers[0]!;
  if (approver.credentialId !== proof.credentialId) {
    return { ok: false, reason: `${label} proof credential is not the listed approver` };
  }
  const expectedChallenge = sha256(
    canonicalBytes(
      buildRegistrationChallengePayload({
        repo: file.body.repo,
        rpId: file.body.rp.id,
        name: approver.name,
        predecessorDigest: predecessor === null ? null : computeVersionDigest(predecessor),
      }),
    ),
  );
  const verifier =
    ctx.verifyRegistration ?? ((input) => verifyAttestedRegistration(input, { expectedChallenge }));
  const reg = verifier({
    attestationObject: proof.registration.attestationObject,
    clientDataJSON: proof.registration.clientDataJSON,
    rp: file.body.rp,
  });
  if (!reg.ok) return { ok: false, reason: `${label} registration refused: ${reg.reason}` };
  const r = reg.registration;
  if (
    r.credentialId !== approver.credentialId ||
    r.publicKey !== approver.publicKey ||
    r.alg !== approver.alg ||
    r.aaguid !== approver.aaguid ||
    r.backupEligible !== approver.backupEligible
  ) {
    return { ok: false, reason: `${label} registration does not match the listed approver` };
  }
  const error = checkAssertion(
    proof.assertion,
    approver,
    file.body.rp,
    transitionPayloadBytes(file, predecessor),
  );
  if (error !== null) return { ok: false, reason: `${label} assertion refused: ${error}` };
  return { ok: true, fmt: r.fmt };
}

/**
 * Check one version against the chain so far (`state` null for the first
 * version). Returns the next state or the reason the version is refused.
 */
export function applyTrustVersion(
  state: TrustChainState | null,
  file: ApproversFile,
  ctx: VersionContext,
): VersionResult {
  const refuse = (reason: string): VersionResult => ({
    ok: false,
    reason: `${reason} (at ${ctx.at})`,
  });
  const ids = file.body.approvers.map((a) => a.credentialId);
  if (state === null) {
    if (file.proof.kind !== "root") {
      return refuse("the first trust-file version must be an attested root");
    }
    const root = verifyRootProof(file, null, ctx);
    if (!root.ok) return refuse(root.reason);
    return {
      ok: true,
      state: {
        file,
        rootKind: root.fmt,
        epochStart: ctx.at,
        attested: new Set(ids),
        everEnrolled: new Set(ids),
        priorEpochs: new Set(),
      },
    };
  }
  const prev = state.file;
  if (file.proof.kind === "root") {
    return refuse(
      "only the first version may be a root; a later version is a transition or re-root",
    );
  }
  if (file.proof.kind === "re-root") {
    if (state.everEnrolled.has(file.proof.credentialId)) {
      return refuse("a re-root must use a credential no earlier version enrolled");
    }
    const root = verifyRootProof(file, prev, ctx);
    if (!root.ok) return refuse(root.reason);
    return {
      ok: true,
      state: {
        file,
        rootKind: root.fmt,
        epochStart: ctx.at,
        attested: new Set(ids),
        everEnrolled: new Set([...state.everEnrolled, ...ids]),
        priorEpochs: new Set(state.everEnrolled),
      },
    };
  }
  const signer = prev.body.approvers.find((a) => a.credentialId === file.proof.credentialId);
  if (signer === undefined) {
    return refuse("a transition must be signed by a credential of the preceding version");
  }
  const error = checkAssertion(
    file.proof.assertion,
    signer,
    prev.body.rp,
    transitionPayloadBytes(file, prev),
  );
  if (error !== null) return refuse(`transition assertion refused: ${error}`);
  for (const next of file.body.approvers) {
    const before = prev.body.approvers.find((a) => a.credentialId === next.credentialId);
    if (before !== undefined && !sameKey(before, next)) {
      return refuse(
        `a transition may rename credential ${next.credentialId} but not change its key`,
      );
    }
    if (before === undefined && state.priorEpochs.has(next.credentialId)) {
      return refuse(
        `credential ${next.credentialId} belongs to an earlier epoch; a re-root does not bring it back`,
      );
    }
  }
  const attested = new Set([...state.attested].filter((id) => ids.includes(id)));
  if (attested.size === 0) {
    return refuse("a transition must leave at least one attested credential in the set");
  }
  return {
    ok: true,
    state: {
      file,
      rootKind: state.rootKind,
      epochStart: state.epochStart,
      attested,
      everEnrolled: new Set([...state.everEnrolled, ...ids]),
      priorEpochs: state.priorEpochs,
    },
  };
}
