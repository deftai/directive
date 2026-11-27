/**
 * Docs and page bundle for signed approvals (#6945).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalJson } from "../../approvers/canonical.js";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const CLAIM = /user-verified gesture by an enrolled authenticator/;

describe("signed approval docs (#6945)", () => {
  it("states what a valid approval proves and the named residuals", () => {
    for (const rel of [
      "content/commands.md",
      "content/docs/approvers.md",
      "content/docs/observable-scope.md",
      "content/docs/intent-constraint.md",
      "content/contracts/human-origin-authz.md",
    ]) {
      const text = read(rel);
      expect(text, rel).toMatch(CLAIM);
      expect(text, rel).toMatch(/credentials the agent does not hold/);
    }
    const approvers = read("content/docs/approvers.md");
    expect(approvers).toMatch(/Windows Hello/);
    expect(approvers).toMatch(/#6207/);
    expect(approvers).toMatch(/onePrScopeProof/);
    expect(approvers).toMatch(/signed` stays reserved|#5862/);
    expect(approvers).toMatch(/DEFT_ALLOW_BOT_MERGE/);
    expect(approvers).toMatch(/localhost/);
  });

  it("operator delegation names the passkey as its upgrade and states its strength (#7420)", () => {
    const doc = read("content/docs/operator-delegation.md");
    expect(doc).toMatch(/Parity of forging effort/);
    expect(doc).toMatch(/Wider blast radius/);
    expect(doc).toMatch(
      /passkey \(#6945 \/ #7046\) makes the arming factor\s+unproducible by an agent/,
    );
    expect(doc).toMatch(/#7279 request digest is\s+not human review/);
    expect(doc).toMatch(/finish-loop/);
    expect(doc).toMatch(/Stop inventory/);
    for (const rel of ["content/contracts/human-origin-authz.md", "content/commands.md"]) {
      const text = read(rel);
      expect(text, rel).toMatch(/parity of forging effort/i);
      expect(text, rel).toMatch(/operator-delegation\.md/);
    }
    expect(read("content/contracts/human-origin-authz.md")).toMatch(
      /#7279 request digest is not human review/,
    );
    expect(read("content/docs/scope-provenance.md")).toMatch(/Delegated stamps \(#7420\)/);
  });

  it("the page bundle matches the shared canonical vectors", async () => {
    const vectors = JSON.parse(
      readFileSync(
        join(ROOT, "packages/core/src/approvers/fixtures/canonical-vectors.json"),
        "utf8",
      ),
    ) as { payloads: { name: string; value: unknown; canonical: string; sha256: string }[] };
    const page = (await import("../../../../../content/tools/approvers/ceremony.js")) as {
      canonicalJson: (value: unknown) => string;
      canonicalBytes: (value: unknown) => Uint8Array;
    };
    for (const vector of vectors.payloads) {
      expect(page.canonicalJson(vector.value), vector.name).toBe(vector.canonical);
      expect(page.canonicalJson(vector.value), vector.name).toBe(canonicalJson(vector.value));
      const digest = createHash("sha256").update(page.canonicalBytes(vector.value)).digest("hex");
      expect(digest, vector.name).toBe(vector.sha256);
      expect(Buffer.from(page.canonicalBytes(vector.value))).toEqual(
        Buffer.from(canonicalBytes(vector.value)),
      );
    }
  });

  it("computes the approve challenge from the text it shows", async () => {
    const page = (await import("../../../../../content/tools/approvers/ceremony.js")) as {
      shownApprove: (request: unknown) => string;
      challengeFromShown: (shown: string) => Promise<string>;
      entriesFromShown: (shown: string) => { repo: string; entries: unknown[] };
      buildRecordApprovalPayload: (repo: string, entries: unknown[]) => unknown;
      canonicalBytes: (value: unknown) => Uint8Array;
      base64urlEncode: (bytes: Uint8Array) => string;
      sha256Bytes: (bytes: Uint8Array) => Promise<Uint8Array>;
    };
    const request = {
      schema: "deft.ceremony-request.v1",
      mode: "approve",
      repo: "deftai/directive",
      rp: { id: "approve.example.com", origins: ["https://approve.example.com"] },
      entries: [
        {
          kind: "observable-scope",
          planId: "story-1",
          xbriefRelPath: "xbrief/active/story.xbrief.json",
          recordRel: ".deft/observable-scope/story-1.json",
          changeKind: "fields-only",
          contractDigest: "a".repeat(64),
        },
      ],
    };
    const shown = page.shownApprove(request);
    expect(shown).toContain("repo deftai/directive");
    expect(shown).toContain("planId story-1");
    const challenge = await page.challengeFromShown(shown);
    const parsed = page.entriesFromShown(shown);
    const payload = page.buildRecordApprovalPayload(parsed.repo, parsed.entries);
    const want = page.base64urlEncode(await page.sha256Bytes(page.canonicalBytes(payload)));
    expect(challenge).toBe(want);
    await expect(page.challengeFromShown(shown.replace("story-1", "story-2"))).resolves.not.toBe(
      challenge,
    );
  });

  it("adds a key only in the same session as an enrolled key's signature", () => {
    const source = read("content/tools/approvers/ceremony.js");
    const enroll = source.indexOf("navigator.credentials.create");
    const sign = source.lastIndexOf("navigator.credentials.get");
    const approveGet = source.indexOf("navigator.credentials.get");
    const secondGet = source.indexOf("navigator.credentials.get", approveGet + 1);
    expect(enroll).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(enroll);
    expect(source.slice(approveGet, secondGet)).toContain("allowCredentials");
    expect(source).toContain("button.disabled = true");
    expect(source).toContain("if (busy) return");
    expect(source).toContain("deft.approvers.v1");
    expect(source).toContain("deft.registration-challenge.v1");
    expect(source).not.toContain("crypto.getRandomValues(new Uint8Array(32))");
    expect(read("content/tools/approvers/ceremony.html")).toContain("frame-ancestors 'none'");
    expect(source).toContain("split the cohort");
  });

  it("converts a COSE key to the same SPKI the verifier stores", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { spkiOf } = await import("../../approvers/webauthn.js");
    const { base64urlDecode } = await import("../../approvers/canonical.js");
    const page = (await import("../../../../../content/tools/approvers/ceremony.js")) as {
      coseKeyToSpki: (cose: Uint8Array) => { alg: number; spki: Uint8Array };
    };
    const head = (major: number, n: number) => Uint8Array.from([(major << 5) | n]);
    const cint = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
    const cbytes = (bytes: Uint8Array) => {
      const out = new Uint8Array(2 + bytes.length);
      out[0] = (2 << 5) | 24;
      out[1] = bytes.length;
      out.set(bytes, 2);
      return out;
    };
    const cmap = (pairs: readonly (readonly [number, number | Uint8Array])[]) => {
      const parts = [head(5, pairs.length)];
      for (const [key, value] of pairs) {
        parts.push(cint(key));
        parts.push(typeof value === "number" ? cint(value) : cbytes(value));
      }
      const len = parts.reduce((n, part) => n + part.length, 0);
      const out = new Uint8Array(len);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    };
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = ec.publicKey.export({ format: "jwk" });
    const x = base64urlDecode(String(jwk.x));
    const y = base64urlDecode(String(jwk.y));
    if (x === null || y === null) throw new Error("jwk");
    const cose = cmap([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]);
    const spki = page.coseKeyToSpki(cose);
    expect(spki.alg).toBe(-7);
    expect(Buffer.from(spki.spki)).toEqual(Buffer.from(spkiOf(ec.publicKey)));
  });
});
