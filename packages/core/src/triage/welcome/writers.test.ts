import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAuditEntry,
  previewWipRelief,
  subscriptionPreset,
  writeTriageScope,
  writeWipCap,
} from "./writers.js";

function seedPd(root: string): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy: {} } }),
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
      readFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    );
    expect(data.plan.policy.triageScope).toEqual(rules);
    expect(data.plan.policy.wipCap).toBe(8);
    rmSync(root, { recursive: true, force: true });
  });

  it("default wip cap confirm does not materialize field", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-"));
    seedPd(root);
    const [changed] = writeWipCap(root, 10);
    expect(changed).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("previewWipRelief classifies by age", () => {
    const root = mkdtempSync(join(tmpdir(), "relief-"));
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "old.vbrief.json"),
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
    const [changed, entry] = writeWipCap(root, 10);
    expect(changed).toBe(true);
    expect(entry).toContain("cleared-to-default");
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
