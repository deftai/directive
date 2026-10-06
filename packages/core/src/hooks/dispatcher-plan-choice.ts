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

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isQuestionToolName } from "../tool-events/classify.js";
import { platformUserConfigDir } from "../user-config/resolve-user-md.js";
import { fieldString, record, toolInputRecord } from "./classify/payload.js";
import {
  type CursorPlanChoiceDeps,
  decideCursorPlanChoice,
  defaultCursorPlanChoiceDeps,
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
  return QUESTION_HATCH_ALIASES.has(normalizeLabel(text));
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

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
  const top = record(payload);
  if (top === null) return null;
  const conversationId = fieldString(top, "conversation_id") ?? fieldString(top, "conversationId");
  if (conversationId === null) return null;
  const workspace =
    fieldString(top, "cwd") ??
    (Array.isArray(top.workspace_roots) && typeof top.workspace_roots[0] === "string"
      ? top.workspace_roots[0]
      : projectRoot);
  return sha256Hex(`cursor|${workspace}|${conversationId}`);
}

function readPause(
  key: string,
  environ: NodeJS.ProcessEnv,
  nowMs: number,
): QuestionHatchPauseRecord | null {
  const path = pauseRecordPath(key, environ);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as QuestionHatchPauseRecord;
    if (parsed.schema !== "deft.question-hatch-pause.v1") return null;
    const expires = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expires) || expires <= nowMs) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePause(record: QuestionHatchPauseRecord, environ: NodeJS.ProcessEnv): "ok" | "fail" {
  const path = pauseRecordPath(record.key, environ);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return "ok";
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return "fail";
  }
}

function clearPause(key: string, environ: NodeJS.ProcessEnv): void {
  try {
    rmSync(pauseRecordPath(key, environ), { force: true });
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

  // Explicit operator resume clears the Cursor plan-choice Discuss-pause latch.
  if (
    input.event === "prompt.submit" &&
    key !== null &&
    prompt !== null &&
    isExplicitResumeSignal(prompt)
  ) {
    const live = readPause(key, environ, nowMs);
    if (live !== null) {
      clearPause(key, environ);
      return decision(
        input,
        "allow",
        "question-hatch-pause-resumed",
        null,
        "Directive cleared Discuss-pause on explicit operator resume.",
      );
    }
  }

  // Free-text hatch alias while plan-choice is asking: treat as Discuss halt.
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
  }

  const base = decideCursorPlanChoice(input, deps);
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
