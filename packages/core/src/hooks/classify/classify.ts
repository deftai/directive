/**
 * Pure classify entry: payload → tool identity + write intent + paths (#2950 Phase A).
 * No process I/O, no ritual/scope/policy evaluation.
 */

import { isDirectWriteTool, isMcpTool, isShellTool, isSpawnTool } from "../tools.js";
import { hookPathSet, hookShellCommand, hookWriteTargetPath } from "./paths.js";
import { hookPayloadTopLevelKeys } from "./payload.js";
import { hookToolName } from "./tool-name.js";
import type { ClassifyHookPayloadInput, HookClassification, HookWriteIntent } from "./types.js";

function writeIntentForTool(toolName: string | null): HookWriteIntent {
  if (toolName === null) return "unknown";
  if (isDirectWriteTool(toolName)) return "direct-write";
  if (isSpawnTool(toolName)) return "spawn";
  if (isShellTool(toolName)) return "shell";
  if (isMcpTool(toolName)) return "mcp";
  return "other";
}

/**
 * Classify a host hook payload without policy or filesystem access.
 */
export function classifyHookPayload(input: ClassifyHookPayloadInput): HookClassification {
  const toolName = hookToolName(input.payload, input.host);
  const writeTargetPath = hookWriteTargetPath(input.payload);
  return {
    toolName,
    writeIntent: writeIntentForTool(toolName),
    writeTargetPath,
    shellCommand: hookShellCommand(input.payload),
    topLevelKeys: hookPayloadTopLevelKeys(input.payload),
    paths: hookPathSet(input.payload),
  };
}
