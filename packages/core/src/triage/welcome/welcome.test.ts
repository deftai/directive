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
    expect(lines.some((l) => l.includes("SCM label mirror discovery"))).toBe(false);
    expect(lines.some((l) => l.includes("triage:classify -- --mirror"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("fully set up is silent after summary", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "");
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { triageScope: [{ rule: "all-open" }], wipCap: 8 } },
      }),
      "utf8",
    );
    const lines: string[] = [];
    runDefaultMode(root, { output: (l) => lines.push(l), writeHistory: false });
    expect(lines.filter((l) => l.includes("[welcome]"))).toHaveLength(0);
    // #3124 tip may still fire once until dry-run/ack (not [welcome] lines).
    rmSync(root, { recursive: true, force: true });
  });

  it("hides SCM label mirror discovery tip after successful dry-run (#3124)", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-tip-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "");
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { triageScope: [{ rule: "all-open" }], wipCap: 8 } },
      }),
      "utf8",
    );
    const first: string[] = [];
    runDefaultMode(root, { output: (l) => first.push(l), writeHistory: false });
    expect(first.some((l) => l.includes("SCM label mirror discovery"))).toBe(false);
    // Simulate first successful --mirror dry-run throttle.
    writeFileSync(
      join(root, "xbrief", ".triage-cache", "scm-label-mirror-discovery-state.json"),
      JSON.stringify({ successfulDryRunAt: "2026-08-11T00:00:00.000Z" }),
      "utf8",
    );
    const second: string[] = [];
    runDefaultMode(root, { output: (l) => second.push(l), writeHistory: false });
    expect(second.some((l) => l.includes("SCM label mirror discovery"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("default mode incomplete nudge", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-inc-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "");
    const lines: string[] = [];
    runDefaultMode(root, { output: (l) => lines.push(l), writeHistory: false });
    expect(lines.some((l) => l.includes("Onboarding incomplete"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
