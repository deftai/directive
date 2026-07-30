/**
 * Shared host × OS × tool fixture corpus skeleton (#2950 Phase A).
 *
 * Cases are pure data: raw stdin or structured payload → expected classification.
 * Core tests import this module; CLI may re-use the same cases later (Phase C).
 */

import type { ClassifyHookHost, HookWriteIntent } from "../classify/types.js";

export type FixtureOs = "win32" | "posix";

export type FixtureToolFamily = "Write" | "ApplyPatch" | "Task" | "StrReplace" | "other";

export interface HookFixtureCase {
  readonly id: string;
  readonly host: ClassifyHookHost;
  readonly os: FixtureOs;
  readonly tool: FixtureToolFamily;
  /** Closed-issue tags for the regression class this case freezes. */
  readonly regression: readonly string[];
  /** Structured payload when the host sends JSON. */
  readonly payload?: unknown;
  /** Raw stdin when testing BOM / free-form ApplyPatch parse. */
  readonly raw?: string;
  readonly expected: {
    readonly toolName: string | null;
    readonly writeIntent: HookWriteIntent;
    readonly writeTargetPath: string | null;
    /** When raw is set: after parseHookStdin. */
    readonly stdinEmpty?: boolean;
    readonly parseFailed?: boolean;
  };
  readonly notes?: string;
}

const freeFormAddPosix = [
  "*** Begin Patch",
  "*** Add File: xbrief/proposed/_probe-applypatch-only.txt",
  "+probe",
  "*** End Patch",
].join("\n");

