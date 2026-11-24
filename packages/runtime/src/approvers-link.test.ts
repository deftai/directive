import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvers } from "@deftai/directive-core";
import { describe, expect, it } from "vitest";
import {
  buildCeremonyLink,
  decideSignedWrite,
  formatCeremonyOutput,
  loadCliTrustState,
  MAX_REQUEST_BYTES,
  parseRecordAssertion,
  QR_URL_MAX,
  resolveCliSignedLevel,
} from "./approvers-link.js";

const rp = { id: "approve.example.com", origins: ["https://approve.example.com"] as const };
const entry: approvers.RecordApprovalEntry = {
  kind: "observable-scope",
  planId: "story-1",
  xbriefRelPath: "xbrief/active/story.xbrief.json",
  recordRel: ".deft/observable-scope/story-1.json",
  changeKind: "fields-only",
  contractDigest: "a".repeat(64),
};

describe("ceremony link (#6945)", () => {
  it("prints a link and a QR only when the link fits, and writes no approval", () => {
    const link = buildCeremonyLink("https://approve.example.com", {
      schema: "deft.ceremony-request.v1",
      mode: "approve",
      repo: "deftai/directive",
      rp,
      entries: [entry],
    });
    if ("error" in link) throw new Error(link.error);
    expect(link.url.startsWith("https://approve.example.com/ceremony.html#")).toBe(true);
    expect(link.url.length).toBeLessThanOrEqual(QR_URL_MAX);
    expect(link.qr).toBe(link.url);
    const text = formatCeremonyOutput(link);
    expect(text).toMatch(/^link: /);
    expect(text).toMatch(/\nqr: /);
    expect(text).toMatch(/user-verified gesture by an enrolled authenticator/);
  });

  it("refuses an oversized request and tells the operator to split the cohort", () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      ...entry,
      planId: `story-${String(i)}`,
      recordRel: `.deft/observable-scope/story-${String(i)}.json`,
      xbriefRelPath: `xbrief/active/${"p".repeat(40)}-${String(i)}.xbrief.json`,
    }));
    const link = buildCeremonyLink("https://approve.example.com", {
      schema: "deft.ceremony-request.v1",
      mode: "approve",
      repo: "deftai/directive",
      rp,
      entries,
    });
    expect("error" in link).toBe(true);
    if (!("error" in link)) return;
    expect(link.error).toMatch(new RegExp(String(MAX_REQUEST_BYTES)));
    expect(link.error).toMatch(/split the cohort/);
  });

  it("refuses localhost and a non-https origin", () => {
    expect(
      buildCeremonyLink("http://approve.example.com", {
        schema: "deft.ceremony-request.v1",
        mode: "enroll",
        repo: "deftai/directive",
        rp,
        name: "scott",
      }),
    ).toMatchObject({ error: /https/ });
    expect(
      buildCeremonyLink("https://localhost", {
        schema: "deft.ceremony-request.v1",
        mode: "enroll",
        repo: "deftai/directive",
        rp: { id: "localhost", origins: ["https://localhost"] },
        name: "scott",
      }),
    ).toMatchObject({ error: /localhost/ });
  });

  it("parses a record assertion and refuses a blob with an extra key", () => {
    const payload = approvers.buildRecordApprovalPayload("deftai/directive", [entry]);
    const blob = {
      payload,
      credentialId: "Y3JlZA",
      authenticatorData: "YQ",
      clientDataJSON: "YQ",
      signature: "YQ",
    };
    expect(parseRecordAssertion(JSON.stringify(blob))).toMatchObject({ credentialId: "Y3JlZA" });
    expect(parseRecordAssertion(JSON.stringify({ ...blob, actor: "agent" }))).toMatchObject({
      error: /keys must be exactly/,
    });
  });
});

describe("decideSignedWrite (#6945)", () => {
  const level = {
    level: "signed" as const,
    ok: true as const,
    repo: "deftai/directive",
    trust: {
      body: { repo: "deftai/directive", rp, approvers: [] },
      rootKind: "packed",
      epochStart: "abc",
      attested: [],
    },
  };

  it("keeps the declared write when there is no trust file", () => {
    expect(decideSignedWrite({ level: "none" }, false, null)).toEqual({ kind: "declared" });
  });

  it("refuses an uncommitted trust file as the predecessor", () => {
    const dir = mkdtempSync(join(tmpdir(), "approvers-link-"));
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const file = {
      schema: "deft.approvers.v1",
      body: {
        repo: "deftai/directive",
        rp,
        approvers: [
          {
            name: "scott",
            credentialId: "Y3JlZA",
            publicKey: approvers.base64urlEncode(approvers.spkiOf(publicKey)),
            alg: -7,
            aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
            backupEligible: false,
          },
        ],
      },
      proof: {
        kind: "root",
        credentialId: "Y3JlZA",
        registration: { attestationObject: "YQ", clientDataJSON: "YQ" },
        assertion: { authenticatorData: "YQ", clientDataJSON: "YQ", signature: "YQ" },
      },
    };
    mkdirSync(join(dir, ".deft"));
    writeFileSync(join(dir, ".deft", "approvers.json"), JSON.stringify(file));
    expect(loadCliTrustState(dir)).toMatchObject({ error: /commit \.deft\/approvers\.json/ });
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a non-repository as unsigned and reports a merge-base failure", () => {
    const plain = mkdtempSync(join(tmpdir(), "approvers-plain-"));
    expect(resolveCliSignedLevel(plain)).toEqual({ level: "none" });
    rmSync(plain, { recursive: true, force: true });
    const repo = mkdtempSync(join(tmpdir(), "approvers-git-"));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    expect(resolveCliSignedLevel(repo)).toMatchObject({ level: "signed", ok: false, code: 2 });
    rmSync(repo, { recursive: true, force: true });
  });

  it("refuses --request when unsigned, and refuses a bare write when signed", () => {
    expect(decideSignedWrite({ level: "none" }, true, null)).toMatchObject({
      kind: "refuse",
      message: /declared write is unchanged/,
    });
    expect(decideSignedWrite(level, false, null)).toMatchObject({
      kind: "refuse",
      message: /--request/,
    });
  });
});
