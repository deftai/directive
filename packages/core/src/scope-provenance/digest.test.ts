import { describe, expect, it } from "vitest";
import {
  buildApprovedScopeRecord,
  computeFileScopeDigest,
  extractFileScope,
  extractPlanId,
  isHumanApprovalStamp,
  normalizeFileScope,
  scopeExpansion,
} from "./digest.js";

describe("scope-provenance digest (#3145)", () => {
  it("extracts plan id and file_scope", () => {
    const payload = {
      plan: {
        id: "demo",
        metadata: { swarm: { file_scope: ["a.ts", "b.ts"] } },
      },
    };
    expect(extractPlanId(payload)).toBe("demo");
    expect(extractFileScope(payload)).toEqual(["a.ts", "b.ts"]);
  });

  it("builds approved records with stable digests", () => {
    const payload = {
      plan: { id: "demo", metadata: { swarm: { file_scope: ["b.ts", "a.ts"] } } },
    };
    const rec = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/demo.xbrief.json",
      payload,
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-06T00:00:00Z" },
    });
    expect(rec.fileScopeDigest).toBe(computeFileScopeDigest(["a.ts", "b.ts"]));
    expect(rec.fileScope).toEqual(normalizeFileScope(["a.ts", "b.ts"]));
    expect(isHumanApprovalStamp(rec.humanApproval)).toBe(true);
    expect(rec.xbriefBodyDigest).toBeUndefined();
    expect(scopeExpansion(rec.fileScope, ["a.ts", "b.ts", "c.ts"])).toEqual(["c.ts"]);
  });

  it("does not write xbriefBodyDigest when raw text is provided (#3384 F4)", () => {
    const rec = buildApprovedScopeRecord({
      xbriefRelPath: "xbrief/active/demo.xbrief.json",
      payload: { plan: { id: "demo", metadata: { swarm: { file_scope: ["a.ts"] } } } },
      xbriefRawText: '{"plan":{"id":"demo"}}',
      humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-08-06T00:00:00Z" },
    });
    expect(rec.xbriefBodyDigest).toBeUndefined();
    expect("xbriefBodyDigest" in rec).toBe(false);
  });

  it("rejects agent stamps", () => {
    expect(
      isHumanApprovalStamp({ kind: "agent", actor: "agent:x", mintedAt: "2026-08-06T00:00:00Z" }),
    ).toBe(false);
  });
});
