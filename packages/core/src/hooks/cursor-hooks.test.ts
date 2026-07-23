import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFT_CURSOR_ADAPTER_COMMAND_MARKER,
  writeAgentHookDeposit,
} from "../init-deposit/agent-hooks.js";
import { ritualStatePath } from "../session/ritual-sentinel.js";
import {
  APPLY_PATCH_HOOK_MATCHER,
  assertCursorApplyPatchMatchersDisjoint,
  CURSOR_APPLY_PATCH_ADAPTER_COMMAND,
  CURSOR_APPLY_PATCH_ADAPTER_RELATIVE,
  CURSOR_APPLY_PATCH_ADAPTER_SOURCE,
  CURSOR_GENERIC_WRITE_HOOK_MATCHER,
  cursorApplyPatchAdapterEntry,
  cursorApplyPatchMatchersDisjoint,
} from "./cursor-hooks.js";
import { projectRootFromHookPayload } from "./dispatcher.js";
import { DIRECT_WRITE_HOOK_MATCHER } from "./tools.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cursor-hooks-"));
  temps.push(root);
  return root;
}

describe("cursor hook projection (#2764)", () => {
  it("keeps ApplyPatch out of the generic Cursor write matcher", () => {
    assertCursorApplyPatchMatchersDisjoint();
    expect(cursorApplyPatchMatchersDisjoint()).toBe(true);
    expect(CURSOR_GENERIC_WRITE_HOOK_MATCHER).not.toContain("ApplyPatch");
    expect(CURSOR_GENERIC_WRITE_HOOK_MATCHER).not.toContain("apply_patch");
    expect(APPLY_PATCH_HOOK_MATCHER).toBe("ApplyPatch|apply_patch");
    expect(DIRECT_WRITE_HOOK_MATCHER).toContain("ApplyPatch");
  });

  it("builds the adapter preToolUse entry expected by hooks.json", () => {
    expect(cursorApplyPatchAdapterEntry()).toEqual({
      command: CURSOR_APPLY_PATCH_ADAPTER_COMMAND,
      matcher: APPLY_PATCH_HOOK_MATCHER,
      failClosed: true,
      timeout: 5,
    });
    expect(CURSOR_APPLY_PATCH_ADAPTER_COMMAND).toContain(DEFT_CURSOR_ADAPTER_COMMAND_MARKER);
  });

  it("deposits adapter script and disjoint matchers into .cursor/hooks.json", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const hooksJson = readFileSync(join(root, ".cursor/hooks.json"), "utf8");
    const adapterPath = join(root, CURSOR_APPLY_PATCH_ADAPTER_RELATIVE);

    expect(existsSync(adapterPath)).toBe(true);
    expect(readFileSync(adapterPath, "utf8")).toBe(CURSOR_APPLY_PATCH_ADAPTER_SOURCE);
    expect(hooksJson).toContain(CURSOR_APPLY_PATCH_ADAPTER_COMMAND);
    expect(hooksJson).toContain(CURSOR_GENERIC_WRITE_HOOK_MATCHER);
    expect(hooksJson).not.toMatch(
      new RegExp(
        `"matcher": "${CURSOR_GENERIC_WRITE_HOOK_MATCHER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*ApplyPatch`,
      ),
    );
    expect(hooksJson).toContain('"matcher": "ApplyPatch|apply_patch"');
  });

  it.skipIf(process.platform !== "win32")(
    "avoids Windows C:\\C:\\ ritual paths when payload carries a drive-only root",
    () => {
      const fallback = "C:\\Users\\nicol\\OneDrive\\Documents\\Projects\\Aperture";
      const resolved = projectRootFromHookPayload({ workspace_roots: ["C:"], cwd: "C:" }, fallback);
      expect(resolved).toBe(resolve(fallback));
      expect(ritualStatePath(resolved)).toBe(join(resolve(fallback), ".deft", "ritual-state.json"));
      expect(ritualStatePath(resolved)).not.toContain("C:\\C:\\");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "treats trailing-backslash drive roots as drive-only on Windows",
    () => {
      const fallback = "C:\\Users\\nicol\\OneDrive\\Documents\\Projects\\Aperture";
      expect(projectRootFromHookPayload({ workspace_root: "C:\\" }, fallback)).toBe(
        resolve(fallback),
      );
      expect(projectRootFromHookPayload({ workspace_root: "C:/" }, fallback)).toBe(
        resolve(fallback),
      );
    },
  );

  it("leaves adapter deposit byte-idempotent on repeat refresh", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const first = readFileSync(join(root, CURSOR_APPLY_PATCH_ADAPTER_RELATIVE), "utf8");
    const second = writeAgentHookDeposit(root);
    expect(second.changed).toBe(false);
    expect(readFileSync(join(root, CURSOR_APPLY_PATCH_ADAPTER_RELATIVE), "utf8")).toBe(first);
  });

  it("rewrites a drifted adapter script even when hooks.json is already current", () => {
    const root = project();
    writeAgentHookDeposit(root);
    writeAgentHookDeposit(root);
    const adapterPath = join(root, CURSOR_APPLY_PATCH_ADAPTER_RELATIVE);
    writeFileSync(adapterPath, "// stale adapter\n", "utf8");
    const refreshed = writeAgentHookDeposit(root);
    expect(refreshed.changed).toBe(true);
    expect(readFileSync(adapterPath, "utf8")).toBe(CURSOR_APPLY_PATCH_ADAPTER_SOURCE);
  });
});
