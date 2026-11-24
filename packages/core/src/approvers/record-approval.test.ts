import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64urlEncode, buildRecordApprovalPayload, canonicalBytes } from "./canonical.js";
import { SIGNED_APPROVAL_CLAIM, verifyRecordApproval } from "./record-approval.js";
import type { Approver, ApproversBody, RecordApprovalEntry } from "./types.js";
import { FLAG_UP, FLAG_UV, spkiOf } from "./webauthn.js";

const REPO = "deftai/directive";
const RP = { id: "approve.example.com", origins: ["https://approve.example.com"] };
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

interface Soft {
  readonly approver: Approver;
  readonly privateKey: KeyObject;
}
function soft(name: string): Soft {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    approver: {
      name,
      credentialId: base64urlEncode(randomBytes(16)),
      publicKey: base64urlEncode(spkiOf(publicKey)),
      alg: -7,
      aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
      backupEligible: false,
    },
  };
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

const OBS_ENTRY: RecordApprovalEntry = {
  kind: "observable-scope",
  planId: "github.issue.42",
  xbriefRelPath: "xbrief/active/42.xbrief.json",
  recordRel: ".deft/observable-scope/github.issue.42.json",
  changeKind: "fields-only",
  contractDigest: D1,
};
const INT_ENTRY: RecordApprovalEntry = {
  kind: "intent-constraint",
  planId: "github.issue.43",
  xbriefRelPath: "xbrief/active/43.xbrief.json",
  recordRel: ".deft/intent-constraint/github.issue.43.json",
  changeKind: null,
  contractDigest: D2,
};

interface ApproveOptions {
  repo?: string;
  flags?: number;
  origin?: string;
  crossOrigin?: boolean;
  signer?: Soft;
}

function approve(entries: RecordApprovalEntry[], key: Soft, opts: ApproveOptions = {}) {
  const payload = buildRecordApprovalPayload(opts.repo ?? REPO, entries);
  const auth = Buffer.concat([sha(Buffer.from(RP.id)), Buffer.from([opts.flags ?? FLAG_UP | FLAG_UV, 0, 0, 0, 1])]);
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: base64urlEncode(sha(canonicalBytes(payload))),
      origin: opts.origin ?? RP.origins[0],
      ...(opts.crossOrigin === undefined ? {} : { crossOrigin: opts.crossOrigin }),
    }),
  );
  const sig = sign("sha256", Buffer.concat([auth, sha(client)]), {
    key: (opts.signer ?? key).privateKey,
    dsaEncoding: "der",
  });
  return {
    payload,
    credentialId: key.approver.credentialId,
    authenticatorData: base64urlEncode(auth),
    clientDataJSON: base64urlEncode(client),
    signature: base64urlEncode(sig),
  };
}

function observableRecord(approval: unknown, over: Record<string, unknown> = {}) {
  return {
    schema: "deft.observable-scope.v1",
    planId: OBS_ENTRY.planId,
    xbriefRelPath: OBS_ENTRY.xbriefRelPath,
    approvedAt: "2026-11-23T00:00:00Z",
    changeKind: "fields-only",
    oracle: { provider: "parse5+typescript", version: 1 },
    allowedChanges: [],
    humanApproval: { kind: "declared", actor: "agent", mintedAt: "2026-11-23T00:00:00Z", mintedVia: "scope:record-observable-scope" },
    contractDigest: D1,
    ...(approval === undefined ? {} : { approval }),
    ...over,
  };
}

function check(record: unknown, body: ApproversBody, entry: RecordApprovalEntry = OBS_ENTRY, repo = REPO) {
  return verifyRecordApproval({
    kind: entry.kind,
    record,
    recordRel: entry.recordRel,
    planId: entry.planId,
    xbriefRelPath: entry.xbriefRelPath,
    changeKind: entry.changeKind,
    contractDigest: entry.contractDigest,
    repo,
    body,
  });
}

function bodyOf(...keys: Soft[]): ApproversBody {
  return { repo: REPO, rp: RP, approvers: keys.map((k) => k.approver) };
}

