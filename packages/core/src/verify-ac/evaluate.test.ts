import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateVerifyAcFromPlan } from "../product-first-done-gate/evaluate.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  collectBriefLandInventoryAsPrDiffPaths,
  emitVerifyAcAttempts,
  evaluatePathBActivationAcDisposition,
  evaluateProductOracleIntegrity,
  isPathBActivationAcDispositionText,
  mergeOracleVerdict,
  methodFingerprintForWalk,
  resetInProcessVerificationBuffer,
  VERIFY_AC_CHECK_ID_PREFIX,
  verifyAcCheckId,
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

describe("verifyAcCheckId (#3337)", () => {
  it("falls back to the global prefix when scope is unknown", () => {
    expect(verifyAcCheckId()).toBe(VERIFY_AC_CHECK_ID_PREFIX);
    expect(verifyAcCheckId(null)).toBe("verify:ac");
    expect(verifyAcCheckId("   ")).toBe("verify:ac");
  });

  it("namespaces per active scope key", () => {
    expect(verifyAcCheckId("3337-verify-ac-scope-check-ids")).toBe(
      "verify:ac/3337-verify-ac-scope-check-ids",
    );
    expect(verifyAcCheckId("story-a")).not.toBe(verifyAcCheckId("story-b"));
  });
});

