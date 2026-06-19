import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAuditEntry,
  previewWipRelief,
  subscriptionPreset,
  writeTriageScope,
  writeWipCap,
} from "./writers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "writers-br-"));
  roots.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  return root;
}

function seedPd(root: string, body: Record<string, unknown> = { plan: { policy: {} } }): void {
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify(body),
    "utf8",
  );
}

describe("writers error and edge branches", () => {
  it("writeTriageScope fails when project definition is missing or malformed", () => {
    const root = makeRoot();
    expect(() => writeTriageScope(root, [], { presetLabel: "custom" })).toThrow(
      /PROJECT-DEFINITION not found/,
    );

    seedPd(root, { plan: null });
    expect(() => writeTriageScope(root, [], { presetLabel: "custom" })).toThrow(
      /plan.*not an object/,
    );
  });

  it("writeTriageScope materializes policy object and records unchanged preset", () => {
    const root = makeRoot();
    seedPd(root, { plan: {} });
    const rules = subscriptionPreset("small");
    const [changed] = writeTriageScope(root, rules, { presetLabel: "small", actor: "tester" });
    expect(changed).toBe(true);
    const data = JSON.parse(
      readFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    );
    expect(data.plan.policy.triageScope).toEqual(rules);
    expect(readFileSync(join(root, "meta", "policy-changes.log"), "utf8")).toContain(
      "actor=tester",
    );
  });

  it("writeWipCap fails for invalid values and missing project definition", () => {
    const root = makeRoot();
    expect(() => writeWipCap(root, 0)).toThrow(/positive int/);
    expect(() => writeWipCap(root, 5)).toThrow(/PROJECT-DEFINITION not found/);
  });

  it("writeWipCap records unchanged cap updates", () => {
    const root = makeRoot();
    seedPd(root, { plan: { policy: { wipCap: 8 } } });
    const [changed] = writeWipCap(root, 8, { actor: "tester" });
    expect(changed).toBe(false);
  });

  it("previewWipRelief handles missing pending dir and mtime fallback", () => {
    const root = makeRoot();
    expect(previewWipRelief(root)).toEqual({
      olderThanDays: 30,
      eligibleCount: 0,
      eligibleFiles: [],
      skippedCount: 0,
    });

    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    const path = join(pending, "mtime-only.vbrief.json");
    writeFileSync(path, JSON.stringify({ plan: {} }), "utf8");
    const old = new Date(Date.now() - 40 * 86400000);
    utimesSync(path, old, old);
    const preview = previewWipRelief(root, 30);
    expect(preview.eligibleCount).toBe(1);
    expect(statSync(path).mtime.getTime()).toBeLessThan(Date.now());
  });

  it("appendAuditEntry appends to existing audit log", () => {
    const root = makeRoot();
    const first = appendAuditEntry(root, "first");
    appendAuditEntry(root, "second");
    const text = readFileSync(first, "utf8");
    expect(text).toContain("first");
    expect(text).toContain("second");
  });

  it("subscriptionPreset rejects unknown keys", () => {
    expect(() => subscriptionPreset("not-a-preset")).toThrow(/unknown preset/);
  });
});
