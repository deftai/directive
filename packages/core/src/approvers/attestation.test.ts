import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAttestedRegistration } from "./attestation.js";
import { base64urlDecode, base64urlEncode } from "./canonical.js";
import type { ApproversRp } from "./types.js";
import { VENDOR_ROOTS, type VendorRoot } from "./vendor-roots.js";
import { FLAG_AT, FLAG_BE, FLAG_UP, FLAG_UV, spkiOf } from "./webauthn.js";

const RP: ApproversRp = { id: "approve.example.com", origins: ["https://approve.example.com"] };
/** Raw bytes whose base64url is the fixture clientData challenge `Y2hhbGxlbmdl`. */
const CHALLENGE = new TextEncoder().encode("challenge");
const AAGUID = Buffer.from("cb69481e8ff7403993ec0a2729a154a8", "hex");

// --- DER builder (test only: certificates are made in memory per run) ---
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len =
    n < 128
      ? Buffer.from([n])
      : n < 256
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const int = (n: number) => tlv(0x02, Buffer.from([n]));
const octet = (b: Buffer) => tlv(0x04, b);
const bool = (b: boolean) => tlv(0x01, Buffer.from([b ? 0xff : 0]));
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    let v = n >> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function name(fields: [string, string][]): Buffer {
  const ids: Record<string, string> = {
    C: "2.5.4.6",
    O: "2.5.4.10",
    OU: "2.5.4.11",
    CN: "2.5.4.3",
  };
  return seq(
    ...fields.map(([k, v]) => set(seq(oid(ids[k]!), tlv(k === "C" ? 0x13 : 0x0c, Buffer.from(v))))),
  );
}
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

interface CertSpec {
  subject: [string, string][];
  issuer: [string, string][];
  key: KeyObject;
  issuerKey: KeyObject;
  ca: boolean;
  aaguid?: Buffer | null;
  version1?: boolean;
  serial: number;
  notBefore?: string;
  notAfter?: string;
}

function cert(spec: CertSpec): Buffer {
  const exts: Buffer[] = [
    seq(
      oid("2.5.29.19"),
      ...(spec.ca ? [bool(true)] : []),
      octet(spec.ca ? seq(bool(true)) : seq()),
    ),
  ];
  if (spec.aaguid !== undefined && spec.aaguid !== null) {
    exts.push(seq(oid("1.3.6.1.4.1.45724.1.1.4"), octet(octet(spec.aaguid))));
  }
  const tbs = seq(
    ...(spec.version1 === true ? [] : [tlv(0xa0, int(2))]),
    int(spec.serial),
    ECDSA_SHA256,
    name(spec.issuer),
    seq(
      tlv(0x17, Buffer.from(spec.notBefore ?? "200101000000Z")),
      tlv(0x17, Buffer.from(spec.notAfter ?? "491231235959Z")),
    ),
    name(spec.subject),
    spec.key.export({ type: "spki", format: "der" }),
    ...(spec.version1 === true ? [] : [tlv(0xa3, seq(...exts))]),
  );
  const sig = sign("sha256", tbs, { key: spec.issuerKey, dsaEncoding: "der" });
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

// --- CBOR builder ---
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (typeof value === "string")
    return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("unsupported");
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest();

function ec(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

function coseEc(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  return cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, base64urlDecode(jwk.x!)!],
      [-3, base64urlDecode(jwk.y!)!],
    ]),
  );
}

const ROOT_NAME: [string, string][] = [["CN", "Test Attestation Root"]];
const LEAF_NAME: [string, string][] = [
  ["C", "SE"],
  ["O", "Test Vendor"],
  ["OU", "Authenticator Attestation"],
  ["CN", "Test EE"],
];

interface RegOptions {
  fmt?: string;
  leafAaguid?: Buffer | null;
  leafSubject?: [string, string][];
  leafIsCredential?: boolean;
  noX5c?: boolean;
  intermediate?: boolean;
  flags?: number;
  origin?: string;
  tamper?: boolean;
  version1?: boolean;
  rootNotAfter?: string;
  leafNotBefore?: string;
}

