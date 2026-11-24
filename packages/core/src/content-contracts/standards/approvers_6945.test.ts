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
    expect(enroll).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(enroll);
    expect(source).toContain("allowCredentials");
    expect(read("content/tools/approvers/ceremony.html")).toContain("frame-ancestors 'none'");
    expect(source).toContain("split the cohort");
  });
});