describe("verifyRecordApproval (#6945)", () => {
  const key = soft("yubikey");
  const body = bodyOf(key);

  it("approves a record whose entry is in a payload signed by an enrolled key", () => {
    const result = check(observableRecord(approve([OBS_ENTRY], key)), body);
    expect(result).toMatchObject({ ok: true, approver: "yubikey" });
  });

  it("approves each record of a cohort and names the approver from the trust file", () => {
    const approval = approve([INT_ENTRY, OBS_ENTRY], key);
    expect(check(observableRecord(approval), body).ok).toBe(true);
    const intent = {
      schema: "deft.intent-constraint.v1",
      planId: INT_ENTRY.planId,
      xbriefRelPath: INT_ENTRY.xbriefRelPath,
      approvedAt: "x",
      constraints: [],
      humanApproval: { kind: "declared", actor: "someone-else", mintedAt: "x" },
      contractDigest: D2,
      approval,
    };
    expect(check(intent, body, INT_ENTRY)).toMatchObject({ ok: true, approver: "yubikey" });
  });

  it("refuses a record without an approval: hand-written, TTY-minted or merged by any route", () => {
    expect(check(observableRecord(undefined), body)).toMatchObject({ ok: false, reason: /no approval/ });
    const legacy = observableRecord(undefined, { humanApproval: { kind: "operator", actor: "scott", mintedAt: "x" } });
    expect(check(legacy, body)).toMatchObject({ ok: false, reason: /no approval/ });
  });

  it("refuses a signature by a key that is not the enrolled one", () => {
    const agent = soft("agent");
    expect(check(observableRecord(approve([OBS_ENTRY], key, { signer: agent })), body)).toMatchObject({
      ok: false,
      reason: /signature does not verify/,
    });
    expect(check(observableRecord(approve([OBS_ENTRY], agent)), body)).toMatchObject({
      ok: false,
      reason: /not enrolled/,
    });
  });

  it("refuses another repository's approval pasted in", () => {
    const pasted = approve([OBS_ENTRY], key, { repo: "someone/else" });
    expect(check(observableRecord(pasted), body)).toMatchObject({ ok: false, reason: /names repository/ });
    const relabeled = { ...pasted, payload: { ...pasted.payload, repo: REPO } };
    expect(check(observableRecord(relabeled), body)).toMatchObject({ ok: false, reason: /challenge/ });
  });

  it("refuses an unknown origin, crossOrigin true and a missing UV flag", () => {
    expect(check(observableRecord(approve([OBS_ENTRY], key, { origin: "https://evil.example.com" })), body).ok).toBe(false);
    expect(check(observableRecord(approve([OBS_ENTRY], key, { crossOrigin: true })), body)).toMatchObject({
      ok: false,
      reason: /crossOrigin/,
    });
    expect(check(observableRecord(approve([OBS_ENTRY], key, { flags: FLAG_UP })), body)).toMatchObject({
      ok: false,
      reason: /user-verified/,
    });
  });

  it("needs a fresh approval when plan id, brief, record path, changeKind or contract change", () => {
    const record = observableRecord(approve([OBS_ENTRY], key));
    for (const changed of [
      { ...OBS_ENTRY, planId: "github.issue.99" },
      { ...OBS_ENTRY, xbriefRelPath: "xbrief/active/other.xbrief.json" },
      { ...OBS_ENTRY, recordRel: ".deft/observable-scope/other.json" },
      { ...OBS_ENTRY, changeKind: "layout-authorized" },
      { ...OBS_ENTRY, contractDigest: D2 },
    ]) {
      expect(check(record, body, changed), JSON.stringify(changed)).toMatchObject({
        ok: false,
        reason: /does not hold this record's entry/,
      });
    }
  });

  it("refuses a payload that does not hold the record's entry, and an edited payload", () => {
    expect(check(observableRecord(approve([INT_ENTRY], key)), body)).toMatchObject({
      ok: false,
      reason: /does not hold/,
    });
    const approval = approve([OBS_ENTRY], key);
    const widened = { ...approval, payload: buildRecordApprovalPayload(REPO, [OBS_ENTRY, INT_ENTRY]) };
    expect(check(observableRecord(widened), body)).toMatchObject({ ok: false, reason: /challenge/ });
  });

  it("refuses unknown record keys and unknown approval keys", () => {
    const approval = approve([OBS_ENTRY], key);
    expect(check(observableRecord(approval, { level: "signed" }), body)).toMatchObject({
      ok: false,
      reason: /unknown record key level/,
    });
    expect(check(observableRecord({ ...approval, approver: "scott" }), body)).toMatchObject({
      ok: false,
      reason: /approval keys/,
    });
  });

  it("states what a valid approval proves and the residuals", () => {
    expect(SIGNED_APPROVAL_CLAIM).toMatch(/user-verified gesture by an enrolled authenticator over exactly this set/);
    expect(SIGNED_APPROVAL_CLAIM).toMatch(/device the agent does not drive/);
    expect(SIGNED_APPROVAL_CLAIM).toMatch(/credentials the agent does not hold/);
    expect(SIGNED_APPROVAL_CLAIM).toMatch(/deleting a record does not revoke it/);
  });
});
