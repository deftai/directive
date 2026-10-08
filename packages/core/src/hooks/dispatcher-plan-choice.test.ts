import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeArcSpendState } from "../design-critique/spend.js";
import { cursorPlanChoiceStoreRoot } from "./cursor-plan-choice/index.js";
import type { CursorPlanChoiceDeps } from "./cursor-plan-choice/types.js";
import {
  decideHook,
  type HookDecision,
  type HookPolicySeams,
  renderHostDecision,
} from "./dispatcher.js";
import {
  decideSpendRecommendGate,
  evaluateHatchPresence,
  extractQuestionOptionGroups,
  isHatchAliasText,
  resolveArcSpendSessionForHook,
} from "./dispatcher-plan-choice.js";

const READY_RITUAL = {
  code: 0,
  message: "OK",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function readySeams(planDeps?: CursorPlanChoiceDeps): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => ({
      ready: true,
      path: "/project/xbrief/active/story.xbrief.json",
      message: "OK",
    }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    cursorPlanChoice: planDeps,
  };
}

function planDeps(nowMs: { value: number }, configDir: string): CursorPlanChoiceDeps {
  let seq = 0;
  return {
    now: () => nowMs.value,
    randomBytes: (size) => {
      seq += 1;
      return Buffer.alloc(size, seq);
    },
    configDir,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
    processExists: (pid) => pid === process.pid,
    sleepMs: () => undefined,
    homedir: configDir,
    env: {},
  };
}

function isolationEnv(configHome: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return { APPDATA: configHome, USERPROFILE: configHome };
  }
  return { HOME: configHome };
}

describe("Cursor planning-choice dispatcher wiring (#4973)", () => {
  it("renders continue false for a Plan-choice block", () => {
    const decision: HookDecision = {
      verdict: "deny",
      code: "plan-choice-question",
      event: "prompt.submit",
      host: "cursor",
      toolName: null,
      projectRoot: "/project",
      message: "choose",
      scopePath: null,
    };
    expect(JSON.parse(renderHostDecision("cursor", decision))).toEqual({
      continue: false,
      user_message: "choose",
      code: "plan-choice-question",
    });
    expect(
      JSON.parse(
        renderHostDecision("cursor", {
          ...decision,
          verdict: "allow",
          code: "plan-choice-allow-non-plan",
        }),
      ),
    ).toEqual({ continue: true, code: "plan-choice-allow-non-plan" });
  });

  it("denies recognized writes to the planning-choice store with an active scope", () => {
    const store = cursorPlanChoiceStoreRoot(process.env, process.platform, homedir());
    const target = join(store, "deadbeef", "cafebabe.json");
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Write", tool_input: { path: target } },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("plan-choice-store-deny");
    expect(decision.message).toContain("planning-choice store");
  });
});

