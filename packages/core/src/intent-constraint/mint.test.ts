import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIntentConstraintRecord,
  computeContractDigest,
  extractIntentConstraintFromPlan,
  parseIntentConstraintContract,
  parseIntentConstraintRecord,
  writeIntentConstraintRecord,
} from "./mint.js";

const human = {
  kind: "operator" as const,
  actor: "scott",
  mintedAt: "2026-09-15T00:00:00Z",
  mintedVia: "scope:record-intent-constraint",
};

describe("intent-constraint mint (#4541)", () => {
  it("refuses worker-declared baselineRef and agent stamps", () => {
    const rec = buildIntentConstraintRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    expect(parseIntentConstraintRecord({ ...rec, baselineRef: "HEAD~1" })).toMatchObject({
      error: expect.stringMatching(/baselineRef/),
    });
    const agent = buildIntentConstraintRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
      humanApproval: { kind: "agent", actor: "agent:leaf", mintedAt: "2026-09-15T00:00:00Z" },
    });
    expect(agent).toMatchObject({ error: expect.stringMatching(/human-presence/) });
  });

  it("requires value, unit, and rejectionScope", () => {
    expect(parseIntentConstraintContract({ constraints: [{ value: "1024" }] })).toMatchObject({
      error: expect.stringMatching(/unit/),
    });
    expect(
      parseIntentConstraintContract({
        constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
      }),
    ).toEqual({
      constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
    });
  });

  it("pins contractDigest", () => {
    const constraints = [
      { value: "1024" as const, unit: "bytes", rejectionScope: "invocation" as const },
    ];
    const rec = buildIntentConstraintRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      constraints,
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    expect(rec.contractDigest).toBe(computeContractDigest(constraints));
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("intent-constraint mint IO (#4541)", () => {
  it("writes a record and extracts the plan key", () => {
    const rec = buildIntentConstraintRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    const root = mkdtempSync(join(tmpdir(), "ic-mint-io-"));
    temps.push(root);
    const pathWritten = writeIntentConstraintRecord(root, rec);
    const parsed = parseIntentConstraintRecord(JSON.parse(readFileSync(pathWritten, "utf8")));
    expect("error" in parsed).toBe(false);
    expect(
      extractIntentConstraintFromPlan({
        plan: { "x-directive/intentConstraint": { constraints: rec.constraints } },
      }),
    ).toEqual({ constraints: rec.constraints });
  });
});
