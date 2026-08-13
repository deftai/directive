import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunSummaryEmitter } from "./emit.js";
import {
  DEFAULT_RUN_SUMMARY_BASENAME,
  ENV_RUN_SUMMARY_PATH,
  gitignoreCoversRunSummary,
  RUN_SUMMARY_STDOUT_PREFIX,
  RUN_SUMMARY_WRITE_WARNING,
  resolveRunSummaryDestination,
} from "./path.js";
import { RUN_SUMMARY_SCHEMA_VERSION } from "./types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("resolveRunSummaryDestination (#3282)", () => {
  it("is silent when unset and gitignore does not cover default path", () => {
    const root = freshRoot("run-summary-silent-");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
    const dest = resolveRunSummaryDestination(root, { env: {} });
    expect(dest).toEqual({ kind: "silent" });
  });

  it("uses default path when gitignore covers .deft-run-summary.json", () => {
    const root = freshRoot("run-summary-default-");
    writeFileSync(join(root, ".gitignore"), `${DEFAULT_RUN_SUMMARY_BASENAME}\n`, "utf8");
    expect(gitignoreCoversRunSummary(root)).toBe(true);
    const dest = resolveRunSummaryDestination(root, { env: {} });
    expect(dest.kind).toBe("file");
    if (dest.kind === "file") {
      expect(dest.explicit).toBe(false);
      expect(dest.truncateOnSessionStart).toBe(true);
      expect(dest.path).toBe(join(root, DEFAULT_RUN_SUMMARY_BASENAME));
    }
  });

  it("honors DEFT_RUN_SUMMARY_PATH=- for stdout", () => {
    const root = freshRoot("run-summary-stdout-");
    const dest = resolveRunSummaryDestination(root, {
      env: { [ENV_RUN_SUMMARY_PATH]: "-" },
    });
    expect(dest).toEqual({ kind: "stdout" });
  });

  it("honors explicit absolute/relative DEFT_RUN_SUMMARY_PATH", () => {
    const root = freshRoot("run-summary-explicit-");
    const abs = join(root, "logs", "summary.jsonl");
    const destAbs = resolveRunSummaryDestination(root, {
      env: { [ENV_RUN_SUMMARY_PATH]: abs },
    });
    expect(destAbs.kind).toBe("file");
    if (destAbs.kind === "file") {
      expect(destAbs.explicit).toBe(true);
      expect(destAbs.truncateOnSessionStart).toBe(false);
      expect(destAbs.path).toBe(abs);
    }
    const destRel = resolveRunSummaryDestination(root, {
      env: { [ENV_RUN_SUMMARY_PATH]: "out/summary.jsonl" },
    });
    expect(destRel.kind).toBe("file");
    if (destRel.kind === "file") {
      expect(destRel.path).toBe(join(root, "out", "summary.jsonl"));
    }
  });
});

