/**
 * Deterministic-questions hatch gate + Cursor plan-choice pause latch (#5373).
 *
 * Deny vs render are separate: refuse non-conforming question tools when
 * PreToolUse admits them; operator-visible corrected menu only on hosts with
 * a render channel (Cursor user_message). Pause latch arms only where
 * selection ingress is observed (Cursor plan-choice / prompt.submit).
 *
 * hooks → tool-events import: question-tool subset only (never full COORDINATE).
 */

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isSpendAskDeniedByArcState,
  optionLabelsLookLikeSpend,
  readArcSpendState,
  resolveArcSpendSessionId,
  sanitizeArcSpendSessionId,
} from "../design-critique/spend.js";
import { containedRemove, containedRename, containedWrite } from "../fs/contained-write.js";
import { isQuestionToolName } from "../tool-events/classify.js";
import { platformUserConfigDir } from "../user-config/resolve-user-md.js";
import { resolveHookHostIdentity } from "./classify/host-session-identity.js";
import { fieldString, record, toolInputRecord } from "./classify/payload.js";
import {
  CURSOR_PLAN_CHOICE_HOST,
  type CursorPlanChoiceDeps,
  canonicalWorkspaceRoot,
  decideCursorPlanChoice,
  defaultCursorPlanChoiceDeps,
  hashPlanChoiceTuple,
  resolvePlanChoiceIdentity,
} from "./cursor-plan-choice/index.js";
import type { HookDecision, HookDecisionCode, HookDispatchInput } from "./dispatcher.js";

/** Visible normative hatch label (#5373). */
export const QUESTION_HATCH_VISIBLE = "Discuss";

/** Accepted-input aliases for the same halt control (trim, case-insensitive). */
export const QUESTION_HATCH_ALIASES: ReadonlySet<string> = new Set(["discuss", "i have questions"]);

export const QUESTION_BACK_LABEL = "Back";

export type QuestionHatchDecisionCode =
  | "question-hatch-ready"
  | "question-hatch-missing"
  | "question-hatch-order"
  | "question-hatch-pause-active"
  | "question-hatch-pause-storage-failure"
  | "question-hatch-pause-lock-busy"
  | "question-hatch-pause-resumed";

/** Arc in-flight without spend-recommend — deny structured asks (#5466). */
export type SpendRecommendGateDecisionCode = "spend-recommend-required";

/** Retention hint only — elapsed time MUST NOT clear the latch (#5373). */
const PAUSE_TTL_MS = 60 * 60 * 1000;
const PAUSE_DIR = ["runtime", "question-hatch-pause", "v1"] as const;

export type QuestionOptionLabels = {
  readonly labels: readonly string[];
  readonly questionCount: number;
};

export type HatchPresence =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "question-hatch-missing" | "question-hatch-order" };

function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^\d+\.\s*/, "")
    .trim()
    .toLowerCase();
}

export function isHatchAliasText(text: string): boolean {
  // Free-text hatch input is exact display match (trim + casefold only).
  // Do not strip numbered-option prefixes — "1. Discuss" is not a hatch alias (#5373).
  return QUESTION_HATCH_ALIASES.has(text.trim().toLowerCase());
}

export function isBackLabelText(text: string): boolean {
  return normalizeLabel(text) === "back";
}

function optionLabel(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
  const obj = record(entry);
  if (obj === null) return null;
  return (
    fieldString(obj, "label") ??
    fieldString(obj, "title") ??
    fieldString(obj, "text") ??
    fieldString(obj, "name")
  );
}

function labelsFromQuestion(question: Record<string, unknown>): string[] {
  const options = question.options;
  if (!Array.isArray(options)) return [];
  const labels: string[] = [];
  for (const opt of options) {
    const label = optionLabel(opt);
    if (label !== null) labels.push(label);
  }
  return labels;
}

/**
 * Extract per-question option labels from host structured-question payloads.
 * Supports Grok ask_user_question and Cursor AskQuestion shapes.
 */
