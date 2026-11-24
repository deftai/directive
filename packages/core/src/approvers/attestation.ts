/**
 * Attested registration check for trust-file roots (#6945).
 *
 * The first `.deft/approvers.json` version, and every re-root, needs a
 * registration whose attestation passes a format profile. A profile ends at a
 * vendored root (`vendor-roots.ts`), never the OS trust store. `none` and self
 * attestation are refused: a key pair any process can make cannot anchor
 * approval. A registration whose claimed attestation fails its profile is
 * refused, never downgraded.
 *
 * This story ships the `packed` profile only. Profiles are keyed by format so
 * a later story can add `tpm` (#7046) without changing callers; the format a
 * root passed is reported as the root kind.
 */
import { X509Certificate } from "node:crypto";
import { base64urlDecode, base64urlEncode } from "./canonical.js";
import type { ApproversRp, SupportedCoseAlg } from "./types.js";
import { VENDOR_ROOTS, type VendorRoot } from "./vendor-roots.js";
import {
  type AuthenticatorData,
  bytesEqual,
  type CborValue,
  checkAuthenticatorFlags,
  checkClientData,
  concatBytes,
  coseToPublicKey,
  decodeCbor,
  FLAG_AT,
  FLAG_BE,
  formatAaguid,
  isSupportedAlg,
  parseAuthenticatorData,
  parseClientData,
  sha256,
  spkiOf,
  verifyCoseSignature,
} from "./webauthn.js";

/** Longest x5c chain accepted (leaf plus intermediates). */
const MAX_X5C_CERTS = 5;
/** id-fido-gen-ce-aaguid (1.3.6.1.4.1.45724.1.1.4), DER-encoded OID body. */
const AAGUID_EXTENSION_OID = Uint8Array.from([
  0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xe5, 0x1c, 0x01, 0x01, 0x04,
]);
/** Subject OU a packed attestation leaf must carry (WebAuthn section 8.2.1). */
const PACKED_LEAF_OU = "Authenticator Attestation";

/** The credential a verified registration enrolls. Binary fields are base64url. */
export interface AttestedRegistration {
  /** The attestation format whose profile passed; reported as the root kind. */
  readonly fmt: string;
  readonly credentialId: string;
  /** SubjectPublicKeyInfo DER, base64url. */
  readonly publicKey: string;
  readonly alg: SupportedCoseAlg;
  readonly aaguid: string;
  readonly backupEligible: boolean;
}

export interface RegistrationInput {
  readonly attestationObject: string;
  readonly clientDataJSON: string;
  readonly rp: ApproversRp;
}

export type RegistrationResult =
  | { readonly ok: true; readonly registration: AttestedRegistration }
  | { readonly ok: false; readonly reason: string };

/** Checks one registration; injectable so trust-file tests need no hardware. */
export type RegistrationVerifier = (input: RegistrationInput) => RegistrationResult;

interface ProfileInput {
  readonly attStmt: Map<CborValue, CborValue>;
  readonly authDataBytes: Uint8Array;
  readonly auth: AuthenticatorData;
  readonly clientDataHash: Uint8Array;
  /** SPKI DER of the credential key. */
  readonly credentialSpki: Uint8Array;
  readonly roots: readonly VendorRoot[];
}

type Profile = (input: ProfileInput) => string | null;

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (offset + 2 > bytes.length) throw new Error("DER truncated");
  const tag = bytes[offset]!;
  let len = bytes[offset + 1]!;
  let pos = offset + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4 || pos + count > bytes.length) throw new Error("DER bad length");
    len = 0;
    for (let i = 0; i < count; i += 1) len = len * 256 + bytes[pos + i]!;
    pos += count;
  }
  if (pos + len > bytes.length) throw new Error("DER truncated");
  return { tag, start: pos, end: pos + len };
}

function children(bytes: Uint8Array, outer: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = outer.start;
  while (pos < outer.end) {
    const tlv = readTlv(bytes, pos);
    out.push(tlv);
    pos = tlv.end;
  }
  return out;
}

interface LeafFacts {
  readonly version: number;
  /** extnValue bytes of the AAGUID extension, or null. */
  readonly aaguidExtension: { readonly value: Uint8Array; readonly critical: boolean } | null;
}

