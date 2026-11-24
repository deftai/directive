import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RegistrationVerifier } from "./attestation.js";
import { base64urlEncode } from "./canonical.js";
import {
  applyTrustVersion,
  parseApproversFile,
  type TrustChainState,
  transitionPayloadBytes,
} from "./trust-file.js";
import type { Approver, ApproversFile, ApproversRp, AssertionProof } from "./types.js";
import { FLAG_UP, FLAG_UV, spkiOf } from "./webauthn.js";

const RP: ApproversRp = { id: "approve.example.com", origins: ["https://approve.example.com"] };
const REPO = "deftai/directive";

// --- soft authenticator (test only) ---
interface Soft {
  readonly approver: Approver;
  readonly privateKey: KeyObject;
}
const attestedTokens = new Map<string, Approver>();

function soft(name: string, attested: boolean): Soft {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const approver: Approver = {
    name,
    credentialId: base64urlEncode(randomBytes(16)),
    publicKey: base64urlEncode(spkiOf(publicKey)),
    alg: -7,
    aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
    backupEligible: !attested,
  };
  if (attested) attestedTokens.set(`att-${approver.credentialId}`, approver);
  return { approver, privateKey };
}

/** Stub for the hardware profile: only tokens minted by `soft(.., true)` pass. */
const stubVerifier: RegistrationVerifier = (input) => {
  const a = attestedTokens.get(input.attestationObject);
  if (a === undefined) return { ok: false, reason: "none attestation cannot root a trust file" };
  const { name: _name, ...credential } = a;
  return { ok: true, registration: { fmt: "packed", ...credential } };
};

function sha(b: Uint8Array): Buffer {
  return createHash("sha256").update(b).digest();
}

function assertOver(signer: Soft, payload: Uint8Array, rp: ApproversRp = RP): AssertionProof {
  const auth = Buffer.concat([
    sha(Buffer.from(rp.id)),
    Buffer.from([FLAG_UP | FLAG_UV, 0, 0, 0, 1]),
  ]);
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: base64urlEncode(sha(payload)),
      origin: rp.origins[0],
    }),
  );
  const sig = sign("sha256", Buffer.concat([auth, sha(client)]), {
    key: signer.privateKey,
    dsaEncoding: "der",
  });
  return {
    authenticatorData: base64urlEncode(auth),
    clientDataJSON: base64urlEncode(client),
    signature: base64urlEncode(sig),
  };
}

const PLACEHOLDER: AssertionProof = {
  authenticatorData: "AA",
  clientDataJSON: "AA",
  signature: "AA",
};

function rootFile(
  key: Soft,
  kind: "root" | "re-root" = "root",
  prev: ApproversFile | null = null,
): ApproversFile {
  const draft: ApproversFile = {
    schema: "deft.approvers.v1",
    body: { repo: REPO, rp: RP, approvers: [key.approver] },
    proof: {
      kind,
      credentialId: key.approver.credentialId,
      registration: {
        attestationObject: `att-${key.approver.credentialId}`,
        clientDataJSON: "e30",
      },
      assertion: PLACEHOLDER,
    },
  };
  return {
    ...draft,
    proof: { ...draft.proof, assertion: assertOver(key, transitionPayloadBytes(draft, prev)) },
  } as ApproversFile;
}

function transition(
  prev: ApproversFile,
  approvers: Approver[],
  signer: Soft,
  opts: { rp?: ApproversRp; signedPrev?: ApproversFile } = {},
): ApproversFile {
  const draft: ApproversFile = {
    schema: "deft.approvers.v1",
    body: { repo: REPO, rp: opts.rp ?? prev.body.rp, approvers },
    proof: {
      kind: "transition",
      credentialId: signer.approver.credentialId,
      assertion: PLACEHOLDER,
    },
  };
  const assertion = assertOver(
    signer,
    transitionPayloadBytes(draft, opts.signedPrev ?? prev),
    prev.body.rp,
  );
  return { ...draft, proof: { ...draft.proof, assertion } } as ApproversFile;
}

function chain(
  files: ApproversFile[],
): { ok: true; state: TrustChainState } | { ok: false; reason: string } {
  let state: TrustChainState | null = null;
  for (const [i, file] of files.entries()) {
    const r = applyTrustVersion(state, file, { at: `c${i}`, verifyRegistration: stubVerifier });
    if (!r.ok) return r;
    state = r.state;
  }
  return { ok: true, state: state! };
}

describe("parseApproversFile (#6945)", () => {
  it("parses a root file and refuses unknown keys at every level", () => {
    const file = rootFile(soft("yubikey", true));
    expect(parseApproversFile(JSON.stringify(file))).toEqual(file);
    expect(parseApproversFile(JSON.stringify({ ...file, level: "signed" }))).toMatchObject({
      error: /exactly/,
    });
    const bodyExtra = { ...file, body: { ...file.body, rootKind: "packed" } };
    expect(parseApproversFile(JSON.stringify(bodyExtra))).toMatchObject({ error: /exactly/ });
    const apExtra = {
      ...file,
      body: { ...file.body, approvers: [{ ...file.body.approvers[0], attested: true }] },
    };
    expect(parseApproversFile(JSON.stringify(apExtra))).toMatchObject({ error: /exactly/ });
  });

  it("refuses a localhost rp, an http origin and an origin off rp.id", () => {
    const file = rootFile(soft("yubikey", true));
    const withRp = (rp: unknown) => JSON.stringify({ ...file, body: { ...file.body, rp } });
    expect(
      parseApproversFile(withRp({ id: "localhost", origins: ["https://localhost"] })),
    ).toMatchObject({ error: /localhost/ });
    expect(
      parseApproversFile(withRp({ id: RP.id, origins: ["http://approve.example.com"] })),
    ).toMatchObject({ error: /https/ });
    expect(
      parseApproversFile(withRp({ id: RP.id, origins: ["https://evil.example.org"] })),
    ).toMatchObject({ error: /not on rp.id/ });
  });
});

