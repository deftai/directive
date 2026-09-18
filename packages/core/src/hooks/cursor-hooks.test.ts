import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_HOOK_PATHS,
  inspectAgentHookDeposit,
  writeAgentHookDeposit,
} from "../init-deposit/agent-hooks.js";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import { ritualStatePath } from "../session/ritual-sentinel.js";
import { WRITE_GATED_EXECUTE_STEPS } from "../session/session-start.js";
import { evaluateAgentHookReadiness } from "../verify-env/agent-hook-readiness.js";
import {
  AGENT_HOOK_NO_SWAP_RECOVERY,
  evaluateAgentHooks,
  repairAgentHookRegistrations,
} from "../verify-env/agent-hooks.js";
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

describe("writeAgentHookDeposit no-swap recovery (#4716)", () => {
  function driftCursor(root: string): void {
    const hookPath = join(root, ".cursor/hooks.json");
    const parsed = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    const first = parsed.hooks.preToolUse[0];
    if (!first) throw new Error("missing preToolUse");
    first.matcher = "drifted-matcher";
    writeFileSync(hookPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  it("keeps structural missing and drifted fail-closed", () => {
    const missing = evaluateAgentHooks(project());
    expect(missing.code).toBe(1);
    expect(missing.registrations.every((entry) => entry.status === "missing")).toBe(true);
    expect(missing.message).not.toMatch(/treat .* as a warning/i);

    const root = project();
    writeAgentHookDeposit(root);
    driftCursor(root);
    const drifted = evaluateAgentHooks(root);
    expect(drifted.code).toBe(1);
    expect(drifted.registrations.find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
    });
  });

  it("repairs all still-enabled hosts without runRefreshDeposit file-swap", () => {
    const root = project();
    writeAgentHookDeposit(root);
    driftCursor(root);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), "{}\n", "utf8");

    const repaired = repairAgentHookRegistrations(root, {
      reevaluate: (next) => evaluateAgentHooks(next),
    });
    expect(existsSync(join(root, ".deft/core"))).toBe(false);
    expect(repaired.written.changed).toBe(true);
    expect(repaired.after.code).toBe(0);
    expect(inspectAgentHookDeposit(root).every((entry) => entry.status === "healthy")).toBe(true);
    for (const relative of AGENT_HOOK_PATHS) {
      expect(existsSync(join(root, relative))).toBe(true);
    }
  });

  it("writes remaining enabled hosts when one host is opted out", () => {
    const root = project();
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, cursor: false };
    const repaired = repairAgentHookRegistrations(root, {
      hostHooksPolicy: policy,
      reevaluate: (next) => evaluateAgentHooks(next, policy),
    });
    expect(repaired.after.code).toBe(0);
    const inspections = inspectAgentHookDeposit(root, policy);
    expect(inspections.find((entry) => entry.host === "cursor")).toMatchObject({
      status: "disabled",
    });
    expect(
      inspections
        .filter((entry) => entry.host !== "cursor")
        .every((entry) => entry.status === "healthy"),
    ).toBe(true);
    expect(existsSync(join(root, ".cursor/hooks.json"))).toBe(false);
  });

  it("defaults to the live probe after the no-swap write", () => {
    const root = project();
    writeAgentHookDeposit(root);
    driftCursor(root);
    const probe = vi.fn(() => ({
      code: 1 as const,
      message: "live fail",
      hosts: [],
      cases: [],
      durationMs: 1,
    }));
    const repaired = repairAgentHookRegistrations(root, { probeLive: probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(repaired.after.code).toBe(1);
  });

  it("re-runs the existing live probe after the no-swap write", () => {
    const root = project();
    writeAgentHookDeposit(root);
    driftCursor(root);
    const probe = vi.fn(() => ({
      code: 0 as const,
      message: "live green",
      cases: [],
      hosts: (["claude", "grok", "cursor", "codex"] as const).map((host) => ({
        host,
        status: "functional" as const,
      })),
      durationMs: 1,
    }));

    const repaired = repairAgentHookRegistrations(root, {
      reevaluate: (next) =>
        evaluateAgentHookReadiness(next, {
          consumerContext: () => true,
          probeLive: probe,
        }),
    });

    expect(repaired.after.code).toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(
      resolve(root),
      expect.objectContaining({ hosts: ["claude", "grok", "cursor", "codex"] }),
    );
  });

  it("names writeAgentHookDeposit and discloses update file-swap on the recovery line", () => {
    const result = evaluateAgentHooks(project());
    expect(result.message).toContain(AGENT_HOOK_NO_SWAP_RECOVERY);
    expect(result.message).toContain("writeAgentHookDeposit");
    expect(result.message).toContain("does not swap `.deft/core`");
    expect(result.message).toContain("verify:hooks-installed --scope=agent --live");
    expect(result.message).toContain("repo-wide payload file-swap");
    expect(result.message).toContain("deft update");
    expect(result.message).toContain("directive init");
    expect(result.message).not.toMatch(/treat .* as a warning/i);
  });

  it("does not add doctor to WRITE_GATED_EXECUTE_STEPS", () => {
    expect(WRITE_GATED_EXECUTE_STEPS).toEqual(["agent_hooks"]);
    expect(WRITE_GATED_EXECUTE_STEPS).not.toContain("doctor");
  });
});
