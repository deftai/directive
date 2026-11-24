/**
 * WebAuthn assertion checks for signed approvals (#6945).
 *
 * Everything runs through `node:crypto`; there is no network read. Accepted
 * credential algorithms: ES256, RS256 and Ed25519. Keys are stored as
 * SubjectPublicKeyInfo DER; COSE keys from registrations are converted once.
 */
import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  type KeyObject,
  verify,
} from "node:crypto";
import { base64urlDecode, base64urlEncode } from "./canonical.js";
import {
  type ApproversRp,
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  SUPPORTED_COSE_ALGS,
  type SupportedCoseAlg,
} from "./types.js";

/** Authenticator data flag bits (WebAuthn Level 3, section 6.1). */
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

/** Nesting limit of the CBOR decoder; WebAuthn structures are shallow. */
const CBOR_MAX_DEPTH = 8;

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>;

/** Thrown on malformed or unsupported CBOR. */
export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

/**
 * Decode one definite-length CBOR item at `offset`. Supports the subset
 * WebAuthn uses: integers, byte and text strings, arrays, maps, false, true,
 * null and undefined. Tags, floats and indefinite lengths are refused.
 */
export function decodeCbor(
  bytes: Uint8Array,
  offset = 0,
  depth = 0,
): { value: CborValue; end: number } {
  if (depth > CBOR_MAX_DEPTH) throw new CborError("CBOR nesting too deep");
  if (offset >= bytes.length) throw new CborError("CBOR truncated");
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let pos = offset + 1;
  const readLength = (): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0) throw new CborError("CBOR indefinite or reserved length");
    if (pos + size > bytes.length) throw new CborError("CBOR truncated");
    let n = 0;
    for (let i = 0; i < size; i += 1) n = n * 256 + bytes[pos + i]!;
    pos += size;
    if (!Number.isSafeInteger(n)) throw new CborError("CBOR integer too large");
    return n;
  };
  if (major === 7) {
    if (info === 20) return { value: false, end: pos };
    if (info === 21) return { value: true, end: pos };
    if (info === 22) return { value: null, end: pos };
    if (info === 23) return { value: undefined, end: pos };
    throw new CborError("CBOR floats and simple values are not supported");
  }
  if (major === 6) throw new CborError("CBOR tags are not supported");
  const n = readLength();
  switch (major) {
    case 0:
      return { value: n, end: pos };
    case 1:
      return { value: -1 - n, end: pos };
    case 2:
    case 3: {
      if (pos + n > bytes.length) throw new CborError("CBOR truncated");
      const slice = bytes.slice(pos, pos + n);
      pos += n;
      if (major === 2) return { value: slice, end: pos };
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(slice), end: pos };
    }
    case 4: {
      const arr: CborValue[] = [];
      for (let i = 0; i < n; i += 1) {
        const item = decodeCbor(bytes, pos, depth + 1);
        arr.push(item.value);
        pos = item.end;
      }
      return { value: arr, end: pos };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < n; i += 1) {
        const key = decodeCbor(bytes, pos, depth + 1);
        if (typeof key.value !== "number" && typeof key.value !== "string") {
          throw new CborError("CBOR map keys must be integers or text");
        }
        if (map.has(key.value)) throw new CborError("CBOR map has a duplicate key");
        const value = decodeCbor(bytes, key.end, depth + 1);
        map.set(key.value, value.value);
        pos = value.end;
      }
      return { value: map, end: pos };
    }
    default:
      throw new CborError("CBOR major type not supported");
  }
}

/** sha256 of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** Lowercase hex sha256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export { bytesEqual };

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Format 16 bytes as a lowercase 8-4-4-4-12 UUID. */
export function formatAaguid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface AttestedCredentialData {
  readonly aaguid: Uint8Array;
  readonly credentialId: Uint8Array;
  /** Raw COSE_Key bytes. */
  readonly cosePublicKey: Uint8Array;
}

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly signCount: number;
  readonly attested: AttestedCredentialData | null;
}

