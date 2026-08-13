import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateVerifyAcFromPlan } from "../product-first-done-gate/evaluate.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  mergeOracleVerdict,
  resetInProcessVerificationBuffer,
} from "./evaluate.js";

beforeEach(() => {
  resetInProcessVerificationBuffer();
});

function jsonl(
  events: readonly {
    check_id: string;
    method_fingerprint: string;
    outcome: "pass" | "fail";
    independent_rederivation?: boolean;
  }[],
): string {
  return events
    .map((payload, i) =>
      JSON.stringify({
        event: "verification",
        session_id: "s1",
        seq: i + 1,
        payload,
      }),
    )
    .join("\n");
}

describe("emitVerifyAcAttempts (#3322)", () => {
  it("writes a verification event for each executed AC run", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-emit-"));
    const path = join(root, "summary.jsonl");
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-ac",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      runs: [
        {
          command: "true",
          cwd: root,
          exitCode: 0,
          stdout: "",
          stderr: "",
          ok: true,
          detail: "ok",
        },
      ],
    });
    const line = JSON.parse(readFileSync(path, "utf8").trim()) as {
      event: string;
      session_id: string;
      payload: { check_id: string; outcome: string; method_fingerprint: string };
    };
    expect(line.event).toBe("verification");
    expect(line.session_id).toBe("sess-ac");
    expect(line.payload.check_id).toBe("verify:ac");
    expect(line.payload.outcome).toBe("pass");
    expect(line.payload.method_fingerprint).toContain("true");
  });
});

describe("evaluateProductOracleIntegrity (#3322)", () => {
  it("is a no-op when no run-summary exists", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-none-"));
    const verdict = evaluateProductOracleIntegrity({ projectRoot: root, env: {} });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe(0);
    expect(verdict.unresolved).toEqual([]);
  });

  it("is a no-op for stdout dest or empty injected text", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-stdout-"));
    expect(
      evaluateProductOracleIntegrity({
        projectRoot: root,
        env: { [ENV_RUN_SUMMARY_PATH]: "-" },
      }).ok,
    ).toBe(true);
    expect(
      evaluateProductOracleIntegrity({
        projectRoot: root,
        runSummaryText: null,
      }).ok,
    ).toBe(true);
    expect(
      evaluateProductOracleIntegrity({
        projectRoot: root,
        runSummaryText: "   ",
      }).ok,
    ).toBe(true);
  });

  it("fails closed on PATH=- method-change pass from in-process attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-stdout-mcp-"));
    const env = { [ENV_RUN_SUMMARY_PATH]: "-", DEFT_SESSION_ID: "sess-stdout" };
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-stdout",
      env,
      writeStdout: () => undefined,
      runs: [
        {
          command: "diff-v1",
          cwd: root,
          exitCode: 1,
          stdout: "",
          stderr: "mismatch",
          ok: false,
          detail: "fail",
        },
        {
          command: "json-v2",
          cwd: root,
          exitCode: 0,
          stdout: "",
          stderr: "",
          ok: true,
          detail: "ok",
        },
      ],
    });
    const verdict = evaluateProductOracleIntegrity({ projectRoot: root, env });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(1);
    expect(verdict.unresolved).toHaveLength(1);
    expect(verdict.message).toMatch(/UNRESOLVED product-oracle discrepancy \(#3322\)/);
    expect(
      evaluateProductOracleIntegrity({
        projectRoot: root,
        env: {},
      }).ok,
    ).toBe(true);
  });

  it("pairs successive PATH=- emits via the in-process session", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-stdout-session-"));
    const env = { [ENV_RUN_SUMMARY_PATH]: "-" };
    const failRun = {
      command: "diff-v1",
      cwd: root,
      exitCode: 1,
      stdout: "",
      stderr: "mismatch",
      ok: false,
      detail: "fail",
    };
    const passRun = {
      command: "json-v2",
      cwd: root,
      exitCode: 0,
      stdout: "",
      stderr: "",
      ok: true,
      detail: "ok",
    };
    emitVerifyAcAttempts({
      projectRoot: root,
      env,
      writeStdout: () => undefined,
      runs: [failRun],
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      env,
      writeStdout: () => undefined,
      runs: [passRun],
    });
    const verdict = evaluateProductOracleIntegrity({ projectRoot: root, env });
    expect(verdict.ok).toBe(false);
    expect(verdict.unresolved).toHaveLength(1);
  });

  it("fails closed on unresolved method-change pass", () => {
    const verdict = evaluateProductOracleIntegrity({
      projectRoot: mkdtempSync(join(tmpdir(), "oracle-unresolved-")),
      runSummaryText: jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        { check_id: "eq", method_fingerprint: "json-v2", outcome: "pass" },
      ]),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(1);
    expect(verdict.message).toMatch(/UNRESOLVED product-oracle discrepancy \(#3322\)/);
    expect(verdict.message).toMatch(/check_id=eq/);
  });

  it("passes when independent re-derivation is recorded", () => {
    const verdict = evaluateProductOracleIntegrity({
      projectRoot: mkdtempSync(join(tmpdir(), "oracle-resolved-")),
      runSummaryText: jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        {
          check_id: "eq",
          method_fingerprint: "json-v2",
          outcome: "pass",
          independent_rederivation: true,
        },
      ]),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.flagged).toHaveLength(1);
    expect(verdict.unresolved).toEqual([]);
  });

  it("reads DEFT_RUN_SUMMARY_PATH from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-disk-"));
    const path = join(root, "summary.jsonl");
    writeFileSync(
      path,
      jsonl([
        { check_id: "eq", method_fingerprint: "a", outcome: "fail" },
        { check_id: "eq", method_fingerprint: "b", outcome: "pass" },
      ]),
      "utf8",
    );
    const verdict = evaluateProductOracleIntegrity({
      projectRoot: root,
      env: { [ENV_RUN_SUMMARY_PATH]: path },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.unresolved).toHaveLength(1);
  });

  it("treats an unreadable dest path as no evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-dir-"));
    const dest = join(root, "not-a-file");
    mkdirSync(dest);
    const verdict = evaluateProductOracleIntegrity({
      projectRoot: root,
      env: { [ENV_RUN_SUMMARY_PATH]: dest },
    });
    expect(verdict.ok).toBe(true);
  });

  it("leads an existing verify:ac message with the unresolved discrepancy", () => {
    const merged = mergeOracleVerdict(
      { ok: true, code: 0, message: "verify:ac passed (#3284) [rung=project_floor]" },
      {
        ok: false,
        code: 1,
        flagged: [],
        unresolved: [
          {
            check_id: "eq",
            failed_method: "a",
            passed_method: "b",
            independent_rederivation: false,
          },
        ],
        message: "UNRESOLVED product-oracle discrepancy (#3322): check_id=eq",
      },
    );
    expect(merged.ok).toBe(false);
    expect(merged.code).toBe(1);
    expect(merged.message.startsWith("UNRESOLVED product-oracle discrepancy")).toBe(true);
    expect(merged.message).toMatch(/verify:ac passed/);
  });

  it("keeps config-error code 2 and can stand alone when the prior message is empty", () => {
    const kept = mergeOracleVerdict(
      { ok: false, code: 2, message: "verify:ac config error" },
      {
        ok: false,
        code: 1,
        flagged: [],
        unresolved: [],
        message: "UNRESOLVED product-oracle discrepancy (#3322)",
      },
    );
    expect(kept.code).toBe(2);
    expect(kept.ok).toBe(false);
    const alone = mergeOracleVerdict(
      { ok: true, code: 0, message: "" },
      {
        ok: false,
        code: 1,
        flagged: [],
        unresolved: [],
        message: "UNRESOLVED product-oracle discrepancy (#3322)",
      },
    );
    expect(alone.message).toBe("UNRESOLVED product-oracle discrepancy (#3322)");
    expect(
      mergeOracleVerdict(
        { ok: true, code: 0, message: "ok" },
        { ok: true, code: 0, flagged: [], unresolved: [], message: "" },
      ).ok,
    ).toBe(true);
  });
});