describe("RunSummaryEmitter (#3282)", () => {
  it("emits zero stdout when unset (silent)", () => {
    const root = freshRoot("run-summary-emit-silent-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-1",
      frameworkVersion: "0.0.0-test",
      env: {},
      gitignoreCovers: () => false,
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });
    const result = emitter.emitSessionStart({ ready: true, exit_code: 0 });
    expect(result.emitted).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("appends JSONL with schema_version and session_id when path is set", () => {
    const root = freshRoot("run-summary-emit-file-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-abc",
      frameworkVersion: "1.2.3",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });
    const r1 = emitter.emitSessionStart({
      ready: true,
      exit_code: 0,
      ceremony_dial: { depth: "rapid" },
    });
    const r2 = emitter.emitCheckInvocation({
      target: "check:consumer",
      exit_code: 0,
      gates: [{ id: "verify:branch", status: "run", exit_code: 0 }],
    });
    expect(r1.emitted).toBe(true);
    expect(r2.emitted).toBe(true);
    const text = readFileSync(out, "utf8");
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.schema_version).toBe(RUN_SUMMARY_SCHEMA_VERSION);
    expect(lines[0]?.session_id).toBe("sess-abc");
    expect(lines[0]?.event).toBe("session_start");
    expect(lines[0]?.seq).toBe(1);
    expect(lines[1]?.event).toBe("check_invocation");
    expect(lines[1]?.seq).toBe(2);
    expect(lines[1]?.framework_version).toBe("1.2.3");
  });

  it("prefixes stdout with DEFT-TLM: when path is -", () => {
    const root = freshRoot("run-summary-tlm-");
    const stdout: string[] = [];
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "s",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: "-" },
      writeStdout: (line) => stdout.push(line),
    });
    emitter.emitDialTransition({ from: "rapid", to: "standard", reason: "size=M" });
    expect(stdout).toHaveLength(1);
    const first = stdout[0] ?? "";
    expect(first.startsWith(RUN_SUMMARY_STDOUT_PREFIX)).toBe(true);
    const body = JSON.parse(first.slice(RUN_SUMMARY_STDOUT_PREFIX.length)) as {
      event: string;
    };
    expect(body.event).toBe("dial_transition");
  });

  it("prints exactly one warning on unwritable explicit path and does not throw", () => {
    const root = freshRoot("run-summary-unwritable-");
    // Create a directory where a file cannot be created as a child of a file path:
    // point at a path under a file-as-directory parent.
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x", "utf8");
    const badPath = join(blocker, "summary.jsonl");
    const stderr: string[] = [];
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "s",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: badPath },
      writeStderr: (line) => stderr.push(line),
    });
    const r1 = emitter.emitSessionStart({ ready: true });
    const r2 = emitter.emitCheckInvocation({
      target: "check:consumer",
      exit_code: 0,
      gates: [],
    });
    expect(r1.emitted).toBe(false);
    expect(r1.warning).toBe(true);
    expect(r2.warning).toBe(false); // only one warning
    expect(stderr.filter((l) => l.includes(RUN_SUMMARY_WRITE_WARNING))).toHaveLength(1);
    expect(existsSync(badPath)).toBe(false);
  });

  it("truncates default-path file on session_start then appends later events", () => {
    const root = freshRoot("run-summary-truncate-");
    writeFileSync(join(root, ".gitignore"), `${DEFAULT_RUN_SUMMARY_BASENAME}\n`, "utf8");
    const path = join(root, DEFAULT_RUN_SUMMARY_BASENAME);
    writeFileSync(path, '{"stale":true}\n', "utf8");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "new-sess",
      frameworkVersion: "0.0.0",
      env: {},
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    emitter.emitSessionStart({ ready: true });
    emitter.emitCheckInvocation({ target: "check:consumer", exit_code: 0, gates: [] });
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; session_id: string });
    expect(lines[0]?.event).toBe("session_start");
    expect(lines[0]?.session_id).toBe("new-sess");
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => "stale" in l)).toBe(false);
  });

  it("emits dial_escalation_evaluation with tier, outcome, and reason (#3319)", () => {
    const root = freshRoot("run-summary-eval-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-eval",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    const declined = emitter.emitDialEscalationEvaluation({
      tier: "rapid",
      outcome: "declined",
      reason: "insufficient evidence to raise above rapid (size=- modelTier=-)",
    });
    const escalated = emitter.emitDialEscalationEvaluation({
      tier: "standard",
      outcome: "escalated",
      reason: "evidence raised rapid -> standard (size=M modelTier=frontier)",
    });
    expect(declined.emitted).toBe(true);
    expect(escalated.emitted).toBe(true);
    const lines = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            payload: { tier: string; outcome: string; reason: string };
          },
      );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.event).toBe("dial_escalation_evaluation");
    expect(lines[0]?.payload).toEqual({
      outcome: "declined",
      reason: "insufficient evidence to raise above rapid (size=- modelTier=-)",
      tier: "rapid",
    });
    expect(lines[1]?.payload.outcome).toBe("escalated");
    expect(lines[1]?.payload.tier).toBe("standard");
    expect(lines[0]?.payload.outcome).not.toBe(lines[1]?.payload.outcome);
  });

  it("stays silent for dial_escalation_evaluation when path is unset (#3319)", () => {
    const root = freshRoot("run-summary-eval-silent-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "s",
      frameworkVersion: "0.0.0",
      env: {},
      gitignoreCovers: () => false,
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });
    const result = emitter.emitDialEscalationEvaluation({
      tier: "rapid",
      outcome: "declined",
      reason: "no evidence",
    });
    expect(result.emitted).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });
});