describe("question hatch gate (#5373)", () => {
  it("extracts Grok and Cursor option labels and evaluates final-two hatch", () => {
    const grok = extractQuestionOptionGroups({
      tool_name: "ask_user_question",
      tool_input: {
        questions: [
          {
            question: "Pick?",
            options: [{ label: "A" }, { label: "Discuss" }, { label: "Back" }],
          },
        ],
      },
    });
    expect(grok).toHaveLength(1);
    expect(evaluateHatchPresence(grok[0]?.labels ?? [])).toEqual({ ok: true });

    const missing = extractQuestionOptionGroups({
      tool_input: {
        questions: [{ prompt: "Q?", options: [{ label: "1. Only" }, { label: "2. Other" }] }],
      },
    });
    expect(evaluateHatchPresence(missing[0]?.labels ?? []).ok).toBe(false);
    expect(isHatchAliasText("I have questions")).toBe(true);
    expect(isHatchAliasText("Other")).toBe(false);
    expect(isHatchAliasText("1. Discuss")).toBe(false);
    expect(isHatchAliasText("1. I have questions")).toBe(false);
  });

  it("denies ask_user_question missing Discuss then Back (Grok reason-only render)", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Pick one?",
                options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Other" }],
              },
            ],
          },
        },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("question-hatch-missing");
    expect(decision.message).toContain("Discuss");
    expect(JSON.parse(renderHostDecision("grok", decision))).toEqual({
      decision: "deny",
      reason: decision.message,
    });
  });

  it("allows ask_user_question when Discuss then Back are final two", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Pick one?",
                options: [{ label: "Alpha" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("question-hatch-ready");
  });

  it("denies Cursor AskQuestion without hatch via user_message render", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "AskQuestion",
          tool_input: {
            questions: [
              {
                id: "q1",
                prompt: "OK?",
                options: [
                  { id: "a", label: "1. Yes" },
                  { id: "b", label: "2. No" },
                ],
              },
            ],
          },
        },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("question-hatch-missing");
    expect(JSON.parse(renderHostDecision("cursor", decision))).toMatchObject({
      permission: "deny",
      user_message: decision.message,
      code: "question-hatch-missing",
    });
  });

  it("arms Discuss-pause latch on plan-choice Discuss and denies next tool until resume", () => {
    const root = tempDir("hatch-ws-");
    const cfg = tempDir("hatch-cfg-");
    const clock = { value: 2_000_000 };
    const deps = planDeps(clock, cfg);
    const environ = isolationEnv(cfg);
    const seams = readySeams(deps);

    const ask = decideHook(
      {
        host: "cursor",
        event: "prompt.submit",
        projectRoot: root,
        environ,
        payload: {
          composer_mode: "plan",
          cursor_version: "3.21.16",
          conversation_id: "conv-hatch-1",
          workspace_roots: [root],
          attachments: [],
          prompt: "please plan",
          generation_id: "g1",
        },
      },
      seams,
    );
    expect(ask.code).toBe("plan-choice-question");
    const token = /DEFT-PLAN-CHOICE ([0-9a-f]{32})/.exec(ask.message)?.[1];
    expect(token).toBeTruthy();

    const discuss = decideHook(
      {
        host: "cursor",
        event: "prompt.submit",
        projectRoot: root,
        environ,
        payload: {
          composer_mode: "plan",
          cursor_version: "3.21.16",
          conversation_id: "conv-hatch-1",
          workspace_roots: [root],
          attachments: [],
          prompt: `DEFT-PLAN-CHOICE ${token} 3`,
          generation_id: "g2",
        },
      },
      seams,
    );
    expect(discuss.code).toBe("plan-choice-discuss");
    expect(discuss.message).toContain("What would you like to discuss?");

    const blocked = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        environ,
        payload: {
          conversation_id: "conv-hatch-1",
          workspace_roots: [root],
          tool_name: "Shell",
          tool_input: { command: "echo hi" },
        },
      },
      seams,
    );
    expect(blocked.verdict).toBe("deny");
    expect(blocked.code).toBe("question-hatch-pause-active");

    const resumed = decideHook(
      {
        host: "cursor",
        event: "prompt.submit",
        projectRoot: root,
        environ,
        payload: {
          composer_mode: "agent",
          cursor_version: "3.21.16",
          conversation_id: "conv-hatch-1",
          workspace_roots: [root],
          attachments: [],
          prompt: "resume",
          generation_id: "g3",
        },
      },
      seams,
    );
    expect(resumed.code).toBe("question-hatch-pause-resumed");
    expect(resumed.verdict).toBe("deny");
    expect(resumed.message).toContain("Re-ask the planning question");

    const after = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        environ,
        payload: {
          conversation_id: "conv-hatch-1",
          workspace_roots: [root],
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Next?",
                options: [{ label: "A" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      seams,
    );
    expect(after.code).toBe("question-hatch-ready");
  });
});

