import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContainedWriteError } from "../../fs/contained-write.js";
import { DEFAULT_WIP_CAP } from "./constants.js";
import {
  appendAuditEntry,
  previewWipRelief,
  subscriptionPreset,
  writeTriageScope,
  writeWipCap,
  writeWipCapDecision,
} from "./writers.js";

function seedPd(root: string): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy: {} } }),
    "utf8",
  );
}

describe("welcome writers", () => {
  it("writes triage scope and wip cap", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-"));
    seedPd(root);
    const rules = subscriptionPreset("small");
    writeTriageScope(root, rules, { presetLabel: "small" });
    writeWipCap(root, 8);
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    expect(data.plan["x-directive/policy"].triageScope).toEqual(rules);
    expect(data.plan["x-directive/policy"].wipCap).toBe(8);
    rmSync(root, { recursive: true, force: true });
  });

  it("default wip cap confirm does not materialize field but records decision (#1694)", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-"));
    seedPd(root);
    const [changed] = writeWipCap(root, DEFAULT_WIP_CAP);
    expect(changed).toBe(true);
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    expect(data.plan["x-directive/policy"]?.wipCap).toBeUndefined();
    expect(data.plan["x-directive/onboarding"]?.wipCapDecided).toBe(true);
    expect(data.plan["x-directive/onboarding"]?.acceptedDefault).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("writeWipCapDecision records provenance without materializing wipCap (#1694)", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-decision-"));
    seedPd(root);
    writeWipCapDecision(root, { acceptedDefault: true, actor: "test" });
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    expect(data.plan["x-directive/policy"]?.wipCap).toBeUndefined();
    expect(data.plan["x-directive/onboarding"]).toMatchObject({
      wipCapDecided: true,
      acceptedDefault: true,
      actor: "test",
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("previewWipRelief classifies by age", () => {
    const root = mkdtempSync(join(tmpdir(), "relief-"));
    const pending = join(root, "xbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "old.xbrief.json"),
      JSON.stringify({ plan: { updated: "2020-01-01T00:00:00Z" } }),
      "utf8",
    );
    const preview = previewWipRelief(root, 30);
    expect(preview.eligibleCount).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("clears wip cap back to default", () => {
    const root = mkdtempSync(join(tmpdir(), "writers2-"));
    seedPd(root);
    writeWipCap(root, 8);
    const [changed, entry] = writeWipCap(root, DEFAULT_WIP_CAP);
    expect(changed).toBe(true);
    expect(entry).toContain("cleared-to-default");
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    // Clearing to default must not leave a stale custom value on the decision record.
    expect(data.plan["x-directive/onboarding"]).toMatchObject({
      wipCapDecided: true,
      acceptedDefault: true,
    });
    expect(data.plan["x-directive/onboarding"].value).toBeUndefined();
    expect(data.plan["x-directive/policy"]?.wipCap).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("appendAuditEntry creates log header", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-audit-"));
    const path = appendAuditEntry(root, "test entry");
    expect(readFileSync(path, "utf8")).toContain("test entry");
    appendAuditEntry(root, "second");
    rmSync(root, { recursive: true, force: true });
  });

  it("writeWipCap rejects invalid values", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-bad-"));
    seedPd(root);
    expect(() => writeWipCap(root, 0)).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("previewWipRelief empty pending dir", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-relief-empty-"));
    expect(previewWipRelief(root).eligibleCount).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("subscriptionPreset throws on unknown key", () => {
    expect(() => subscriptionPreset("nope")).toThrow();
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("welcome audit containment (#2470)", () => {
  itSymlink("refuses audit append when policy-changes.log is a symlink outside the project", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "writers-contain-proj-"));
    const escapeTarget = mkdtempSync(join(tmpdir(), "writers-contain-escape-"));
    const escapeFile = join(escapeTarget, "stolen-audit.log");
    try {
      mkdirSync(join(projectDir, "meta"), { recursive: true });
      writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
      symlinkSync(escapeFile, join(projectDir, "meta", "policy-changes.log"));
      expect(() => appendAuditEntry(projectDir, "injected")).toThrow(ContainedWriteError);
      expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});
