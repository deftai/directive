import { describe, expect, it } from "vitest";
import {
  babysitPathAdmissionCost,
  evaluateBoundedPrWatchDeny,
  isApproach1CheapestVs,
  isDirectivePrWatchForm,
} from "./bounded-pr-watch-deny.js";

describe("bounded-pr-watch-deny (#5229)", () => {
  it("ranks Approach 1 cheapest vs shell/host/temp paths", () => {
    expect(babysitPathAdmissionCost("approach1-spawn")).toBeLessThan(
      babysitPathAdmissionCost("directive-pr-watch-bare"),
    );
    expect(isApproach1CheapestVs("host-monitor")).toBe(true);
    expect(isApproach1CheapestVs("bespoke-temp-poller")).toBe(true);
  });

  it("recognizes bounded Directive pr:watch forms only", () => {
    expect(isDirectivePrWatchForm("task pr:watch -- 12")).toBe(true);
    expect(isDirectivePrWatchForm("deft pr:watch 12 --json")).toBe(true);
    expect(isDirectivePrWatchForm("task deft:pr:watch -- 12")).toBe(true);
    expect(isDirectivePrWatchForm("pwsh %TEMP%/watch-pr.ps1")).toBe(false);
    expect(isDirectivePrWatchForm("monitor host-watch")).toBe(false);
  });

  it("denies bare Directive pr:watch when Tier 1 is provable", () => {
    const result = evaluateBoundedPrWatchDeny({
      command: "task pr:watch -- 5229",
      tier: { tier: 1, primitive: "spawn_subagent", descriptor: "grok-build" },
      pr: 5229,
      monitorAgentId: "rm-5229",
    });
    expect(result.deny).toBe(true);
    expect(result.message).toContain("--monitor-agent-id");
    expect(result.message).toContain("Approach 1");
    expect(result.residualNamed).toContain("%TEMP%");
  });

  it("admits child-bound Directive pr:watch with monitor-agent-id", () => {
    const result = evaluateBoundedPrWatchDeny({
      command: "DEFT_MONITOR_AGENT_ID=rm-1 task pr:watch -- 1 --monitor-agent-id rm-1",
      tier: { tier: 1, primitive: "spawn_subagent", descriptor: "grok-build" },
      pr: 1,
    });
    expect(result.deny).toBe(false);
    expect(result.hasMonitorAgentId).toBe(true);
  });

  it("treats empty / flag-shaped monitor ids as missing (#5229)", () => {
    const emptyFlag = evaluateBoundedPrWatchDeny({
      command: "task pr:watch -- 1 --monitor-agent-id=",
      tier: { tier: 1, primitive: "spawn_subagent", descriptor: "grok-build" },
      pr: 1,
    });
    expect(emptyFlag.hasMonitorAgentId).toBe(false);
    expect(emptyFlag.deny).toBe(true);
    const emptyEnv = evaluateBoundedPrWatchDeny({
      command: "DEFT_MONITOR_AGENT_ID= task pr:watch -- 1",
      tier: { tier: 1, primitive: "spawn_subagent", descriptor: "grok-build" },
      pr: 1,
    });
    expect(emptyEnv.hasMonitorAgentId).toBe(false);
    expect(emptyEnv.deny).toBe(true);
    const flagAsId = evaluateBoundedPrWatchDeny({
      command: "pr:watch 12 --monitor-agent-id --json",
      tier: { tier: 1, primitive: "spawn_subagent", descriptor: "grok-build" },
      pr: 12,
    });
    expect(flagAsId.hasMonitorAgentId).toBe(false);
    expect(flagAsId.deny).toBe(true);
  });

  it("does not deny unrecognized %TEMP% forms (named residual)", () => {
    const result = evaluateBoundedPrWatchDeny({
      command: "pwsh -File $env:TEMP/watch-pr.ps1",
      tier: { tier: 1, primitive: "spawn_subagent", descriptor: "grok-build" },
    });
    expect(result.deny).toBe(false);
    expect(result.recognizedForm).toBe(false);
    expect(result.residualNamed).toContain("Named residual");
  });
});
