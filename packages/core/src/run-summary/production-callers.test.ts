/**
 * Production emitters share one workspace session_id (#3399).
 *
 * DEFT_SESSION_ID is unset; ritual-state is present. Component names stay
 * out of session_id.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCachedTaskCheck } from "../check/cached-orchestrator.js";
import { emitAcceptanceStampFromPlan } from "../intake/clause-derivation.js";
import { escalateCeremonyDial } from "../policy/ceremony-dial.js";
import { evaluateVerifyAcFromPlan } from "../product-first-done-gate/evaluate.js";
import { bankAcPass, evaluateSurplus } from "../session/ac-pass-banking.js";
import {
  detectHardEffortBudget,
  ENV_MAX_TURNS,
  ENV_REMAINING_TURNS,
} from "../session/effort-budget.js";
import { newRitualStatePayload, writeRitualState } from "../session/ritual-sentinel.js";
import { emitVerifyAcAttempts } from "../verify-ac/evaluate.js";
import { parseRunSummaryJsonl } from "./share.js";
import { ENV_RUN_SUMMARY_PATH } from "./types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "run-summary-callers-"));
  tempDirs.push(root);
  return root;
}

function writeRitual(root: string, sessionId: string): void {
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId,
      gitHead: "abc123",
      worktreePath: root,
    }),
  );
}

function readLines(path: string) {
  return parseRunSummaryJsonl(readFileSync(path, "utf8"));
}

const RITUAL = "workspace-ritual-sid";

describe("production emitters with ritual-state and no DEFT_SESSION_ID (#3399)", () => {
  it("emitVerifyAcAttempts uses ritual-state session_id, never a fresh UUID", () => {
    const root = freshRoot();
    writeRitual(root, RITUAL);
    const dest = join(root, "summary.jsonl");
    emitVerifyAcAttempts({
      projectRoot: root,
      env: { [ENV_RUN_SUMMARY_PATH]: dest },
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
    const lines = readLines(dest);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.session_id).toBe(RITUAL);
    expect(lines[0]?.session_id).not.toBe("verify-ac");
    expect(lines[0]?.component).toBe("verify-ac");
  });

  it("acceptance outcome uses ritual-state session_id, not verify-ac", () => {
    const root = freshRoot();
    writeRitual(root, RITUAL);
    const dest = join(root, "summary.jsonl");
    evaluateVerifyAcFromPlan(
      {
        id: "3399-acceptance-caller",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      {
        projectRoot: root,
        env: { [ENV_RUN_SUMMARY_PATH]: dest },
        applyOracleIntegrity: false,
        bankOnPass: false,
        hasSuiteFloor: false,
      },
    );
    const lines = readLines(dest);
    const acceptance = lines.find((line) => line.event === "acceptance");
    expect(acceptance?.session_id).toBe(RITUAL);
    expect(acceptance?.session_id).not.toBe("verify-ac");
    expect(acceptance?.component).toBe("verify-ac");
  });

  it("clause-derivation stamp uses ritual-state session_id, not clause-derivation", () => {
    const root = freshRoot();
    writeRitual(root, RITUAL);
    const dest = join(root, "summary.jsonl");
    emitAcceptanceStampFromPlan(
      root,
      {
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "project_floor",
          clauses: [],
        },
      },
      { [ENV_RUN_SUMMARY_PATH]: dest },
    );
    const lines = readLines(dest);
    expect(lines[0]?.event).toBe("acceptance_stamp");
    expect(lines[0]?.session_id).toBe(RITUAL);
    expect(lines[0]?.session_id).not.toBe("clause-derivation");
    expect(lines[0]?.component).toBe("clause-derivation");
  });

  it("check orchestrator uses ritual-state session_id instead of minting", () => {
    const root = freshRoot();
    writeRitual(root, RITUAL);
    const dest = join(root, "summary.jsonl");
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    dispatchCachedTaskCheck(root, root, {
      noCache: true,
      preflight: null,
      env: { [ENV_RUN_SUMMARY_PATH]: dest },
    });
    errWrite.mockRestore();
    const lines = readLines(dest);
    const check = lines.find((line) => line.event === "check_invocation");
    expect(check?.session_id).toBe(RITUAL);
  });

  it("ceremony-dial uses ritual-state session_id instead of dial-timestamp", () => {
    const root = freshRoot();
    writeRitual(root, RITUAL);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { title: "P", status: "running", policy: {} } }),
      "utf8",
    );
    const dest = join(root, "summary.jsonl");
    escalateCeremonyDial(root, {
      to: "standard",
      reason: "3399-ritual",
      env: { [ENV_RUN_SUMMARY_PATH]: dest },
    });
    const lines = readLines(dest);
    const evalLine = lines.find((line) => line.event === "dial_escalation_evaluation");
    expect(evalLine?.session_id).toBe(RITUAL);
    expect(evalLine?.session_id.startsWith("dial-") ?? false).toBe(false);
  });

  it("bankAcPass writes through the emitter with envelope fields and continuing seq", () => {
    const root = freshRoot();
    writeRitual(root, RITUAL);
    const dest = join(root, "summary.jsonl");
    writeFileSync(
      dest,
      `${JSON.stringify({
        schema_version: 1,
        session_id: RITUAL,
        seq: 1,
        ts: "2026-08-16T00:00:00.000Z",
        event: "session_start",
        payload: {},
      })}\n`,
      "utf8",
    );
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "50", [ENV_REMAINING_TURNS]: "8" },
    });
    bankAcPass({
      projectRoot: root,
      scopeId: "3399-bank-envelope",
      budget,
      surplus: evaluateSurplus({ budget }),
      nextAction: "finalize_and_ship",
      headSha: "abc123",
      now: "2026-08-16T12:00:00Z",
      environ: { [ENV_RUN_SUMMARY_PATH]: dest },
    });
    const lines = readLines(dest);
    expect(lines).toHaveLength(2);
    const bank = lines[1];
    expect(bank?.event).toBe("ac_pass_bank");
    expect(bank?.schema_version).toBe(1);
    expect(bank?.session_id).toBe(RITUAL);
    expect(bank?.seq).toBe(2);
    expect(typeof bank?.ts).toBe("string");
    expect(bank).not.toHaveProperty("type");
    expect(bank).not.toHaveProperty("schemaVersion");
    const payload = bank?.payload as { scope_id?: string; next_action?: string };
    expect(payload.scope_id).toBe("3399-bank-envelope");
    expect(payload.next_action).toBe("finalize_and_ship");
  });
});