export function extractQuestionOptionGroups(payload: unknown): QuestionOptionLabels[] {
  const top = record(payload);
  if (top === null) return [];
  const toolInput = toolInputRecord(top) ?? top;
  const groups: QuestionOptionLabels[] = [];

  const questions = toolInput.questions;
  if (Array.isArray(questions)) {
    for (const q of questions) {
      const qr = record(q);
      if (qr === null) continue;
      const labels = labelsFromQuestion(qr);
      groups.push({ labels, questionCount: 1 });
    }
    return groups;
  }

  if (Array.isArray(toolInput.options)) {
    groups.push({ labels: labelsFromQuestion(toolInput), questionCount: 1 });
  }
  return groups;
}

export function evaluateHatchPresence(labels: readonly string[]): HatchPresence {
  if (labels.length < 2) {
    return { ok: false, code: "question-hatch-missing" };
  }
  const hatch = labels[labels.length - 2];
  const back = labels[labels.length - 1];
  if (hatch === undefined || back === undefined) {
    return { ok: false, code: "question-hatch-missing" };
  }
  const hatchNorm = normalizeLabel(hatch);
  const backNorm = normalizeLabel(back);
  if (hatchNorm === "discuss" && backNorm === "back") {
    return { ok: true };
  }
  // Other / free-text widening must never count as the rendered hatch.
  if (QUESTION_HATCH_ALIASES.has(hatchNorm) && hatchNorm !== "discuss") {
    return { ok: false, code: "question-hatch-order" };
  }
  if (backNorm === "back" && hatchNorm !== "discuss") {
    return { ok: false, code: "question-hatch-order" };
  }
  return { ok: false, code: "question-hatch-missing" };
}

export function missingHatchMessage(toolName: string): string {
  return [
    `Directive denied ${toolName}: structured question missing hard-stop hatch.`,
    "",
    "Final two options MUST be:",
    `${QUESTION_HATCH_VISIBLE}`,
    `${QUESTION_BACK_LABEL}`,
    "",
    `Visible hatch is "${QUESTION_HATCH_VISIBLE}". "I have questions" is an accepted-input alias for the same halt — not a substitute rendered label.`,
    "Other / free-text widening is never the hatch.",
    "Re-present the menu with Discuss then Back as the final two options.",
  ].join("\n");
}

export function hatchOrderMessage(toolName: string): string {
  return [
    `Directive denied ${toolName}: structured question hatch order invalid.`,
    "",
    `Final two options MUST be "${QUESTION_HATCH_VISIBLE}" then "${QUESTION_BACK_LABEL}" (in that order).`,
    'Do not render "I have questions" or Other as the visible hatch.',
  ].join("\n");
}

export function pauseActiveMessage(toolName: string): string {
  return [
    `Directive denied ${toolName}: Discuss-pause is active for this conversation.`,
    "",
    "What would you like to discuss?",
    "Resume only with an explicit operator signal: re-ask the paused question, say resume/continue, or re-issue the prior selection.",
  ].join("\n");
}

function pauseStoreRoot(environ: NodeJS.ProcessEnv = process.env): string {
  const home = environ.HOME?.trim() || environ.USERPROFILE?.trim() || homedir();
  return join(platformUserConfigDir(process.platform, environ, home), ...PAUSE_DIR);
}

function pauseRecordPath(key: string, environ: NodeJS.ProcessEnv = process.env): string {
  return join(pauseStoreRoot(environ), `${key}.json`);
}

export type QuestionHatchPauseRecord = {
  readonly schema: "deft.question-hatch-pause.v1";
  readonly key: string;
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly pausedAt: string;
  readonly expiresAt: string;
  readonly source: "cursor-plan-choice-discuss";
};

