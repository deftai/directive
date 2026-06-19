import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDefaultMode } from "./default-mode.js";
import { classifyOnboarding, detectPriorState } from "./prior-state.js";

describe("welcome prior state", () => {
  it("detects first-time state", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-"));
    const state = detectPriorState(root);
    expect(state.auditLogPresent).toBe(false);
    expect(state.triageScopeSet).toBe(false);
    const [label] = classifyOnboarding(state);
    expect(label).toBe("first-time");
    rmSync(root, { recursive: true, force: true });
  });

  it("default mode emits cache empty line", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-"));
    const lines: string[] = [];
    runDefaultMode(root, { output: (l) => lines.push(l), writeHistory: false });
    expect(lines[0]).toContain("[triage] cache empty");
    expect(lines.some((l) => l.includes("First-time?"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("fully set up is silent after summary", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(join(root, "vbrief", ".eval", "candidates.jsonl"), "");
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { policy: { triageScope: [{ rule: "all-open" }], wipCap: 8 } },
      }),
      "utf8",
    );
    const lines: string[] = [];
    runDefaultMode(root, { output: (l) => lines.push(l), writeHistory: false });
    expect(lines.filter((l) => l.includes("[welcome]"))).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("default mode incomplete nudge", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-inc-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(join(root, "vbrief", ".eval", "candidates.jsonl"), "");
    const lines: string[] = [];
    runDefaultMode(root, { output: (l) => lines.push(l), writeHistory: false });
    expect(lines.some((l) => l.includes("Onboarding incomplete"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