const freeFormUpdateWin32 = [
  "*** Begin Patch",
  "*** Update File: src\\example.ts",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

/**
 * Phase A skeleton: Cursor × {win32, posix} × {Write, ApplyPatch, Task}
 * plus recent regression classes (BOM, free-form, missing tool name, outside-root).
 */
export const HOOK_FIXTURE_CASES: readonly HookFixtureCase[] = [
  // --- Cursor × posix × Write ---
  {
    id: "cursor-posix-write-structured",
    host: "cursor",
    os: "posix",
    tool: "Write",
    regression: ["#2669", "#2950"],
    payload: {
      tool_name: "Write",
      tool_input: { contents: "hello", path: "src/a.ts" },
      cwd: "/project",
    },
    expected: {
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "src/a.ts",
    },
  },
  {
    id: "cursor-posix-write-infer-name",
    host: "cursor",
    os: "posix",
    tool: "Write",
    regression: ["#2628", "#2669"],
    payload: {
      arguments: { contents: "x", path: "a.py" },
    },
    expected: {
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "a.py",
    },
    notes: "Cursor omits tool_name; infer from contents+path",
  },
  {
    id: "cursor-posix-write-outside-root",
    host: "cursor",
    os: "posix",
    tool: "Write",
    regression: ["#2885"],
    payload: {
      tool_name: "Write",
      tool_input: {
        file_path: "/home/user/.claude/projects/slug/memory/note.md",
      },
      cwd: "/project",
    },
    expected: {
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "/home/user/.claude/projects/slug/memory/note.md",
    },
  },

  // --- Cursor × win32 × Write ---
  {
    id: "cursor-win32-write-structured",
    host: "cursor",
    os: "win32",
    tool: "Write",
    regression: ["#2787", "#2950"],
    payload: {
      tool_name: "Write",
      tool_input: {
        contents: "x",
        path: "C:\\Repos\\deft\\statusreport\\src\\a.ts",
      },
      workspace_roots: ["C:\\Repos\\deft\\statusreport"],
    },
    expected: {
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "C:\\Repos\\deft\\statusreport\\src\\a.ts",
    },
  },
  {
    id: "cursor-win32-write-statusreport-shape",
    host: "cursor",
    os: "win32",
    tool: "Write",
    regression: ["#2787"],
    payload: {
      tool_name: "Write",
      tool_input: { content: "x", file_path: "notes.md" },
      workspace_roots: ["C:\\Repos\\deft\\statusreport"],
      cwd: "C:\\Repos\\deft\\statusreport",
    },
    expected: {
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "notes.md",
    },
    notes: "Ritual-root normalization is dispatcher-owned; classify keeps raw path",
  },
  {
    id: "cursor-win32-write-bom-raw",
    host: "cursor",
    os: "win32",
    tool: "Write",
    regression: ["#2734"],
    raw: `\uFEFF${JSON.stringify({
      tool_name: "Write",
      tool_input: { content: "x", file_path: "a.txt" },
      workspace_roots: ["C:\\\\Repos\\\\deft"],
    })}`,
    expected: {
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "a.txt",
      stdinEmpty: false,
      parseFailed: false,
    },
  },

  // --- Cursor × posix × ApplyPatch ---
  {
    id: "cursor-posix-applypatch-structured",
    host: "cursor",
    os: "posix",
    tool: "ApplyPatch",
    regression: ["#2738", "#2790"],
    payload: {
      tool_name: "ApplyPatch",
      tool_input: {
        path: "xbrief/proposed/a.xbrief.json",
        patch: "*** Begin Patch\n*** Add File: x\n+probe\n*** End Patch",
      },
    },
    expected: {
      toolName: "ApplyPatch",
      writeIntent: "direct-write",
      writeTargetPath: "xbrief/proposed/a.xbrief.json",
    },
  },
  {
    id: "cursor-posix-applypatch-freeform",
    host: "cursor",
    os: "posix",
    tool: "ApplyPatch",
    regression: ["#2738"],
    raw: freeFormAddPosix,
    expected: {
      toolName: "ApplyPatch",
      writeIntent: "direct-write",
      writeTargetPath: "xbrief/proposed/_probe-applypatch-only.txt",
      parseFailed: false,
    },
  },
  {
    id: "cursor-posix-applypatch-infer-from-patch-field",
    host: "cursor",
    os: "posix",
    tool: "ApplyPatch",
    regression: ["#2669"],
    payload: {
      tool_input: { path: "src/a.ts", patch: "diff" },
    },
    expected: {
      toolName: "ApplyPatch",
      writeIntent: "direct-write",
      writeTargetPath: "src/a.ts",
    },
  },

  // --- Cursor × win32 × ApplyPatch ---
  {
    id: "cursor-win32-applypatch-structured",
    host: "cursor",
    os: "win32",
    tool: "ApplyPatch",
    regression: ["#2738", "#2790"],
    payload: {
      tool_name: "ApplyPatch",
      tool_input: {
        path: "C:\\Repos\\proj\\src\\a.ts",
        patch: "*** Begin Patch",
      },
      workspace_roots: ["C:\\Repos\\proj"],
    },
    expected: {
      toolName: "ApplyPatch",
      writeIntent: "direct-write",
      writeTargetPath: "C:\\Repos\\proj\\src\\a.ts",
    },
  },
  {
    id: "cursor-win32-applypatch-freeform",
    host: "cursor",
    os: "win32",
    tool: "ApplyPatch",
    regression: ["#2738"],
    raw: freeFormUpdateWin32,
    expected: {
      toolName: "ApplyPatch",
      writeIntent: "direct-write",
      writeTargetPath: "src\\example.ts",
      parseFailed: false,
    },
  },

  // --- Cursor × posix × Task ---
  {
    id: "cursor-posix-task-spawn",
    host: "cursor",
    os: "posix",
    tool: "Task",
    regression: ["#1185", "#2864", "#2950"],
    payload: {
      tool_name: "Task",
      tool_input: { description: "explore", prompt: "scan hooks" },
      cwd: "/project",
    },
    expected: {
      toolName: "Task",
      writeIntent: "spawn",
      writeTargetPath: null,
    },
  },

  // --- Cursor × win32 × Task ---
  {
    id: "cursor-win32-task-spawn",
    host: "cursor",
    os: "win32",
    tool: "Task",
    regression: ["#1185", "#2864", "#2950"],
    payload: {
      tool_name: "Task",
      tool_input: { description: "implement", prompt: "fix write path" },
      workspace_roots: ["C:\\Repos\\deft\\statusreport"],
    },
    expected: {
      toolName: "Task",
      writeIntent: "spawn",
      writeTargetPath: null,
    },
  },

  // --- Regression: empty / missing tool name ---
  {
    id: "cursor-posix-stdin-empty",
    host: "cursor",
    os: "posix",
    tool: "other",
    regression: ["#2864"],
    raw: "",
    expected: {
      toolName: null,
      writeIntent: "unknown",
      writeTargetPath: null,
      stdinEmpty: true,
    },
  },
  {
    id: "cursor-posix-missing-tool-name-keys",
    host: "cursor",
    os: "posix",
    tool: "other",
    regression: ["#2669", "#2864"],
    payload: { host_version: "1.2.3" },
    expected: {
      toolName: null,
      writeIntent: "unknown",
      writeTargetPath: null,
    },
  },
  {
    id: "cursor-posix-applypatch-multifile-fail-closed",
    host: "cursor",
    os: "posix",
    tool: "ApplyPatch",
    regression: ["#2738"],
    raw: [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+a",
      "*** Add File: b.txt",
      "+b",
      "*** End Patch",
    ].join("\n"),
    expected: {
      toolName: null,
      writeIntent: "unknown",
      writeTargetPath: null,
      parseFailed: true,
    },
  },
];

export function fixtureCasesFor(filter: {
  host?: ClassifyHookHost;
  os?: FixtureOs;
  tool?: FixtureToolFamily;
}): HookFixtureCase[] {
  return HOOK_FIXTURE_CASES.filter((c) => {
    if (filter.host !== undefined && c.host !== filter.host) return false;
    if (filter.os !== undefined && c.os !== filter.os) return false;
    if (filter.tool !== undefined && c.tool !== filter.tool) return false;
    return true;
  });
}
