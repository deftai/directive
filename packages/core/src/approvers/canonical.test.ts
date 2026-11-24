import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  buildRecordApprovalEntry,
  buildRecordApprovalPayload,
  buildTransitionPayload,
  CanonicalEncodingError,
  canonicalBytes,
  canonicalJson,
  payloadHasEntry,
  recordApprovalPayloadError,
} from "./canonical.js";
import type { RecordApprovalEntry } from "./types.js";

interface Vectors {
  payloads: { name: string; value: unknown; canonical: string; sha256: string }[];
  base64url: { hex: string; text: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/canonical-vectors.json", import.meta.url), "utf8"),
) as Vectors;

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);

function entry(over: Partial<RecordApprovalEntry> = {}): RecordApprovalEntry {
  return {
    kind: "observable-scope",
    planId: "github.issue.42",
    xbriefRelPath: "xbrief/active/2026-11-23-42-story.xbrief.json",
    recordRel: ".deft/observable-scope/github.issue.42.json",
    changeKind: "fields-only",
    contractDigest: D2,
    ...over,
  };
}

describe("canonical encoding (#6945)", () => {
  it("matches every shared vector, text and sha256", () => {
    for (const v of vectors.payloads) {
      expect(canonicalJson(v.value), v.name).toBe(v.canonical);
      const digest = createHash("sha256").update(canonicalBytes(v.value)).digest("hex");
      expect(digest, v.name).toBe(v.sha256);
    }
  });

  it("builds the record approval vector from unsorted entries", () => {
    const want = vectors.payloads.find((v) => v.name === "record-approval-two-entries")!;
    const payload = buildRecordApprovalPayload("DeftAI/Directive", [
      entry(),
      entry({
        kind: "intent-constraint",
        recordRel: ".deft/intent-constraint/github.issue.42.json",
        changeKind: null,
        contractDigest: D1,
      }),
    ]);
    expect(canonicalJson(payload)).toBe(want.canonical);
  });

  it("builds both transition vectors", () => {
    const root = buildTransitionPayload({
      repo: "deftai/directive",
      predecessorDigest: null,
      bodyDigest: "3".repeat(64),
    });
    expect(canonicalJson(root)).toBe(vectors.payloads.find((v) => v.name === "transition-root")!.canonical);
    const next = buildTransitionPayload({
      repo: "deftai/directive",
      predecessorDigest: "4".repeat(64),
      bodyDigest: "5".repeat(64),
    });
    expect(canonicalJson(next)).toBe(
      vectors.payloads.find((v) => v.name === "transition-with-predecessor")!.canonical,
    );
  });

  it("refuses floats, undefined and non-plain objects", () => {
    expect(() => canonicalJson(1.5)).toThrow(CanonicalEncodingError);
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalEncodingError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalEncodingError);
  });

  it("round-trips base64url vectors and refuses non-canonical text", () => {
    for (const v of vectors.base64url) {
      const bytes = Uint8Array.from(Buffer.from(v.hex, "hex"));
      expect(base64urlEncode(bytes)).toBe(v.text);
      expect(Buffer.from(base64urlDecode(v.text)!).toString("hex")).toBe(v.hex);
    }
    expect(base64urlDecode("AA==")).toBeNull();
    expect(base64urlDecode("A+")).toBeNull();
    expect(base64urlDecode("AB")).toBeNull();
    expect(base64urlDecode("A")).toBeNull();
  });

  it("keeps record approvals and transitions in separate domains", () => {
    const a = buildRecordApprovalPayload("deftai/directive", [entry()]);
    const t = buildTransitionPayload({ repo: "deftai/directive", predecessorDigest: null, bodyDigest: D1 });
    expect(a.schema).toBe("deft.record-approval.v1");
    expect(t.schema).toBe("deft.approvers-transition.v1");
    expect(recordApprovalPayloadError(t)).not.toBeNull();
  });

  it("refuses duplicates, unsorted entries, extra keys and bad digests", () => {
    expect(() => buildRecordApprovalPayload("deftai/directive", [entry(), entry()])).toThrow(/twice/);
    const two = buildRecordApprovalPayload("deftai/directive", [
      entry(),
      entry({ kind: "intent-constraint", recordRel: ".deft/intent-constraint/x.json", changeKind: null }),
    ]);
    expect(recordApprovalPayloadError({ ...two, entries: [...two.entries].reverse() })).toMatch(/sorted/);
    expect(recordApprovalPayloadError({ ...two, extra: 1 })).toMatch(/exactly/);
    expect(recordApprovalPayloadError({ ...two, entries: [{ ...entry(), note: "x" }] })).toMatch(/exactly/);
    expect(recordApprovalPayloadError({ ...two, entries: [entry({ contractDigest: "ABC" })] })).toMatch(
      /contractDigest/,
    );
    expect(recordApprovalPayloadError({ ...two, repo: "DeftAI/Directive" })).toMatch(/lowercase/);
    expect(recordApprovalPayloadError({ ...two, entries: [] })).toMatch(/non-empty/);
  });

  it("finds an entry only when every field matches", () => {
    const payload = buildRecordApprovalPayload("deftai/directive", [entry()]);
    expect(payloadHasEntry(payload, entry())).toBe(true);
    expect(payloadHasEntry(payload, entry({ planId: "github.issue.43" }))).toBe(false);
    expect(payloadHasEntry(payload, entry({ changeKind: "layout-authorized" }))).toBe(false);
    expect(payloadHasEntry(payload, entry({ contractDigest: D1 }))).toBe(false);
  });

  it("normalizes entry paths and forces a null changeKind for intent records", () => {
    const e = buildRecordApprovalEntry({
      kind: "intent-constraint",
      planId: " github.issue.7 ",
      xbriefRelPath: "xbrief\\active\\a.xbrief.json",
      recordRel: ".deft\\intent-constraint\\github.issue.7.json",
      changeKind: "fields-only",
      contractDigest: D1,
    });
    expect(e).toEqual({
      kind: "intent-constraint",
      planId: "github.issue.7",
      xbriefRelPath: "xbrief/active/a.xbrief.json",
      recordRel: ".deft/intent-constraint/github.issue.7.json",
      changeKind: null,
      contractDigest: D1,
    });
  });
});
