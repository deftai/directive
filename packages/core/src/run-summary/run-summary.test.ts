import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitRunSummaryEvent, RunSummaryEmitter } from "./emit.js";
import {
  DEFAULT_RUN_SUMMARY_BASENAME,
  ENV_RUN_SUMMARY_PATH,
  ENV_TOTAL_TOOL_TURNS,
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
    const r3 = emitter.emitAcceptance({
      resolved_command_count: 0,
      outcome: "empty-pass",
      source_rung: "project_floor",
    });
    expect(r3.emitted).toBe(true);
    const after = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; payload: { outcome?: string } });
    expect(after[2]?.event).toBe("acceptance");
    expect(after[2]?.payload.outcome).toBe("empty-pass");
    const r4 = emitter.emitAcceptanceStamp({
      rung: "derived",
      none_stated: true,
      command_count: 0,
      clause_count: 4,
    });
    expect(r4.emitted).toBe(true);
    const stamped = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as { event: string; schema_version: number; payload: { rung?: string } },
      );
    expect(stamped[3]?.event).toBe("acceptance_stamp");
    expect(stamped[3]?.schema_version).toBe(RUN_SUMMARY_SCHEMA_VERSION);
    expect(stamped[3]?.payload.rung).toBe("derived");
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

  it("emits total_tool_turns on a tool_turn_denominator event (#3320)", () => {
    const root = freshRoot("run-summary-denom-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-denom",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    const result = emitter.emitToolTurnDenominator({ total_tool_turns: 32 });
    expect(result.emitted).toBe(true);
    const line = JSON.parse(readFileSync(out, "utf8").trim()) as {
      event: string;
      total_tool_turns: number;
      payload: { total_tool_turns: number };
    };
    expect(line.event).toBe("tool_turn_denominator");
    expect(line.total_tool_turns).toBe(32);
    expect(line.payload.total_tool_turns).toBe(32);
  });

  it("emits verification events with check_id, method_fingerprint, and outcome (#3322)", () => {
    const root = freshRoot("run-summary-verify-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-verify",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    const failed = emitter.emitVerification({
      check_id: "output-eq",
      method_fingerprint: "diff-ref-v1",
      outcome: "fail",
    });
    const passed = emitter.emitVerification({
      check_id: "output-eq",
      method_fingerprint: "json-rebuilt-v2",
      outcome: "pass",
    });
    expect(failed.emitted).toBe(true);
    expect(passed.emitted).toBe(true);
    const lines = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            payload: {
              check_id: string;
              method_fingerprint: string;
              outcome: string;
            };
          },
      );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.event).toBe("verification");
    expect(lines[0]?.payload).toEqual({
      check_id: "output-eq",
      method_fingerprint: "diff-ref-v1",
      outcome: "fail",
    });
    expect(lines[1]?.payload.outcome).toBe("pass");
    expect(lines[1]?.payload.method_fingerprint).toBe("json-rebuilt-v2");
  });

  it("stays silent for verification when path is unset (#3322)", () => {
    const root = freshRoot("run-summary-verify-silent-");
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
    const result = emitter.emitVerification({
      check_id: "output-eq",
      method_fingerprint: "diff-ref-v1",
      outcome: "fail",
    });
    expect(result.emitted).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("stays silent for tool_turn_denominator when path is unset (#3320)", () => {
    const root = freshRoot("run-summary-denom-silent-");
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
    const result = emitter.emitToolTurnDenominator({ total_tool_turns: 10 });
    expect(result.emitted).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("stamps DEFT_TOTAL_TOOL_TURNS onto production events when set (#3320)", () => {
    const root = freshRoot("run-summary-env-denom-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-env",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out, [ENV_TOTAL_TOOL_TURNS]: "40" },
    });
    emitter.emitCheckInvocation({ target: "check:consumer", exit_code: 0, gates: [] });
    const line = JSON.parse(readFileSync(out, "utf8").trim()) as {
      event: string;
      total_tool_turns?: number;
    };
    expect(line.event).toBe("check_invocation");
    expect(line.total_tool_turns).toBe(40);
  });

  it("does not invent a denominator from an invalid DEFT_TOTAL_TOOL_TURNS (#3320)", () => {
    const root = freshRoot("run-summary-env-bad-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-env-bad",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out, [ENV_TOTAL_TOOL_TURNS]: "nope" },
    });
    emitter.emitCheckInvocation({ target: "check:consumer", exit_code: 0, gates: [] });
    const line = JSON.parse(readFileSync(out, "utf8").trim()) as {
      total_tool_turns?: number;
    };
    expect(line.total_tool_turns).toBeUndefined();
  });

  it("emits tool_turn_denominator from production emitKnown when env is set (#3320)", () => {
    const root = freshRoot("run-summary-known-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-known",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out, [ENV_TOTAL_TOOL_TURNS]: "12" },
    });
    const missing = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "sess-known-missing",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    expect(missing.emitKnownToolTurnDenominator().emitted).toBe(false);
    expect(emitter.emitKnownToolTurnDenominator().emitted).toBe(true);
    const lines = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; total_tool_turns?: number });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe("tool_turn_denominator");
    expect(lines[0]?.total_tool_turns).toBe(12);
  });

  it("continues seq across separate constructors into one file (#3350)", () => {
    const root = freshRoot("run-summary-seq-ctors-");
    const out = join(root, "summary.jsonl");
    const base = {
      projectRoot: root,
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    };
    const first = new RunSummaryEmitter({ ...base, sessionId: "cli-1" });
    expect(first.emitCheckInvocation({ target: "a", exit_code: 0, gates: [] }).line?.seq).toBe(1);
    expect(first.emitCheckInvocation({ target: "b", exit_code: 0, gates: [] }).line?.seq).toBe(2);
    const second = new RunSummaryEmitter({ ...base, sessionId: "cli-2" });
    expect(second.emitCheckInvocation({ target: "c", exit_code: 0, gates: [] }).line?.seq).toBe(3);
    const third = new RunSummaryEmitter({ ...base, sessionId: "cli-3" });
    expect(third.emitCheckInvocation({ target: "d", exit_code: 0, gates: [] }).line?.seq).toBe(4);
    expect(third.emitCheckInvocation({ target: "e", exit_code: 0, gates: [] }).line?.seq).toBe(5);
    const seqs = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not duplicate seq when two constructors seed before either appends (#3350)", () => {
    const root = freshRoot("run-summary-seq-dual-ctor-");
    const out = join(root, "summary.jsonl");
    const base = {
      projectRoot: root,
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    };
    const first = new RunSummaryEmitter({ ...base, sessionId: "ctor-1" });
    const second = new RunSummaryEmitter({ ...base, sessionId: "ctor-2" });
    expect(first.emitCheckInvocation({ target: "a", exit_code: 0, gates: [] }).line?.seq).toBe(1);
    expect(second.emitCheckInvocation({ target: "b", exit_code: 0, gates: [] }).line?.seq).toBe(2);
    const seqs = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
  });

  it("continues seq across emitRunSummaryEvent one-shot calls (#3350)", () => {
    const root = freshRoot("run-summary-seq-oneshot-");
    const out = join(root, "summary.jsonl");
    const base = {
      projectRoot: root,
      sessionId: "oneshot",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      event: "check_invocation" as const,
      payload: { target: "check:consumer", exit_code: 0, gates: [] },
    };
    expect(emitRunSummaryEvent(base).line?.seq).toBe(1);
    expect(emitRunSummaryEvent(base).line?.seq).toBe(2);
    expect(emitRunSummaryEvent(base).line?.seq).toBe(3);
    const seqs = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("keeps stdout seq per-process across constructors (#3350)", () => {
    const root = freshRoot("run-summary-seq-stdout-");
    const firstOut: string[] = [];
    const first = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "stdout-1",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: "-" },
      writeStdout: (line) => firstOut.push(line),
    });
    first.emitCheckInvocation({ target: "a", exit_code: 0, gates: [] });
    const secondOut: string[] = [];
    const second = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "stdout-2",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: "-" },
      writeStdout: (line) => secondOut.push(line),
    });
    second.emitCheckInvocation({ target: "b", exit_code: 0, gates: [] });
    const firstBody = JSON.parse(firstOut[0]?.slice(RUN_SUMMARY_STDOUT_PREFIX.length) ?? "") as {
      seq: number;
    };
    const secondBody = JSON.parse(secondOut[0]?.slice(RUN_SUMMARY_STDOUT_PREFIX.length) ?? "") as {
      seq: number;
    };
    expect(firstBody.seq).toBe(1);
    expect(secondBody.seq).toBe(1);
  });

  it("resets seq to 1 when default-path session_start truncates (#3350)", () => {
    const root = freshRoot("run-summary-seq-truncate-");
    writeFileSync(join(root, ".gitignore"), `${DEFAULT_RUN_SUMMARY_BASENAME}\n`, "utf8");
    const path = join(root, DEFAULT_RUN_SUMMARY_BASENAME);
    writeFileSync(path, '{"stale":true}\n{"also":"stale"}\n', "utf8");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "new-sess",
      frameworkVersion: "0.0.0",
      env: {},
    });
    const start = emitter.emitSessionStart({ ready: true });
    const next = emitter.emitCheckInvocation({ target: "check:consumer", exit_code: 0, gates: [] });
    expect(start.line?.seq).toBe(1);
    expect(next.line?.seq).toBe(2);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq?: number; event?: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.event).toBe("session_start");
    expect(lines[0]?.seq).toBe(1);
    expect(lines[1]?.seq).toBe(2);
  });

  it("starts seq at 1 when the destination file is empty (#3350)", () => {
    const root = freshRoot("run-summary-seq-empty-");
    const out = join(root, "summary.jsonl");
    writeFileSync(out, "", "utf8");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "empty",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    expect(emitter.emitCheckInvocation({ target: "a", exit_code: 0, gates: [] }).line?.seq).toBe(1);
  });

  it("fail-opens seq seed when the destination file is unreadable (#3350)", () => {
    const root = freshRoot("run-summary-seq-unreadable-");
    const asDir = join(root, "not-a-file");
    mkdirSync(asDir);
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "unreadable",
      frameworkVersion: "0.0.0",
      env: {},
      destination: {
        kind: "file",
        path: asDir,
        truncateOnSessionStart: false,
        explicit: true,
      },
    });
    const result = emitter.emitCheckInvocation({ target: "a", exit_code: 0, gates: [] });
    expect(result.line?.seq).toBe(1);
    expect(result.emitted).toBe(false);
  });

  it("does not leave a seq lock file after a successful emit (#3350)", () => {
    const root = freshRoot("run-summary-seq-lock-");
    const out = join(root, "summary.jsonl");
    const emitter = new RunSummaryEmitter({
      projectRoot: root,
      sessionId: "lock",
      frameworkVersion: "0.0.0",
      env: { [ENV_RUN_SUMMARY_PATH]: out },
    });
    expect(emitter.emitCheckInvocation({ target: "a", exit_code: 0, gates: [] }).emitted).toBe(
      true,
    );
    expect(existsSync(`${out}.seq.lock`)).toBe(false);
  });
});