describe("spend-recommend gate (#5466)", () => {
  it("denies ask_user_question while arc in flight without spend-recommend", () => {
    const root = tempDir("spend-gate-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
      updatedAt: new Date().toISOString(),
      utterance: "arc 5466",
      sessionId: "no-session",
    });
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Spend?",
                options: [{ label: "N=1" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("spend-recommend-required");
    expect(decision.message).toContain("design-critique:spend-resolve");
  });

  it("allows ask after spend-recommend recorded (hatch still applies)", () => {
    const root = tempDir("spend-gate-ok-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: "N=1",
      spend: "N=1",
      spendAsk: "resolved",
      askPermitted: false,
      updatedAt: new Date().toISOString(),
      utterance: "arc 5466",
      sessionId: "no-session",
    });
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Ambiguous spend?",
                options: [{ label: "N=1" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("question-hatch-ready");
  });

  it("does not deny when no arc-spend-state exists for non-spend questions", () => {
    const root = tempDir("spend-gate-absent-");
    const gate = decideSpendRecommendGate(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Pick?",
                options: [{ label: "Alpha" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      "ask_user_question",
    );
    expect(gate).toBeNull();
  });

  it("denies spend-shaped ask when session gate was never opened", () => {
    const root = tempDir("spend-gate-shaped-");
    const gate = decideSpendRecommendGate(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Spend?",
                options: [{ label: "N=1" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      "ask_user_question",
    );
    expect(gate?.verdict).toBe("deny");
    expect(gate?.code).toBe("spend-recommend-required");
  });

  it("denies numbered spend labels while open unresolved gate", () => {
    const root = tempDir("spend-gate-numbered-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
      updatedAt: new Date().toISOString(),
      utterance: "arc 5466",
      sessionId: "no-session",
    });
    const gate = decideSpendRecommendGate(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Spend?",
                options: [
                  { label: "1. N=1" },
                  { label: "2. N≥3" },
                  { label: "3. Discuss" },
                  { label: "4. Back" },
                ],
              },
            ],
          },
        },
      },
      "ask_user_question",
    );
    expect(gate?.verdict).toBe("deny");
    expect(gate?.code).toBe("spend-recommend-required");
  });

  it("allows unrelated questions while session gate is open without recommend", () => {
    const root = tempDir("spend-gate-unrelated-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: false,
      updatedAt: new Date().toISOString(),
      utterance: "arc 5466",
      sessionId: "no-session",
    });
    const gate = decideSpendRecommendGate(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        environ: {},
        payload: {
          tool_name: "ask_user_question",
          tool_input: {
            questions: [
              {
                question: "Unrelated?",
                options: [{ label: "Alpha" }, { label: "Discuss" }, { label: "Back" }],
              },
            ],
          },
        },
      },
      "ask_user_question",
    );
    expect(gate).toBeNull();
  });

  it("aligns hook session with CLI --session-id via payload when env is empty", () => {
    const root = tempDir("spend-gate-session-align-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: true,
      updatedAt: new Date().toISOString(),
      utterance: "arc panel",
      sessionId: "sess-a",
    });
    const input = {
      host: "claude",
      event: "tool.before" as const,
      projectRoot: root,
      environ: {},
      payload: {
        session_id: "sess-a",
        tool_name: "ask_user_question",
        tool_input: {
          questions: [
            {
              question: "Spend?",
              options: [{ label: "N=1" }, { label: "Discuss" }, { label: "Back" }],
            },
          ],
        },
      },
    };
    expect(resolveArcSpendSessionForHook(input)).toBe("sess-a");
    const gate = decideSpendRecommendGate(input, "ask_user_question");
    expect(gate).toBeNull();
    const mismatch = decideSpendRecommendGate(
      {
        ...input,
        payload: { ...input.payload, session_id: "other-session" },
      },
      "ask_user_question",
    );
    // other-session has no state; falls back to no-session (also empty) → deny
    expect(mismatch?.verdict).toBe("deny");
    expect(mismatch?.code).toBe("spend-recommend-required");
  });

  it("does not borrow no-session askPermitted when payload session is empty", () => {
    const root = tempDir("spend-gate-nosession-no-borrow-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: true,
      updatedAt: new Date().toISOString(),
      utterance: "arc panel",
      sessionId: "no-session",
    });
    const input = {
      host: "claude",
      event: "tool.before" as const,
      projectRoot: root,
      environ: {},
      payload: {
        session_id: "sess-b",
        tool_name: "ask_user_question",
        tool_input: {
          questions: [
            {
              question: "Spend?",
              options: [{ label: "N=1" }, { label: "Discuss" }, { label: "Back" }],
            },
          ],
        },
      },
    };
    expect(resolveArcSpendSessionForHook(input)).toBe("sess-b");
    const gate = decideSpendRecommendGate(input, "ask_user_question");
    expect(gate?.verdict).toBe("deny");
    expect(gate?.code).toBe("spend-recommend-required");
  });

  it("prefers payload session state over a different env session id", () => {
    const root = tempDir("spend-gate-payload-over-env-");
    writeArcSpendState(root, {
      schema: "deft.design-critique.arc-spend-state.v1",
      status: "in-flight",
      spendRecommend: null,
      spend: null,
      spendAsk: null,
      askPermitted: true,
      updatedAt: new Date().toISOString(),
      utterance: "arc panel",
      sessionId: "sess-a",
    });
    const input = {
      host: "claude",
      event: "tool.before" as const,
      projectRoot: root,
      environ: { DEFT_SESSION_ID: "host:claude:v1:other" },
      payload: {
        session_id: "sess-a",
        tool_name: "ask_user_question",
        tool_input: {
          questions: [
            {
              question: "Spend?",
              options: [{ label: "N=1" }, { label: "Discuss" }, { label: "Back" }],
            },
          ],
        },
      },
    };
    expect(resolveArcSpendSessionForHook(input)).toBe("sess-a");
    expect(decideSpendRecommendGate(input, "ask_user_question")).toBeNull();
  });
});