/** Parse authenticator data; throws on malformed input or trailing bytes. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new CborError("authenticatorData shorter than 37 bytes");
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32]!;
  const signCount =
    ((bytes[33]! << 24) >>> 0) + (bytes[34]! << 16) + (bytes[35]! << 8) + bytes[36]!;
  let pos = 37;
  let attested: AttestedCredentialData | null = null;
  if ((flags & FLAG_AT) !== 0) {
    if (pos + 18 > bytes.length) throw new CborError("attested credential data truncated");
    const aaguid = bytes.slice(pos, pos + 16);
    const idLength = (bytes[pos + 16]! << 8) + bytes[pos + 17]!;
    pos += 18;
    if (pos + idLength > bytes.length) throw new CborError("credential id truncated");
    const credentialId = bytes.slice(pos, pos + idLength);
    pos += idLength;
    const key = decodeCbor(bytes, pos);
    const cosePublicKey = bytes.slice(pos, key.end);
    pos = key.end;
    attested = { aaguid, credentialId, cosePublicKey };
  }
  if ((flags & FLAG_ED) !== 0) {
    pos = decodeCbor(bytes, pos).end;
  }
  if (pos !== bytes.length) throw new CborError("authenticatorData has trailing bytes");
  return { rpIdHash, flags, signCount, attested };
}

function coseBytes(map: Map<CborValue, CborValue>, label: number): Uint8Array {
  const v = map.get(label);
  if (!(v instanceof Uint8Array)) throw new CborError(`COSE key parameter ${label} missing`);
  return v;
}

/** Convert a COSE_Key to a Node public key; only the three supported algorithms. */
export function coseToPublicKey(cose: Uint8Array): { alg: SupportedCoseAlg; key: KeyObject } {
  const decoded = decodeCbor(cose);
  if (decoded.end !== cose.length) throw new CborError("COSE key has trailing bytes");
  const map = decoded.value;
  if (!(map instanceof Map)) throw new CborError("COSE key must be a map");
  const kty = map.get(1);
  const alg = map.get(3);
  if (kty === 2 && alg === COSE_ALG_ES256) {
    if (map.get(-1) !== 1) throw new CborError("ES256 key must use curve P-256");
    const x = coseBytes(map, -2);
    const y = coseBytes(map, -3);
    if (x.length !== 32 || y.length !== 32)
      throw new CborError("P-256 coordinates must be 32 bytes");
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: base64urlEncode(x), y: base64urlEncode(y) },
      format: "jwk",
    });
    return { alg: COSE_ALG_ES256, key };
  }
  if (kty === 3 && alg === COSE_ALG_RS256) {
    const n = coseBytes(map, -1);
    const e = coseBytes(map, -2);
    const key = createPublicKey({
      key: { kty: "RSA", n: base64urlEncode(n), e: base64urlEncode(e) },
      format: "jwk",
    });
    return { alg: COSE_ALG_RS256, key };
  }
  if (kty === 1 && alg === COSE_ALG_EDDSA) {
    if (map.get(-1) !== 6) throw new CborError("EdDSA key must use curve Ed25519");
    const x = coseBytes(map, -2);
    if (x.length !== 32) throw new CborError("Ed25519 key must be 32 bytes");
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: base64urlEncode(x) },
      format: "jwk",
    });
    return { alg: COSE_ALG_EDDSA, key };
  }
  throw new CborError("COSE key is not ES256, RS256 or Ed25519");
}

/** SPKI DER of a public key. */
export function spkiOf(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ type: "spki", format: "der" }));
}

/** True when `alg` is one of the supported COSE algorithm ids. */
export function isSupportedAlg(alg: unknown): alg is SupportedCoseAlg {
  return typeof alg === "number" && (SUPPORTED_COSE_ALGS as readonly number[]).includes(alg);
}

/** Parse a base64url SPKI and check it fits `alg`. Null when it does not. */
export function publicKeyFromSpki(spkiB64: string, alg: SupportedCoseAlg): KeyObject | null {
  const der = base64urlDecode(spkiB64);
  if (der === null || der.length === 0) return null;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  } catch {
    return null;
  }
  const type = key.asymmetricKeyType;
  if (alg === COSE_ALG_ES256) {
    return type === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  }
  if (alg === COSE_ALG_RS256) return type === "rsa" ? key : null;
  return type === "ed25519" ? key : null;
}

