import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildObservableScopeRecord,
  computeContractDigest,
  evaluateObservableMintPreflight,
  parseObservableChangeContract,
  parseObservableScopeRecord,
  writeObservableScopeRecord,
} from "./mint.js";

const human = {
  kind: "operator" as const,
  actor: "david",
  mintedAt: "2026-09-13T00:00:00Z",
  mintedVia: "scope:record-observable-scope",
};

describe("observable-scope mint record (#4495)", () => {
  it("refuses worker-declared baselineRef and URL designApprovalRef", () => {
    const rec = buildObservableScopeRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    expect(parseObservableScopeRecord({ ...rec, baselineRef: "HEAD~1" })).toMatchObject({
      error: expect.stringMatching(/baselineRef/),
    });
    expect(
      parseObservableScopeRecord({ ...rec, designApprovalRef: "https://example.test" }),
    ).toMatchObject({
      error: expect.stringMatching(/designApprovalRef/),
    });
  });

  it("refuses agent stamps", () => {
    const rec = buildObservableScopeRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: { kind: "agent", actor: "agent:leaf", mintedAt: "2026-09-13T00:00:00Z" },
    });
    expect(rec).toMatchObject({ error: expect.stringMatching(/human-presence/) });
  });

  it("accepts namespaced contract without baselineRef", () => {
    const parsed = parseObservableChangeContract({
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    expect("error" in parsed).toBe(false);
  });

  it("accepts layout-authorized and refuses mixed", () => {
    const ok = parseObservableChangeContract({
      changeKind: "layout-authorized",
      allowedChanges: [{ kind: "tab", op: "reorder" }],
    });
    expect("error" in ok).toBe(false);
    expect(
      parseObservableChangeContract({ changeKind: "mixed", allowedChanges: [] }),
    ).toMatchObject({ error: expect.stringMatching(/mixed/) });
    expect(
      parseObservableChangeContract({
        changeKind: "fields-only",
        allowedChanges: [{ kind: "heading", op: "rename", name: "A" }],
      }),
    ).toMatchObject({ error: expect.stringMatching(/reorder/) });
  });

  it("pins contractDigest", () => {
    const allowedChanges = [{ kind: "control" as const, op: "add" as const, name: "email" }];
    const rec = buildObservableScopeRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges,
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    expect(rec.contractDigest).toBe(computeContractDigest({ allowedChanges }));
    expect(parseObservableScopeRecord({ ...rec, contractDigest: "deadbeef" })).toMatchObject({
      error: expect.stringMatching(/contractDigest/),
    });
  });

  it("preflight refuses UI intended_placement without a mint record (#4588)", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-preflight-"));
    try {
      const payload = {
        plan: {
          id: "story-ui",
          metadata: { intended_placement: { files: ["src/App.tsx"] } },
        },
      };
      const missing = evaluateObservableMintPreflight(payload, root);
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.message).toMatch(/x-directive\/observableChange/);

      const rec = buildObservableScopeRecord({
        planId: "story-ui",
        xbriefRelPath: "xbrief/active/story.xbrief.json",
        allowedChanges: [{ kind: "control", op: "add", name: "email" }],
        humanApproval: human,
      });
      if ("error" in rec) throw new Error(rec.error);
      writeObservableScopeRecord(root, rec);
      const stillMissingContract = evaluateObservableMintPreflight(payload, root);
      expect(stillMissingContract.ok).toBe(false);

      const withContract = {
        plan: {
          id: "story-ui",
          metadata: { intended_placement: { files: ["src/App.tsx"] } },
          "x-directive/observableChange": {
            changeKind: "fields-only",
            allowedChanges: [{ kind: "control", op: "add", name: "email" }],
          },
        },
      };
      expect(evaluateObservableMintPreflight(withContract, root).ok).toBe(true);
      expect(
        evaluateObservableMintPreflight(
          { plan: { id: "story-ts", metadata: { intended_placement: { files: ["src/app.ts"] } } } },
          root,
        ).ok,
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