function resolvePauseKey(payload: unknown, projectRoot: string): string | null {
  const classified = resolvePlanChoiceIdentity(payload, projectRoot);
  if (classified.ok && classified.identity.recordKey.length > 0) {
    return classified.identity.recordKey;
  }
  const top = record(payload);
  if (top === null) return null;
  const conversationId = fieldString(top, "conversation_id") ?? fieldString(top, "conversationId");
  if (conversationId === null) return null;
  // Never key on cwd — it diverges from Plan workspace_roots across events (#5373).
  const fromRoots =
    Array.isArray(top.workspace_roots) && typeof top.workspace_roots[0] === "string"
      ? top.workspace_roots[0].trim()
      : "";
  const workspace =
    fromRoots.length > 0 ? canonicalWorkspaceRoot(fromRoots) : canonicalWorkspaceRoot(projectRoot);
  return hashPlanChoiceTuple([CURSOR_PLAN_CHOICE_HOST, workspace, conversationId]);
}

function ensurePauseRoot(environ: NodeJS.ProcessEnv): string {
  const root = pauseStoreRoot(environ);
  mkdirSync(root, { recursive: true });
  return root;
}

function readPause(
  key: string,
  environ: NodeJS.ProcessEnv,
  _nowMs: number,
): QuestionHatchPauseRecord | null {
  const path = pauseRecordPath(key, environ);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as QuestionHatchPauseRecord;
    if (parsed.schema !== "deft.question-hatch-pause.v1") return null;
    // Elapsed time must not clear Discuss-pause; only explicit resume does (#5373).
    void _nowMs;
    return parsed;
  } catch {
    return null;
  }
}

function writePause(record: QuestionHatchPauseRecord, environ: NodeJS.ProcessEnv): "ok" | "fail" {
  const root = ensurePauseRoot(environ);
  const path = pauseRecordPath(record.key, environ);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    containedWrite({
      root,
      target: tmp,
      data: `${JSON.stringify(record, null, 2)}\n`,
      mode: "replace",
      mutation: false,
    });
    containedRename({ root, from: tmp, to: path, mutation: false });
    return "ok";
  } catch {
    try {
      containedRemove({ root, target: tmp, mutation: false });
    } catch {
      /* ignore */
    }
    return "fail";
  }
}

function clearPause(key: string, environ: NodeJS.ProcessEnv): void {
  try {
    const root = pauseStoreRoot(environ);
    containedRemove({ root, target: pauseRecordPath(key, environ), mutation: false });
  } catch {
    /* ignore */
  }
}

function promptText(payload: unknown): string | null {
  const top = record(payload);
  if (top === null) return null;
  return fieldString(top, "prompt") ?? fieldString(top, "text") ?? fieldString(top, "message");
}

function isExplicitResumeSignal(prompt: string): boolean {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "resume" || lower === "continue") return true;
  if (/^resume[.!]?$/i.test(trimmed) || /^continue[.!]?$/i.test(trimmed)) return true;
  return false;
}

function decision(
  input: HookDispatchInput,
  verdict: "allow" | "deny",
  code: HookDecisionCode,
  toolName: string | null,
  message: string,
): HookDecision {
  return {
    verdict,
    code,
    event: input.event,
    host: input.host,
    toolName,
    projectRoot: input.projectRoot,
    message,
    scopePath: null,
  };
}

export function spendRecommendRequiredMessage(toolName: string): string {
  return [
    `Directive denied ${toolName}: design-critique arc is in flight without a closed spend-recommend: record.`,
    "",
    "Bare-arc missing spend-recommend is a parent defect (#5466 Prefer-A).",
    "Remediation: deft design-critique:spend-resolve --utterance <text> --recommend N=1|N≥3",
    "Open the gate at arc start with --open-gate; clear with --clear when the arc ends.",
    "Then re-attempt the ask only if still lawful (ambiguous mixes, bare panel, or --unclosable-recommend).",
    "Keep the #5373 Discuss then Back hatch on any lawful ask.",
  ].join("\n");
}

/**
 * Session key for arc-spend-state that matches `design-critique:spend-resolve`
 * (#5466). Candidates are host-owned only: payload raw id (Claude
 * `session_id` / Cursor `conversation_id`), then env (`DEFT_SESSION_ID` /
 * `DEFT_MONITOR_AGENT_ID` / `GROK_SESSION_ID`). Prefer the first of those that
 * already has in-flight state so CLI `--session-id` raw and env keys align.
 * Never borrow shared `no-session` state when a host/env key exists — that
 * would let another conversation's `askPermitted` leak. `no-session` is only
 * the key when neither payload nor env identifies a conversation.
 */
