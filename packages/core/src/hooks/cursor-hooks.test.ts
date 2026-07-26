import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { ritualStatePath } from "../session/ritual-sentinel.js";
import { APPLY_PATCH_HOOK_MATCHER } from "./cursor-hooks.js";
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

describe("cursor hook projection", () => {
  it("uses the shared direct-write matcher for ApplyPatch", () => {
    expect(APPLY_PATCH_HOOK_MATCHER).toBe("ApplyPatch|apply_patch");
    expect(DIRECT_WRITE_HOOK_MATCHER).toContain("ApplyPatch");
  });

  it("deposits one direct-write hook and removes a legacy adapter", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const hooksJson = readFileSync(join(root, ".cursor/hooks.json"), "utf8");

    expect(existsSync(join(root, ".cursor/hooks/deft-cursor-hook-adapter.mjs"))).toBe(false);
    expect(hooksJson).toContain(`"matcher": "${DIRECT_WRITE_HOOK_MATCHER}"`);
  });

  it.skipIf(process.platform !== "win32")(
    "avoids Windows C:\\C:\\ ritual paths when payload carries a drive-only root",
    () => {
      const fallback = "C:\\Repos\\deft\\statusreport";
      const resolved = projectRootFromHookPayload({ workspace_roots: ["C:"], cwd: "C:" }, fallback);
      expect(resolved).toBe(resolve(fallback));
      expect(ritualStatePath(resolved)).toBe(join(resolve(fallback), ".deft", "ritual-state.json"));
      expect(ritualStatePath(resolved)).not.toMatch(/[A-Za-z]:\\[A-Za-z]:\\/i);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "resolves statusreport-shaped Write payloads without C:\\c:\\ doubling (#2787)",
    () => {
      const fallback = "C:\\Repos\\deft\\statusreport";
      const payload = {
        tool_name: "Write",
        workspace_root: "C:",
        cwd: "c:\\Repos\\deft\\statusreport",
        workspace_roots: ["C:", "c:\\Repos\\deft\\statusreport"],
      };
      const root = projectRootFromHookPayload(payload, fallback);
      expect(root).toBe(resolve(fallback));
      expect(ritualStatePath(root)).toBe(join(resolve(fallback), ".deft", "ritual-state.json"));
      expect(ritualStatePath(root)).not.toMatch(/[A-Za-z]:\\[A-Za-z]:\\/i);
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

  it("leaves fast hook deposit byte-idempotent on repeat refresh", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const first = readFileSync(join(root, ".cursor/hooks.json"), "utf8");
    const second = writeAgentHookDeposit(root);
    expect(second.changed).toBe(false);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toBe(first);
  });

  it("removes a legacy adapter even when hooks.json is already current", () => {
    const root = project();
    writeAgentHookDeposit(root);
    writeAgentHookDeposit(root);
    const adapterPath = join(root, ".cursor/hooks/deft-cursor-hook-adapter.mjs");
    mkdirSync(join(root, ".cursor", "hooks"), { recursive: true });
    writeFileSync(adapterPath, "// stale adapter\n", "utf8");
    const refreshed = writeAgentHookDeposit(root);
    expect(refreshed.changed).toBe(true);
    expect(existsSync(adapterPath)).toBe(false);
  });

  it("removes legacy adapter and companion test on refresh (#2838)", () => {
    const root = project();
    const hooksDir = join(root, ".cursor", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const adapterPath = join(hooksDir, "deft-cursor-hook-adapter.mjs");
    const adapterTestPath = join(hooksDir, "deft-cursor-hook-adapter.test.mjs");
    writeFileSync(adapterPath, "export const removed = true;\n", "utf8");
    writeFileSync(
      adapterTestPath,
      "import { removed } from './deft-cursor-hook-adapter.mjs';\n",
      "utf8",
    );

    writeAgentHookDeposit(root);
    const hooksJson = readFileSync(join(root, ".cursor/hooks.json"), "utf8");

    expect(existsSync(adapterPath)).toBe(false);
    expect(existsSync(adapterTestPath)).toBe(false);
    expect(hooksJson).toContain(`"matcher": "${DIRECT_WRITE_HOOK_MATCHER}"`);
    expect(hooksJson).toContain("--host cursor --event tool.before");
  });
});
