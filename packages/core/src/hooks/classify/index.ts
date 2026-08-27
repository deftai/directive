/**
 * Pure hook payload classification (#2950 Phase A).
 *
 * Payload → tool identity + write intent + path set. No process I/O.
 * Policy / ritual / scope / permission emission stay in dispatcher + CLI adapter.
 */

export { classifyHookPayload } from "./classify.js";
export {
  EXACT_LIFECYCLE_VERBS,
  type ExactLifecycleCommandConflict,
  type ExactLifecycleCommandInspection,
  type ExactLifecycleCommandResult,
  type ExactLifecycleCommandRewrite,
  type ExactLifecycleVerb,
  exactLifecycleCommandVerb,
  HOST_IDENTITY_PROVIDERS,
  type HookHostIdentityProvider,
  type HookHostIdentityResolution,
  type HookHostIdentityStatus,
  inspectExactLifecycleCommand,
  MAX_HOOK_HOST_IDENTITY_UTF8_BYTES,
  resolveHookHostIdentity,
  rewriteExactLifecycleCommand,
} from "./host-session-identity.js";
export {
  hookApplyPatchBodyPaths,
  hookMcpArgsText,
  hookMutationTargetPaths,
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
export { applyPatchMutationPaths, parseHookStdin, stripUtf8Bom } from "./stdin.js";
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
