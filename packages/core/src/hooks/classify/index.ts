/**
 * Pure hook payload classification (#2950 Phase A).
 *
 * Payload → tool identity + write intent + path set. No process I/O.
 * Policy / ritual / scope / permission emission stay in dispatcher + CLI adapter.
 */

export { classifyHookPayload } from "./classify.js";
export {
  hookMcpArgsText,
  hookPathSet,
  hookShellCommand,
  hookWriteTargetPath,
} from "./paths.js";
export {
  fieldPresent,
  fieldString,
  firstString,
  hookPayloadTopLevelKeys,
  record,
  toolInputRecord,
} from "./payload.js";
export { parseHookStdin, stripUtf8Bom } from "./stdin.js";
export {
  hookToolName,
  inferCursorDirectWriteToolName,
  type MissingToolNameInput,
  missingToolNameMessage,
} from "./tool-name.js";
export type {
  ClassifyHookHost,
  ClassifyHookPayloadInput,
  HookClassification,
  HookPayloadContext,
  HookWriteIntent,
  ParsedHookPayload,
} from "./types.js";
export { CLASSIFY_HOOK_HOSTS } from "./types.js";
