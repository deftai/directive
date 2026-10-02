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
    expect(readHostCapabilityStamp(root, { now })?.source).toBe("test");
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

  it("keys env patch by primitive, not descriptor (#5229)", () => {
    const stamp = parseHostCapabilityStamp({
      schema_version: 1,
      descriptor: "grok-build",
      primitive: "claude-agent",
      stamped_at: "2026-10-01T20:00:00.000Z",
      source: "t",
    });
    expect(stamp).not.toBeNull();
    if (stamp === null) return;
    const patch = mergeHostCapabilityStampIntoEnviron({}, stamp);
    expect(patch.DEFT_PROBE_CLAUDE_CODE).toBe("1");
    expect(patch.DEFT_HAS_SPAWN_SUBAGENT).toBeUndefined();
  });

  it("ignores stale stamps and foreign host_session_id (#5229)", () => {
    const root = mkdtempSync(join(tmpdir(), "hc-stamp-stale-"));
    const stampedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(
      writeHostCapabilityStamp(root, {
        primitive: "spawn_subagent",
        hostSessionId: "host-A",
        source: "unit",
        now: stampedAt,
      }).ok,
    ).toBe(true);
    expect(
      readHostCapabilityStamp(root, {
        now: new Date("2026-10-01T20:00:00.000Z"),
        environ: { GROK_SESSION_ID: "host-A" },
      }),
    ).toBeNull();
    const freshRoot = mkdtempSync(join(tmpdir(), "hc-stamp-foreign-"));
    const now = new Date("2026-10-01T20:00:00.000Z");
    expect(
      writeHostCapabilityStamp(freshRoot, {
        primitive: "spawn_subagent",
        hostSessionId: "host-A",
        source: "unit",
        now,
      }).ok,
    ).toBe(true);
    expect(
      readHostCapabilityStamp(freshRoot, {
        now,
        environ: { GROK_SESSION_ID: "host-B" },
      }),
    ).toBeNull();
    expect(
      readHostCapabilityStamp(freshRoot, {
        now,
        environ: {},
      }),
    ).toBeNull();
    expect(
      readHostCapabilityStamp(freshRoot, {
        now,
        environ: { GROK_SESSION_ID: "host-A" },
      })?.host_session_id,
    ).toBe("host-A");
  });
});
