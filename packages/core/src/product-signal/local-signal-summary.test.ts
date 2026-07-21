import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleLocalSignalSummary } from "./local-signal-summary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("assembleLocalSignalSummary", () => {
  it("returns schemaVersion 1 summary", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-lss-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    const summary = assembleLocalSignalSummary(root);
    expect(summary.schemaVersion).toBe(1);
    expect(summary.window).toBe("30d");
  });

  it("supports custom window units", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-lss-win-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    expect(assembleLocalSignalSummary(root, { window: "7d" }).window).toBe("7d");
    expect(assembleLocalSignalSummary(root, { window: "12h" }).window).toBe("12h");
    expect(assembleLocalSignalSummary(root, { window: "15m" }).window).toBe("15m");
    expect(assembleLocalSignalSummary(root, { window: "bogus" }).window).toBe("bogus");
  });

  it("includes disabled valueFeedback summary when policy off", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-lss-vf-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    const summary = assembleLocalSignalSummary(root);
    expect(summary.valueFeedback?.enabled).toBe(false);
  });
});
