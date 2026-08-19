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

  it("names a missing global CLI without telling the agent to install go-task (#3335)", () => {
    const msg = formatNamedCauseFailure({
      gateId: "verify:ac",
      exitCode: 1,
      spawnError: "spawn deft ENOENT",
    });
    expect(msg.cause).toMatch(/deft\/directive CLI not found/i);
    expect(msg.remedy).toMatch(/@deftai\/directive/);
    expect(msg.remedy).not.toMatch(/go-task|taskfile\.dev/i);
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
    expect(lines.join("\n")).toContain("exit 2 (degraded/config)");
  });

  it("returns a generic remedy for unknown gates", () => {
    expect(remedyForGate("unknown:gate", "something broke")).toMatch(/Re-run the gate/);
  });

  it("attributes verify:ac instead of quoting engine:_ts-build (#3449)", () => {
    const msg = formatNamedCauseFailure({
      gateId: "verify:ac",
      exitCode: 201,
      stdout:
        "task: [engine:_ts-build] set -eu\n" +
        "set -eu\n" +
        "# #3324: consumer-deposit marker\n" +
        "if node tasks/engine-invoke.cjs is-buildable-source /repo; then\n" +
        "verify:ac passed (#3284) [rung=stated]\n" +
        "Literal acceptance-command gate: no stated commands (nothing to run) (#3284/#3267)\n",
      stderr: "",
    });
    expect(msg.cause).toMatch(/verify:ac/);
    expect(msg.cause).not.toMatch(/engine:_ts-build/);
    expect(msg.cause).not.toMatch(/set -eu/);
  });
});
