import { describe, expect, it } from "vitest";
import { probeMonitoringTier } from "./tier-detection.js";

describe("tier-detection", () => {
  it("maps WARP env to Tier 1 start_agent", () => {
    const probe = probeMonitoringTier({ WARP_IS_WARP_TERMINAL: "1" });
    expect(probe.tier).toBe(1);
    expect(probe.primitive).toBe("start_agent");
  });

  it("honors DEFT_PROBE_START_AGENT and DEFT_HAS_START_AGENT", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_START_AGENT: "yes" }).descriptor).toBe(
      "warp-orchestrated",
    );
    expect(probeMonitoringTier({ DEFT_HAS_START_AGENT: "1" }).primitive).toBe("start_agent");
  });

  it("honors spawn_subagent probe and tier2 auto-reinvoke", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_SPAWN_SUBAGENT: "1" }).primitive).toBe(
      "spawn_subagent",
    );
    expect(probeMonitoringTier({ DEFT_HAS_SPAWN_SUBAGENT: "true" }).descriptor).toBe("grok-build");
    expect(probeMonitoringTier({ DEFT_MONITOR_TIER2: "1" }).tier).toBe(2);
    expect(probeMonitoringTier({ DEFT_HAS_AUTO_REINVOKE: "on" }).descriptor).toBe(
      "yield-between-polls",
    );
  });

  it("maps Claude Code probes to Tier 1 claude-agent (#3134)", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_CLAUDE_CODE: "1" })).toMatchObject({
      tier: 1,
      primitive: "claude-agent",
      descriptor: "claude-code",
    });
    expect(probeMonitoringTier({ DEFT_HAS_CLAUDE_AGENT: "true" }).primitive).toBe("claude-agent");
    expect(probeMonitoringTier({ CLAUDECODE: "1" }).descriptor).toBe("claude-code");
    expect(probeMonitoringTier({ CLAUDE_CODE: "yes" }).primitive).toBe("claude-agent");
    expect(probeMonitoringTier({ DEFT_AGENT_RUNTIME: "claude-code" }).primitive).toBe(
      "claude-agent",
    );
    expect(probeMonitoringTier({ DEFT_AGENT_RUNTIME: "claude" }).descriptor).toBe("claude-code");
  });

  it("does not misclassify Claude as cursor when only Claude signals present (#3134)", () => {
    const probe = probeMonitoringTier({ CLAUDECODE: "1" });
    expect(probe.descriptor).not.toBe("cursor-composer");
    expect(probe.descriptor).not.toBe("cursor-cloud-agent");
    expect(probe.primitive).not.toBe("cursor-task");
    expect(probe.descriptor).toBe("claude-code");
  });

  it("Cursor CURSOR_* still wins over Claude signals (ordered probe) (#3134)", () => {
    expect(
      probeMonitoringTier({ CURSOR_COMPOSER: "1", CLAUDECODE: "1", DEFT_PROBE_CLAUDE_CODE: "1" })
        .descriptor,
    ).toBe("cursor-composer");
  });

  it("maps OpenClaw / sessions_spawn probes to Tier 1 (#2876)", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_SESSIONS_SPAWN: "1" }).primitive).toBe(
      "sessions_spawn",
    );
    expect(probeMonitoringTier({ DEFT_HAS_SESSIONS_SPAWN: "true" }).descriptor).toBe("openclaw");
    expect(probeMonitoringTier({ OPENCLAW: "1" }).primitive).toBe("sessions_spawn");
    expect(probeMonitoringTier({ DEFT_AGENT_RUNTIME: "openclaw" }).primitive).toBe(
      "sessions_spawn",
    );
    expect(
      probeMonitoringTier({
        DEFT_PROBE_OPENCLAW: "yes",
        DEFT_MONITOR_TIER1_PRIMITIVE: "openclaw-sessions-spawn",
      }).primitive,
    ).toBe("openclaw-sessions-spawn");
  });

  it("maps Grok Bot unique probes to Tier 1 grok-bot-executor (#4201)", () => {
    expect(probeMonitoringTier({ DEFT_PROBE_GROK_BOT: "1" })).toMatchObject({
      tier: 1,
      primitive: "grok-bot-executor",
      descriptor: "grok-bot",
    });
    expect(probeMonitoringTier({ DEFT_HAS_GROK_BOT_WIDGETS: "true" }).descriptor).toBe("grok-bot");
    expect(probeMonitoringTier({ DEFT_HAS_GROK_BOT_EXECUTOR: "yes" }).primitive).toBe(
      "grok-bot-executor",
    );
    expect(probeMonitoringTier({ GROK_BOT: "1" }).descriptor).toBe("grok-bot");
    expect(probeMonitoringTier({ DEFT_AGENT_RUNTIME: "grok-bot" }).primitive).toBe(
      "grok-bot-executor",
    );
    expect(probeMonitoringTier({ DEFT_AGENT_RUNTIME: "grokbot" }).descriptor).toBe("grok-bot");
  });

  it("does not misclassify Grok Bot as grok-build when spawn_subagent is also present (#4201)", () => {
    const probe = probeMonitoringTier({
      DEFT_PROBE_GROK_BOT: "1",
      DEFT_HAS_SPAWN_SUBAGENT: "true",
      DEFT_PROBE_SPAWN_SUBAGENT: "1",
      GROK_BUILD: "1",
    });
    expect(probe.descriptor).toBe("grok-bot");
    expect(probe.primitive).toBe("grok-bot-executor");
    expect(probe.descriptor).not.toBe("grok-build");
    expect(probe.primitive).not.toBe("spawn_subagent");
  });

  it("does not misclassify Grok Bot as cursor-composer without CURSOR_* (#4201)", () => {
    const probe = probeMonitoringTier({ GROK_BOT: "1" });
    expect(probe.descriptor).not.toBe("cursor-composer");
    expect(probe.descriptor).not.toBe("cursor-cloud-agent");
    expect(probe.primitive).not.toBe("cursor-task");
    expect(probe.descriptor).toBe("grok-bot");
  });

  it("Cursor CURSOR_* still wins over Grok Bot signals (ordered probe) (#4201)", () => {
    expect(
      probeMonitoringTier({ CURSOR_COMPOSER: "1", GROK_BOT: "1", DEFT_PROBE_GROK_BOT: "1" })
        .descriptor,
    ).toBe("cursor-composer");
  });

  it("OpenClaw still wins over Grok Bot signals (ordered probe) (#4201)", () => {
    expect(probeMonitoringTier({ OPENCLAW: "1", GROK_BOT: "1" }).descriptor).toBe("openclaw");
  });

  it("spawn_subagent alone remains grok-build (#4201)", () => {
    expect(probeMonitoringTier({ DEFT_HAS_SPAWN_SUBAGENT: "true" }).descriptor).toBe("grok-build");
    expect(probeMonitoringTier({ GROK_BUILD: "yes" }).primitive).toBe("spawn_subagent");
  });

  it("honors tier overrides", () => {
    expect(probeMonitoringTier({ DEFT_MONITOR_TIER: "tier1" }).descriptor).toBe("override-tier1");
    expect(
      probeMonitoringTier({
        DEFT_MONITOR_TIER_OVERRIDE: "1",
        DEFT_MONITOR_TIER1_PRIMITIVE: "start_agent",
      }).primitive,
    ).toBe("start_agent");
    expect(
      probeMonitoringTier({
        DEFT_MONITOR_TIER: "1",
        DEFT_MONITOR_TIER1_PRIMITIVE: "sessions_spawn",
      }).primitive,
    ).toBe("sessions_spawn");
    expect(probeMonitoringTier({ DEFT_MONITOR_TIER: "tier3" }).tier).toBe(3);
  });
});
