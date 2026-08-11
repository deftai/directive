import { describe, expect, it } from "vitest";
import {
  extractGateCause,
  formatDegradedSkipReport,
  formatNamedCauseFailure,
  remedyForGate,
} from "./named-cause.js";

describe("named-cause gate failures (#3282)", () => {
  it("includes gate name, cause, and remedy without env values", () => {
    const msg = formatNamedCauseFailure({
      gateId: "verify:branch",
      exitCode: 1,
      stderr: "❌ deft branch-protection: refusing default branch\n",
      stdout: "",
    });
    expect(msg.lines[0]).toContain("verify:branch");
    expect(msg.lines[0]).toContain("exit 1");
    expect(msg.cause).toMatch(/branch-protection|refusing/i);
    expect(msg.remedy).toMatch(/feature branch|git switch/i);
    expect(msg.lines.join("\n")).not.toMatch(/DEFT_[A-Z0-9_]+=/);
  });

  it("names missing task binary from spawn errors", () => {
    const msg = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: 1,
      spawnError: "spawn task ENOENT",
    });
    expect(msg.cause).toMatch(/task binary not found/i);
    expect(msg.remedy).toMatch(/taskfile\.dev|go-task/i);
  });

  it("does not treat bare exit as empty cause", () => {
    const cause = extractGateCause("", "", 1);
    expect(cause).toMatch(/without a diagnostic/);
  });

  it("strips env-like lines from cause extraction", () => {
    const cause = extractGateCause("", "DEFT_FOO=secret\nreal failure: cache stale\n", 1);
    expect(cause).toBe("real failure: cache stale");
    expect(cause).not.toContain("DEFT_FOO");
  });

  it("formats degraded skip report with causes", () => {
    const lines = formatDegradedSkipReport({
      reason: "task missing",
      skipped: [
        {
          id: "toolchain:check-consumer",
          cause: "go-task binary not found on PATH",
          remedy: "Install go-task",
        },
      ],
    });
    expect(lines.join("\n")).toContain("degraded mode");
    expect(lines.join("\n")).toContain("toolchain:check-consumer");
    expect(lines.join("\n")).toContain("exit 0 (degraded)");
  });

  it("returns a generic remedy for unknown gates", () => {
    expect(remedyForGate("unknown:gate", "something broke")).toMatch(/Re-run the gate/);
  });
});