/** Verify `signature` over `data` under `key` for a COSE algorithm. Never throws. */
export function verifyCoseSignature(
  alg: SupportedCoseAlg,
  key: KeyObject,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (alg === COSE_ALG_ES256) {
      return verify("sha256", data, { key, dsaEncoding: "der" }, signature);
    }
    if (alg === COSE_ALG_RS256) {
      return verify("sha256", data, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
    }
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

export interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin?: unknown;
}

/** Parse clientDataJSON bytes; null when not UTF-8 JSON with the string fields. */
export function parseClientData(bytes: Uint8Array): ClientData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.type !== "string" ||
    typeof rec.challenge !== "string" ||
    typeof rec.origin !== "string"
  ) {
    return null;
  }
  return {
    type: rec.type,
    challenge: rec.challenge,
    origin: rec.origin,
    crossOrigin: rec.crossOrigin,
  };
}

/**
 * Check clientDataJSON against the expected ceremony: type, challenge,
 * origin listed in `rp.origins`, and `crossOrigin` not true.
 */
export function checkClientData(
  clientData: ClientData | null,
  expected: {
    readonly type: "webauthn.get" | "webauthn.create";
    readonly challenge?: Uint8Array;
    readonly rp: ApproversRp;
  },
): string | null {
  if (clientData === null) return "clientDataJSON is not valid";
  if (clientData.type !== expected.type) return `clientDataJSON type must be ${expected.type}`;
  if (expected.challenge !== undefined) {
    if (clientData.challenge !== base64urlEncode(expected.challenge)) {
      return "challenge does not match the payload rebuilt from this repository";
    }
  }
  if (!expected.rp.origins.includes(clientData.origin)) {
    return `origin ${clientData.origin} is not in the trust file's rp.origins`;
  }
  if (clientData.crossOrigin === true) return "crossOrigin is true";
  return null;
}

/** Check rpIdHash and the user-present and user-verified flags. */
export function checkAuthenticatorFlags(auth: AuthenticatorData, rpId: string): string | null {
  if (!bytesEqual(auth.rpIdHash, sha256(new TextEncoder().encode(rpId)))) {
    return "rpIdHash does not match the trust file's rp.id";
  }
  if ((auth.flags & FLAG_UP) === 0) return "user-present flag not set";
  if ((auth.flags & FLAG_UV) === 0) return "user-verified flag not set";
  return null;
}

export interface AssertionInput {
  /** The bytes whose sha256 is the expected challenge. */
  readonly payloadBytes: Uint8Array;
  readonly rp: ApproversRp;
  readonly alg: SupportedCoseAlg;
  /** Base64url SPKI of the enrolled key. */
  readonly publicKey: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/**
 * Verify a WebAuthn get() assertion: challenge equals sha256 of the payload
 * bytes, type `webauthn.get`, origin in `rp.origins`, `crossOrigin` not true,
 * `rpIdHash` equals sha256 of `rp.id`, user present and user verified, and
 * the signature valid under the enrolled key. Null when valid, else the reason.
 */
export function verifyAssertion(input: AssertionInput): string | null {
  const authBytes = base64urlDecode(input.authenticatorData);
  const clientBytes = base64urlDecode(input.clientDataJSON);
  const signature = base64urlDecode(input.signature);
  if (authBytes === null || clientBytes === null || signature === null) {
    return "assertion fields must be base64url";
  }
  const clientError = checkClientData(parseClientData(clientBytes), {
    type: "webauthn.get",
    challenge: sha256(input.payloadBytes),
    rp: input.rp,
  });
  if (clientError !== null) return clientError;
  let auth: AuthenticatorData;
  try {
    auth = parseAuthenticatorData(authBytes);
  } catch (err: unknown) {
    return `authenticatorData is malformed: ${(err as Error).message}`;
  }
  const flagError = checkAuthenticatorFlags(auth, input.rp.id);
  if (flagError !== null) return flagError;
  const key = publicKeyFromSpki(input.publicKey, input.alg);
  if (key === null) return "enrolled public key does not parse for its algorithm";
  const signed = concat(authBytes, sha256(clientBytes));
  if (!verifyCoseSignature(input.alg, key, signed, signature)) {
    return "signature does not verify under the enrolled key";
  }
  return null;
}

export { concat as concatBytes };