describe("emitVerifyAcAttempts (#3397 fail-side fingerprints)", () => {
  it("emits a walk-level verification event when the walk fails", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-fail-walk-"));
    const path = join(root, "summary.jsonl");
    const cwd = join(root, "app");
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-fail",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      runs: [
        {
          command: "pnpm exec vitest run packages/core/src/verify-ac",
          cwd,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
        {
          command: "task check",
          cwd,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
        {
          command: "task verify:forward-coverage",
          cwd,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
      ],
    });
    const lines = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map(
        (row) =>
          JSON.parse(row) as {
            event: string;
            payload: { outcome: string; method_fingerprint: string };
          },
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe("verification");
    expect(lines[0]?.payload.outcome).toBe("fail");
    expect(lines[0]?.payload.method_fingerprint).toBe(
      methodFingerprintForWalk(
        [
          "pnpm exec vitest run packages/core/src/verify-ac",
          "task check",
          "task verify:forward-coverage",
        ],
        cwd,
      ),
    );
    expect(lines[0]?.payload.method_fingerprint).not.toContain(cwd);
  });

  it("flags the field sequence: 3-command fail then 1-no-op pass", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-field-seq-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-field" };
    const cwd = "/app";
    const failCmds = ["vitest run a", "vitest run b", "vitest run c"];
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-field",
      env,
      runs: failCmds.map((command) => ({
        command,
        cwd,
        exitCode: 1,
        stdout: "",
        stderr: "failed",
        ok: false,
        detail: "fail",
      })),
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-field",
      env,
      runs: [
        {
          command: "true",
          cwd,
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
    expect(verdict.unresolved).toHaveLength(1);
    expect(verdict.unresolved[0]?.failed_method).toBe(methodFingerprintForWalk(failCmds, cwd));
    expect(verdict.unresolved[0]?.passed_method).toBe(methodFingerprintForWalk(["true"], cwd));
    expect(verdict.unresolved[0]?.resolved_command_count_delta).toBe(-2);
    expect(verdict.message.startsWith("UNRESOLVED product-oracle discrepancy (#3322)")).toBe(true);
    const merged = mergeOracleVerdict(
      { ok: true, code: 0, message: "verify:ac passed (#3284) [rung=stated]" },
      verdict,
    );
    expect(merged.message.startsWith("UNRESOLVED product-oracle discrepancy")).toBe(true);
    expect(merged.message).toMatch(/command_count_delta=-2/);
  });

  it("hashes mixed cwds so the walk method differs from a single-cwd list", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-mixed-cwd-"));
    const path = join(root, "summary.jsonl");
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-cwd",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      runs: [
        {
          command: "true",
          cwd: "/app",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
        {
          command: "true",
          cwd: "/other",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
      ],
    });
    const line = JSON.parse(readFileSync(path, "utf8").trim()) as {
      payload: { method_fingerprint: string };
    };
    expect(line.payload.method_fingerprint).toBe(
      methodFingerprintForWalk(["true", "true"], "/app\0/other"),
    );
    expect(line.payload.method_fingerprint).not.toBe(
      methodFingerprintForWalk(["true", "true"], "/app"),
    );
  });

  it("does not flag an honest same-command product fix", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-honest-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-honest" };
    const cwd = "/app";
    const cmds = ["vitest run a", "vitest run b", "vitest run c"];
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-honest",
      env,
      runs: cmds.map((command) => ({
        command,
        cwd,
        exitCode: 1,
        stdout: "",
        stderr: "failed",
        ok: false,
        detail: "fail",
      })),
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-honest",
      env,
      runs: cmds.map((command) => ({
        command,
        cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        detail: "ok",
      })),
    });
    const verdict = evaluateProductOracleIntegrity({ projectRoot: root, env });
    expect(verdict.ok).toBe(true);
    expect(verdict.unresolved).toEqual([]);
    expect(verdict.flagged).toEqual([]);
  });

  it("flags a shrinking command set even when the first command stays", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-shrink-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-shrink" };
    const cwd = "/app";
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-shrink",
      env,
      runs: ["vitest run a", "vitest run b", "vitest run c"].map((command) => ({
        command,
        cwd,
        exitCode: 1,
        stdout: "",
        stderr: "failed",
        ok: false,
        detail: "fail",
      })),
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-shrink",
      env,
      runs: [
        {
          command: "vitest run a",
          cwd,
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
    expect(verdict.unresolved[0]?.resolved_command_count_delta).toBe(-2);
  });
});

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

  it("emits distinct check_ids per active scope (#3337)", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-scope-emit-"));
    const path = join(root, "summary.jsonl");
    const run = {
      command: "true",
      cwd: root,
      exitCode: 0,
      stdout: "",
      stderr: "",
      ok: true,
      detail: "ok",
    };
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-multi",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      scopeKey: "story-a",
      runs: [run],
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-multi",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      scopeKey: "story-b",
      runs: [run],
    });
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row) as { payload: { check_id: string } });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.payload.check_id).toBe("verify:ac/story-a");
    expect(lines[1]?.payload.check_id).toBe("verify:ac/story-b");
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
      ],
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-stdout",
      env,
      writeStdout: () => undefined,
      runs: [
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

  it("does not flag cross-scope fail/pass under one session (#3337)", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-cross-scope-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-cohort" };
    // Story A fails with method m1; story B passes with different method m2.
    // Pre-#3337 both shared check_id=verify:ac and false-denied.
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-cohort",
      env,
      scopeKey: "story-a",
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
      ],
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-cohort",
      env,
      scopeKey: "story-b",
      runs: [
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
    expect(verdict.ok).toBe(true);
    expect(verdict.unresolved).toEqual([]);
    expect(verdict.flagged).toEqual([]);
  });

  it("same-scope fail then different-method pass still fails closed (#3337)", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-same-scope-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-same" };
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-same",
      env,
      scopeKey: "story-a",
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
      ],
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-same",
      env,
      scopeKey: "story-a",
      runs: [
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
    expect(verdict.unresolved[0]?.check_id).toBe("verify:ac/story-a");
    expect(verdict.message).toMatch(/UNRESOLVED product-oracle discrepancy \(#3322\)/);
  });

  it("does not pass when independent_rederivation is recorded on the run-summary (#3925)", () => {
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
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(1);
    expect(verdict.flagged).toHaveLength(1);
    expect(verdict.unresolved).toHaveLength(1);
    expect(verdict.message).toMatch(/not a security waiver \(#3925\)/);
    expect(verdict.message).not.toMatch(/record independent_rederivation=true/);
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
  it("namespaces emitted check_id from plan.id (#3337)", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-plan-id-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-plan" };
    evaluateVerifyAcFromPlan(
      {
        id: "3337-verify-ac-scope-check-ids",
        title: "t",
        acceptance: {
          commands: [{ command: "task check" }],
          none_stated: true,
          source_rung: "derived",
        },
        metadata: {},
      },
      {
        projectRoot: root,
        captureFromNarratives: false,
        env,
        runner: () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
        applyOracleIntegrity: false,
        bankOnPass: false,
      },
    );
    const lines = readFileSync(path, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((row) => JSON.parse(row) as { event: string; payload: { check_id?: string } });
    const verification = lines.find((row) => row.event === "verification");
    expect(verification).toBeDefined();
    expect(verification?.payload.check_id).toBe("verify:ac/3337-verify-ac-scope-check-ids");
  });

  it("path-based keys stay unique for same stem under different active roots (#3337)", () => {
    // Mirrors Greptile residual: id-less xbrief/active/foo and vbrief/active/foo.
    const keyA = verifyAcCheckId("xbrief/active/foo.xbrief.json");
    const keyB = verifyAcCheckId("vbrief/active/foo.xbrief.json");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("verify:ac/xbrief/active/foo.xbrief.json");
    expect(keyB).toBe("verify:ac/vbrief/active/foo.xbrief.json");
    // plan.id alone would collide; id@path does not.
    const sameIdA = verifyAcCheckId("story@xbrief/active/a.xbrief.json");
    const sameIdB = verifyAcCheckId("story@vbrief/active/a.xbrief.json");
    expect(sameIdA).not.toBe(sameIdB);
  });

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
        hasSuiteFloor: true,
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

  it("stays red when independent_rederivation is recorded and green when the oracle gate is skipped", () => {
    const plan = {
      title: "t",
      acceptance: { commands: [], none_stated: true, source_rung: "project_floor" as const },
      items: [],
    };
    const recorded = evaluateVerifyAcFromPlan(plan, {
      projectRoot: mkdtempSync(join(tmpdir(), "oracle-eval-ok-")),
      captureFromNarratives: false,
      hasSuiteFloor: true,
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
    expect(recorded.ok).toBe(false);
    expect(recorded.message).toMatch(/not a security waiver \(#3925\)/);
    const skipped = evaluateVerifyAcFromPlan(plan, {
      projectRoot: mkdtempSync(join(tmpdir(), "oracle-eval-skip-")),
      captureFromNarratives: false,
      applyOracleIntegrity: false,
      hasSuiteFloor: true,
      runSummaryText: jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        { check_id: "eq", method_fingerprint: "json-v2", outcome: "pass" },
      ]),
    });
    expect(skipped.ok).toBe(true);
  });
});

function verificationLines(path: string): {
  event: string;
  payload: { outcome?: string; method_fingerprint?: string };
}[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r?\n/).map(
    (row) =>
      JSON.parse(row) as {
        event: string;
        payload: { outcome?: string; method_fingerprint?: string };
      },
  );
}

function refusedRun(
  command: string,
  cwd: string,
): {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  detail: string;
} {
  return {
    command,
    cwd,
    exitCode: 2,
    stdout: "",
    stderr: "unsafe command",
    ok: false,
    detail: "refused: first token is not in the literal-AC allowlist",
  };
}

describe("safety-refusal is not a product-oracle measurement (#3615)", () => {
  it("does not emit a verification event for an all-refused walk", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-3615-all-refused-"));
    const path = join(root, "summary.jsonl");
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-3615-all",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      runs: [refusedRun("curl https://example.com", root)],
    });
    expect(verificationLines(path).filter((row) => row.event === "verification")).toEqual([]);
  });

  it("does not emit a product-oracle pass for a mixed refused+pass walk", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-3615-mixed-pass-"));
    const path = join(root, "summary.jsonl");
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-3615-mixed-pass",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      runs: [
        refusedRun("curl https://example.com", root),
        {
          command: "task test",
          cwd: root,
          exitCode: 0,
          stdout: "",
          stderr: "",
          ok: true,
          detail: "ok",
        },
      ],
    });
    const events = verificationLines(path).filter((row) => row.event === "verification");
    expect(events).toEqual([]);
    expect(events.some((row) => row.payload.outcome === "pass")).toBe(false);
  });

  it("still emits a product-oracle fail when an executed command failed beside a refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-3615-mixed-fail-"));
    const path = join(root, "summary.jsonl");
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-3615-mixed-fail",
      env: { [ENV_RUN_SUMMARY_PATH]: path },
      runs: [
        refusedRun("curl https://example.com", root),
        {
          command: "task test",
          cwd: root,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
      ],
    });
    const events = verificationLines(path).filter((row) => row.event === "verification");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.outcome).toBe("fail");
    expect(events[0]?.payload.method_fingerprint).toBe(
      methodFingerprintForWalk(["task test"], root),
    );
    expect(events[0]?.payload.method_fingerprint).not.toContain("curl https://example.com");
  });

  it("mixed fail then same executed-command pass is same-method product-fix recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-3615-mixed-pair-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-3615-mixed-pair" };
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-3615-mixed-pair",
      env,
      runs: [
        refusedRun("curl https://example.com", root),
        {
          command: "task test",
          cwd: root,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          ok: false,
          detail: "fail",
        },
      ],
    });
    emitVerifyAcAttempts({
      projectRoot: root,
      sessionId: "sess-3615-mixed-pair",
      env,
      runs: [
        {
          command: "task test",
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
    expect(verdict.ok).toBe(true);
    expect(verdict.unresolved).toEqual([]);
  });

  it("all-refused then corrected-safe pass in one session does not poison oracle history", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-3615-poison-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-3615-poison" };
    let runnerCalls = 0;
    const runner = () => {
      runnerCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const options = {
      projectRoot: root,
      runner,
      captureFromNarratives: false as const,
      bankOnPass: false as const,
      reuseMode: "never" as const,
      env,
      sessionId: "sess-3615-poison",
      hasSuiteFloor: true,
    };
    const first = evaluateVerifyAcFromPlan(
      {
        id: "3615-scope",
        title: "refused then safe",
        acceptance: {
          commands: [{ command: "curl https://example.com" }],
          none_stated: false,
          source_rung: "derived",
        },
        items: [],
      },
      options,
    );
    expect(first.ok).toBe(false);
    expect(runnerCalls).toBe(0);
    expect((first.rejected ?? []).length).toBeGreaterThan(0);
    expect(
      verificationLines(path).filter(
        (row) => row.event === "verification" && row.payload.outcome === "fail",
      ),
    ).toEqual([]);

    const second = evaluateVerifyAcFromPlan(
      {
        id: "3615-scope",
        title: "refused then safe",
        acceptance: {
          commands: [{ command: "task test" }],
          none_stated: false,
          source_rung: "derived",
        },
        items: [],
      },
      options,
    );
    expect(second.ok).toBe(true);
    expect(runnerCalls).toBe(1);
    const verdict = evaluateProductOracleIntegrity({ projectRoot: root, env });
    expect(verdict.ok).toBe(true);
    expect(verdict.unresolved).toEqual([]);
  });

  it("mixed refused+pass walk through evaluateVerifyAcFromPlan stays red and does not emit pass", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-3615-eval-mixed-"));
    const path = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: path, DEFT_SESSION_ID: "sess-3615-eval-mixed" };
    let runnerCalls = 0;
    const result = evaluateVerifyAcFromPlan(
      {
        id: "3615-mixed",
        title: "mixed walk",
        acceptance: {
          commands: [{ command: "curl https://example.com" }, { command: "task test" }],
          none_stated: false,
          source_rung: "derived",
        },
        items: [],
      },
      {
        projectRoot: root,
        runner: () => {
          runnerCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        captureFromNarratives: false,
        bankOnPass: false,
        reuseMode: "never",
        env,
        sessionId: "sess-3615-eval-mixed",
        hasSuiteFloor: true,
      },
    );
    expect(result.ok).toBe(false);
    expect(runnerCalls).toBe(1);
    expect(
      verificationLines(path).some(
        (row) => row.event === "verification" && row.payload.outcome === "pass",
      ),
    ).toBe(false);
  });

  it("names poisoned-history recovery that is not independent re-derivation", () => {
    const text = readFileSync(join(process.cwd(), "content/docs/gate-integrity.md"), "utf8");
    expect(text).toMatch(/#3615/);
    expect(text).toMatch(/DEFT_SESSION_ID/);
    expect(text).toMatch(/\.deft-run-summary\.json/);
    expect(text).toMatch(/independent_rederivation=true/);
    expect(text).toMatch(/refused side never executed/i);
  });
});

