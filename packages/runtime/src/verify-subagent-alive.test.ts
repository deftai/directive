import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSubagentAliveGate,
  parseVerifySubagentAliveArgs,
  run,
} from "./verify-subagent-alive.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verify-subagent-alive gate (#2824 / cohort-2804-2814)", () => {
  it("parseVerifySubagentAliveArgs accepts require-agent flags", () => {
    const parsed = parseVerifySubagentAliveArgs([
      "--scratch-dir",
      "scratch",
      "--require-agent=leaf-a",
      "--require-agent",
      "leaf-b",
      "--threshold-minutes=5",
      "--json",
    ]);
    expect(parsed.requireAgents).toEqual(["leaf-a", "leaf-b"]);
    expect(parsed.scratchDirs).toEqual(["scratch"]);
    expect(parsed.thresholdMinutes).toBe(5);
    expect(parsed.emitJson).toBe(true);
  });

  it("rejects missing --require-agent value", () => {
    expect(parseVerifySubagentAliveArgs(["--require-agent"]).error).toMatch(
      /expected one argument/,
    );
  });

  it("cohort-2804-2814: PR open with no heartbeat => not healthy", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });

    const verdict = evaluateSubagentAliveGate(
      {
        scratchDirs: [scratch],
        requireAgents: ["2804-deposit-package-absent-prune"],
        thresholdMinutes: 30,
        emitJson: false,
        help: false,
      },
      root,
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.redispatchOk).toBe(true);
    expect(verdict.message).toContain("REDISPATCH_OK");
    expect(verdict.message).toContain("2804-deposit-package-absent-prune");
    expect(verdict.message).toContain("--action cancel");
    expect(verdict.message).toContain("session:start --rearm");

    rmSync(root, { recursive: true, force: true });
  });

  it("exits 0 when required agent heartbeat is fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-fresh-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(scratch, "worker-2824.json"),
      JSON.stringify({
        agent_id: "worker-2824",
        parent_id: "parent",
        last_heartbeat_at: now,
        last_message: "polling PR #2824",
        phase: "polling",
        pr_number: 2824,
      }),
      "utf8",
    );

    const verdict = evaluateSubagentAliveGate(
      {
        scratchDirs: [scratch],
        requireAgents: ["worker-2824"],
        thresholdMinutes: 30,
        emitJson: false,
        help: false,
      },
      root,
    );

    expect(verdict.exitCode).toBe(0);
    expect(verdict.redispatchOk).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("exits 1 with REDISPATCH_OK on STALE heartbeat", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-stale-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, "silent-leaf.json"),
      JSON.stringify({
        agent_id: "silent-leaf",
        parent_id: "parent",
        last_heartbeat_at: "2020-01-01T12:00:00Z",
        last_message: "opened PR then went dark",
        phase: "polling",
        pr_number: 2818,
      }),
      "utf8",
    );

    const verdict = evaluateSubagentAliveGate(
      {
        scratchDirs: [scratch],
        requireAgents: ["silent-leaf"],
        thresholdMinutes: 30,
        emitJson: true,
        help: false,
      },
      root,
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.redispatchOk).toBe(true);
    expect(verdict.json?.redispatch_ok).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("required agent healthy ignores unrelated stale record in same scratch dir", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-mixed-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(scratch, "worker-2824.json"),
      JSON.stringify({
        agent_id: "worker-2824",
        parent_id: "parent",
        last_heartbeat_at: now,
        last_message: "healthy",
        phase: "polling",
      }),
      "utf8",
    );
    writeFileSync(
      join(scratch, "unrelated-stale.json"),
      JSON.stringify({
        agent_id: "unrelated-stale",
        parent_id: "parent",
        last_heartbeat_at: "2020-01-01T12:00:00Z",
        last_message: "old",
        phase: "polling",
      }),
      "utf8",
    );

    const verdict = evaluateSubagentAliveGate(
      {
        scratchDirs: [scratch],
        requireAgents: ["worker-2824"],
        thresholdMinutes: 30,
        emitJson: false,
        help: false,
      },
      root,
    );

    expect(verdict.exitCode).toBe(0);
    expect(verdict.redispatchOk).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("run prints help and exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("verify:subagent-alive");
  });

  it("evaluateSubagentAliveGate propagates parse args errors", () => {
    const verdict = evaluateSubagentAliveGate({
      scratchDirs: [],
      requireAgents: [],
      thresholdMinutes: 30,
      emitJson: false,
      help: false,
      error: "argument --require-agent: expected one argument",
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.message).toContain("expected one argument");
  });

  it("configError returns text message when emitJson is false", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-cfg-"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--scratch-dir", join(root, "missing-status"), "--require-agent", "x"])).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("parseVerifySubagentAliveArgs surfaces scratch-dir and threshold errors", () => {
    expect(parseVerifySubagentAliveArgs(["--scratch-dir"]).error).toMatch(/expected one argument/);
    expect(parseVerifySubagentAliveArgs(["--threshold-minutes"]).error).toMatch(
      /expected one argument/,
    );
    expect(parseVerifySubagentAliveArgs(["--unknown-flag"]).error).toMatch(/unrecognized argument/);
    expect(parseVerifySubagentAliveArgs(["positional"]).error).toMatch(/unrecognized argument/);
  });

  it("evaluateSubagentAliveGate rejects non-positive threshold minutes", () => {
    const verdict = evaluateSubagentAliveGate({
      scratchDirs: [],
      requireAgents: [],
      thresholdMinutes: Number.NaN,
      emitJson: false,
      help: false,
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.message).toContain("must be positive");
  });

  it("sweep-only mode fails when unrelated stale records exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-sweep-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(scratch, "stale-only.json"),
      JSON.stringify({
        agent_id: "stale-only",
        parent_id: "parent",
        last_heartbeat_at: "2020-01-01T12:00:00Z",
        last_message: "stale",
        phase: "polling",
      }),
      "utf8",
    );

    const verdict = evaluateSubagentAliveGate(
      {
        scratchDirs: [scratch],
        requireAgents: [],
        thresholdMinutes: 30,
        emitJson: false,
        help: false,
      },
      root,
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain("Sweep:");
    expect(verdict.message).toContain("REDISPATCH_OK");

    rmSync(root, { recursive: true, force: true });
  });

  it("evaluateSubagentAliveGate rejects zero threshold minutes", () => {
    expect(
      evaluateSubagentAliveGate({
        scratchDirs: [],
        requireAgents: [],
        thresholdMinutes: 0,
        emitJson: false,
        help: false,
      }).message,
    ).toContain("must be positive");
  });

  it("json config error uses external exit code", () => {
    const verdict = evaluateSubagentAliveGate(
      {
        scratchDirs: ["/does/not/exist/subagent-status"],
        requireAgents: ["worker"],
        thresholdMinutes: 30,
        emitJson: true,
        help: false,
      },
      process.cwd(),
    );
    expect(verdict.exitCode).toBe(2);
    expect(verdict.json?.all_ok).toBe(false);
  });

  it("run emits JSON verdict on stdout", () => {
    const root = mkdtempSync(join(tmpdir(), "sam-alive-json-"));
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(scratch, { recursive: true });
    const cwd = process.cwd();
    process.chdir(root);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(run(["--scratch-dir", scratch, "--require-agent", "missing-agent", "--json"])).toBe(1);
      expect(out.mock.calls.join("")).toContain('"redispatch_ok": true');
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