function makeRegistration(opts: RegOptions = {}) {
  const root = ec();
  const rootDer = cert({
    subject: ROOT_NAME,
    issuer: ROOT_NAME,
    key: root.publicKey,
    issuerKey: root.privateKey,
    ca: true,
    serial: 1,
    notAfter: opts.rootNotAfter,
  });
  const rootCert = new X509Certificate(rootDer);
  const vendorRoot: VendorRoot = {
    vendor: "Test",
    name: "Test Attestation Root",
    sourceUrl: "test://in-memory",
    sha256: rootCert.fingerprint256,
    pem: rootCert.toString(),
  };
  const credential = ec();
  const leafKey = opts.leafIsCredential === true ? credential : ec();
  let issuerKey = root.privateKey;
  let issuerName = ROOT_NAME;
  const chain: Buffer[] = [];
  if (opts.intermediate === true) {
    const mid = ec();
    const midName: [string, string][] = [["CN", "Test Intermediate"]];
    chain.push(
      cert({
        subject: midName,
        issuer: ROOT_NAME,
        key: mid.publicKey,
        issuerKey: root.privateKey,
        ca: true,
        serial: 2,
      }),
    );
    issuerKey = mid.privateKey;
    issuerName = midName;
  }
  const leafDer = cert({
    subject: opts.leafSubject ?? LEAF_NAME,
    issuer: issuerName,
    key: leafKey.publicKey,
    issuerKey,
    ca: false,
    aaguid: opts.leafAaguid === undefined ? AAGUID : opts.leafAaguid,
    version1: opts.version1,
    serial: 3,
    notBefore: opts.leafNotBefore,
  });
  const credId = Buffer.from("root-credential");
  const authData = Buffer.concat([
    sha(Buffer.from(RP.id)),
    Buffer.from([opts.flags ?? FLAG_UP | FLAG_UV | FLAG_AT, 0, 0, 0, 0]),
    AAGUID,
    Buffer.from([0, credId.length]),
    credId,
    coseEc(credential.publicKey),
  ]);
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge: "Y2hhbGxlbmdl",
      origin: opts.origin ?? RP.origins[0],
    }),
  );
  const sig = sign("sha256", Buffer.concat([authData, sha(clientData)]), {
    key: leafKey.privateKey,
    dsaEncoding: "der",
  });
  const attStmt = new Map<string, unknown>([
    ["alg", -7],
    ["sig", sig],
  ]);
  if (opts.noX5c !== true) attStmt.set("x5c", [leafDer, ...chain]);
  const signedAuth = opts.tamper === true ? Buffer.from(authData) : authData;
  if (opts.tamper === true) signedAuth[33] = 9;
  const attestationObject = cbor(
    new Map<string, unknown>([
      ["fmt", opts.fmt ?? "packed"],
      ["attStmt", opts.fmt === "none" ? new Map() : attStmt],
      ["authData", signedAuth],
    ]),
  );
  return {
    input: {
      attestationObject: base64urlEncode(attestationObject),
      clientDataJSON: base64urlEncode(clientData),
      rp: RP,
    },
    roots: [vendorRoot],
    credential,
  };
}

