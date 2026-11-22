import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIntentConstraintRecord } from "../intent-constraint/mint.js";
import { buildObservableScopeRecord } from "../observable-scope/mint.js";
import {
  briefLandHeadReader,
  evaluateBriefLandScopeRecord,
  isScopeRecordPath,
} from "./brief-land-records.js";
import { isBriefLandShapedDiff, isProductShapedDiff, type PrDiffPath } from "./main.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STAMP = {
  kind: "operator",
  actor: "scott",
  mintedAt: "2026-11-21T00:00:00Z",
  mintedVia: "scope:record-observable-scope",
};
const BRIEF = "xbrief/active/2026-11-21-1-ui.xbrief.json";
const OBS = {
  changeKind: "fields-only",
  allowedChanges: [{ kind: "control", op: "add", name: "email" }],
};

function write(root: string, rel: string, value: unknown): void {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function fixture(
  opts: { briefContract?: unknown; recordPlanId?: string; recordBrief?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "brief-land-rec-"));
  temps.push(root);
  write(root, BRIEF, {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "plan/one",
      title: "ui",
      status: "running",
      items: [],
      "x-directive/observableChange": opts.briefContract ?? OBS,
    },
  });
  const rec = buildObservableScopeRecord({
    planId: opts.recordPlanId ?? "plan/one",
    xbriefRelPath: opts.recordBrief ?? BRIEF,
    allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    changeKind: "fields-only",
    humanApproval: STAMP,
  });
  if ("error" in rec) throw new Error(rec.error);
  write(root, ".deft/observable-scope/plan_one.json", { ...rec, cohortDigest: "sha256:x" });
  return root;
}

const RECORD = ".deft/observable-scope/plan_one.json";
const files = (...extra: PrDiffPath[]): PrDiffPath[] => [
  { status: "added", path: BRIEF },
  { status: "added", path: RECORD },
  ...extra,
];

describe("activation-PR record carry (#6937)", () => {
  it("names the two record folders only", () => {
    expect(isScopeRecordPath(".deft/observable-scope/a.json")).toBe(true);
    expect(isScopeRecordPath(".deft/intent-constraint/a.json")).toBe(true);
    expect(isScopeRecordPath(".deft/approved-scope/a.json")).toBe(false);
    expect(isScopeRecordPath(".deft/observable-scope/sub/a.json")).toBe(false);
  });

  it("admits a record that matches a brief the PR adds", () => {
    const root = fixture();
    const read = briefLandHeadReader(root);
    expect(isBriefLandShapedDiff(files(), read)).toBe(true);
    expect(isProductShapedDiff(files(), read)).toBe(false);
  });

  it("keeps today's answer without a reader", () => {
    fixture();
    expect(isBriefLandShapedDiff(files())).toBe(false);
  });

  it("refuses a record for another brief", () => {
    const root = fixture({ recordBrief: "xbrief/active/other.xbrief.json" });
    expect(isBriefLandShapedDiff(files(), briefLandHeadReader(root))).toBe(false);
  });

  it("refuses a record with no brief in the PR", () => {
    const root = fixture();
    expect(
      isBriefLandShapedDiff(
        [
          { status: "added", path: "xbrief/active/unrelated.xbrief.json" },
          { status: "added", path: RECORD },
        ],
        briefLandHeadReader(root),
      ),
    ).toBe(false);
    const res = evaluateBriefLandScopeRecord({
      file: { status: "added", path: RECORD },
      files: [{ status: "added", path: RECORD }],
      readHeadFile: briefLandHeadReader(root),
    });
    expect(res.ok).toBe(false);
  });

  it("refuses a removed brief", () => {
    const root = fixture();
    expect(
      isBriefLandShapedDiff(
        [
          { status: "removed", path: BRIEF },
          { status: "added", path: "xbrief/active/keep.xbrief.json" },
          { status: "added", path: RECORD },
        ],
        briefLandHeadReader(root),
      ),
    ).toBe(false);
  });

  it("refuses a wrong file name", () => {
    const root = fixture();
    const recBytes = join(root, ".deft", "observable-scope", "plan_one.json");
    write(root, ".deft/observable-scope/wrong.json", readFileSync(recBytes, "utf8"));
    expect(
      isBriefLandShapedDiff(
        [
          { status: "added", path: BRIEF },
          { status: "added", path: ".deft/observable-scope/wrong.json" },
        ],
        briefLandHeadReader(root),
      ),
    ).toBe(false);
  });

  it("refuses a contract or changeKind mismatch", () => {
    const changed = fixture({
      briefContract: {
        changeKind: "fields-only",
        allowedChanges: [{ kind: "control", op: "add", name: "phone" }],
      },
    });
    expect(isBriefLandShapedDiff(files(), briefLandHeadReader(changed))).toBe(false);
    const kind = fixture({ briefContract: { ...OBS, changeKind: "layout-authorized" } });
    expect(isBriefLandShapedDiff(files(), briefLandHeadReader(kind))).toBe(false);
  });

  it("refuses a record that does not parse", () => {
    const root = fixture();
    write(root, RECORD, "{");
    expect(isBriefLandShapedDiff(files(), briefLandHeadReader(root))).toBe(false);
  });

  it("admits a matching intent-constraint record", () => {
    const root = mkdtempSync(join(tmpdir(), "brief-land-ic-"));
    temps.push(root);
    const constraints = [{ value: "5", unit: "minutes", rejectionScope: "operation" as const }];
    write(root, BRIEF, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "p1",
        title: "t",
        status: "running",
        items: [],
        "x-directive/intentConstraint": { constraints },
      },
    });
    const rec = buildIntentConstraintRecord({
      planId: "p1",
      xbriefRelPath: BRIEF,
      constraints,
      humanApproval: { ...STAMP, mintedVia: "scope:record-intent-constraint" },
    });
    if ("error" in rec) throw new Error(rec.error);
    write(root, ".deft/intent-constraint/p1.json", rec);
    const diff = [
      { status: "added", path: BRIEF },
      { status: "added", path: ".deft/intent-constraint/p1.json" },
    ];
    expect(isBriefLandShapedDiff(diff, briefLandHeadReader(root))).toBe(true);
    write(root, BRIEF, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "p1",
        title: "t",
        status: "running",
        items: [],
        "x-directive/intentConstraint": { constraints: [{ ...constraints[0], value: "6" }] },
      },
    });
    expect(isBriefLandShapedDiff(diff, briefLandHeadReader(root))).toBe(false);
  });

  it("reader refuses escaping paths", () => {
    const root = fixture();
    const read = briefLandHeadReader(root);
    expect(read("../x.json")).toBeNull();
    expect(read(BRIEF)).not.toBeNull();
  });
});
