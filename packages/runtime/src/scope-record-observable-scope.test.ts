import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvers } from "@deftai/directive-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./scope-record-observable-scope.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An agent shell with no TTY: the declared writer needs neither (#7031). */
const agentSeams = {
  isTty: () => false,
  hasControllingTerminal: () => false,
  readInteractiveConfirm: () => null,
  environ: { CURSOR_AGENT: "1" },
};

function storyBrief(root: string, contract: Record<string, unknown>): string {
  mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
  const xbrief = join(root, "xbrief", "pending", "story.xbrief.json");
  writeFileSync(
    xbrief,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-1",
        title: "T",
        status: "pending",
        items: [],
        "x-directive/observableChange": contract,
      },
    }),
    "utf8",
  );
  return xbrief;
}

describe("scope-record-observable-scope CLI (#4495 / #7031)", () => {
  it("prints usage", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(0);
  });

  it("writes a declared record from an agent shell with no TTY (#7031)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-declared-"));
    temps.push(root);
    const xbrief = storyBrief(root, {
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run([xbrief, "--actor", "david", "--project-root", root], agentSeams)).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(root, ".deft", "observable-scope", "story-1.json"), "utf8"),
    ) as {
      humanApproval: { kind: string; actor: string; mintedVia?: string };
      allowedChanges: unknown[];
      xbriefRelPath: string;
    };
    expect(rec.humanApproval).toMatchObject({
      kind: "declared",
      actor: "david",
      mintedVia: "scope:record-observable-scope",
    });
    expect(rec.allowedChanges).toEqual([{ kind: "control", op: "add", name: "email" }]);
    expect(rec.xbriefRelPath).toBe("xbrief/active/story.xbrief.json");
  });

  it("refuses --kind and --minted-via (#7031)", () => {
    expect(parseArgs(["story.xbrief.json", "--kind", "operator"]).error).toMatch(/--kind is not/);
    expect(parseArgs(["story.xbrief.json", "--minted-via=in-harness-ask"]).error).toMatch(
      /--minted-via is not/,
    );
  });

  it("refuses worker-declared baselineRef", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-declared-base-"));
    temps.push(root);
    const xbrief = storyBrief(root, {
      baselineRef: "HEAD",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([xbrief, "--project-root", root], agentSeams)).toBe(2);
  });
});

const SIGNED_RP = { id: "approve.example.com", origins: ["https://approve.example.com"] };
const signedKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signedApprover = {
  name: "yubikey",
  credentialId: "Y3JlZC0x",
  publicKey: approvers.base64urlEncode(approvers.spkiOf(signedKey.publicKey)),
  alg: -7 as const,
  aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
  backupEligible: false,
};
const signedLevel = {
  level: "signed" as const,
  ok: true as const,
  repo: "deftai/directive",
  trust: {
    body: { repo: "deftai/directive", rp: SIGNED_RP, approvers: [signedApprover] },
    rootKind: "packed",
    epochStart: "0123456789abcdef",
    attested: [signedApprover.credentialId],
  },
};

function signPayload(payload: approvers.RecordApprovalPayload) {
  const auth = Buffer.concat([
    createHash("sha256").update(Buffer.from(SIGNED_RP.id)).digest(),
    Buffer.from([approvers.FLAG_UP | approvers.FLAG_UV, 0, 0, 0, 1]),
  ]);
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: approvers.base64urlEncode(
        createHash("sha256").update(approvers.canonicalBytes(payload)).digest(),
      ),
      origin: SIGNED_RP.origins[0],
    }),
  );
  return {
    payload,
    credentialId: signedApprover.credentialId,
    authenticatorData: approvers.base64urlEncode(auth),
    clientDataJSON: approvers.base64urlEncode(client),
    signature: approvers.base64urlEncode(
      sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), {
        key: signedKey.privateKey,
        dsaEncoding: "der",
      }),
    ),
  };
}

describe("scope-record-observable-scope signed level (#6945)", () => {
  it("--request writes nothing and prints the ceremony link", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-request-"));
    temps.push(dir);
    const xbrief = storyBrief(dir, {
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    expect(
      run([xbrief, "--request", "--project-root", dir], {
        ...agentSeams,
        approvalLevel: signedLevel,
      }),
    ).toBe(0);
    expect(existsSync(join(dir, ".deft", "observable-scope", "story-1.json"))).toBe(false);
    expect(lines.join("")).toMatch(/link: https:\/\/approve.example.com\/ceremony.html#/);
    expect(lines.join("")).toMatch(/user-verified gesture/);
  });

  it("--assertion writes the record only after the blob verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-assert-"));
    temps.push(dir);
    const xbrief = storyBrief(dir, {
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    expect(
      run([xbrief, "--request", "--project-root", dir], {
        ...agentSeams,
        approvalLevel: signedLevel,
      }),
    ).toBe(0);
    const link = lines.join("").match(/link: (\S+)/)?.[1];
    if (link === undefined) throw new Error("missing link");
    const fragment = link.slice(link.indexOf("#") + 1);
    const bytes = approvers.base64urlDecode(fragment);
    if (bytes === null) throw new Error("bad fragment");
    const request = JSON.parse(new TextDecoder().decode(bytes)) as {
      entries: approvers.RecordApprovalEntry[];
    };
    const approval = signPayload(
      approvers.buildRecordApprovalPayload("deftai/directive", request.entries),
    );
    expect(
      run([xbrief, "--assertion", JSON.stringify(approval), "--project-root", dir], {
        ...agentSeams,
        approvalLevel: signedLevel,
      }),
    ).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(dir, ".deft", "observable-scope", "story-1.json"), "utf8"),
    ) as {
      approval?: { credentialId?: string };
    };
    expect(rec.approval?.credentialId).toBe(signedApprover.credentialId);
  });

  it("refuses --request when the repository has no trust file and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-unsigned-"));
    temps.push(dir);
    const xbrief = storyBrief(dir, {
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([xbrief, "--request", "--project-root", dir], agentSeams)).toBe(2);
    expect(existsSync(join(dir, ".deft", "observable-scope", "story-1.json"))).toBe(false);
  });
});
