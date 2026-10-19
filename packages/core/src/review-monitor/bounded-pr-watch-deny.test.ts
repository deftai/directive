import { describe, expect, it } from "vitest";
import {
  babysitPathAdmissionCost,
  evaluateBoundedPrWatchDeny,
  evaluateClaimedBabysitPathDeny,
  FORBIDDEN_CLAIMED_WAIT_KINDS_WHEN_TIER1,
  isApproach1CheapestVs,
  isDirectivePrWatchForm,
} from "./bounded-pr-watch-deny.js";

const TIER1 = {
  tier: 1 as const,
  primitive: "spawn_subagent" as const,
  descriptor: "grok-build",
};

const TIER3 = {
  tier: 3 as const,
  primitive: null,
  descriptor: "generic-terminal",
};

describe("bounded-pr-watch-deny (#5229)", () => {
  it("ranks Approach 1 cheapest vs shell/host/forge/temp paths", () => {
    expect(babysitPathAdmissionCost("approach1-spawn")).toBeLessThan(
      babysitPathAdmissionCost("directive-pr-watch-bare"),
    );
    expect(isApproach1CheapestVs("host-monitor")).toBe(true);
    expect(isApproach1CheapestVs("forge-poll")).toBe(true);
    expect(isApproach1CheapestVs("bespoke-temp-poller")).toBe(true);
    expect(babysitPathAdmissionCost("forge-poll")).toBeGreaterThan(
      babysitPathAdmissionCost("host-monitor"),
    );
  });

  it("recognizes bounded Directive pr:watch forms only", () => {
    expect(isDirectivePrWatchForm("")).toBe(false);
    expect(isDirectivePrWatchForm("   ")).toBe(false);
    expect(isDirectivePrWatchForm("task pr:watch -- 12")).toBe(true);
    expect(isDirectivePrWatchForm("deft pr:watch 12 --json")).toBe(true);
    expect(isDirectivePrWatchForm("task deft:pr:watch -- 12")).toBe(true);
    expect(isDirectivePrWatchForm("pwsh %TEMP%/watch-pr.ps1")).toBe(false);
    expect(isDirectivePrWatchForm("monitor host-watch")).toBe(false);
  });

  it("admits bare Directive pr:watch when Tier 1 is not proven", () => {
    const result = evaluateBoundedPrWatchDeny({
      command: "task pr:watch -- 12",
      tier: TIER3,
      pr: 12,
    });
    expect(result.deny).toBe(false);
    expect(result.recognizedForm).toBe(true);
    expect(result.message).toContain("no Tier-1");
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

describe("evaluateClaimedBabysitPathDeny (#5727 P4)", () => {
  it("forbids forge-poll / bespoke-temp / host-monitor / bare watch when Tier 1", () => {
    expect([...FORBIDDEN_CLAIMED_WAIT_KINDS_WHEN_TIER1].sort()).toEqual(
      ["bespoke-temp-poller", "directive-pr-watch-bare", "forge-poll", "host-monitor"].sort(),
    );
    for (const kind of FORBIDDEN_CLAIMED_WAIT_KINDS_WHEN_TIER1) {
      const result = evaluateClaimedBabysitPathDeny({
        claimedKind: kind,
        tier: TIER1,
        boundEvidence: { pr: 5727 },
      });
      expect(result.deny).toBe(true);
      expect(result.reason).toBe("forbidden-claimed-kind");
      expect(result.message).toContain("Exclusive lawful waits");
      expect(result.message).toContain("forge-poll");
    }
  });

  it("admits forbidden kinds when Tier 1 is not proven", () => {
    const result = evaluateClaimedBabysitPathDeny({
      claimedKind: "forge-poll",
      tier: TIER3,
    });
    expect(result.deny).toBe(false);
    expect(result.reason).toBe("admitted-not-tier1");
  });

  it("admits post-CLEAN pr:wait-mergeable-and-merge", () => {
    const result = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      phase: "post-clean",
      claimedPostCleanWait: "pr-wait-mergeable-and-merge",
    });
    expect(result.deny).toBe(false);
    expect(result.reason).toBe("admitted-post-clean");
  });

  it("fails closed on Approach 1 without bound evidence", () => {
    const unbound = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
    });
    expect(unbound.deny).toBe(true);
    expect(unbound.reason).toBe("approach1-unbound");

    const partial = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 5727,
        monitorAgentId: "rm-5727",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: false,
      },
    });
    expect(partial.deny).toBe(true);
    expect(partial.reason).toBe("approach1-unbound");

    const badPr = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 0,
        monitorAgentId: "rm-0",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(badPr.deny).toBe(true);
    expect(badPr.reason).toBe("approach1-unbound");

    const flagId = evaluateClaimedBabysitPathDeny({
      claimedKind: "directive-pr-watch-with-monitor-id",
      tier: TIER1,
      boundEvidence: {
        pr: 12,
        monitorAgentId: "--json",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(flagId.deny).toBe(true);
    expect(flagId.reason).toBe("approach1-unbound");

    const nullEvidence = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: null,
    });
    expect(nullEvidence.deny).toBe(true);
    expect(nullEvidence.reason).toBe("approach1-unbound");

    const emptyId = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 12,
        monitorAgentId: "   ",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(emptyId.deny).toBe(true);

    const emptyPrim = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 12,
        monitorAgentId: "rm-12",
        registeredPlatformPrimitive: "   ",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(emptyPrim.deny).toBe(true);

    const otherPrim = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 12,
        evidencePr: 12,
        monitorAgentId: "rm-12",
        registeredPlatformPrimitive: "cursor-task",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(otherPrim.deny).toBe(false);
    expect(otherPrim.reason).toBe("admitted");
  });

  it("fails closed on different-PR arm", () => {
    const result = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 5727,
        evidencePr: 9999,
        monitorAgentId: "rm-5727",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(result.deny).toBe(true);
    expect(result.reason).toBe("different-pr-arm");
    expect(result.message).toContain("9999");
    expect(result.message).toContain("5727");
  });

  it("admits Approach 1 with bound evidence on the same PR", () => {
    const result = evaluateClaimedBabysitPathDeny({
      claimedKind: "approach1-spawn",
      tier: TIER1,
      boundEvidence: {
        pr: 5727,
        evidencePr: 5727,
        monitorAgentId: "rm-5727",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(result.deny).toBe(false);
    expect(result.reason).toBe("admitted");
  });
});
