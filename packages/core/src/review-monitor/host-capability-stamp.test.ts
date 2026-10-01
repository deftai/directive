import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeHostCapabilityStampIntoEnviron,
  parseHostCapabilityStamp,
  readHostCapabilityStamp,
  writeHostCapabilityStamp,
} from "./host-capability-stamp.js";
import { probeMonitoringTier } from "./tier-detection.js";

describe("host-capability-stamp (#5229)", () => {
  it("writes and reads a grok-build stamp", () => {
    const root = mkdtempSync(join(tmpdir(), "hc-stamp-"));
    const now = new Date("2026-10-01T20:00:00.000Z");
    const written = writeHostCapabilityStamp(root, {
      descriptor: "grok-build",
      primitive: "spawn_subagent",
      source: "test",
      now,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const raw = JSON.parse(readFileSync(written.path, "utf8")) as unknown;
    expect(parseHostCapabilityStamp(raw)?.primitive).toBe("spawn_subagent");
    expect(readHostCapabilityStamp(root)?.source).toBe("test");
  });

  it("fills DEFT_HAS_SPAWN_SUBAGENT so probe stays Tier 1 without GROK_BUILD env", () => {
    const root = mkdtempSync(join(tmpdir(), "hc-stamp-probe-"));
    expect(writeHostCapabilityStamp(root, { source: "unit" }).ok).toBe(true);
    const probe = probeMonitoringTier({}, { projectRoot: root });
    expect(probe.tier).toBe(1);
    expect(probe.primitive).toBe("spawn_subagent");
    expect(probe.descriptor).toBe("grok-build");
  });

  it("does not clobber existing env keys when merging", () => {
    const stamp = parseHostCapabilityStamp({
      schema_version: 1,
      descriptor: "grok-build",
      primitive: "spawn_subagent",
      stamped_at: "2026-10-01T20:00:00.000Z",
      source: "t",
    });
    expect(stamp).not.toBeNull();
    const merged = mergeHostCapabilityStampIntoEnviron(
      { DEFT_HAS_SPAWN_SUBAGENT: "preexisting" },
      stamp,
    );
    expect(merged.DEFT_HAS_SPAWN_SUBAGENT).toBe("preexisting");
  });
});
