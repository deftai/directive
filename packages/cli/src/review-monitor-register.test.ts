import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    ]);
    expect(parsed.pr).toBe(3);
    expect(parsed.monitorAgentId).toBe("agent-3");
    expect(parsed.platformPrimitive).toBe("spawn_subagent");
    expect(parsed.repo).toBe("deftai/directive");
    expect(parsed.headSha).toBe("deadbeef");
    expect(parsed.parentSessionId).toBe("sess-1");
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
  });

  it("run registers a monitor successfully", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-reg-"));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(
      run([
        "--pr",
        "88",
        "--monitor-agent-id",
        "rm-88",
        "--platform-primitive",
        "cursor-task",
        "--project-root",
        root,
        "--head-sha",
        "abc123",
      ]),
    ).toBe(0);
    expect(out.mock.calls.join("")).toContain("recorded PR #88");
  });
});
