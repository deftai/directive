import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSteer } from "@deftai/directive-core/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSubagentSteerGate,
  parseVerifySubagentSteerArgs,
  run,
} from "./verify-subagent-steer.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verify-subagent-steer gate (#4286)", () => {
  it("parseVerifySubagentSteerArgs accepts agent and steer-dir flags", () => {
    const parsed = parseVerifySubagentSteerArgs([
      "--steer-dir",
      "inbox",
      "--agent=leaf-a",
      "--agent",
      "leaf-b",
      "--json",
    ]);
    expect(parsed.agentIds).toEqual(["leaf-a", "leaf-b"]);
    expect(parsed.steerDir).toBe("inbox");
    expect(parsed.emitJson).toBe(true);
  });

  it("rejects missing flag values and unknown flags", () => {
    expect(parseVerifySubagentSteerArgs(["--steer-dir"]).error).toMatch(/expected one argument/);
    expect(parseVerifySubagentSteerArgs(["--agent"]).error).toMatch(/expected one argument/);
    expect(parseVerifySubagentSteerArgs(["--unknown"]).error).toMatch(/unrecognized argument/);
    expect(parseVerifySubagentSteerArgs(["positional"]).error).toMatch(/unrecognized argument/);
  });

  it("exit 1 STEER_PENDING never prints REDISPATCH_OK", () => {
    const root = mkdtempSync(join(tmpdir(), "steer-cli-"));
    const steerDir = join(root, ".deft-scratch", "subagent-steer");
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent",
      kind: "constraint",
      text: "do not kill check",
      steerId: "s1",
      writtenAt: new Date(),
    });

    const verdict = evaluateSubagentSteerGate(
      {
        steerDir,
        agentIds: ["leaf-a"],
        emitJson: false,
        help: false,
      },
      root,
    );
    expect(verdict.exitCode).toBe(1);
    expect(verdict.redispatchOk).toBe(false);
    expect(verdict.message).toContain("STEER_PENDING");
    expect(verdict.message).not.toContain("REDISPATCH_OK");
    rmSync(root, { recursive: true, force: true });
  });

  it("exit 0 when inbox is empty or missing", () => {
    const root = mkdtempSync(join(tmpdir(), "steer-cli-empty-"));
    const verdict = evaluateSubagentSteerGate(
      {
        steerDir: join(root, "missing-steer"),
        agentIds: [],
        emitJson: true,
        help: false,
      },
      root,
    );
    expect(verdict.exitCode).toBe(0);
    expect(verdict.json?.steer_pending).toBe(false);
    expect(verdict.json?.redispatch_ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("acked inbox is not pending", () => {
    const root = mkdtempSync(join(tmpdir(), "steer-cli-ack-"));
    const steerDir = join(root, "inbox");
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent",
      kind: "note",
      text: "acked",
      steerId: "s2",
      writtenAt: new Date(),
    });
    writeFileSync(
      join(steerDir, "leaf-a.ack.json"),
      JSON.stringify({
        schema: "deft.subagent.steer-ack.v1",
        agent_id: "leaf-a",
        steer_id: "s2",
        acked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
      "utf8",
    );
    const verdict = evaluateSubagentSteerGate(
      { steerDir, agentIds: ["leaf-a"], emitJson: false, help: false },
      root,
    );
    expect(verdict.exitCode).toBe(0);
    expect(verdict.message).toContain("no unread steer");
    rmSync(root, { recursive: true, force: true });
  });

  it("run prints help and exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("verify:subagent-steer");
  });

  it("config error when steer path is a file", () => {
    const root = mkdtempSync(join(tmpdir(), "steer-cli-cfg-"));
    const filePath = join(root, "afile");
    writeFileSync(filePath, "x", "utf8");
    const verdict = evaluateSubagentSteerGate({
      steerDir: filePath,
      agentIds: [],
      emitJson: false,
      help: false,
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.redispatchOk).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("evaluateSubagentSteerGate propagates parse errors", () => {
    const verdict = evaluateSubagentSteerGate({
      steerDir: null,
      agentIds: [],
      emitJson: false,
      help: false,
      error: "argument --agent: expected one argument",
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.message).toContain("expected one argument");
  });
});
