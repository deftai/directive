import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PRESETS } from "./constants.js";
import { classifyOnboarding, detectPriorState, pendingDecisionsNudgeLine } from "./prior-state.js";

describe("prior-state branches", () => {
  it("detects small preset scope", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-small-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { triageScope: SUBSCRIPTION_PRESETS.small, wipCap: 5 } } }),
      "utf8",
    );
    const state = detectPriorState(root);
    expect(state.triageScopeSummary).toContain("Small");
    expect(state.wipCapSet).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("detects mid and mega presets", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-mid-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { triageScope: SUBSCRIPTION_PRESETS.mid } } }),
      "utf8",
    );
    expect(detectPriorState(root).triageScopeSummary).toContain("Mid");
    rmSync(root, { recursive: true, force: true });

    const root2 = mkdtempSync(join(tmpdir(), "prior-mega-"));
    mkdirSync(join(root2, "xbrief"), { recursive: true });
    writeFileSync(
      join(root2, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { triageScope: SUBSCRIPTION_PRESETS.mega } } }),
      "utf8",
    );
    expect(detectPriorState(root2).triageScopeSummary).toContain("Mega");
    rmSync(root2, { recursive: true, force: true });
  });

  it("classifies fully-set-up vs incomplete", () => {
    const full = classifyOnboarding({
      triageScopeSet: true,
      triageScopeSummary: "x",
      cacheEmpty: false,
      cacheEntryCount: 1,
      wipCapSet: true,
      wipCapDecided: true,
      wipCap: 10,
      wipCount: 0,
      auditLogPresent: true,
      pendingDecisions: 0,
    });
    expect(full[0]).toBe("fully-set-up");
    const incomplete = classifyOnboarding({
      triageScopeSet: false,
      triageScopeSummary: "x",
      cacheEmpty: false,
      cacheEntryCount: 1,
      wipCapSet: true,
      wipCapDecided: true,
      wipCap: 10,
      wipCount: 0,
      auditLogPresent: true,
      pendingDecisions: 0,
    });
    expect(incomplete[0]).toBe("incomplete");
  });

  it("treats default-accepted decision marker as wipCap complete without materializing (#1694)", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-wipcap-decided-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          policy: { triageScope: SUBSCRIPTION_PRESETS.small },
          "x-directive/onboarding": { wipCapDecided: true, acceptedDefault: true },
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "{}\n", "utf8");
    const state = detectPriorState(root);
    expect(state.wipCapSet).toBe(false);
    expect(state.wipCapDecided).toBe(true);
    expect(classifyOnboarding(state)[0]).toBe("fully-set-up");
    rmSync(root, { recursive: true, force: true });
  });

  it("still prompts greenfield consumers that have never decided wipCap (#1694)", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-wipcap-undecided-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { policy: { triageScope: SUBSCRIPTION_PRESETS.small } },
      }),
      "utf8",
    );
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "{}\n", "utf8");
    const state = detectPriorState(root);
    expect(state.wipCapSet).toBe(false);
    expect(state.wipCapDecided).toBe(false);
    const [label, missing] = classifyOnboarding(state);
    expect(label).toBe("incomplete");
    expect(missing).toContain("wipCap");
    rmSync(root, { recursive: true, force: true });
  });

  it("detects custom scope rules", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-custom-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { triageScope: [{ rule: "labels", "any-of": ["x"] }] } } }),
      "utf8",
    );
    expect(detectPriorState(root).triageScopeSummary).toContain("custom");
    rmSync(root, { recursive: true, force: true });
  });

  it("pendingDecisionsNudgeLine above threshold", () => {
    expect(pendingDecisionsNudgeLine(5)).toContain("TIER-1");
    expect(pendingDecisionsNudgeLine(1)).toBe("");
  });
});
