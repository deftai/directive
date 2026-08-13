import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/types.js";
import { escalateCeremonyDial, selectCeremonyDepth } from "./ceremony-dial.js";
import {
  emitCeremonyDialEscalationEvaluation,
  evaluateCeremonyDialEscalation,
  evaluateSessionStartCeremonyDialEscalation,
  formatCeremonyDialPinBypassLine,
  isCeremonyStartTierPinned,
  resolveCeremonyStartTierProvenance,
} from "./ceremony-dial-escalation.js";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("ceremony-dial start-tier provenance (#3319)", () => {
  it("treats matrix/default selection as cold-start", () => {
    const selection = selectCeremonyDepth({
      inputs: { modelTier: "frontier", projectShape: "project" },
    });
    expect(resolveCeremonyStartTierProvenance({ selection, injectedSelection: false })).toBe(
      "cold-start",
    );
    expect(isCeremonyStartTierPinned("cold-start")).toBe(false);
    expect(formatCeremonyDialPinBypassLine("cold-start")).toBeNull();
  });

  it("treats injected override as external-pin and names unset-the-pin", () => {
    const selection = selectCeremonyDepth({
      config: { override: "rapid" },
      inputs: { modelTier: "mid", projectShape: "project" },
    });
    const provenance = resolveCeremonyStartTierProvenance({
      selection,
      injectedSelection: true,
    });
    expect(provenance).toBe("external-pin");
    const line = formatCeremonyDialPinBypassLine(provenance);
    expect(line).toContain("#3274 cold-start selection is bypassed (external-pin)");
    expect(line).toContain("Unset the pin");
    expect(line).toContain("--ceremony-depth");
  });

  it("treats policy override as operator pin", () => {
    const selection = selectCeremonyDepth({
      config: { override: "rapid" },
    });
    expect(resolveCeremonyStartTierProvenance({ selection, injectedSelection: false })).toBe(
      "operator",
    );
    const line = formatCeremonyDialPinBypassLine("operator");
    expect(line).toContain("operator pin");
    expect(line).toContain("plan.policy.ceremonyDial.override");
  });

  it("honors an explicit provenance hint", () => {
    const selection = selectCeremonyDepth({ config: { override: "standard" } });
    expect(
      resolveCeremonyStartTierProvenance({
        selection,
        injectedSelection: true,
        hint: "operator",
      }),
    ).toBe("operator");
  });
});

describe("evaluateCeremonyDialEscalation (#3319)", () => {
  it("emits escalated when evidence raises depth", () => {
    const ev = evaluateCeremonyDialEscalation({
      from: "rapid",
      to: "standard",
      inputs: { taskSize: "M", modelTier: "frontier" },
    });
    expect(ev.outcome).toBe("escalated");
    expect(ev.tier).toBe("standard");
    expect(ev.reason).toContain("rapid -> standard");
    expect(ev.reason).toContain("size=M");
  });

  it("emits declined when evidence does not raise depth", () => {
    const ev = evaluateCeremonyDialEscalation({
      from: "rapid",
      to: "rapid",
      inputs: { taskSize: "S", modelTier: "frontier" },
    });
    expect(ev.outcome).toBe("declined");
    expect(ev.tier).toBe("rapid");
    expect(ev.reason).toContain("insufficient evidence");
    expect(ev.outcome).not.toBe("escalated");
  });

  it("session-start helper compares cold-start floor to selected depth", () => {
    const raised = selectCeremonyDepth({
      inputs: { taskSize: "M", modelTier: "frontier", projectShape: "project" },
    });
    const ev = evaluateSessionStartCeremonyDialEscalation({ selection: raised });
    expect(ev.outcome).toBe("escalated");
    expect(ev.from).toBe("rapid");
    expect(ev.to).toBe("standard");

    const stayed = selectCeremonyDepth({
      inputs: { taskSize: "S", modelTier: "frontier", projectShape: "project" },
    });
    expect(evaluateSessionStartCeremonyDialEscalation({ selection: stayed }).outcome).toBe(
      "declined",
    );
  });

  it("does not change thresholds: mid incomplete-size stays at standard floor", () => {
    const mid = selectCeremonyDepth({
      inputs: { modelTier: "mid", projectShape: "project" },
    });
    expect(mid.depth).toBe("standard");
    const ev = evaluateSessionStartCeremonyDialEscalation({ selection: mid });
    expect(ev.outcome).toBe("declined");
    expect(ev.tier).toBe("standard");
  });
});

