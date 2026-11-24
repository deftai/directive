import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegistrationVerifier } from "./attestation.js";
import { base64urlEncode } from "./canonical.js";
import { transitionPayloadBytes } from "./trust-file.js";
import {
  loadTrustHistory,
  parseRemoteRepo,
  resolveApprovalRepo,
  signedLevelFromLoad,
  type TrustHistoryLoad,
  verifyTrustHistory,
} from "./trust-history.js";
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
const stubVerifier: RegistrationVerifier = (input) => {
  const a = attestedTokens.get(input.attestationObject);
  if (a === undefined) return { ok: false, reason: "none attestation cannot root a trust file" };
  const { name: _name, ...credential } = a;
  return { ok: true, registration: { fmt: "packed", ...credential } };
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();
function assertOver(signer: Soft, payload: Uint8Array): AssertionProof {
  const auth = Buffer.concat([sha(Buffer.from(RP.id)), Buffer.from([FLAG_UP | FLAG_UV, 0, 0, 0, 1])]);
  const client = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: base64urlEncode(sha(payload)), origin: RP.origins[0] }),
  );
  const sig = sign("sha256", Buffer.concat([auth, sha(client)]), { key: signer.privateKey, dsaEncoding: "der" });
  return { authenticatorData: base64urlEncode(auth), clientDataJSON: base64urlEncode(client), signature: base64urlEncode(sig) };
}
const PLACEHOLDER: AssertionProof = { authenticatorData: "AA", clientDataJSON: "AA", signature: "AA" };
function rootFile(key: Soft): ApproversFile {
  const draft: ApproversFile = {
    schema: "deft.approvers.v1",
    body: { repo: REPO, rp: RP, approvers: [key.approver] },
    proof: {
      kind: "root",
      credentialId: key.approver.credentialId,
      registration: { attestationObject: `att-${key.approver.credentialId}`, clientDataJSON: "e30" },
      assertion: PLACEHOLDER,
    },
  };
  return { ...draft, proof: { ...draft.proof, assertion: assertOver(key, transitionPayloadBytes(draft, null)) } } as ApproversFile;
}
function transition(prev: ApproversFile, approvers: Approver[], signer: Soft): ApproversFile {
  const draft: ApproversFile = {
    schema: "deft.approvers.v1",
    body: { repo: REPO, rp: RP, approvers },
    proof: { kind: "transition", credentialId: signer.approver.credentialId, assertion: PLACEHOLDER },
  };
  return { ...draft, proof: { ...draft.proof, assertion: assertOver(signer, transitionPayloadBytes(draft, prev)) } } as ApproversFile;
}
const text = (f: ApproversFile) => `${JSON.stringify(f, null, 2)}\n`;

function fixture() {
  const key = soft("yubikey", true);
  const phone = soft("phone", false);
  const v1 = rootFile(key);
  const v2 = transition(v1, [key.approver, phone.approver], key);
  const v3 = transition(v2, [key.approver], key);
  return { key, phone, v1, v2, v3 };
}

const opts = { verifyRegistration: stubVerifier };

describe("verifyTrustHistory (#6945)", () => {
  it("accepts a root then signed transitions", () => {
    const { v1, v2, v3 } = fixture();
    const result = verifyTrustHistory(
      [{ commit: "a", text: text(v1) }, { commit: "b", text: text(v2) }, { commit: "c", text: text(v3) }],
      opts,
    );
    expect(result).toMatchObject({ ok: true, rootKind: "packed", epochStart: "a" });
  });

  it("refuses a rollback to an earlier version", () => {
    const { v1, v2, v3 } = fixture();
    const toRoot = verifyTrustHistory(
      [{ commit: "a", text: text(v1) }, { commit: "b", text: text(v2) }, { commit: "c", text: text(v1) }],
      opts,
    );
    expect(toRoot).toMatchObject({ ok: false, reason: /only the first version may be a root/ });
    const toTransition = verifyTrustHistory(
      [
        { commit: "a", text: text(v1) },
        { commit: "b", text: text(v2) },
        { commit: "c", text: text(v3) },
        { commit: "d", text: text(v2) },
      ],
      opts,
    );
    expect(toTransition).toMatchObject({ ok: false, reason: /transition assertion refused/ });
  });

  it("refuses two transitions from one predecessor", () => {
    const { key, phone, v1, v2 } = fixture();
    const sibling = transition(v1, [key.approver, phone.approver, soft("other", false).approver], key);
    const result = verifyTrustHistory(
      [{ commit: "a", text: text(v1) }, { commit: "b", text: text(v2) }, { commit: "c", text: text(sibling) }],
      opts,
    );
    expect(result).toMatchObject({ ok: false, reason: /transition assertion refused/ });
  });

  it("refuses a file deleted or broken after its first appearance", () => {
    const { v1 } = fixture();
    expect(verifyTrustHistory([{ commit: "a", text: text(v1) }, { commit: "b", text: null }], opts)).toMatchObject({
      ok: false,
      reason: /deleted at b/,
    });
    expect(verifyTrustHistory([{ commit: "a", text: text(v1) }, { commit: "b", text: "{" }], opts)).toMatchObject({
      ok: false,
      reason: /malformed/,
    });
  });

  it("treats a whitespace-only rewrite as no change", () => {
    const { v1 } = fixture();
    const result = verifyTrustHistory(
      [{ commit: "a", text: text(v1) }, { commit: "b", text: JSON.stringify(v1) }],
      opts,
    );
    expect(result.ok).toBe(true);
  });
});