export function resolveArcSpendSessionForHook(input: HookDispatchInput): string {
  const fromEnv = resolveArcSpendSessionId({ env: input.environ });
  const identity = resolveHookHostIdentity(input.host, input.payload, input.environ ?? process.env);
  const fromPayload =
    identity.status === "ok" ? sanitizeArcSpendSessionId(identity.rawSessionId) : null;
  const keyed: string[] = [];
  if (fromPayload !== null && fromPayload !== "no-session") keyed.push(fromPayload);
  if (fromEnv !== "no-session") keyed.push(fromEnv);
  if (keyed.length === 0) return "no-session";
  const seen = new Set<string>();
  for (const candidate of keyed) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const state = readArcSpendState(input.projectRoot, {
      sessionId: candidate,
      env: {},
    });
    if (state !== null) return candidate;
  }
  return keyed[0] ?? "no-session";
}

/**
 * State-keyed deny for spend-shaped QUESTION_HOOK tools while the session arc
 * gate is open and no spend-recommend is recorded yet (#5466). Not
 * utterance-keyed; no NLP. Option labels N=1 / N≥3 are the spend shape.
 * Missing session state still denies those spend-shaped asks so a fresh arc
 * cannot slip the first ask past an unopened gate. Unrelated questions are
 * never blanket-denied by abandoned session state.
 * #5373 hatch remains for lawful asks after askPermitted or resolved spend.
 */
export function decideSpendRecommendGate(
  input: HookDispatchInput,
  toolName: string,
): HookDecision | null {
  if (input.event !== "tool.before") return null;
  if (!isQuestionToolName(toolName)) return null;
  const groups = extractQuestionOptionGroups(input.payload);
  const spendShaped = groups.some((group) => optionLabelsLookLikeSpend(group.labels));
  const sessionId = resolveArcSpendSessionForHook(input);
  const state = readArcSpendState(input.projectRoot, { sessionId, env: {} });
  if (!isSpendAskDeniedByArcState(state, { spendShaped })) return null;
  return decision(
    input,
    "deny",
    "spend-recommend-required",
    toolName,
    spendRecommendRequiredMessage(toolName),
  );
}

/**
 * Refuse-missing-hatch when PreToolUse admits a structured-question tool.
 */
export function decideQuestionHatchGate(
  input: HookDispatchInput,
  toolName: string,
): HookDecision | null {
  if (input.event !== "tool.before") return null;
  if (!isQuestionToolName(toolName)) return null;

  const groups = extractQuestionOptionGroups(input.payload);
  if (groups.length === 0) {
    return decision(
      input,
      "deny",
      "question-hatch-missing",
      toolName,
      missingHatchMessage(toolName),
    );
  }
  for (const group of groups) {
    const presence = evaluateHatchPresence(group.labels);
    if (!presence.ok) {
      const message =
        presence.code === "question-hatch-order"
          ? hatchOrderMessage(toolName)
          : missingHatchMessage(toolName);
      return decision(input, "deny", presence.code, toolName, message);
    }
  }
  return decision(
    input,
    "allow",
    "question-hatch-ready",
    toolName,
    `Directive allowed ${toolName}: Discuss then Back present as final two options.`,
  );
}

/**
 * When a Discuss-pause latch is live for this conversation, deny non-ack tools.
 */
export function decideQuestionHatchPauseGate(
  input: HookDispatchInput,
  toolName: string | null,
  nowMs: number = Date.now(),
): HookDecision | null {
  if (input.event !== "tool.before") return null;
  if (input.host !== "cursor") return null;
  const environ = input.environ ?? process.env;
  const key = resolvePauseKey(input.payload, input.projectRoot);
  if (key === null) return null;
  const live = readPause(key, environ, nowMs);
  if (live === null) return null;
  return decision(
    input,
    "deny",
    "question-hatch-pause-active",
    toolName,
    pauseActiveMessage(toolName ?? "tool"),
  );
}