describe("emitCeremonyDialEscalationEvaluation fail-open (#3319)", () => {
  it("appends tier/outcome/reason when DEFT_RUN_SUMMARY_PATH is set", () => {
    const root = mkdtempSync(join(tmpdir(), "dial-eval-emit-"));
    temps.push(root);
    const out = join(root, "summary.jsonl");
    emitCeremonyDialEscalationEvaluation({
      projectRoot: root,
      sessionId: "sess-eval",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      evaluation: {
        tier: "rapid",
        outcome: "declined",
        reason: "insufficient evidence to raise above rapid (size=- modelTier=-)",
        from: "rapid",
        to: "rapid",
      },
    });
    const line = JSON.parse(readFileSync(out, "utf8").trim()) as {
      event: string;
      payload: { tier: string; outcome: string; reason: string };
    };
    expect(line.event).toBe("dial_escalation_evaluation");
    expect(line.payload.tier).toBe("rapid");
    expect(line.payload.outcome).toBe("declined");
    expect(line.payload.reason).toContain("insufficient evidence");
  });

  it("is silent when DEFT_RUN_SUMMARY_PATH is unset", () => {
    const root = mkdtempSync(join(tmpdir(), "dial-eval-silent-"));
    temps.push(root);
    emitCeremonyDialEscalationEvaluation({
      projectRoot: root,
      sessionId: "sess-silent",
      env: {},
      evaluation: {
        tier: "rapid",
        outcome: "escalated",
        reason: "x",
        from: "rapid",
        to: "standard",
      },
    });
    expect(() => readFileSync(join(root, ".deft-run-summary.json"), "utf8")).toThrow();
  });
});

describe("escalateCeremonyDial evaluation events (#3319)", () => {
  function makeProject(): string {
    const root = mkdtempSync(join(tmpdir(), "dial-escalate-eval-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { title: "P", status: "running", policy: {} },
      }),
      "utf8",
    );
    return root;
  }

  it("emits declined when escalate is evaluated without --confirm", () => {
    const root = makeProject();
    const out = join(root, "summary.jsonl");
    const result = escalateCeremonyDial(root, {
      to: "standard",
      reason: "size=M",
      sessionId: "sess-preview",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    expect(result.changed).toBe(false);
    const line = JSON.parse(readFileSync(out, "utf8").trim()) as {
      event: string;
      payload: { outcome: string; reason: string; tier: string };
    };
    expect(line.event).toBe("dial_escalation_evaluation");
    expect(line.payload.outcome).toBe("declined");
    expect(line.payload.reason).toContain("need --confirm");
  });

  it("emits escalated plus dial_transition when confirm applies a raise", () => {
    const root = makeProject();
    const out = join(root, "summary.jsonl");
    const result = escalateCeremonyDial(root, {
      to: "standard",
      reason: "size=M",
      confirm: true,
      sessionId: "sess-apply",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    expect(result.exitCode).toBe(0);
    const events = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; payload: { outcome?: string } });
    expect(events.some((e) => e.event === "dial_escalation_evaluation")).toBe(true);
    expect(events.some((e) => e.event === "dial_transition")).toBe(true);
    const evaluation = events.find((e) => e.event === "dial_escalation_evaluation");
    expect(evaluation?.payload.outcome).toBe("escalated");
  });
});