/** Read the version and the AAGUID extension from a certificate's DER. */
function leafFacts(der: Uint8Array): LeafFacts {
  const cert = readTlv(der, 0);
  const tbs = children(der, cert)[0];
  if (tbs === undefined) throw new Error("certificate has no tbsCertificate");
  const fields = children(der, tbs);
  let version = 1;
  const first = fields[0];
  if (first !== undefined && first.tag === 0xa0) {
    const int = readTlv(der, first.start);
    if (int.tag !== 0x02 || int.end - int.start !== 1) throw new Error("bad version");
    version = der[int.start]! + 1;
  }
  let aaguidExtension: LeafFacts["aaguidExtension"] = null;
  const extWrapper = fields.find((f) => f.tag === 0xa3);
  if (extWrapper !== undefined) {
    const extSeq = readTlv(der, extWrapper.start);
    for (const ext of children(der, extSeq)) {
      const parts = children(der, ext);
      const oid = parts[0];
      if (oid === undefined || oid.tag !== 0x06) continue;
      if (!bytesEqual(der.slice(oid.start, oid.end), AAGUID_EXTENSION_OID)) continue;
      let critical = false;
      let valueTlv = parts[1];
      if (valueTlv !== undefined && valueTlv.tag === 0x01) {
        critical = der[valueTlv.start] !== 0;
        valueTlv = parts[2];
      }
      if (valueTlv === undefined || valueTlv.tag !== 0x04) throw new Error("bad AAGUID extension");
      aaguidExtension = { value: der.slice(valueTlv.start, valueTlv.end), critical };
    }
  }
  return { version, aaguidExtension };
}

function subjectFields(cert: X509Certificate): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of cert.subject.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

function keyFitsAlg(cert: X509Certificate, alg: SupportedCoseAlg): boolean {
  const key = cert.publicKey;
  if (alg === -7) {
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  }
  if (alg === -257) return key.asymmetricKeyType === "rsa";
  return key.asymmetricKeyType === "ed25519";
}

/** Null when the chain ends at a vendored root. */
function chainError(certs: readonly X509Certificate[], roots: readonly VendorRoot[]): string | null {
  for (let i = 0; i + 1 < certs.length; i += 1) {
    const child = certs[i]!;
    const parent = certs[i + 1]!;
    if (!parent.ca) return "an x5c intermediate is not a CA certificate";
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      return "x5c chain signature does not verify";
    }
  }
  const last = certs[certs.length - 1]!;
  for (const root of roots) {
    let anchor: X509Certificate;
    try {
      anchor = new X509Certificate(root.pem);
    } catch {
      continue;
    }
    if (anchor.fingerprint256 !== root.sha256) continue;
    if (last.fingerprint256 === anchor.fingerprint256) return null;
    if (last.checkIssued(anchor) && last.verify(anchor.publicKey)) return null;
  }
  return "x5c chain does not end at a vendored vendor root";
}

/** `packed` with a full x5c chain (WebAuthn section 8.2); self attestation refused. */
const packedProfile: Profile = (input) => {
  const alg = input.attStmt.get("alg");
  const sig = input.attStmt.get("sig");
  const x5c = input.attStmt.get("x5c");
  if (input.attStmt.has("ecdaaKeyId")) return "packed ECDAA attestation is not supported";
  if (x5c === undefined) return "packed self attestation cannot root a trust file";
  if (!isSupportedAlg(alg)) return "packed attestation alg is not ES256, RS256 or Ed25519";
  if (!(sig instanceof Uint8Array)) return "packed attestation sig is missing";
  if (!Array.isArray(x5c) || x5c.length === 0 || x5c.length > MAX_X5C_CERTS) {
    return `packed x5c must hold 1 to ${MAX_X5C_CERTS} certificates`;
  }
  const certs: X509Certificate[] = [];
  for (const item of x5c) {
    if (!(item instanceof Uint8Array)) return "packed x5c entries must be byte strings";
    try {
      certs.push(new X509Certificate(Buffer.from(item)));
    } catch {
      return "packed x5c entry is not a certificate";
    }
  }
  const leaf = certs[0]!;
  if (!keyFitsAlg(leaf, alg)) return "attestation leaf key does not fit the stated alg";
  const signed = concatBytes(input.authDataBytes, input.clientDataHash);
  if (!verifyCoseSignature(alg, leaf.publicKey, signed, sig)) {
    return "packed attestation signature does not verify under the leaf certificate";
  }
  let facts: LeafFacts;
  try {
    facts = leafFacts(new Uint8Array(leaf.raw));
  } catch (err: unknown) {
    return `attestation leaf certificate is malformed: ${(err as Error).message}`;
  }
  if (facts.version !== 3) return "attestation leaf certificate must be version 3";
  if (leaf.ca) return "attestation leaf certificate must not be a CA";
  const subject = subjectFields(leaf);
  if (subject.get("OU") !== PACKED_LEAF_OU) {
    return `attestation leaf subject OU must be ${PACKED_LEAF_OU}`;
  }
  for (const field of ["C", "O", "CN"]) {
    if ((subject.get(field) ?? "").length === 0) return `attestation leaf subject lacks ${field}`;
  }
  const aaguid = input.auth.attested?.aaguid;
  const ext = facts.aaguidExtension;
  if (ext === null) return "attestation leaf has no AAGUID extension";
  if (ext.critical) return "attestation leaf AAGUID extension must not be critical";
  let extAaguid: Uint8Array;
  try {
    const inner = readTlv(ext.value, 0);
    if (inner.tag !== 0x04 || inner.end !== ext.value.length) throw new Error("bad");
    extAaguid = ext.value.slice(inner.start, inner.end);
  } catch {
    return "attestation leaf AAGUID extension is malformed";
  }
  if (aaguid === undefined || !bytesEqual(extAaguid, aaguid)) {
    return "attestation leaf AAGUID does not equal the authenticator data AAGUID";
  }
  if (bytesEqual(spkiOf(leaf.publicKey), input.credentialSpki)) {
    return "the credential key must not be the attestation signer";
  }
  return chainError(certs, input.roots);
};

