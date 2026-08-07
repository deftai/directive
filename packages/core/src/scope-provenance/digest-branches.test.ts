/**
 * Branch coverage for scope-provenance digest helpers (#3185 coverage-debt hairline).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedScopeRecordPath,
  buildApprovedScopeRecord,
  computeFileScopeDigest,
  computeTextDigest,
  extractFileScope,
  extractPlanId,
  isHumanApprovalStamp,
  listApprovedScopeRecords,
  normalizeFileScope,
  readApprovedScopeRecord,
  scopeExpansion,
  writeApprovedScopeRecord,
} from "./digest.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sp-digest-br-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("extractFileScope / extractPlanId branches (#3185)", () => {
  it("returns empty/null for non-objects and broken plan graphs", () => {
    expect(extractFileScope(null)).toEqual([]);
    expect(extractFileScope("x")).toEqual([]);
    expect(extractFileScope([])).toEqual([]);
    expect(extractFileScope({})).toEqual([]);
    expect(extractFileScope({ plan: null })).toEqual([]);
    expect(extractFileScope({ plan: [] })).toEqual([]);
    expect(extractFileScope({ plan: { metadata: null } })).toEqual([]);
    expect(extractFileScope({ plan: { metadata: [] } })).toEqual([]);
    expect(extractFileScope({ plan: { metadata: { swarm: null } } })).toEqual([]);
    expect(extractFileScope({ plan: { metadata: { swarm: [] } } })).toEqual([]);
    expect(extractFileScope({ plan: { metadata: { swarm: { file_scope: "a" } } } })).toEqual([]);
    expect(
      extractFileScope({ plan: { metadata: { swarm: { file_scope: ["a", 1, "b"] } } } }),
    ).toEqual(["a", "b"]);

    expect(extractPlanId(null)).toBeNull();
    expect(extractPlanId("x")).toBeNull();
    expect(extractPlanId([])).toBeNull();
    expect(extractPlanId({})).toBeNull();
    expect(extractPlanId({ plan: null })).toBeNull();
    expect(extractPlanId({ plan: [] })).toBeNull();
    expect(extractPlanId({ plan: { id: 12 } })).toBeNull();
    expect(extractPlanId({ plan: { id: "  " } })).toBeNull();
    expect(extractPlanId({ plan: { id: "  ok  " } })).toBe("ok");
  });

  it("normalizeFileScope drops non-strings, empties, and ./ prefixes", () => {
    expect(
      normalizeFileScope([" ./a.ts ", "pkg\\b.ts", "", "  ", "a.ts", 3 as unknown as string]),
    ).toEqual(["a.ts", "pkg/b.ts"]);
  });
});

describe("buildApprovedScopeRecord / disk IO branches (#3185)", () => {
  it("falls back plan id from basename and optional body digest", () => {
    const rec = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief\\active\\story.xbrief.json",
      payload: { plan: { metadata: { swarm: { file_scope: ["z.ts"] } } } },
      xbriefRawText: '{"plan":{}}',
      approvedAt: "2026-08-07T00:00:00Z",
    });
    expect(rec.planId).toBe("story");
    expect(rec.xbriefRelPath).toBe("xbrief/active/story.xbrief.json");
    expect(rec.xbriefBodyDigest).toBe(computeTextDigest('{"plan":{}}'));
    expect(rec.fileScopeDigest).toBe(computeFileScopeDigest(["z.ts"]));
  });

  it("includes humanApproval without body digest when raw text omitted", () => {
    const rec = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/h.xbrief.json",
      payload: { plan: { id: "h", metadata: { swarm: { file_scope: [] } } } },
      humanApproval: { kind: "cli", actor: "scott", mintedAt: "2026-08-07T00:00:00Z" },
    });
    expect(rec.humanApproval?.kind).toBe("cli");
    expect(rec.xbriefBodyDigest).toBeUndefined();
  });

  it("writes and reads records; malformed disk entries return null", () => {
    const root = tempRoot();
    const rec = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/io.xbrief.json",
      payload: {
        plan: { id: "io-plan", metadata: { swarm: { file_scope: ["a.ts"] } } },
      },
    });
    const path = writeApprovedScopeRecord(root, rec);
    expect(path).toBe(approvedScopeRecordPath(root, "io-plan"));
    expect(readApprovedScopeRecord(root, "io-plan")?.planId).toBe("io-plan");
    expect(readApprovedScopeRecord(root, "missing")).toBeNull();

    // corrupt file
    writeFileSync(approvedScopeRecordPath(root, "bad"), "{not-json", "utf8");
    expect(readApprovedScopeRecord(root, "bad")).toBeNull();

    writeFileSync(approvedScopeRecordPath(root, "arr"), "[]", "utf8");
    expect(readApprovedScopeRecord(root, "arr")).toBeNull();

    writeFileSync(
      approvedScopeRecordPath(root, "partial"),
      JSON.stringify({ fileScope: "nope" }),
      "utf8",
    );
    expect(readApprovedScopeRecord(root, "partial")).toBeNull();
  });

  it("lists only well-formed json records under approved-scope", () => {
    const root = tempRoot();
    expect(listApprovedScopeRecords(root)).toEqual([]);
    const good = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/l.xbrief.json",
      payload: { plan: { id: "list-me", metadata: { swarm: { file_scope: ["x.ts"] } } } },
    });
    writeApprovedScopeRecord(root, good);
    const dir = join(root, ".deft", "approved-scope");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skip.txt"), "nope", "utf8");
    writeFileSync(join(dir, "broken.json"), "{", "utf8");
    writeFileSync(join(dir, "array.json"), "[]", "utf8");
    writeFileSync(join(dir, "nodigest.json"), JSON.stringify({ fileScope: [] }), "utf8");
    const listed = listApprovedScopeRecords(root);
    expect(listed.some((r) => r.planId === "list-me")).toBe(true);
    expect(listed.every((r) => typeof r.fileScopeDigest === "string")).toBe(true);
  });
});

describe("isHumanApprovalStamp / scopeExpansion branches (#3185)", () => {
  it("rejects empty, agent, and non-human kinds; accepts human kinds", () => {
    expect(isHumanApprovalStamp(null)).toBe(false);
    expect(isHumanApprovalStamp(undefined)).toBe(false);
    expect(isHumanApprovalStamp({ kind: "", actor: "x", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "cli", actor: "", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "cli", actor: "agent", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "cli", actor: "agent:bot", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "cli", actor: "self", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "agent", actor: "scott", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "self", actor: "scott", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "xbrief", actor: "scott", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "dispatch", actor: "scott", mintedAt: "t" })).toBe(false);
    expect(isHumanApprovalStamp({ kind: "operator", actor: "scott", mintedAt: "t" })).toBe(true);
    expect(isHumanApprovalStamp({ kind: "github-user", actor: "u", mintedAt: "t" })).toBe(true);
    expect(isHumanApprovalStamp({ kind: "human-renewed", actor: "u", mintedAt: "t" })).toBe(true);
    expect(isHumanApprovalStamp({ kind: "robot", actor: "u", mintedAt: "t" })).toBe(false);
  });

  it("scopeExpansion returns only new normalized paths", () => {
    expect(scopeExpansion(["a.ts", "b.ts"], ["b.ts", "./c.ts", "a.ts"])).toEqual(["c.ts"]);
    expect(scopeExpansion([], ["x.ts"])).toEqual(["x.ts"]);
    expect(scopeExpansion(["x.ts"], ["x.ts"])).toEqual([]);
  });
});