describe("verifyAttestedRegistration (#6945)", () => {
  it("accepts a packed registration that chains to a vendored root", () => {
    const reg = makeRegistration();
    const result = verifyAttestedRegistration(reg.input, {
      roots: reg.roots,
      expectedChallenge: CHALLENGE,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.registration.fmt).toBe("packed");
    expect(result.registration.alg).toBe(-7);
    expect(result.registration.aaguid).toBe("cb69481e-8ff7-4039-93ec-0a2729a154a8");
    expect(result.registration.publicKey).toBe(base64urlEncode(spkiOf(reg.credential.publicKey)));
    expect(result.registration.backupEligible).toBe(false);
  });

  it("accepts a chain through an intermediate and reports backup eligibility", () => {
    const reg = makeRegistration({
      intermediate: true,
      flags: FLAG_UP | FLAG_UV | FLAG_AT | FLAG_BE,
    });
    const result = verifyAttestedRegistration(reg.input, {
      roots: reg.roots,
      expectedChallenge: CHALLENGE,
    });
    expect(result.ok && result.registration.backupEligible).toBe(true);
  });

  it("refuses a chain that does not end at a vendored root, including the shipped roots", () => {
    const reg = makeRegistration();
    const other = makeRegistration();
    expect(
      verifyAttestedRegistration(reg.input, { roots: other.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/vendored vendor root/),
    });
    expect(verifyAttestedRegistration(reg.input, { expectedChallenge: CHALLENGE })).toMatchObject({
      ok: false,
    });
  });

  it("refuses none and self attestation", () => {
    const none = makeRegistration({ fmt: "none" });
    expect(
      verifyAttestedRegistration(none.input, { roots: none.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/none attestation/),
    });
    const self = makeRegistration({ noX5c: true });
    expect(
      verifyAttestedRegistration(self.input, { roots: self.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/self attestation/),
    });
  });

  it("refuses a format with no profile instead of downgrading it", () => {
    const reg = makeRegistration({ fmt: "tpm" });
    expect(
      verifyAttestedRegistration(reg.input, { roots: reg.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no profile/),
    });
  });

  it("refuses a leaf whose AAGUID is missing or differs", () => {
    for (const leafAaguid of [null, Buffer.alloc(16, 1)]) {
      const reg = makeRegistration({ leafAaguid });
      expect(
        verifyAttestedRegistration(reg.input, { roots: reg.roots, expectedChallenge: CHALLENGE }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/AAGUID/),
      });
    }
  });

  it("refuses a leaf without the attestation OU, a v1 leaf, and a leaf that is the credential key", () => {
    const ou = makeRegistration({
      leafSubject: [
        ["C", "SE"],
        ["O", "X"],
        ["OU", "Other"],
        ["CN", "Y"],
      ],
    });
    expect(
      verifyAttestedRegistration(ou.input, { roots: ou.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/OU/),
    });
    const v1 = makeRegistration({ version1: true });
    expect(
      verifyAttestedRegistration(v1.input, { roots: v1.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/version 3/),
    });
    const same = makeRegistration({ leafIsCredential: true });
    expect(
      verifyAttestedRegistration(same.input, { roots: same.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/must not be the attestation signer/),
    });
  });

  it("refuses altered authenticator data, a wrong origin and a missing UV flag", () => {
    const tampered = makeRegistration({ tamper: true });
    expect(
      verifyAttestedRegistration(tampered.input, {
        roots: tampered.roots,
        expectedChallenge: CHALLENGE,
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/signature does not verify/),
    });
    const origin = makeRegistration({ origin: "https://evil.example.com" });
    expect(
      verifyAttestedRegistration(origin.input, {
        roots: origin.roots,
        expectedChallenge: CHALLENGE,
      }),
    ).toMatchObject({ ok: false });
    const noUv = makeRegistration({ flags: FLAG_UP | FLAG_AT });
    expect(
      verifyAttestedRegistration(noUv.input, { roots: noUv.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/user-verified/),
    });
  });

  it("refuses a registration whose challenge is not the expected one", () => {
    const reg = makeRegistration();
    expect(
      verifyAttestedRegistration(reg.input, {
        roots: reg.roots,
        expectedChallenge: new TextEncoder().encode("other"),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/challenge/) });
  });

  it("refuses clientDataJSON that is not valid UTF-8", () => {
    const reg = makeRegistration();
    const bad = base64urlEncode(Uint8Array.from([0xff, 0xfe, 0xfd]));
    expect(
      verifyAttestedRegistration(
        { ...reg.input, clientDataJSON: bad },
        { roots: reg.roots, expectedChallenge: CHALLENGE },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/clientDataJSON/) });
  });

  it("refuses a certificate outside its validity period, including the anchor", () => {
    const leaf = makeRegistration({ leafNotBefore: "490101000000Z" });
    expect(
      verifyAttestedRegistration(leaf.input, { roots: leaf.roots, expectedChallenge: CHALLENGE }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/validity/) });
    const anchor = makeRegistration({ rootNotAfter: "210101000000Z" });
    expect(
      verifyAttestedRegistration(anchor.input, {
        roots: anchor.roots,
        expectedChallenge: CHALLENGE,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/validity/) });
  });
});

describe("vendored roots (#6945)", () => {
  it("each vendored root parses, is a self-signed CA and matches its recorded fingerprint", () => {
    expect(VENDOR_ROOTS.length).toBeGreaterThan(0);
    for (const root of VENDOR_ROOTS) {
      const cert = new X509Certificate(root.pem);
      expect(cert.fingerprint256, root.name).toBe(root.sha256);
      expect(cert.ca, root.name).toBe(true);
      expect(cert.verify(cert.publicKey), root.name).toBe(true);
      expect(cert.subject).toContain(root.name);
      expect(root.sourceUrl).toMatch(/^https:\/\/developers\.yubico\.com\/PKI\//);
    }
  });
});