/** Format profiles a root registration may pass. `none` is never a profile. */
export const ATTESTATION_PROFILES: Readonly<Record<string, Profile>> = {
  packed: packedProfile,
};

/**
 * Verify a WebAuthn create() result as an attested root key: client data
 * (`webauthn.create`, origin in `rp.origins`, not cross-origin), `rpIdHash`,
 * user present and verified, attested credential data, and the attestation
 * statement under its format profile against vendored roots.
 */
export function verifyAttestedRegistration(
  input: RegistrationInput,
  options: { readonly roots?: readonly VendorRoot[] } = {},
): RegistrationResult {
  const roots = options.roots ?? VENDOR_ROOTS;
  const refuse = (reason: string): RegistrationResult => ({ ok: false, reason });
  const attBytes = base64urlDecode(input.attestationObject);
  const clientBytes = base64urlDecode(input.clientDataJSON);
  if (attBytes === null || clientBytes === null) return refuse("registration fields must be base64url");
  const clientError = checkClientData(parseClientData(clientBytes), {
    type: "webauthn.create",
    rp: input.rp,
  });
  if (clientError !== null) return refuse(clientError);
  let attObj: Map<CborValue, CborValue>;
  try {
    const decoded = decodeCbor(attBytes);
    if (decoded.end !== attBytes.length || !(decoded.value instanceof Map)) {
      throw new Error("attestationObject must be one CBOR map");
    }
    attObj = decoded.value;
  } catch (err: unknown) {
    return refuse(`attestationObject is malformed: ${(err as Error).message}`);
  }
  const fmt = attObj.get("fmt");
  const attStmt = attObj.get("attStmt");
  const authDataBytes = attObj.get("authData");
  if (typeof fmt !== "string" || !(attStmt instanceof Map) || !(authDataBytes instanceof Uint8Array)) {
    return refuse("attestationObject must hold fmt, attStmt and authData");
  }
  if (fmt === "none") return refuse("none attestation cannot root a trust file");
  const profile = ATTESTATION_PROFILES[fmt];
  if (profile === undefined) return refuse(`attestation format ${fmt} has no profile in this release`);
  let auth: AuthenticatorData;
  try {
    auth = parseAuthenticatorData(authDataBytes);
  } catch (err: unknown) {
    return refuse(`authenticatorData is malformed: ${(err as Error).message}`);
  }
  const flagError = checkAuthenticatorFlags(auth, input.rp.id);
  if (flagError !== null) return refuse(flagError);
  if ((auth.flags & FLAG_AT) === 0 || auth.attested === null) {
    return refuse("registration has no attested credential data");
  }
  let credential: ReturnType<typeof coseToPublicKey>;
  try {
    credential = coseToPublicKey(auth.attested.cosePublicKey);
  } catch (err: unknown) {
    return refuse(`credential public key: ${(err as Error).message}`);
  }
  const credentialSpki = spkiOf(credential.key);
  const profileError = profile({
    attStmt,
    authDataBytes,
    auth,
    clientDataHash: sha256(clientBytes),
    credentialSpki,
    roots,
  });
  if (profileError !== null) return refuse(profileError);
  return {
    ok: true,
    registration: {
      fmt,
      credentialId: base64urlEncode(auth.attested.credentialId),
      publicKey: base64urlEncode(credentialSpki),
      alg: credential.alg,
      aaguid: formatAaguid(auth.attested.aaguid),
      backupEligible: (auth.flags & FLAG_BE) !== 0,
    },
  };
}
