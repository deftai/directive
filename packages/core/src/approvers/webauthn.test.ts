import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode } from "./canonical.js";
import type { ApproversRp, SupportedCoseAlg } from "./types.js";
import {
  CborError,
  coseToPublicKey,
  decodeCbor,
  FLAG_AT,
  FLAG_UP,
  FLAG_UV,
  parseAuthenticatorData,
  publicKeyFromSpki,
  spkiOf,
  verifyAssertion,
} from "./webauthn.js";

const RP: ApproversRp = { id: "approve.example.com", origins: ["https://approve.example.com"] };
const PAYLOAD = new TextEncoder().encode('{"schema":"deft.record-approval.v1"}');

function sha(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function keyPair(alg: SupportedCoseAlg): { publicKey: KeyObject; privateKey: KeyObject } {
  if (alg === -7) return generateKeyPairSync("ec", { namedCurve: "P-256" });
  if (alg === -257) return generateKeyPairSync("rsa", { modulusLength: 2048 });
  return generateKeyPairSync("ed25519");
}

function signWith(alg: SupportedCoseAlg, key: KeyObject, data: Uint8Array): Buffer {
  if (alg === -7) return sign("sha256", data, { key, dsaEncoding: "der" });
  if (alg === -257) return sign("sha256", data, key);
  return sign(null, data, key);
}

interface AssertOptions {
  readonly alg?: SupportedCoseAlg;
  readonly flags?: number;
  readonly origin?: string;
  readonly rpId?: string;
  readonly type?: string;
  readonly crossOrigin?: boolean;
  readonly payload?: Uint8Array;
  readonly signer?: KeyObject;
}

function assertion(privateKey: KeyObject, opts: AssertOptions = {}) {
  const alg = opts.alg ?? -7;
  const auth = Buffer.concat([
    sha(new TextEncoder().encode(opts.rpId ?? RP.id)),
    Buffer.from([opts.flags ?? FLAG_UP | FLAG_UV, 0, 0, 0, 1]),
  ]);
  const client = Buffer.from(
    JSON.stringify({
      type: opts.type ?? "webauthn.get",
      challenge: base64urlEncode(sha(opts.payload ?? PAYLOAD)),
      origin: opts.origin ?? RP.origins[0],
      ...(opts.crossOrigin === undefined ? {} : { crossOrigin: opts.crossOrigin }),
    }),
  );
  const sig = signWith(alg, opts.signer ?? privateKey, Buffer.concat([auth, sha(client)]));
  return {
    authenticatorData: base64urlEncode(auth),
    clientDataJSON: base64urlEncode(client),
    signature: base64urlEncode(sig),
  };
}

function check(publicKey: KeyObject, a: ReturnType<typeof assertion>, alg: SupportedCoseAlg = -7) {
  return verifyAssertion({
    payloadBytes: PAYLOAD,
    rp: RP,
    alg,
    publicKey: base64urlEncode(spkiOf(publicKey)),
    ...a,
  });
}

/** Minimal CBOR encoder for test COSE keys. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("unsupported");
}

function coseOf(alg: SupportedCoseAlg, publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  const b = (s: string | undefined) => base64urlDecode(s ?? "")!;
  if (alg === -7) {
    return cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b(jwk.x)],
        [-3, b(jwk.y)],
      ]),
    );
  }
  if (alg === -257)
    return cbor(
      new Map<number, unknown>([
        [1, 3],
        [3, -257],
        [-1, b(jwk.n)],
        [-2, b(jwk.e)],
      ]),
    );
  return cbor(
    new Map<number, unknown>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, b(jwk.x)],
    ]),
  );
}

describe("verifyAssertion (#6945)", () => {
  for (const alg of [-7, -257, -8] as const) {
    it(`accepts a valid assertion (alg ${alg})`, () => {
      const { publicKey, privateKey } = keyPair(alg);
      expect(check(publicKey, assertion(privateKey, { alg }), alg)).toBeNull();
    });
  }

  it("refuses a signature by another key", () => {
    const { publicKey } = keyPair(-7);
    const other = keyPair(-7);
    expect(check(publicKey, assertion(other.privateKey))).toMatch(/signature does not verify/);
  });

  it("refuses when one payload byte changed", () => {
    const { publicKey, privateKey } = keyPair(-7);
    const changed = Uint8Array.from(PAYLOAD);
    changed[3] ^= 1;
    expect(check(publicKey, assertion(privateKey, { payload: changed }))).toMatch(/challenge/);
  });

  it("refuses an unknown origin, a wrong rp.id, crossOrigin true and a create ceremony", () => {
    const { publicKey, privateKey } = keyPair(-7);
    expect(check(publicKey, assertion(privateKey, { origin: "https://evil.example.com" }))).toMatch(
      /origin/,
    );
    expect(check(publicKey, assertion(privateKey, { rpId: "evil.example.com" }))).toMatch(
      /rpIdHash/,
    );
    expect(check(publicKey, assertion(privateKey, { crossOrigin: true }))).toMatch(/crossOrigin/);
    expect(check(publicKey, assertion(privateKey, { crossOrigin: false }))).toBeNull();
    expect(check(publicKey, assertion(privateKey, { type: "webauthn.create" }))).toMatch(/type/);
  });

  it("refuses when user verification or presence is missing", () => {
    const { publicKey, privateKey } = keyPair(-7);
    expect(check(publicKey, assertion(privateKey, { flags: FLAG_UP }))).toMatch(/user-verified/);
    expect(check(publicKey, assertion(privateKey, { flags: FLAG_UV }))).toMatch(/user-present/);
  });

  it("refuses a key whose type does not fit the enrolled alg", () => {
    const { publicKey, privateKey } = keyPair(-8);
    expect(check(publicKey, assertion(privateKey, { alg: -8 }), -7)).toMatch(/does not parse/);
    expect(publicKeyFromSpki(base64urlEncode(spkiOf(publicKey)), -257)).toBeNull();
  });
});

describe("CBOR and authenticator data (#6945)", () => {
  it("decodes maps and refuses tags, floats, indefinite lengths and duplicate keys", () => {
    const decoded = decodeCbor(
      cbor(
        new Map<unknown, unknown>([
          ["fmt", "none"],
          [1, -7],
        ]),
      ),
    );
    expect(decoded.value).toEqual(
      new Map<unknown, unknown>([
        ["fmt", "none"],
        [1, -7],
      ]),
    );
    expect(() => decodeCbor(Uint8Array.from([0xc0, 0x00]))).toThrow(CborError);
    expect(() => decodeCbor(Uint8Array.from([0xf9, 0x3c, 0x00]))).toThrow(CborError);
    expect(() => decodeCbor(Uint8Array.from([0x9f, 0xff]))).toThrow(CborError);
    expect(() => decodeCbor(Uint8Array.from([0xa2, 0x01, 0x00, 0x01, 0x00]))).toThrow(/duplicate/);
  });

  for (const alg of [-7, -257, -8] as const) {
    it(`reads attested credential data and converts the COSE key (alg ${alg})`, () => {
      const { publicKey } = keyPair(alg);
      const cose = coseOf(alg, publicKey);
      const credId = Buffer.from("credential-1");
      const auth = Buffer.concat([
        sha(new TextEncoder().encode(RP.id)),
        Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT, 0, 0, 0, 0]),
        Buffer.alloc(16, 7),
        Buffer.from([0, credId.length]),
        credId,
        cose,
      ]);
      const parsed = parseAuthenticatorData(auth);
      expect(Buffer.from(parsed.attested!.credentialId).toString()).toBe("credential-1");
      const converted = coseToPublicKey(parsed.attested!.cosePublicKey);
      expect(converted.alg).toBe(alg);
      expect(Buffer.from(spkiOf(converted.key)).equals(Buffer.from(spkiOf(publicKey)))).toBe(true);
      expect(() => parseAuthenticatorData(Buffer.concat([auth, Buffer.from([0])]))).toThrow(
        /trailing/,
      );
    });
  }
});
