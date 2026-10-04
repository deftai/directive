import { describe, expect, it } from "vitest";
import {
  approach1BabysitterCommands,
  approach1RemediationForUnarmedPrs,
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
    expect(card).toContain("cheapest admitted path");
    expect(card).toContain("writeHostCapabilityStamp");
    expect(card).toContain("%TEMP%");
    expect(card).toContain("Bounded deny");
  });

  it("cohort remediation emits Approach 1 commands per unarmed PR (#5318)", () => {
    const cmds = approach1RemediationForUnarmedPrs([7, 8]);
    expect(cmds).toHaveLength(6);
    expect(cmds[0]).toContain("--pr 7");
    expect(cmds[3]).toContain("--pr 8");
  });
});