describe("signedLevelFromLoad (#6945)", () => {
  const { v1 } = fixture();
  const load: TrustHistoryLoad = { kind: "versions", versions: [{ commit: "a", text: text(v1) }] };

  it("is none for an absent history and signed for a verified chain", () => {
    expect(signedLevelFromLoad({ kind: "absent" }, () => REPO, opts)).toEqual({ level: "none" });
    expect(signedLevelFromLoad(load, () => REPO, opts)).toMatchObject({ level: "signed", ok: true, repo: REPO });
  });

  it("refuses a shallow clone with a full-history remediation", () => {
    expect(signedLevelFromLoad({ kind: "shallow" }, () => REPO, opts)).toMatchObject({
      level: "signed",
      ok: false,
      code: 2,
      reason: /fetch-depth: 0/,
    });
  });

  it("refuses when the repository cannot be resolved or differs from the trust file", () => {
    expect(signedLevelFromLoad(load, () => null, opts)).toMatchObject({ ok: false, code: 2, reason: /GITHUB_REPOSITORY/ });
    expect(signedLevelFromLoad(load, () => "other/repo", opts)).toMatchObject({
      ok: false,
      code: 1,
      reason: /names repository deftai\/directive/,
    });
  });
});

describe("repository resolution (#6945)", () => {
  it("prefers GITHUB_REPOSITORY and parses remote URLs", () => {
    expect(resolveApprovalRepo(".", { GITHUB_REPOSITORY: "Owner/Repo" })).toBe("owner/repo");
    for (const url of [
      "https://github.com/DeftAI/Directive.git",
      "git@github.com:DeftAI/Directive.git",
      "ssh://git@github.com/DeftAI/Directive",
    ]) {
      expect(parseRemoteRepo(url), url).toBe("deftai/directive");
    }
    expect(parseRemoteRepo("not a url")).toBeNull();
  });
});

// --- git-backed walk: one shared repository, built once ---
const roots: string[] = [];
function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.com" },
  }).trim();
}
function commitAll(root: string, files: Record<string, string | null>, msg: string): string {
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) git(root, ["rm", "-q", rel]);
    else {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), body, "utf8");
      git(root, ["add", rel]);
    }
  }
  git(root, ["commit", "-q", "-m", msg]);
  return git(root, ["rev-parse", "HEAD"]);
}

describe("loadTrustHistory over git (#6945)", () => {
  const F = ".deft/approvers.json";
  const ids: Record<string, string> = {};
  const loads: Record<string, TrustHistoryLoad> = {};
  let repo = "";
  let clone = "";

  beforeAll(() => {
    const { v1, v2 } = fixture();
    repo = mkdtempSync(join(tmpdir(), "approvers-history-"));
    roots.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    ids.before = commitAll(repo, { "a.txt": "a" }, "before");
    ids.root = commitAll(repo, { [F]: text(v1) }, "root");
    git(repo, ["checkout", "-q", "-b", "side"]);
    commitAll(repo, { [F]: text(v2) }, "side change");
    git(repo, ["checkout", "-q", "main"]);
    commitAll(repo, { "b.txt": "b" }, "main work");
    git(repo, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
    ids.merge = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["branch", "at-merge"]);
    ids.deleted = commitAll(repo, { [F]: null }, "delete");
    clone = mkdtempSync(join(tmpdir(), "approvers-shallow-"));
    roots.push(clone);
    git(clone, ["clone", "-q", "--depth", "1", "--branch", "at-merge", `file://${repo.replace(/\\/g, "/")}`, "."]);
    loads.before = loadTrustHistory(repo, ids.before);
    loads.unknown = loadTrustHistory(repo, "no-such-ref");
    loads.merge = loadTrustHistory(repo, ids.merge);
    loads.deleted = loadTrustHistory(repo, ids.deleted);
    loads.shallow = loadTrustHistory(clone, "HEAD");
  }, 120_000);

  afterAll(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it("is absent before the first appearance and for an unknown merge base", () => {
    expect(loads.before).toEqual({ kind: "absent" });
    expect(loads.unknown).toEqual({ kind: "absent" });
  });

  it("walks first-parent versions, including one merged from a side branch", () => {
    const load = loads.merge!;
    expect(load.kind === "versions" && load.versions.map((v) => v.commit)).toEqual([ids.root, ids.merge]);
    const level = signedLevelFromLoad(load, () => REPO, opts);
    expect(level.level === "signed" && level.ok && level.trust.epochStart).toBe(ids.root);
  });

  it("keeps the signed level after the file is deleted", () => {
    const load = loads.deleted!;
    expect(load.kind === "versions" && load.versions.at(-1)).toEqual({ commit: ids.deleted, text: null });
    expect(signedLevelFromLoad(load, () => REPO, opts)).toMatchObject({ ok: false, code: 1, reason: /deleted/ });
  });

  it("reports a shallow clone", () => {
    expect(loads.shallow).toEqual({ kind: "shallow" });
  });
});