function armDiscussPause(input: HookDispatchInput, nowMs: number): HookDecision | null {
  const environ = input.environ ?? process.env;
  const key = resolvePauseKey(input.payload, input.projectRoot);
  if (key === null) return null;
  const top = record(input.payload);
  const conversationId =
    top !== null
      ? (fieldString(top, "conversation_id") ?? fieldString(top, "conversationId") ?? "")
      : "";
  const recordBody: QuestionHatchPauseRecord = {
    schema: "deft.question-hatch-pause.v1",
    key,
    conversationId,
    workspaceRoot: input.projectRoot,
    pausedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + PAUSE_TTL_MS).toISOString(),
    source: "cursor-plan-choice-discuss",
  };
  const wrote = writePause(recordBody, environ);
  if (wrote !== "ok") {
    return decision(
      input,
      "deny",
      "question-hatch-pause-storage-failure",
      null,
      "Directive blocked planning choice: Discuss-pause state could not be stored. Retry.",
    );
  }
  return null;
}

/**
 * Cursor prompt.submit / agent.response path with hatch alias + pause latch.
 * Selection ingress is observed only on this Cursor plan-choice surface.
 */
export function decidePlanChoiceWithHatch(
  input: HookDispatchInput,
  deps: CursorPlanChoiceDeps = defaultCursorPlanChoiceDeps(input.environ ?? process.env),
  nowMs: number = Date.now(),
): HookDecision {
  const environ = input.environ ?? process.env;
  const key = resolvePauseKey(input.payload, input.projectRoot);
  const prompt = promptText(input.payload);

  // Explicit operator resume clears the latch, then re-enters plan-choice.
  // A bare resume must not allow planning to proceed without a strategy.
  if (
    input.event === "prompt.submit" &&
    key !== null &&
    prompt !== null &&
    isExplicitResumeSignal(prompt)
  ) {
    const live = readPause(key, environ, nowMs);
    if (live !== null) {
      clearPause(key, environ);
      const reask = decideCursorPlanChoice(input, deps);
      if (reask.code === "plan-choice-question" || reask.code === "plan-choice-discuss") {
        return {
          ...reask,
          message: [
            "Directive cleared Discuss-pause on explicit operator resume.",
            "",
            reask.message,
          ].join("\n"),
        };
      }
      return decision(
        input,
        "deny",
        "question-hatch-pause-resumed",
        null,
        [
          "Directive cleared Discuss-pause on explicit operator resume.",
          "",
          "Re-ask the planning question in Plan mode and select a strategy.",
          "A bare resume does not complete planning choice.",
        ].join("\n"),
      );
    }
  }

  // Free-text hatch alias while plan-choice is asking: treat as Discuss halt.
  let base: ReturnType<typeof decideCursorPlanChoice> | null = null;
  if (input.event === "prompt.submit" && prompt !== null && isHatchAliasText(prompt)) {
    const probe = decideCursorPlanChoice(input, deps);
    if (probe.code === "plan-choice-question") {
      const armed = armDiscussPause(input, nowMs);
      if (armed !== null) return armed;
      return decision(
        input,
        "deny",
        "plan-choice-discuss",
        null,
        [
          "No planning choice was recorded.",
          "",
          "What would you like to discuss?",
          "Discuss-pause is active. Resume with resume/continue or by re-asking the planning question.",
        ].join("\n"),
      );
    }
    base = probe;
  }

  if (base === null) {
    base = decideCursorPlanChoice(input, deps);
  }
  if (base.code === "plan-choice-discuss") {
    const armed = armDiscussPause(input, nowMs);
    if (armed !== null) return armed;
    return {
      ...base,
      message: [
        base.message,
        "",
        "What would you like to discuss?",
        "Discuss-pause is active for this conversation until an explicit operator resume.",
      ].join("\n"),
    };
  }
  if (base.code === "plan-choice-back" && key !== null) {
    clearPause(key, environ);
  }
  return base;
}
