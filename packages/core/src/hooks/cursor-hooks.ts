import { DIRECT_WRITE_TOOL_NAMES } from "./tools.js";

/** Cursor ApplyPatch spellings handled by the project adapter, not generic write dispatch. */
export const APPLY_PATCH_TOOL_NAMES = ["ApplyPatch", "apply_patch"] as const;
export const APPLY_PATCH_HOOK_MATCHER = APPLY_PATCH_TOOL_NAMES.join("|");

const APPLY_PATCH_TOOLS = new Set<string>(APPLY_PATCH_TOOL_NAMES);

/** Generic Cursor write matcher excludes ApplyPatch — adapter owns it (#2764). */
export const CURSOR_GENERIC_WRITE_TOOL_NAMES = DIRECT_WRITE_TOOL_NAMES.filter(
  (name) => !APPLY_PATCH_TOOLS.has(name),
);
export const CURSOR_GENERIC_WRITE_HOOK_MATCHER = CURSOR_GENERIC_WRITE_TOOL_NAMES.join("|");

export const CURSOR_APPLY_PATCH_ADAPTER_RELATIVE = ".cursor/hooks/deft-cursor-hook-adapter.mjs";
export const DEFT_CURSOR_ADAPTER_COMMAND_MARKER = "deft-cursor-hook-adapter.mjs";
export const CURSOR_APPLY_PATCH_ADAPTER_COMMAND = `node ${CURSOR_APPLY_PATCH_ADAPTER_RELATIVE} ApplyPatch`;

/** Deposited adapter forwards free-form ApplyPatch stdin to hook:dispatch with explicit project root. */
export const CURSOR_APPLY_PATCH_ADAPTER_SOURCE = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(process.cwd());
const stdin = readFileSync(0, "utf8");

function deftCommand() {
  for (const candidate of ["deft", "directive"]) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (probe.error === undefined && probe.status === 0) return candidate;
  }
  process.stderr.write(
    "Directive ApplyPatch adapter: neither deft nor directive is on PATH.\\n",
  );
  process.exit(2);
}

const cli = deftCommand();
const result = spawnSync(
  cli,
  [
    "hook:dispatch",
    "--host",
    "cursor",
    "--event",
    "tool.before",
    "--project-root",
    projectRoot,
  ],
  {
    input: stdin,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  process.stderr.write(String(result.error));
  process.exit(2);
}
if (result.status !== 0 && result.status !== null) {
  process.exit(result.status);
}
process.exit(0);
`;

export interface CursorPreToolUseEntry {
  readonly command: string;
  readonly matcher?: string;
  readonly failClosed?: boolean;
  readonly timeout?: number;
}

export function cursorApplyPatchAdapterEntry(): CursorPreToolUseEntry {
  return {
    command: CURSOR_APPLY_PATCH_ADAPTER_COMMAND,
    matcher: APPLY_PATCH_HOOK_MATCHER,
    failClosed: true,
    timeout: 5,
  };
}

/** True when generic and adapter matchers share no tool tokens. */
export function cursorApplyPatchMatchersDisjoint(): boolean {
  const generic = new Set(CURSOR_GENERIC_WRITE_HOOK_MATCHER.split("|"));
  for (const token of APPLY_PATCH_HOOK_MATCHER.split("|")) {
    if (generic.has(token)) return false;
  }
  return true;
}

/** Fail closed when Cursor hook projection would double-dispatch ApplyPatch (#2764). */
export function assertCursorApplyPatchMatchersDisjoint(): void {
  if (!cursorApplyPatchMatchersDisjoint()) {
    throw new Error(
      "Cursor ApplyPatch and generic direct-write matchers overlap — refusing hook deposit (#2764).",
    );
  }
}