describe("verify:ac evaluation applies oracle integrity (#3322)", () => {
  it("fails a floor-pass plan when method-change pass is unresolved", () => {
    const result = evaluateVerifyAcFromPlan(
      {
        title: "t",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
      },
      {
        projectRoot: mkdtempSync(join(tmpdir(), "oracle-eval-")),
        captureFromNarratives: false,
        runSummaryText: jsonl([
          { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
          { check_id: "eq", method_fingerprint: "json-v2", outcome: "pass" },
        ]),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/UNRESOLVED product-oracle discrepancy \(#3322\)/);
  });

  it("stays green when re-derivation is recorded or the oracle gate is skipped", () => {
    const plan = {
      title: "t",
      acceptance: { commands: [], none_stated: true, source_rung: "project_floor" as const },
      items: [],
    };
    const ok = evaluateVerifyAcFromPlan(plan, {
      projectRoot: mkdtempSync(join(tmpdir(), "oracle-eval-ok-")),
      captureFromNarratives: false,
      runSummaryText: jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        {
          check_id: "eq",
          method_fingerprint: "json-v2",
          outcome: "pass",
          independent_rederivation: true,
        },
      ]),
    });
    expect(ok.ok).toBe(true);
    const skipped = evaluateVerifyAcFromPlan(plan, {
      projectRoot: mkdtempSync(join(tmpdir(), "oracle-eval-skip-")),
      captureFromNarratives: false,
      applyOracleIntegrity: false,
      runSummaryText: jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        { check_id: "eq", method_fingerprint: "json-v2", outcome: "pass" },
      ]),
    });
    expect(skipped.ok).toBe(true);
  });
});