describe("applyTrustVersion (#6945)", () => {
  it("accepts an attested root and reports its kind", () => {
    const result = chain([rootFile(soft("yubikey", true))]);
    expect(result.ok && result.state.rootKind).toBe("packed");
    expect(result.ok && result.state.epochStart).toBe("c0");
  });

  it("refuses a root whose registration has none or self attestation", () => {
    expect(chain([rootFile(soft("phone", false))])).toMatchObject({
      ok: false,
      reason: /none attestation/,
    });
  });

  it("refuses a first version that is not a root, and a later root", () => {
    const key = soft("yubikey", true);
    const root = rootFile(key);
    const t = transition(root, [key.approver], key);
    expect(chain([t])).toMatchObject({ ok: false, reason: /first trust-file version/ });
    expect(chain([root, rootFile(soft("yubikey2", true))])).toMatchObject({
      ok: false,
      reason: /only the first version/,
    });
  });

  it("refuses a root whose registration differs from the listed approver", () => {
    const key = soft("yubikey", true);
    const root = rootFile(key);
    const lying = {
      ...root,
      body: { ...root.body, approvers: [{ ...key.approver, backupEligible: true }] },
    };
    expect(chain([lying as ApproversFile])).toMatchObject({ ok: false });
  });

  it("adds a key by a transition signed by an enrolled key", () => {
    const key = soft("yubikey", true);
    const phone = soft("phone", false);
    const root = rootFile(key);
    const result = chain([root, transition(root, [key.approver, phone.approver], key)]);
    expect(result.ok).toBe(true);
    expect(result.ok && [...result.state.attested]).toEqual([key.approver.credentialId]);
  });

  it("refuses a transition signed by a key not in the predecessor", () => {
    const key = soft("yubikey", true);
    const agent = soft("agent", false);
    const root = rootFile(key);
    expect(chain([root, transition(root, [key.approver, agent.approver], agent)])).toMatchObject({
      ok: false,
      reason: /preceding version/,
    });
  });

  it("refuses removal of the last attested credential", () => {
    const key = soft("yubikey", true);
    const phone = soft("phone", false);
    const root = rootFile(key);
    const added = transition(root, [key.approver, phone.approver], key);
    expect(chain([root, added, transition(added, [phone.approver], phone)])).toMatchObject({
      ok: false,
      reason: /attested credential/,
    });
  });

  it("refuses a transition that changes an enrolled credential's key", () => {
    const key = soft("yubikey", true);
    const root = rootFile(key);
    const swapped = { ...key.approver, publicKey: soft("x", false).approver.publicKey };
    expect(chain([root, transition(root, [swapped], key)])).toMatchObject({
      ok: false,
      reason: /not change its key/,
    });
    const renamed = { ...key.approver, name: "renamed" };
    expect(chain([root, transition(root, [renamed], key)]).ok).toBe(true);
  });

  it("refuses a transition signed over another predecessor", () => {
    const key = soft("yubikey", true);
    const phone = soft("phone", false);
    const root = rootFile(key);
    const b = transition(root, [key.approver, phone.approver], key);
    const c = transition(b, [key.approver], key, { signedPrev: root });
    expect(chain([root, b, c])).toMatchObject({
      ok: false,
      reason: /transition assertion refused/,
    });
  });

  it("moves the page only by a signed change verified at the old rp", () => {
    const key = soft("yubikey", true);
    const root = rootFile(key);
    const moved = transition(root, [key.approver], key, {
      rp: { id: "approve.example.com", origins: ["https://new.approve.example.com"] },
    });
    expect(chain([root, moved]).ok).toBe(true);
  });

  it("re-roots with a new attested key and starts a new epoch", () => {
    const key = soft("yubikey", true);
    const root = rootFile(key);
    const fresh = soft("yubikey-new", true);
    const result = chain([root, rootFile(fresh, "re-root", root)]);
    expect(result.ok && result.state.epochStart).toBe("c1");
    expect(result.ok && [...result.state.attested]).toEqual([fresh.approver.credentialId]);
  });

  it("refuses a re-root that reuses an earlier credential, or one without attestation", () => {
    const key = soft("yubikey", true);
    const phone = soft("phone", false);
    const root = rootFile(key);
    const added = transition(root, [key.approver, phone.approver], key);
    expect(chain([root, added, rootFile(key, "re-root", added)])).toMatchObject({
      ok: false,
      reason: /no earlier version enrolled/,
    });
    expect(chain([root, rootFile(soft("phone2", false), "re-root", root)])).toMatchObject({
      ok: false,
      reason: /none attestation/,
    });
  });

  it("refuses bringing back a key from an earlier epoch", () => {
    const key = soft("yubikey", true);
    const root = rootFile(key);
    const fresh = soft("yubikey-new", true);
    const reroot = rootFile(fresh, "re-root", root);
    expect(
      chain([root, reroot, transition(reroot, [fresh.approver, key.approver], fresh)]),
    ).toMatchObject({
      ok: false,
      reason: /earlier epoch/,
    });
  });
});
