import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitClaimedBabysitPath,
  approach1BabysitterCommands,
  approach1RemediationForUnarmedPrs,
  ensureHostCapabilityStampForBabysit,
  formatApproach1BabysitterCard,
  formatApproach1BabysitterOneLiner,
} from "./approach1-babysitter.js";

describe("approach1 babysitter one-liner (#5219)", () => {
  it("emits register + child-bound pr:watch then parent verify", () => {
    const text = formatApproach1BabysitterOneLiner(5219, "rm-5219");
    expect(text).toContain("--platform-primitive spawn_subagent");
    expect(text).toContain("DEFT_MONITOR_AGENT_ID=rm-5219");
    expect(text).toContain("pr:watch -- 5219 --monitor-agent-id rm-5219");
    expect(text).toContain("--merge-path-arm --live-wait");
    expect(text.indexOf("pr:watch -- 5219")).toBeLessThan(text.indexOf("verify:review-monitor"));
  });

  it("lists the same commands for swarm card dispatch", () => {
    const cmds = approach1BabysitterCommands(12, "monitor-12");
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toContain("review-monitor:register");
    expect(cmds[1]).toContain("DEFT_MONITOR_AGENT_ID=monitor-12");
    expect(cmds[1]).toContain("pr:watch -- 12");
    expect(cmds[2]).toContain("verify:review-monitor");
    const card = formatApproach1BabysitterCard(12, "monitor-12");
    expect(card).toContain("exclusive lawful waits");
    expect(card).toContain("cheapest admitted path");
    expect(card).toContain("writeHostCapabilityStamp");
    expect(card).toContain("forge-poll");
    expect(card).toContain("%TEMP%");
    expect(card).toContain("Bounded deny");
    expect(card).toContain("admitClaimedBabysitPath");
  });

  it("cohort remediation emits Approach 1 commands per unarmed PR (#5318)", () => {
    const cmds = approach1RemediationForUnarmedPrs([7, 8]);
    expect(cmds).toHaveLength(6);
    expect(cmds[0]).toContain("--pr 7");
    expect(cmds[3]).toContain("--pr 8");
  });
});

describe("admitClaimedBabysitPath named caller (#5727 P4)", () => {
  const tier1 = {
    tier: 1 as const,
    primitive: "spawn_subagent" as const,
    descriptor: "grok-build",
  };

  it("denies forge-poll and attaches exclusive lawful-waits card", () => {
    const result = admitClaimedBabysitPath({
      claimedKind: "forge-poll",
      tier: tier1,
      pr: 5727,
      monitorAgentId: "rm-5727",
    });
    expect(result.deny).toBe(true);
    expect(result.reason).toBe("forbidden-claimed-kind");
    expect(result.cheapestAdmissionCard).toContain("exclusive lawful waits");
    expect(result.message).toContain("forge-poll");
    expect(result.message).toContain("review-monitor:register");
  });

  it("denies Approach 1 without bound evidence", () => {
    const result = admitClaimedBabysitPath({
      claimedKind: "approach1-spawn",
      tier: tier1,
      pr: 5727,
    });
    expect(result.deny).toBe(true);
    expect(result.reason).toBe("approach1-unbound");
    expect(result.cheapestAdmissionCard).toContain("Approach 1");
  });

  it("denies different-PR arm", () => {
    const result = admitClaimedBabysitPath({
      claimedKind: "approach1-spawn",
      tier: tier1,
      pr: 5727,
      boundEvidence: {
        pr: 5727,
        evidencePr: 100,
        monitorAgentId: "rm-5727",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(result.deny).toBe(true);
    expect(result.reason).toBe("different-pr-arm");
  });

  it("admits Approach 1 with same-PR bound evidence", () => {
    const result = admitClaimedBabysitPath({
      claimedKind: "approach1-spawn",
      tier: tier1,
      pr: 5727,
      boundEvidence: {
        pr: 5727,
        evidencePr: 5727,
        monitorAgentId: "rm-5727",
        registeredPlatformPrimitive: "spawn_subagent",
        childWatchBoundToMonitorId: true,
      },
    });
    expect(result.deny).toBe(false);
    expect(result.cheapestAdmissionCard).toBeNull();
  });

  it("falls back to boundEvidence pr/id when top-level fields are absent", () => {
    const result = admitClaimedBabysitPath({
      claimedKind: "host-monitor",
      tier: tier1,
      boundEvidence: {
        pr: 42,
        monitorAgentId: "from-evidence",
      },
    });
    expect(result.deny).toBe(true);
    expect(result.cheapestAdmissionCard).toContain("pr:watch -- 42");
    expect(result.cheapestAdmissionCard).toContain("from-evidence");
  });

  it("uses placeholder id and zero PR when no evidence is available", () => {
    const result = admitClaimedBabysitPath({
      claimedKind: "forge-poll",
      tier: { tier: 1, primitive: null, descriptor: "grok-build" },
    });
    expect(result.deny).toBe(true);
    expect(result.cheapestAdmissionCard).toContain("<id>");
    expect(result.cheapestAdmissionCard).toContain("pr:watch -- 0");
  });
});

describe("ensureHostCapabilityStampForBabysit (#5229)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes stamp with defaults and overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "a1-stamp-"));
    roots.push(root);
    const stamped = ensureHostCapabilityStampForBabysit(root);
    expect(stamped.ok).toBe(true);
    if (!stamped.ok) throw new Error("expected stamp write ok");
    expect(stamped.stamp.primitive).toBe("spawn_subagent");
    expect(stamped.stamp.source).toBe("approach1-babysitter");
    const overridden = ensureHostCapabilityStampForBabysit(root, {
      primitive: "spawn_subagent",
      hostSessionId: "host:test",
      source: "unit-test",
      now: new Date("2026-10-19T00:00:00Z"),
    });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) throw new Error("expected override stamp write ok");
    expect(overridden.stamp.host_session_id).toBe("host:test");
    expect(overridden.stamp.source).toBe("unit-test");
  });
});