describe("Path B activation AC disposition (#5792)", () => {
  it("admits local no-bodyText brief-land via issue-ref identity and defers product AC", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-activation-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const files = [
      { status: "added", path: "xbrief/active/story-5792.xbrief.json" },
      { status: "modified", path: "CHANGELOG.md" },
    ];
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: null,
      repo: "deftai/directive",
      files,
    });
    expect(disposition.apply).toBe(true);
    if (!disposition.apply) return;
    expect(disposition.message).toMatch(/path_b_activation_deferred \(#5792\)/);
    expect(disposition.witnessDetail).toMatch(/local issue-ref identity #5792/);
    expect(isPathBActivationAcDispositionText(disposition.message)).toBe(true);
    expect(isPathBActivationAcDispositionText("verify:ac soft_empty (#3334)")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("restores full verify:ac when inventory includes a product path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-product-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "mixed",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: null,
      repo: "deftai/directive",
      files: [
        { status: "added", path: "xbrief/active/story-5792.xbrief.json" },
        { status: "added", path: "src/record-reference.js" },
      ],
    });
    expect(disposition.apply).toBe(false);
    if (disposition.apply) return;
    expect(disposition.reason).toMatch(/not brief-land shaped|product path/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("still requires deft-story marks when PR bodyText is present", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-body-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const missing = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: "Tracking #5792\n",
      repo: "deftai/directive",
      files: [
        { status: "added", path: "xbrief/active/story-5792.xbrief.json" },
        { status: "modified", path: "CHANGELOG.md" },
      ],
    });
    expect(missing.apply).toBe(false);
    const admitted = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: "Tracking #5792\n\ndeft-story: 5792\n",
      repo: "deftai/directive",
      files: [
        { status: "added", path: "xbrief/active/story-5792.xbrief.json" },
        { status: "modified", path: "CHANGELOG.md" },
      ],
    });
    expect(admitted.apply).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses disposition when productPullRequest is stamped", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-stamped-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "product",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: 9999 },
        },
      }),
      "utf8",
    );
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: null,
      repo: "deftai/directive",
      files: [
        { status: "modified", path: "xbrief/active/story-5792.xbrief.json" },
        { status: "modified", path: "CHANGELOG.md" },
      ],
    });
    expect(disposition.apply).toBe(false);
    if (disposition.apply) return;
    expect(disposition.reason).toMatch(/productPullRequest/);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses empty live PR bodyText instead of local issue-ref fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-empty-body-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: "",
      prNumber: 6075,
      repo: "deftai/directive",
      files: [
        { status: "added", path: "xbrief/active/story-5792.xbrief.json" },
        { status: "modified", path: "CHANGELOG.md" },
      ],
    });
    expect(disposition.apply).toBe(false);
    if (disposition.apply) return;
    expect(disposition.reason).toMatch(/missing deft-story marks/);
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves rename previousFilename when a later dirty edit replaces the path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-rename-merge-"));
    const brief = "xbrief/active/story-5792.xbrief.json";
    const origin = "packages/core/src/old-product.json";
    const runGit = (_cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("is-inside-work-tree")) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined.includes("show-toplevel")) {
        return { code: 0, stdout: `${root}\n`, stderr: "" };
      }
      if (joined.includes("rev-parse") && joined.includes("verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("...")) {
        return { code: 0, stdout: `R100\0${origin}\0${brief}\0`, stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("HEAD") && !joined.includes("cached")) {
        return { code: 0, stdout: `M\0${brief}\0`, stderr: "" };
      }
      if (joined.includes("--cached") || joined.includes("ls-files")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = collectBriefLandInventoryAsPrDiffPaths({
      projectRoot: root,
      baseRef: "origin/master",
      runGit,
    });
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    const entry = inventory.files.find((file) => file.path === brief);
    expect(entry?.previousFilename).toBe(origin);
    expect(inventory.files.some((file) => file.path === origin && file.status === "removed")).toBe(
      true,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps brief→brief rename previousFilename without a deleted-nonterminal row", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-brief-move-"));
    const from = "xbrief/pending/story-5792.xbrief.json";
    const to = "xbrief/active/story-5792.xbrief.json";
    const runGit = (_cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("is-inside-work-tree")) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined.includes("show-toplevel")) {
        return { code: 0, stdout: `${root}\n`, stderr: "" };
      }
      if (joined.includes("rev-parse") && joined.includes("verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("...")) {
        return { code: 0, stdout: `R100\0${from}\0${to}\0`, stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("HEAD") && !joined.includes("cached")) {
        return { code: 0, stdout: `M\0${to}\0`, stderr: "" };
      }
      if (joined.includes("--cached") || joined.includes("ls-files")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = collectBriefLandInventoryAsPrDiffPaths({
      projectRoot: root,
      baseRef: "origin/master",
      runGit,
    });
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    const entry = inventory.files.find((file) => file.path === to);
    expect(entry?.previousFilename).toBe(from);
    expect(inventory.files.some((file) => file.path === from)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers typed deliveryBranch over master|main fallbacks for inventory base", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-5792-delivery-base-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "t", status: "running", policy: { deliveryBranch: "develop" } },
      }),
      "utf8",
    );
    const brief = "xbrief/active/story-5792.xbrief.json";
    const seenVerify: string[] = [];
    const runGit = (_cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("is-inside-work-tree")) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined.includes("show-toplevel")) {
        return { code: 0, stdout: `${root}\n`, stderr: "" };
      }
      if (joined.includes("rev-parse") && joined.includes("verify")) {
        seenVerify.push(joined);
        if (joined.includes("origin/develop^{commit}") || joined.includes("origin/develop")) {
          return { code: 0, stdout: "devsha\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }
      if (joined.includes("abbrev-ref") && joined.includes("origin/HEAD")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("...")) {
        return { code: 0, stdout: `A\0${brief}\0`, stderr: "" };
      }
      if (joined.includes("diff") || joined.includes("ls-files")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const prevBase = process.env.DEFT_BASE_REF;
    const prevGh = process.env.GITHUB_BASE_REF;
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    try {
      const inventory = collectBriefLandInventoryAsPrDiffPaths({
        projectRoot: root,
        runGit,
      });
      expect(inventory.ok).toBe(true);
      if (!inventory.ok) return;
      expect(inventory.files.some((file) => file.path === brief)).toBe(true);
      expect(seenVerify.some((s) => s.includes("origin/develop"))).toBe(true);
      expect(seenVerify.some((s) => s.includes("origin/master"))).toBe(false);
    } finally {
      if (prevBase === undefined) delete process.env.DEFT_BASE_REF;
      else process.env.DEFT_BASE_REF = prevBase;
      if (prevGh === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = prevGh;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("remaps nested-project inventory paths to projectRoot so brief-land deferral holds", () => {
    const gitRoot = mkdtempSync(join(tmpdir(), "deft-5792-nested-git-"));
    const projectRoot = join(gitRoot, "apps", "example");
    mkdirSync(join(projectRoot, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(projectRoot, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const gitBrief = "apps/example/xbrief/active/story-5792.xbrief.json";
    const gitChangelog = "apps/example/CHANGELOG.md";
    const sibling = "apps/other/src/product.js";
    const runGit = (_cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("is-inside-work-tree")) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined.includes("show-toplevel")) {
        return { code: 0, stdout: `${gitRoot}\n`, stderr: "" };
      }
      if (joined.includes("rev-parse") && joined.includes("verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("...")) {
        return {
          code: 0,
          stdout: `A\0${gitBrief}\0A\0${gitChangelog}\0A\0${sibling}\0`,
          stderr: "",
        };
      }
      if (joined.includes("diff") || joined.includes("ls-files")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = collectBriefLandInventoryAsPrDiffPaths({
      projectRoot,
      baseRef: "origin/master",
      runGit,
    });
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    expect(
      inventory.files.some((file) => file.path === "xbrief/active/story-5792.xbrief.json"),
    ).toBe(true);
    expect(inventory.files.some((file) => file.path === "CHANGELOG.md")).toBe(true);
    expect(inventory.files.some((file) => file.path.includes("apps/example/"))).toBe(false);
    expect(inventory.files.some((file) => /(?:^|\/)\.\.\//.test(file.path))).toBe(true);

    const briefOnly = collectBriefLandInventoryAsPrDiffPaths({
      projectRoot,
      baseRef: "origin/master",
      runGit: (_cwd, args) => {
        const joined = args.join(" ");
        if (joined.includes("is-inside-work-tree")) {
          return { code: 0, stdout: "true\n", stderr: "" };
        }
        if (joined.includes("show-toplevel")) {
          return { code: 0, stdout: `${gitRoot}\n`, stderr: "" };
        }
        if (joined.includes("rev-parse") && joined.includes("verify")) {
          return { code: 0, stdout: "abc\n", stderr: "" };
        }
        if (joined.includes("diff") && joined.includes("...")) {
          return { code: 0, stdout: `A\0${gitBrief}\0A\0${gitChangelog}\0`, stderr: "" };
        }
        if (joined.includes("diff") || joined.includes("ls-files")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(briefOnly.ok).toBe(true);
    if (!briefOnly.ok) return;
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot,
      bodyText: null,
      repo: "deftai/directive",
      files: briefOnly.files,
    });
    expect(disposition.apply).toBe(true);
    expect(briefOnly.briefReadRoot).toBe(resolve(projectRoot));
    rmSync(gitRoot, { recursive: true, force: true });
  });

  it("keeps repo-root brief deferral when projectRoot is a subdirectory cwd", () => {
    const gitRoot = mkdtempSync(join(tmpdir(), "deft-5792-subdir-cwd-"));
    const projectRoot = join(gitRoot, "packages", "core");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(gitRoot, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(gitRoot, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(join(gitRoot, "CHANGELOG.md"), "# Changelog\n", "utf8");
    const gitBrief = "xbrief/active/story-5792.xbrief.json";
    const gitChangelog = "CHANGELOG.md";
    const runGit = (_cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined.includes("is-inside-work-tree")) {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined.includes("show-toplevel")) {
        return { code: 0, stdout: `${gitRoot}\n`, stderr: "" };
      }
      if (joined.includes("rev-parse") && joined.includes("verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (joined.includes("diff") && joined.includes("...")) {
        return { code: 0, stdout: `A\0${gitBrief}\0A\0${gitChangelog}\0`, stderr: "" };
      }
      if (joined.includes("diff") || joined.includes("ls-files")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const inventory = collectBriefLandInventoryAsPrDiffPaths({
      projectRoot,
      baseRef: "origin/master",
      runGit,
    });
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    expect(inventory.briefReadRoot).toBe(resolve(gitRoot));
    expect(inventory.files.some((file) => file.path === gitBrief)).toBe(true);
    expect(inventory.files.some((file) => file.path === gitChangelog)).toBe(true);
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot,
      bodyText: null,
      repo: "deftai/directive",
      runGit,
      baseRef: "origin/master",
    });
    expect(disposition.apply).toBe(true);
    rmSync(gitRoot, { recursive: true, force: true });
  });
});
