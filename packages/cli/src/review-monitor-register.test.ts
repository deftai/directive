import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRegisterArgs, run } from "./review-monitor-register.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("review-monitor-register CLI", () => {
  it("parseRegisterArgs rejects missing platform primitive", () => {
    const parsed = parseRegisterArgs(["--pr", "1", "--monitor-agent-id", "m1"]);
    expect(parsed.platformPrimitive).toBeNull();
  });

  it("parses equals-form flags", () => {
    const parsed = parseRegisterArgs([
      "--pr=3",
      "--monitor-agent-id=agent-3",
      "--platform-primitive=spawn_subagent",
      "--repo=deftai/directive",
      "--head-sha=deadbeef",
      "--project-root=.",
      "--parent-session-id=sess-1",
      "--owner=alice",
      "--force",
    ]);
    expect(parsed.pr).toBe(3);
    expect(parsed.monitorAgentId).toBe("agent-3");
    expect(parsed.platformPrimitive).toBe("spawn_subagent");
    expect(parsed.repo).toBe("deftai/directive");
    expect(parsed.headSha).toBe("deadbeef");
    expect(parsed.parentSessionId).toBe("sess-1");
    expect(parsed.owner).toBe("alice");
    expect(parsed.force).toBe(true);
  });

  it("accepts OpenClaw sessions_spawn primitives (#2876)", () => {
    expect(
      parseRegisterArgs([
        "--pr=9",
        "--monitor-agent-id=oc-monitor",
        "--platform-primitive=sessions_spawn",
      ]).platformPrimitive,
    ).toBe("sessions_spawn");
    expect(
      parseRegisterArgs([
        "--pr=9",
        "--monitor-agent-id=oc-monitor",
        "--platform-primitive=openclaw-sessions-spawn",
      ]).platformPrimitive,
    ).toBe("openclaw-sessions-spawn");
  });

  it("accepts Claude Code claude-agent primitive (#3134)", () => {
    expect(
      parseRegisterArgs([
        "--pr=11",
        "--monitor-agent-id=cc-monitor",
        "--platform-primitive=claude-agent",
      ]).platformPrimitive,
    ).toBe("claude-agent");
  });

  it("rejects invalid primitive and unknown args", () => {
    expect(parseRegisterArgs(["--platform-primitive", "nope"]).error).toMatch(/invalid/);
    expect(parseRegisterArgs(["--bogus"]).error).toMatch(/unrecognized/);
  });

  it("run exits 2 when required fields missing", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--pr", "1"])).toBe(2);
    expect(run(["--pr", "1", "--monitor-agent-id", "x"])).toBe(2);
    expect(run([])).toBe(2);
  });

  it("run prints help", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("review-monitor:register");
    expect(out.mock.calls.join("")).toContain("deft:review-owner");
  });
});
