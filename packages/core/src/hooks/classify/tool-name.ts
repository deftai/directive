/**
 * Pure tool-name resolution from host PreToolUse payloads (#2950 / #2628 / #2669).
 * No process I/O.
 */

import { hookWriteTargetPath } from "./paths.js";
import {
  fieldPresent,
  fieldString,
  hookPayloadTopLevelKeys,
  record,
  toolInputRecord,
} from "./payload.js";
import type { ClassifyHookHost, HookPayloadContext } from "./types.js";

/**
 * Cursor preToolUse payloads sometimes omit `tool_name` even when the hook matcher
 * fired for a direct-write tool (#2628). Infer from nested tool input when possible.
 */
export function inferCursorDirectWriteToolName(payload: Record<string, unknown>): string | null {
  const toolInput = toolInputRecord(payload);
  if (toolInput !== null) {
    if (
      fieldPresent(toolInput, "new_string") ||
      fieldPresent(toolInput, "newString") ||
      fieldPresent(toolInput, "old_string") ||
      fieldPresent(toolInput, "oldString")
    ) {
      return "StrReplace";
    }

    if (
      fieldString(toolInput, "contents") !== null ||
      fieldString(toolInput, "content") !== null ||
      fieldString(toolInput, "text") !== null
    ) {
      return "Write";
    }

    if (
      fieldString(toolInput, "patch") !== null ||
      fieldString(toolInput, "unified_diff") !== null ||
      fieldString(toolInput, "diff") !== null
    ) {
      return "ApplyPatch";
    }

    if (Array.isArray(toolInput.edits)) return "MultiEdit";
    if (Array.isArray(toolInput.cells) || toolInput.cell_id != null) {
      return "NotebookEdit";
    }
  }

  // Cursor maps Claude Edit → Write; a write target without contents is still a direct write.
  if (hookWriteTargetPath(payload) !== null) return "Write";

  return null;
}

export function hookToolName(payload: unknown, host?: ClassifyHookHost | string): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolObject = record(input.tool);
  const toolCall = record(input.tool_call) ?? record(input.toolCall);
  // OpenAI-style nestings are host-agnostic; checked before Cursor-only inference.
  const direct =
    fieldString(input, "tool_name") ??
    fieldString(input, "toolName") ??
    fieldString(input, "tool") ??
    (toolObject !== null ? fieldString(toolObject, "name") : null) ??
    (toolCall !== null ? fieldString(toolCall, "name") : null);
  if (direct !== null) return direct;
  if (host === "cursor") return inferCursorDirectWriteToolName(input);
  return null;
}

export interface MissingToolNameInput {
  readonly host: ClassifyHookHost | string;
  readonly payload: unknown;
  readonly context?: HookPayloadContext;
}

export function missingToolNameMessage(input: MissingToolNameInput): string {
  const { host, payload, context } = input;
  if (host === "cursor") {
    if (context?.stdinEmpty) {
      return (
        "Directive denied this Cursor preToolUse event because the host sent an empty payload " +
        "(stdin was empty — not a session ritual or scope failure). " +
        "If write tools should pass, update Directive or report the payload shape from Cursor."
      );
    }
    if (context?.parseFailed) {
      return (
        "Directive denied this Cursor preToolUse event because the host payload was not valid JSON " +
        "(host-integration mismatch — not a session ritual or scope failure). " +
        "If write tools should pass, update Directive or report the payload shape from Cursor."
      );
    }
    const keys = hookPayloadTopLevelKeys(payload);
    if (keys.length > 0) {
      return (
        "Directive denied this Cursor preToolUse event because the host payload omitted a " +
        "recognizable tool name (host-integration mismatch — not a session ritual or scope failure). " +
        `Top-level payload keys: ${keys.join(", ")}. ` +
        "If write tools should pass, update Directive or report the payload shape from Cursor."
      );
    }
    return (
      "Directive denied this Cursor preToolUse event because the host payload omitted a " +
      "recognizable tool name (host-integration mismatch — not a session ritual or scope failure). " +
      "If write tools should pass, update Directive or report the payload shape from Cursor."
    );
  }
  return "Directive denied this matched write event because the host payload omitted its tool name.";
}
