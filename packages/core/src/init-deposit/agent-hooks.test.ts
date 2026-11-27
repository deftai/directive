import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
// readdirSync used below
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAgyActivation } from "../doctor/checks.js";
import { runWithMutationLedger, snapshotMutationSummary } from "../fs/mutation-ledger.js";
import { AGY_DIRECTIVE_HOOK_NAME } from "../hooks/classify/agy-hook-order.js";
import {
  AGY_ADMISSION_VERDICT,
  type AgyAdmissionVerdict,
  agyActivationAdmitted,
} from "../hooks/classify/agy-observation.js";
import {
  DIRECT_WRITE_TOOL_NAMES,
  GROK_MUTATION_TOOL_CATALOG,
  isDirectWriteTool,
  isSpawnTool,
  SPAWN_TOOL_NAMES,
} from "../hooks/tools.js";
import {
  DEFAULT_HOST_HOOKS_POLICY,
  disableHostHooks,
  HOST_HOOKS_REMOVED_PRINTF_REFUSAL_CAN_CLEAR,
} from "../policy/host-hooks.js";
import {
  AGENT_HOOK_PATHS,
  AGY_ACTIVATION_HALT_DETAIL,
  agyActivationWiring,
  agyDepositAdmitted,
  CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
  CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
  DIRECT_WRITE_HOOK_MATCHER,
  evaluateGrokPretooluseWrapperOutcome,
  GROK_PRETOOLUSE_WRAPPER_COMMAND,
  GROK_PRETOOLUSE_WRAPPER_MARKER,
  GROK_PRETOOLUSE_WRAPPER_REL_PATH,
  GROK_WRAPPER_DENY_MISSING,
  GROK_WRAPPER_DENY_NONDECISION,
  grokPretooluseWrapperScriptSource,
  inspectAgentHookDeposit,
  inspectSessionStartNotice,
  isGrokWrapperCommand,
  MCP_HOOK_MATCHER,
  NESTED_HOOK_TIMEOUT_SECONDS,
  NESTED_TOOL_BEFORE_TIMEOUT_SECONDS,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
  writeAgentHookDeposit,
} from "./agent-hooks.js";
import {
  hostHookEntryPrefix,
  hostHookEntryText,
  hostHookOuterFileName,
  hostHookOuterSha8,
  hostHookOuterSource,
  isManagedAgyHookEntry,
} from "./host-hook-outer.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(options: { withRuntime?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agent-hooks-"));
  temps.push(root);
  // Default: stub local runtime so deposit prefers package-relative (AC9.1).
  if (options.withRuntime !== false) {
    const hookBin = join(
      root,
      "node_modules",
      "@deftai",
      "directive-runtime",
      "dist",
      "hook-bin.js",
    );
    mkdirSync(join(hookBin, ".."), { recursive: true });
    writeFileSync(hookBin, "// stub\n", "utf8");
  }
  return root;
}

function writeProjectDefinition(root: string, hostHooks: Record<string, boolean>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ plan: { policy: { hostHooks } } }, null, 2)}\n`,
    "utf8",
  );
}

function expectedOuterCmd(host: "claude" | "grok" | "cursor" | "codex", event: string): string {
  return `${hostHookEntryPrefix(host, hostHookOuterSha8())} --host ${host} --event ${event}`;
}

/** Text form of every hook entry in a host config (no-shell entries included). */
function entryTexts(path: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const text = hostHookEntryText(value);
    if (text !== null) out.push(text);
    for (const child of Object.values(value)) walk(child);
  };
  walk(JSON.parse(readFileSync(path, "utf8")));
  return out;
}

describe("writeAgentHookDeposit", () => {
  it("deposits a Claude-only SessionEnd -> session.end hook and reports it (#6274)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const claude = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
      hooks: { SessionEnd?: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    expect(claude.hooks.SessionEnd).toHaveLength(1);
    expect(claude.hooks.SessionEnd?.[0]?.matcher).toBeUndefined();
    expect(hostHookEntryText(claude.hooks.SessionEnd?.[0]?.hooks[0])).toBe(
      expectedOuterCmd("claude", "session.end"),
    );
    for (const path of [".grok/hooks/deft.json", ".cursor/hooks.json", ".codex/hooks.json"]) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text).not.toContain("session.end");
      expect(text).not.toContain("SessionEnd");
    }
    const inspected = inspectAgentHookDeposit(root);
    expect(inspected.find((entry) => entry.host === "claude")).toMatchObject({
      status: "healthy",
      sessionEndSupport: "deposited",
      sessionEndRegistered: true,
    });
    for (const host of ["grok", "cursor", "codex"] as const) {
      expect(inspected.find((entry) => entry.host === host)).toMatchObject({
        sessionEndSupport: "unsupported",
        sessionEndRegistered: null,
      });
    }

    // Absence is best-effort: reported, but the registration stays healthy.
    const path = join(root, ".claude/settings.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, unknown> };
    delete parsed.hooks.SessionEnd;
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")).toMatchObject({
      status: "healthy",
      sessionEndRegistered: false,
    });

    // A restrictive matcher on the managed entry is not reported as registered.
    writeAgentHookDeposit(root);
    const narrowed = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: { SessionEnd: Array<Record<string, unknown>> };
    };
    narrowed.hooks.SessionEnd[0] = { ...narrowed.hooks.SessionEnd[0], matcher: "logout" };
    writeFileSync(path, `${JSON.stringify(narrowed, null, 2)}\n`, "utf8");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")).toMatchObject({
      sessionEndRegistered: false,
    });

    // A user's own SessionEnd command sharing the managed group survives redeposit (Greptile P1).
    const shared = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: { SessionEnd: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    shared.hooks.SessionEnd[0]?.hooks.push({ type: "command", command: "node user-cleanup.mjs" });
    writeFileSync(path, `${JSON.stringify(shared, null, 2)}\n`, "utf8");
    writeAgentHookDeposit(root);
    const afterShared = readFileSync(path, "utf8");
    expect(afterShared).toContain("node user-cleanup.mjs");
    expect(
      entryTexts(path).filter((text) => text === expectedOuterCmd("claude", "session.end")),
    ).toHaveLength(1);
    // Opting Claude out strips only the managed command, never the user's.
    writeProjectDefinition(root, { claude: false });
    writeAgentHookDeposit(root);
    const stripped = readFileSync(path, "utf8");
    expect(stripped).toContain("node user-cleanup.mjs");
    expect(stripped).not.toContain("session.end");
    rmSync(join(root, "xbrief"), { recursive: true, force: true });
    const reset = JSON.parse(stripped) as { hooks: Record<string, unknown> };
    delete reset.hooks.SessionEnd;
    writeFileSync(path, `${JSON.stringify(reset, null, 2)}\n`, "utf8");

    // Redeposit restores exactly one managed SessionEnd entry.
    writeAgentHookDeposit(root);
    writeAgentHookDeposit(root);
    const again = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: { SessionEnd?: unknown[] };
    };
    expect(again.hooks.SessionEnd).toHaveLength(1);
  });

  it("deposits one Claude-only UserPromptSubmit -> prompt.submit group and keeps a user's own (#7420)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const path = join(root, ".claude/settings.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: {
        UserPromptSubmit?: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>;
      };
    };
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit?.[0]?.matcher).toBeUndefined();
    expect(hostHookEntryText(parsed.hooks.UserPromptSubmit?.[0]?.hooks[0])).toBe(
      expectedOuterCmd("claude", "prompt.submit"),
    );
    for (const other of [".grok/hooks/deft.json", ".cursor/hooks.json", ".codex/hooks.json"]) {
      expect(readFileSync(join(root, other), "utf8")).not.toContain("UserPromptSubmit");
    }
    // Repair is idempotent and keeps a user's own UserPromptSubmit group.
    const withUser = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: { UserPromptSubmit: unknown[] };
    };
    withUser.hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command: "node user-prompt.mjs" }],
    });
    writeFileSync(
      path,
      `${JSON.stringify(withUser, null, 2)}
`,
      "utf8",
    );
    writeAgentHookDeposit(root);
    writeAgentHookDeposit(root);
    expect(
      entryTexts(path).filter((text) => text === expectedOuterCmd("claude", "prompt.submit")),
    ).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toContain("node user-prompt.mjs");
    // Opting Claude out strips the managed group only.
    writeProjectDefinition(root, { claude: false });
    writeAgentHookDeposit(root);
    const stripped = readFileSync(path, "utf8");
    expect(stripped).toContain("node user-prompt.mjs");
    expect(stripped).not.toContain("prompt.submit");
  });

  it("deposits native Claude, Grok, Cursor, and Codex SessionStart/direct-write hooks", () => {
    const root = project();
    const lines: string[] = [];
    const result = writeAgentHookDeposit(root, { printf: (text) => lines.push(text) });

    expect(result.changed).toBe(true);
    expect(result.changedPaths).toEqual([...AGENT_HOOK_PATHS, ".agents/hooks.json"]);
    expect(entryTexts(join(root, ".claude/settings.json"))).toContain(
      expectedOuterCmd("claude", "tool.before"),
    );
    expect(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")).toContain(
      "--host grok --event session.start",
    );
    const grokHooksPath = join(root, ".grok/hooks/deft.json");
    const grokDeposit = JSON.parse(readFileSync(grokHooksPath, "utf8")) as {
      hooks: {
        SessionStart?: Array<{ hooks?: Array<{ command?: string }> }>;
        PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };
    const preToolCommands = (grokDeposit.hooks.PreToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        typeof hook.command === "string" ? [hook.command] : [],
      ),
    );
    expect(preToolCommands.length).toBeGreaterThan(0);
    const intentionalGrokPreTool = expectedOuterCmd("grok", "tool.before");
    for (const cmd of preToolCommands) {
      expect(cmd).toBe(intentionalGrokPreTool);
      expect(isGrokWrapperCommand(cmd)).toBe(false);
    }
    const sessionCommands = (grokDeposit.hooks.SessionStart ?? []).flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        typeof hook.command === "string" ? [hook.command] : [],
      ),
    );
    expect(sessionCommands.some((cmd) => cmd.includes("--host grok --event session.start"))).toBe(
      true,
    );
    expect(sessionCommands.every((cmd) => !isGrokWrapperCommand(cmd))).toBe(true);
    // #5994: live deposit no longer writes the legacy .sh wrapper.
    expect(existsSync(join(root, GROK_PRETOOLUSE_WRAPPER_REL_PATH))).toBe(false);
    expect(
      readdirSync(join(root, ".grok/hooks")).some(
        (f) => f.startsWith("deft-hook-") && f.endsWith(".mjs"),
      ),
    ).toBe(true);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(
      "--host cursor --event tool.before",
    );
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toContain(
      "--host codex --event tool.before",
    );
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(
      "--host cursor --event session.compact",
    );
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(
      `"matcher": "${DIRECT_WRITE_HOOK_MATCHER}"`,
    );
    expect(existsSync(join(root, ".cursor/hooks/deft-cursor-hook-adapter.mjs"))).toBe(false);
    expect(entryTexts(join(root, ".claude/settings.json"))).toContain(
      expectedOuterCmd("claude", "session.compact"),
    );
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).not.toContain("session.compact");
    expect(DIRECT_WRITE_HOOK_MATCHER.split("|")).toEqual([...DIRECT_WRITE_TOOL_NAMES]);
    expect(SPAWN_HOOK_MATCHER.split("|")).toEqual([...SPAWN_TOOL_NAMES]);
    expect(DIRECT_WRITE_HOOK_MATCHER.split("|").every(isDirectWriteTool)).toBe(true);
    expect(SPAWN_HOOK_MATCHER.split("|").every(isSpawnTool)).toBe(true);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(SPAWN_HOOK_MATCHER);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(SHELL_HOOK_MATCHER);
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain(SHELL_HOOK_MATCHER);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(MCP_HOOK_MATCHER);
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain(MCP_HOOK_MATCHER);
    expect(MCP_HOOK_MATCHER).toContain("mcp__.*");
    expect(MCP_HOOK_MATCHER).toContain("merge_pull_request");
    expect(lines.join("")).toContain("agent hooks");
    expect(inspectAgentHookDeposit(root).every((entry) => entry.status === "healthy")).toBe(true);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "codex")).toMatchObject({
      compactSupport: "unsupported",
    });

    // #3246: Cursor tool.before budget must clear gated ritual + live readiness.
    const cursor = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8")) as {
      hooks: {
        sessionStart: Array<{ timeout?: number }>;
        preToolUse: Array<{
          matcher?: string;
          failClosed?: boolean;
          timeout?: number;
          command?: string;
        }>;
        preCompact: Array<{ timeout?: number }>;
        beforeSubmitPrompt: Array<{ timeout?: number; command?: string; failClosed?: boolean }>;
        afterAgentResponse: Array<{ timeout?: number; command?: string; failClosed?: boolean }>;
      };
    };
    expect(CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(30);
    expect(CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS).toBeGreaterThan(CURSOR_SESSION_HOOK_TIMEOUT_SECONDS);
    for (const entry of cursor.hooks.preToolUse) {
      if (!entry.command?.includes("--host cursor --event tool.before")) continue;
      expect(entry.failClosed).toBe(true);
      expect(entry.timeout).toBe(CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS);
    }
    expect(
      cursor.hooks.sessionStart.some((e) => e.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS),
    ).toBe(true);
    expect(
      cursor.hooks.preCompact.some((e) => e.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS),
    ).toBe(true);
    expect(
      cursor.hooks.beforeSubmitPrompt.some(
        (e) =>
          e.command?.includes("--event prompt.submit") &&
          e.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS &&
          e.failClosed !== true,
      ),
    ).toBe(true);
    expect(
      cursor.hooks.afterAgentResponse.some(
        (e) =>
          e.command?.includes("--event agent.response") &&
          e.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS &&
          e.failClosed !== true,
      ),
    ).toBe(true);
    // Spawn matcher is one of the failClosed preToolUse deposits.
    expect(
      cursor.hooks.preToolUse.some(
        (e) =>
          e.matcher === SPAWN_HOOK_MATCHER &&
          e.failClosed === true &&
          e.timeout === CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
      ),
    ).toBe(true);
    // #3739: nested tool.before shares Cursor's readiness ceiling; session stays at 5s.
    expect(NESTED_TOOL_BEFORE_TIMEOUT_SECONDS).toBe(CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS);
    expect(NESTED_TOOL_BEFORE_TIMEOUT_SECONDS).toBeGreaterThan(NESTED_HOOK_TIMEOUT_SECONDS);
    const nestedHosts = [
      ".claude/settings.json",
      ".grok/hooks/deft.json",
      ".codex/hooks.json",
    ] as const;
    for (const relativePath of nestedHosts) {
      const nested = JSON.parse(readFileSync(join(root, relativePath), "utf8")) as {
        hooks: {
          SessionStart?: Array<{ hooks?: Array<{ timeout?: number }> }>;
          PreToolUse?: Array<{ hooks?: Array<{ timeout?: number }> }>;
          PreCompact?: Array<{ hooks?: Array<{ timeout?: number }> }>;
        };
      };
      expect(
        (nested.hooks.PreToolUse ?? []).every((group) =>
          (group.hooks ?? []).every((h) => h.timeout === NESTED_TOOL_BEFORE_TIMEOUT_SECONDS),
        ),
      ).toBe(true);
      expect(
        (nested.hooks.SessionStart ?? []).every((group) =>
          (group.hooks ?? []).every((h) => h.timeout === NESTED_HOOK_TIMEOUT_SECONDS),
        ),
      ).toBe(true);
      if (nested.hooks.PreCompact !== undefined) {
        expect(
          nested.hooks.PreCompact.every((group) =>
            (group.hooks ?? []).every((h) => h.timeout === NESTED_HOOK_TIMEOUT_SECONDS),
          ),
        ).toBe(true);
      }
    }

    // Cursor + nested PreToolUse budgets align after #3739 (no longer dragged to 5s).
    const nestedTimeouts = nestedHosts.flatMap((relativePath) => {
      const config = JSON.parse(readFileSync(join(root, relativePath), "utf8")) as {
        hooks: { PreToolUse?: Array<{ hooks?: Array<{ timeout?: number }> }> };
      };
      return (config.hooks.PreToolUse ?? []).flatMap((group) =>
        (group.hooks ?? []).flatMap((hook) =>
          typeof hook.timeout === "number" ? [hook.timeout] : [],
        ),
      );
    });
    const cursorTimeouts = cursor.hooks.preToolUse.flatMap((entry) =>
      typeof entry.timeout === "number" ? [entry.timeout] : [],
    );
    const effectiveTimeoutSeconds = Math.min(...cursorTimeouts, ...nestedTimeouts);
    expect(effectiveTimeoutSeconds).toBe(NESTED_TOOL_BEFORE_TIMEOUT_SECONDS);
  });

  it("ledgers adapter deletes even when the writer return is discarded (#3392)", () => {
    const root = project();
    mkdirSync(join(root, ".cursor", "hooks"), { recursive: true });
    writeFileSync(join(root, ".cursor/hooks/deft-cursor-hook-adapter.mjs"), "legacy\n", "utf8");
    writeFileSync(
      join(root, ".cursor/hooks/deft-cursor-hook-adapter.test.mjs"),
      "legacy\n",
      "utf8",
    );

    const summary = runWithMutationLedger(root, () => {
      writeAgentHookDeposit(root);
      return snapshotMutationSummary();
    });

    expect(existsSync(join(root, ".cursor/hooks/deft-cursor-hook-adapter.mjs"))).toBe(false);
    expect(existsSync(join(root, ".cursor/hooks/deft-cursor-hook-adapter.test.mjs"))).toBe(false);
    expect(summary.deleted).toEqual([
      ".cursor/hooks/deft-cursor-hook-adapter.mjs",
      ".cursor/hooks/deft-cursor-hook-adapter.test.mjs",
    ]);
    expect(summary.wrote).toEqual(expect.arrayContaining([...AGENT_HOOK_PATHS]));
    expect(summary.wrote.some((path) => path.includes(".deft-") && path.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("ledgers stripped host-hook opt-out writes (#3392)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };
    const summary = runWithMutationLedger(root, () => {
      writeAgentHookDeposit(root, { printf: () => undefined }, policy);
      return snapshotMutationSummary();
    });
    expect(summary.stripped).toContain(".claude/settings.json");
    expect(summary.wrote).not.toContain(".claude/settings.json");
  });

  it("repairs legacy Cursor tool.before timeout:5 deposits as drifted (#3246)", () => {
    const root = project();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor/hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                command:
                  "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event session.start",
                timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
              },
            ],
            preToolUse: [
              {
                command:
                  "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event tool.before",
                matcher: DIRECT_WRITE_HOOK_MATCHER,
                failClosed: true,
                timeout: 5,
              },
              {
                command:
                  "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event tool.before",
                matcher: SPAWN_HOOK_MATCHER,
                failClosed: true,
                timeout: 5,
              },
              {
                command:
                  "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event tool.before",
                matcher: SHELL_HOOK_MATCHER,
                failClosed: true,
                timeout: 5,
              },
              {
                command:
                  "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event tool.before",
                matcher: MCP_HOOK_MATCHER,
                failClosed: true,
                timeout: 5,
              },
            ],
            preCompact: [
              {
                command:
                  "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event session.compact",
                timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const before = inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor");
    expect(before?.status).toBe("drifted");

    writeAgentHookDeposit(root);
    const after = inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor");
    expect(after?.status).toBe("healthy");
    const repaired = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf8")) as {
      hooks: { preToolUse: Array<{ timeout?: number; matcher?: string }> };
    };
    for (const entry of repaired.hooks.preToolUse) {
      if (entry.matcher === SPAWN_HOOK_MATCHER) {
        expect(entry.timeout).toBe(CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS);
      }
    }
  });

  it("deposits exactly one direct-write matcher for each supported host (#2790)", () => {
    const root = project();
    writeAgentHookDeposit(root);

    for (const path of AGENT_HOOK_PATHS) {
      const deposit = readFileSync(join(root, path), "utf8");
      expect(deposit.split(DIRECT_WRITE_HOOK_MATCHER)).toHaveLength(2);
      expect(
        entryTexts(join(root, path)).some((text) =>
          /node (?:-e <locator> -- )?\S*deft-hook-[a-f0-9]{8}\.mjs --host/.test(text),
        ),
      ).toBe(true);
      expect(deposit).not.toContain("deft-pretooluse-wrapper.sh");
    }
  });

  it("keeps bare deft-hook when local runtime hook-bin is absent (legacy init/refresh)", () => {
    const root = project({ withRuntime: false });
    writeAgentHookDeposit(root);
    const claude = readFileSync(join(root, ".claude/settings.json"), "utf8");
    expect(entryTexts(join(root, ".claude/settings.json"))).toContain(
      expectedOuterCmd("claude", "tool.before"),
    );
    expect(claude).not.toContain("deft-pretooluse-wrapper.sh");
  });

  it("replaces legacy Cursor adapter registrations with one fast direct-write hook", () => {
    const root = project();
    mkdirSync(join(root, ".cursor", "hooks"), { recursive: true });
    writeFileSync(
      join(root, ".cursor/hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              { command: "deft hook:dispatch --host cursor --event session.start", timeout: 5 },
            ],
            preToolUse: [
              {
                command: "deft hook:dispatch --host cursor --event tool.before",
                matcher: DIRECT_WRITE_HOOK_MATCHER,
                failClosed: true,
                timeout: 5,
              },
            ],
            preCompact: [
              { command: "deft hook:dispatch --host cursor --event session.compact", timeout: 5 },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    writeAgentHookDeposit(root);
    const cursor = readFileSync(join(root, ".cursor/hooks.json"), "utf8");
    expect(cursor).toContain(`"matcher": "${DIRECT_WRITE_HOOK_MATCHER}"`);
    expect(cursor).not.toContain("deft-cursor-hook-adapter.mjs");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")?.status).toBe(
      "healthy",
    );
  });

  it("preserves unrelated settings and is byte-idempotent", () => {
    const root = project();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/settings.json"),
      `${JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "./custom-check.sh" }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    writeAgentHookDeposit(root);
    const first = AGENT_HOOK_PATHS.map((path) => readFileSync(join(root, path), "utf8"));
    const secondResult = writeAgentHookDeposit(root);
    const second = AGENT_HOOK_PATHS.map((path) => readFileSync(join(root, path), "utf8"));
    const claude = JSON.parse(second[0] ?? "{}") as Record<string, unknown>;

    expect(secondResult.changed).toBe(false);
    expect(second).toEqual(first);
    expect(claude.permissions).toEqual({ allow: ["Read"] });
    expect(second[0]).toContain("./custom-check.sh");
  });

  it("preserves unrelated Codex hook groups while replacing only Directive-owned entries", () => {
    const root = project();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex/hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "resume",
                hooks: [{ type: "command", command: "./resume-check.sh" }],
              },
            ],
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "./custom-codex-check.sh" }],
              },
              {
                matcher: "stale",
                hooks: [
                  {
                    type: "command",
                    command: "deft hook:dispatch --host codex --event tool.before --old",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    writeAgentHookDeposit(root);
    const codex = readFileSync(join(root, ".codex/hooks.json"), "utf8");

    expect(codex).toContain("./resume-check.sh");
    expect(codex).toContain("./custom-codex-check.sh");
    expect(codex).not.toContain("--old");
    // direct-write + spawn + shell + kill (#5281) + MCP managed PreToolUse groups
    expect(codex.match(/--host codex --event tool\.before/g)).toHaveLength(5);
  });

  it("preserves malformed unrelated nested candidates without treating them as managed", () => {
    const root = project();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex/hooks.json"),
      `${JSON.stringify({
        hooks: {
          SessionStart: [null, { hooks: null }, { hooks: [null, { command: 7 }] }],
          PreToolUse: [],
        },
      })}\n`,
      "utf8",
    );

    writeAgentHookDeposit(root);

    const codex = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(codex.hooks.SessionStart.slice(0, 3)).toEqual([
      null,
      { hooks: null },
      { hooks: [null, { command: 7 }] },
    ]);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "codex")?.status).toBe(
      "healthy",
    );
  });

  it("refuses to overwrite malformed user JSON", () => {
    const root = project();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor/hooks.json"), "{not-json\n", "utf8");

    expect(() => writeAgentHookDeposit(root)).toThrow(/not valid JSON/);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toBe("{not-json\n");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
      detail: expect.stringContaining("not valid JSON"),
    });
    expect(() => readFileSync(join(root, ".claude/settings.json"), "utf8")).toThrow();
    expect(() => readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")).toThrow();
  });

  it("refuses a non-object Codex hooks member before writing any host deposit", () => {
    const root = project();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex/hooks.json"), '{"hooks":[]}\n', "utf8");

    expect(() => writeAgentHookDeposit(root)).toThrow(/hooks must be a JSON object/);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "codex")).toMatchObject({
      status: "drifted",
    });
    for (const path of AGENT_HOOK_PATHS.slice(0, 3)) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  it("refuses a non-array Codex event before writing any host deposit", () => {
    const root = project();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex/hooks.json"), '{"hooks":{"SessionStart":{}}}\n', "utf8");

    expect(() => writeAgentHookDeposit(root)).toThrow(/hooks\.SessionStart must be an array/);
    for (const path of AGENT_HOOK_PATHS.slice(0, 3)) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  it("refuses malformed Codex JSON before writing any host deposit", () => {
    const root = project();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex/hooks.json"), "[]\n", "utf8");

    expect(() => writeAgentHookDeposit(root)).toThrow(/must contain a JSON object/);
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toBe("[]\n");
    for (const path of AGENT_HOOK_PATHS.slice(0, 3)) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a Codex directory symlink escape before writing any host deposit",
    () => {
      const root = project();
      const outside = project();
      symlinkSync(outside, join(root, ".codex"), "dir");

      expect(() => writeAgentHookDeposit(root)).toThrow(/symlink escaping the project tree/);
      for (const path of AGENT_HOOK_PATHS.slice(0, 3)) {
        expect(existsSync(join(root, path))).toBe(false);
      }
      expect(existsSync(join(outside, "hooks.json"))).toBe(false);
    },
  );

  it("skips Claude deposit when plan.policy.hostHooks.claude is false", () => {
    const root = project();
    writeProjectDefinition(root, { claude: false });
    const lines: string[] = [];
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };
    const result = writeAgentHookDeposit(root, { printf: (text) => lines.push(text) }, policy);

    expect(result.changedPaths).not.toContain(".claude/settings.json");
    expect(() => readFileSync(join(root, ".claude/settings.json"), "utf8")).toThrow();
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain(
      "--host cursor --event tool.before",
    );
    expect(lines.join("")).toContain("Installed Directive agent hooks");
  });

  it("writes leftover-free opted-out Directive-only deposits as empty objects (#3571)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const policy = { claude: false, grok: false, cursor: false, codex: false };
    const lines: string[] = [];
    writeAgentHookDeposit(root, { printf: (text) => lines.push(text) }, policy);
    const printed = lines.join("");
    expect(printed).toContain(
      "Removed Directive-managed agent hooks (plan.policy.hostHooks opt-out):",
    );
    const removedRefusal =
      "A hook refusal in the current session can clear because the gate was removed. " +
      "The running host has to reload or relaunch before the refusal clears.";
    expect(HOST_HOOKS_REMOVED_PRINTF_REFUSAL_CAN_CLEAR).toBe(removedRefusal);
    expect(printed).toContain(removedRefusal);
    expect(printed).not.toContain("is clearing");
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toBe("{}\n");
  });

  it("strips managed Claude hooks on update while preserving unrelated settings", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(claudePath, "utf8")) as Record<string, unknown>;
    claude.permissions = { allow: ["Read"] };
    writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");

    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };
    writeAgentHookDeposit(root, { printf: () => undefined }, policy);
    const stripped = readFileSync(claudePath, "utf8");

    expect(stripped).not.toContain("deft hook:dispatch");
    expect(stripped).toContain('"allow"');
    expect(stripped).toContain("Read");
  });

  it("does not recreate Claude settings after deletion when Claude is opted out", () => {
    const root = project();
    writeAgentHookDeposit(root);
    rmSync(join(root, ".claude/settings.json"));
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };

    writeAgentHookDeposit(root, { printf: () => undefined }, policy);

    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  });

  it("strips legacy nested registrations while preserving custom groups", () => {
    const root = project();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/settings.json"),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ command: "./custom-session.sh" }] },
            {
              hooks: [{ command: "deft hook:dispatch --host claude --event session.start" }],
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    const policy = {
      claude: false,
      grok: false,
      cursor: false,
      codex: false,
    };

    writeAgentHookDeposit(root, { printf: () => undefined }, policy);

    const content = readFileSync(join(root, ".claude/settings.json"), "utf8");
    expect(content).toContain("./custom-session.sh");
    expect(content).not.toContain("deft hook:dispatch");
  });

  it("strips legacy Cursor adapters while preserving malformed and custom entries", () => {
    const root = project();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor/hooks.json"),
      `${JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            null,
            { command: "./custom-session.sh" },
            { command: "deft-cursor-hook-adapter.mjs" },
          ],
        },
      })}\n`,
      "utf8",
    );
    const policy = {
      claude: false,
      grok: false,
      cursor: false,
      codex: false,
    };

    writeAgentHookDeposit(root, { printf: () => undefined }, policy);

    const content = readFileSync(join(root, ".cursor/hooks.json"), "utf8");
    expect(content).toContain("./custom-session.sh");
    expect(content).not.toContain("deft-cursor-hook-adapter.mjs");
  });
});

describe("inspectSessionStartNotice", () => {
  it("keeps SessionStart registered when PreToolUse and compact have drifted", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(claudePath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete claude.hooks.PreToolUse;
    delete claude.hooks.PreCompact;
    delete claude.hooks.PostCompact;
    writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")?.status).toBe(
      "drifted",
    );
    expect(inspectSessionStartNotice(root).find((entry) => entry.host === "claude")).toEqual({
      host: "claude",
      registered: true,
    });
  });

  it("reports not registered when hostHooks disables the host", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };
    expect(
      inspectSessionStartNotice(root, policy).find((entry) => entry.host === "claude"),
    ).toEqual({
      host: "claude",
      registered: false,
    });
  });

  it("reports Cursor SessionStart not registered when hooks.json version is missing or not 1", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const cursorPath = join(root, ".cursor/hooks.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      version?: number;
    };
    expect(inspectSessionStartNotice(root).find((entry) => entry.host === "cursor")).toEqual({
      host: "cursor",
      registered: true,
    });

    cursor.version = 2;
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
    expect(inspectSessionStartNotice(root).find((entry) => entry.host === "cursor")).toEqual({
      host: "cursor",
      registered: false,
    });

    delete cursor.version;
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
    expect(inspectSessionStartNotice(root).find((entry) => entry.host === "cursor")).toEqual({
      host: "cursor",
      registered: false,
    });
  });
});

describe("inspectAgentHookDeposit", () => {
  it("distinguishes missing and drifted registrations", () => {
    const root = project();
    expect(inspectAgentHookDeposit(root).map((entry) => entry.status)).toEqual([
      "missing",
      "missing",
      "missing",
      "missing",
      "missing",
    ]);

    writeAgentHookDeposit(root);
    const cursorPath = join(root, ".cursor/hooks.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    cursor.hooks.preToolUse[0] = { command: "echo bypass", matcher: "Edit" };
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
    });
  });

  it("reports opted-out Claude host as intentionally disabled without requiring deposit", () => {
    const root = project();
    writeProjectDefinition(root, { claude: false });
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };

    expect(
      inspectAgentHookDeposit(root, policy).find((entry) => entry.host === "claude"),
    ).toMatchObject({
      status: "disabled",
      detail: expect.stringContaining("hostHooks.claude is false"),
    });
  });

  it("marks Cursor registration drifted when the direct-write matcher excludes ApplyPatch", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const cursorPath = join(root, ".cursor/hooks.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    cursor.hooks.preToolUse = cursor.hooks.preToolUse.map((entry) =>
      entry.matcher === DIRECT_WRITE_HOOK_MATCHER
        ? { ...entry, matcher: DIRECT_WRITE_HOOK_MATCHER.replace("|ApplyPatch|apply_patch", "") }
        : entry,
    );
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
    });
  });

  it("marks Cursor registration drifted when its direct-write entry is missing", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const cursorPath = join(root, ".cursor/hooks.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      hooks: { preToolUse: Array<Record<string, unknown>> };
    };
    cursor.hooks.preToolUse = cursor.hooks.preToolUse.filter(
      (entry) => entry.matcher !== DIRECT_WRITE_HOOK_MATCHER,
    );
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
    });
  });

  it("marks Cursor registration drifted when hooks.json version is not 1", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const cursorPath = join(root, ".cursor/hooks.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { version: number };
    cursor.version = 2;
    writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")).toMatchObject({
      status: "drifted",
    });
  });

  it("keeps grok healthy when direct-write matcher lacks EditNotebook but has catalog tokens (#4574)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const grokPath = join(root, ".grok/hooks/deft.json");
    const grok = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    const withoutEditNotebook = DIRECT_WRITE_HOOK_MATCHER.replace(
      "|EditNotebook|edit_notebook",
      "",
    );
    expect(withoutEditNotebook).not.toBe(DIRECT_WRITE_HOOK_MATCHER);
    expect(withoutEditNotebook.split("|")).toEqual(
      expect.arrayContaining([...GROK_MUTATION_TOOL_CATALOG.directWrite]),
    );
    grok.hooks.PreToolUse = grok.hooks.PreToolUse.map((entry) =>
      entry.matcher === DIRECT_WRITE_HOOK_MATCHER
        ? { ...entry, matcher: withoutEditNotebook }
        : entry,
    );
    writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")).toMatchObject({
      status: "healthy",
    });
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")).toMatchObject({
      status: "healthy",
    });
  });

  it("marks grok drifted when a GROK_MUTATION_TOOL_CATALOG.directWrite token is missing (#4574)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const grokPath = join(root, ".grok/hooks/deft.json");
    const grok = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    const missingSearchReplace = DIRECT_WRITE_HOOK_MATCHER.replace("|search_replace", "");
    grok.hooks.PreToolUse = grok.hooks.PreToolUse.map((entry) =>
      entry.matcher === DIRECT_WRITE_HOOK_MATCHER
        ? { ...entry, matcher: missingSearchReplace }
        : entry,
    );
    writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")).toMatchObject({
      status: "drifted",
    });
  });

  it("redeposits legacy .sh PreToolUse commands to pin-local hook-bin (#5956-A)", () => {
    const root = project();
    writeAgentHookDeposit(root, { printf: () => undefined });
    const grokPath = join(root, ".grok/hooks/deft.json");
    const grok = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: {
        SessionStart: Array<Record<string, unknown>>;
        PreToolUse: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
        }>;
      };
    };
    // Seed stale .sh wrapper shape + a custom unrelated hook.
    grok.hooks.PreToolUse = [
      {
        matcher: "Shell",
        hooks: [{ type: "command", command: "./custom-grok-check.sh", timeout: 5 }],
      },
      ...grok.hooks.PreToolUse.map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).map((hook) =>
          typeof hook.command === "string"
            ? { ...hook, command: GROK_PRETOOLUSE_WRAPPER_COMMAND }
            : hook,
        ),
      })),
    ];
    writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`, "utf8");
    expect(isGrokWrapperCommand(GROK_PRETOOLUSE_WRAPPER_REL_PATH)).toBe(true);
    expect(isGrokWrapperCommand(GROK_PRETOOLUSE_WRAPPER_COMMAND)).toBe(true);
    expect(isGrokWrapperCommand(GROK_PRETOOLUSE_WRAPPER_MARKER)).toBe(true);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")).toMatchObject({
      status: "drifted",
    });
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")?.detail).toMatch(
      /legacy form|#5994|AC9\.1/,
    );

    writeAgentHookDeposit(root, { printf: () => undefined });
    const redeposited = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };
    const commands = redeposited.hooks.PreToolUse.flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        typeof hook.command === "string" ? [hook.command] : [],
      ),
    );
    const intentionalGrokPreTool = expectedOuterCmd("grok", "tool.before");
    const managedCommands = commands.filter((cmd) => cmd !== "./custom-grok-check.sh");
    expect(managedCommands.length).toBeGreaterThan(0);
    expect(managedCommands.every((cmd) => cmd === intentionalGrokPreTool)).toBe(true);
    expect(commands.every((cmd) => !isGrokWrapperCommand(cmd))).toBe(true);
    expect(commands).toContain("./custom-grok-check.sh");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")).toMatchObject({
      status: "healthy",
    });
  });

  it("treats non-array Grok PreToolUse as registration drift (#5715)", () => {
    const root = project();
    writeAgentHookDeposit(root, { printf: () => undefined });
    expect(existsSync(join(root, GROK_PRETOOLUSE_WRAPPER_REL_PATH))).toBe(false);
    const grokPath = join(root, ".grok/hooks/deft.json");
    const grok = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    grok.hooks.PreToolUse = { not: "an-array" };
    writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`, "utf8");
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")).toMatchObject({
      status: "drifted",
    });
  });

  it("marks grok drifted when PreToolUse still uses the .sh wrapper (#5956-A)", () => {
    const root = project();
    writeAgentHookDeposit(root, { printf: () => undefined });
    const grokPath = join(root, ".grok/hooks/deft.json");
    const grok = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };
    grok.hooks.PreToolUse = grok.hooks.PreToolUse.map((entry) => ({
      ...entry,
      hooks: (entry.hooks ?? []).map((hook) =>
        typeof hook.command === "string"
          ? { ...hook, command: GROK_PRETOOLUSE_WRAPPER_REL_PATH }
          : hook,
      ),
    }));
    writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`, "utf8");
    const doubled = resolve(dirname(grokPath), GROK_PRETOOLUSE_WRAPPER_REL_PATH);
    expect(doubled).not.toBe(join(root, GROK_PRETOOLUSE_WRAPPER_REL_PATH));
    const grokInspect = inspectAgentHookDeposit(root).find((entry) => entry.host === "grok");
    expect(grokInspect).toMatchObject({ status: "drifted" });
    expect(grokInspect?.detail).toMatch(/legacy form|deft-hook-<sha8>\.mjs|#5994/);
    expect(grokInspect?.detail).toMatch(/AC9\.1|#5994|legacy/);
    expect(grokInspect?.detail).toMatch(/directive install --repair/);
  });

  it("keeps Grok healthy when unused .sh wrapper file is missing (#5956-A)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const wrapper = join(root, ".grok/hooks/deft-pretooluse-wrapper.sh");
    expect(existsSync(wrapper)).toBe(false);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")?.status).toBe(
      "healthy",
    );
  });

  it("never emits .sh PreToolUse for Grok (#5956-A)", () => {
    const root = project();
    writeAgentHookDeposit(root, { printf: () => undefined });
    const grok = JSON.parse(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const commands = grok.hooks.PreToolUse.flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        typeof hook.command === "string" ? [hook.command] : [],
      ),
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((cmd) => !isGrokWrapperCommand(cmd))).toBe(true);
    expect(commands.every((cmd) => !cmd.includes(GROK_PRETOOLUSE_WRAPPER_MARKER))).toBe(true);
    expect(commands.every((cmd) => cmd === expectedOuterCmd("grok", "tool.before"))).toBe(true);
  });

  it("does not use write|search_replace exact-equality as the grok registration bar (#4574)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const grokPath = join(root, ".grok/hooks/deft.json");
    const grok = JSON.parse(readFileSync(grokPath, "utf8")) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    // Longer union that still carries catalog tokens — token presence, not exact bar.
    const longerThanCatalogBar = `${DIRECT_WRITE_HOOK_MATCHER}|ExtraWriteAlias`;
    expect(longerThanCatalogBar).not.toBe("write|search_replace");
    grok.hooks.PreToolUse = grok.hooks.PreToolUse.map((entry) =>
      entry.matcher === DIRECT_WRITE_HOOK_MATCHER
        ? { ...entry, matcher: longerThanCatalogBar }
        : entry,
    );
    writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "grok")).toMatchObject({
      status: "healthy",
    });
  });

  it("keeps claude on exact-equality for DIRECT_WRITE_HOOK_MATCHER (#4574)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(claudePath, "utf8")) as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    const withoutEditNotebook = DIRECT_WRITE_HOOK_MATCHER.replace(
      "|EditNotebook|edit_notebook",
      "",
    );
    claude.hooks.PreToolUse = claude.hooks.PreToolUse.map((entry) =>
      entry.matcher === DIRECT_WRITE_HOOK_MATCHER
        ? { ...entry, matcher: withoutEditNotebook }
        : entry,
    );
    writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")).toMatchObject({
      status: "drifted",
    });
  });

  it("marks nested hosts drifted when PreToolUse still has the old 5s timeout (#3739)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const claude = JSON.parse(readFileSync(claudePath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{ hooks?: Array<{ timeout?: number }> }>;
      };
    };
    claude.hooks.PreToolUse = claude.hooks.PreToolUse.map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).map((hook) => ({ ...hook, timeout: 5 })),
    }));
    writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");

    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")).toMatchObject({
      status: "drifted",
    });
  });

  it("still deposits shared DIRECT_WRITE_HOOK_MATCHER for grok merge writer (#4574)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const grok = readFileSync(join(root, ".grok/hooks/deft.json"), "utf8");
    expect(grok).toContain(`"matcher": "${DIRECT_WRITE_HOOK_MATCHER}"`);
  });

  it("strips the Grok outer-deny wrapper when hostHooks.grok is false (#5656)", () => {
    const root = project();
    writeAgentHookDeposit(root, { printf: () => undefined });
    // Seed leftover .sh; #5994 deposit no longer writes it, but disable must still strip.
    writeFileSync(join(root, GROK_PRETOOLUSE_WRAPPER_REL_PATH), "#!/bin/sh\n", "utf8");
    expect(existsSync(join(root, GROK_PRETOOLUSE_WRAPPER_REL_PATH))).toBe(true);
    writeAgentHookDeposit(
      root,
      { printf: () => undefined },
      { ...DEFAULT_HOST_HOOKS_POLICY, grok: false },
    );
    expect(existsSync(join(root, GROK_PRETOOLUSE_WRAPPER_REL_PATH))).toBe(false);
  });

  it("treats non-array event collections as registration drift", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const claudePath = join(root, ".claude/settings.json");
    const cursorPath = join(root, ".cursor/hooks.json");
    const claudeOriginal = readFileSync(claudePath, "utf8");
    const cursorOriginal = readFileSync(cursorPath, "utf8");

    for (const eventName of ["SessionStart", "PreToolUse", "PreCompact", "PostCompact"] as const) {
      const claude = JSON.parse(claudeOriginal) as {
        hooks: Record<string, unknown>;
      };
      claude.hooks[eventName] = {};
      writeFileSync(claudePath, `${JSON.stringify(claude, null, 2)}\n`, "utf8");
      expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "claude")?.status).toBe(
        "drifted",
      );
    }
    writeFileSync(claudePath, claudeOriginal, "utf8");

    for (const eventName of [
      "sessionStart",
      "preToolUse",
      "preCompact",
      "beforeSubmitPrompt",
      "afterAgentResponse",
    ] as const) {
      const cursor = JSON.parse(cursorOriginal) as {
        hooks: Record<string, unknown>;
      };
      cursor.hooks[eventName] = {};
      writeFileSync(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
      expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "cursor")?.status).toBe(
        "drifted",
      );
    }
  });
});

describe("evaluateGrokPretooluseWrapperOutcome (#5656)", () => {
  it("denies when package-relative hook-bin is missing", () => {
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: false,
        childExitCode: null,
        childStdout: "",
      }),
    ).toEqual({ kind: "deny", reason: GROK_WRAPPER_DENY_MISSING });
  });

  it("denies when package-relative hook-bin is not runnable", () => {
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: true,
        deftHookExecutable: false,
        childExitCode: 0,
        childStdout: "",
      }),
    ).toEqual({ kind: "deny", reason: GROK_WRAPPER_DENY_MISSING });
  });

  it("denies on non-zero child exit", () => {
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: true,
        childExitCode: 127,
        childStdout: "",
      }),
    ).toEqual({ kind: "deny", reason: GROK_WRAPPER_DENY_NONDECISION });
  });

  it("passthrough empty stdout on exit 0 (Grok allow wire)", () => {
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: true,
        childExitCode: 0,
        childStdout: "",
      }),
    ).toEqual({ kind: "passthrough", stdout: "" });
  });

  it("denies malformed non-empty stdout", () => {
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: true,
        childExitCode: 0,
        childStdout: "not-json",
      }),
    ).toEqual({ kind: "deny", reason: GROK_WRAPPER_DENY_NONDECISION });
  });

  it("denies truncated decision JSON that is not parseable (#5656)", () => {
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: true,
        childExitCode: 0,
        childStdout: '{"decision":"deny"',
      }),
    ).toEqual({ kind: "deny", reason: GROK_WRAPPER_DENY_NONDECISION });
  });

  it("wrapper script catches mktemp failure and uses node JSON parse (#5656)", () => {
    const src = grokPretooluseWrapperScriptSource();
    expect(src).toContain("TMP=$(mktemp) || { printf");
    expect(src).toContain("command -v node");
    expect(src).toContain("JSON.parse");
    expect(src).not.toMatch(/\*'"decision":"allow"'/);
  });

  it("passthrough valid deny envelopes", () => {
    const denyBody = JSON.stringify({ decision: "deny", reason: "scope" });
    expect(
      evaluateGrokPretooluseWrapperOutcome({
        deftHookResolvable: true,
        childExitCode: 0,
        childStdout: denyBody,
      }),
    ).toEqual({ kind: "passthrough", stdout: denyBody });
  });
});

describe("agy deposit, activation gate and doctor (#7347)", () => {
  const PRE = { PreToolUse: [{ matcher: "*", hooks: [{ command: "x" }] }] };
  const HOOKS = ".agents/hooks.json";
  const NO_IO = { printf: () => undefined };

  function agyProject(): string {
    const root = project();
    writeFileSync(join(root, "package.json"), "{}\n");
    return root;
  }

  function readHooks(root: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, HOOKS), "utf8")) as Record<string, unknown>;
  }

  function writeHooks(root: string, hooks: Record<string, unknown>): void {
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, HOOKS), `${JSON.stringify(hooks, null, 2)}\n`);
  }

  const outerPath = (root: string): string =>
    join(root, ".agents", hostHookOuterFileName(hostHookOuterSha8()));

  /** The real deposited outer, run the way agy runs it: cwd `.agents/`, payload on stdin. */
  function runDepositedOuter(root: string): { decision: string; reason: string; reached: boolean } {
    const pin = join(root, "node_modules/@deftai/directive-runtime/dist/hook-bin.js");
    mkdirSync(join(pin, ".."), { recursive: true });
    writeFileSync(
      pin,
      'process.stderr.write("RUNTIME_REACHED\\n"); process.stdout.write(\'{"decision":"allow"}\');',
    );
    const result = spawnSync(
      process.execPath,
      [hostHookOuterFileName(hostHookOuterSha8()), "--host", "agy", "--event", "tool.before"],
      {
        cwd: join(root, ".agents"),
        encoding: "utf8",
        env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
        input: JSON.stringify({
          hookEventName: "PreToolUse",
          workspacePaths: [root],
          cwd: root,
          toolCall: { id: "c1", name: "run_command", args: { CommandLine: "echo hi" } },
        }),
      },
    );
    const parsed = JSON.parse(String(result.stdout)) as { decision: string; reason?: string };
    return {
      decision: parsed.decision,
      reason: parsed.reason ?? "",
      reached: String(result.stderr).includes("RUNTIME_REACHED"),
    };
  }

  it("deposits Directive's named entry with the outer and keeps foreign hooks", () => {
    const root = agyProject();
    writeHooks(root, { "aaaa-user": PRE });
    const result = writeAgentHookDeposit(root, NO_IO);
    expect(result.changedPaths).toContain(HOOKS);
    const hooks = readHooks(root);
    expect(hooks["aaaa-user"]).toEqual(PRE);
    expect(isManagedAgyHookEntry(hooks[AGY_DIRECTIVE_HOOK_NAME])).toBe(true);
    expect(JSON.stringify(hooks[AGY_DIRECTIVE_HOOK_NAME])).toContain(
      `node ${hostHookOuterFileName(hostHookOuterSha8())} --host agy --event tool.before`,
    );
    expect(existsSync(outerPath(root))).toBe(true);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "agy")?.status).toBe(
      "healthy",
    );
  });

  it("contract (#7440): SessionStart entries are flat handlers and PreToolUse entries are matcher groups", () => {
    const root = agyProject();
    writeAgentHookDeposit(root, NO_IO);
    const entry = readHooks(root)[AGY_DIRECTIVE_HOOK_NAME] as {
      SessionStart: Array<Record<string, unknown>>;
      PreToolUse: Array<Record<string, unknown>>;
    };
    expect(entry.SessionStart).toHaveLength(1);
    for (const handler of entry.SessionStart) {
      expect(typeof handler.command).toBe("string");
      expect(typeof handler.timeout).toBe("number");
      expect(handler).not.toHaveProperty("hooks");
    }
    expect(entry.PreToolUse).toHaveLength(1);
    for (const group of entry.PreToolUse) {
      expect(group.matcher).toBe("*");
      expect(Array.isArray(group.hooks)).toBe(true);
      expect(group).not.toHaveProperty("command");
    }
  });

  it("treats an earlier grouped SessionStart deposit as drift and repairs it (#7440)", () => {
    const root = agyProject();
    writeAgentHookDeposit(root, NO_IO);
    const healthy = readFileSync(join(root, HOOKS), "utf8");
    const current = readHooks(root);
    const entry = current[AGY_DIRECTIVE_HOOK_NAME] as {
      SessionStart: Array<{ command: string; timeout: number }>;
    };
    writeHooks(root, {
      ...current,
      [AGY_DIRECTIVE_HOOK_NAME]: {
        ...entry,
        SessionStart: [{ hooks: entry.SessionStart }],
      },
    });
    // Still recognised as Directive's own entry, but not the current shape.
    expect(isManagedAgyHookEntry(readHooks(root)[AGY_DIRECTIVE_HOOK_NAME])).toBe(true);
    expect(inspectAgentHookDeposit(root).find((e) => e.host === "agy")?.status).toBe("drifted");
    writeAgentHookDeposit(root, NO_IO);
    expect(readFileSync(join(root, HOOKS), "utf8")).toBe(healthy);
  });

  it("is idempotent and repairs a drifted entry", () => {
    const root = agyProject();
    writeAgentHookDeposit(root, NO_IO);
    const before = readFileSync(join(root, HOOKS), "utf8");
    expect(writeAgentHookDeposit(root, NO_IO).changedPaths).not.toContain(HOOKS);
    expect(readFileSync(join(root, HOOKS), "utf8")).toBe(before);

    writeHooks(root, {
      ...readHooks(root),
      [AGY_DIRECTIVE_HOOK_NAME]: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ command: "node deft-hook-00000000.mjs --host agy --event tool.before" }],
          },
        ],
      },
    });
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "agy")?.status).toBe(
      "drifted",
    );
    writeAgentHookDeposit(root, NO_IO);
    expect(readFileSync(join(root, HOOKS), "utf8")).toBe(before);
  });

  it("never overwrites a foreign hook that uses Directive's name, and reports drift", () => {
    const root = agyProject();
    writeHooks(root, { [AGY_DIRECTIVE_HOOK_NAME]: PRE });
    writeAgentHookDeposit(root, NO_IO);
    expect(readHooks(root)[AGY_DIRECTIVE_HOOK_NAME]).toEqual(PRE);
    expect(inspectAgentHookDeposit(root).find((entry) => entry.host === "agy")?.status).toBe(
      "drifted",
    );
  });

  it("reports a changed matcher or a shortened timeout as drift", () => {
    const root = agyProject();
    writeAgentHookDeposit(root, NO_IO);
    const healthy = readFileSync(join(root, HOOKS), "utf8");
    const status = (): string | undefined =>
      inspectAgentHookDeposit(root).find((entry) => entry.host === "agy")?.status;
    for (const [from, to] of [
      ['"matcher": "*"', '"matcher": "write_file"'],
      [`"timeout": ${NESTED_TOOL_BEFORE_TIMEOUT_SECONDS}`, '"timeout": 1'],
    ] as const) {
      writeFileSync(join(root, HOOKS), healthy.replace(from, to));
      expect(status()).toBe("drifted");
    }
    writeFileSync(join(root, HOOKS), healthy);
    expect(status()).toBe("healthy");
  });

  it("uninstalls only Directive's entry and outer, and keeps foreign hooks", () => {
    const root = agyProject();
    writeHooks(root, { "aaaa-user": PRE });
    writeAgentHookDeposit(root, NO_IO);
    writeProjectDefinition(root, { agy: true });
    const result = disableHostHooks(root, { host: "agy", confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(readHooks(root)).toEqual({ "aaaa-user": PRE });
    expect(existsSync(outerPath(root))).toBe(false);
  });

  it("contract: admits the committed verdict with the deposited wiring and a denied later rewrite", () => {
    const root = agyProject();
    writeAgentHookDeposit(root, NO_IO);
    const deposited = readHooks(root);
    const depositedName = Object.keys(deposited).find((name) =>
      isManagedAgyHookEntry(deposited[name]),
    );

    // Behavioural fixture: a foreign hook that sorts after Directive's is denied by the
    // deposited outer before the runtime is reached.
    writeHooks(root, { ...deposited, zzzzz: PRE });
    const later = runDepositedOuter(root);
    expect(later.decision).toBe("deny");
    expect(later.reason).toContain('Hook "zzzzz"');
    expect(later.reached).toBe(false);

    expect(AGY_ADMISSION_VERDICT.overall).toBe("mitigated");
    expect(
      agyActivationAdmitted(
        AGY_ADMISSION_VERDICT,
        {
          depositedName: depositedName ?? "",
          perCallCallsPredicate: readFileSync(outerPath(root), "utf8").includes(
            "agyHookOrderPayloadFindings(",
          ),
          laterRewriteDenied: later.decision === "deny",
        },
        AGY_DIRECTIVE_HOOK_NAME,
      ),
    ).toBe(true);
    expect(agyDepositAdmitted()).toBe(true);
  });

  it("the deposited outer reaches the runtime when nothing runs after Directive's entry", () => {
    const root = agyProject();
    writeAgentHookDeposit(root, NO_IO);
    const ok = runDepositedOuter(root);
    expect(ok.decision).toBe("allow");
    expect(ok.reached).toBe(true);
  });

  it("contract: fails closed on a fail verdict, an absent verdict, and missing wiring", () => {
    const wiring = agyActivationWiring(hostHookOuterSource());
    const failed: AgyAdmissionVerdict = { ...AGY_ADMISSION_VERDICT, overall: "fail" };
    expect(agyActivationAdmitted(failed, wiring, AGY_DIRECTIVE_HOOK_NAME)).toBe(false);
    expect(agyActivationAdmitted(undefined, wiring, AGY_DIRECTIVE_HOOK_NAME)).toBe(false);
    for (const missing of ["laterRewriteDenied", "perCallCallsPredicate"] as const) {
      expect(
        agyActivationAdmitted(
          AGY_ADMISSION_VERDICT,
          { ...wiring, [missing]: false },
          AGY_DIRECTIVE_HOOK_NAME,
        ),
      ).toBe(false);
    }
    expect(agyDepositAdmitted(hostHookOuterSource(), { verdict: failed })).toBe(false);
    expect(agyDepositAdmitted(hostHookOuterSource(), { verdict: undefined })).toBe(false);
  });

  it("halts activation: a fail or absent verdict deposits nothing and says why", () => {
    const verdicts: Array<AgyAdmissionVerdict | undefined> = [
      undefined,
      { ...AGY_ADMISSION_VERDICT, overall: "fail" },
    ];
    for (const verdict of verdicts) {
      const root = agyProject();
      const lines: string[] = [];
      const result = writeAgentHookDeposit(
        root,
        { printf: (text) => lines.push(text) },
        undefined,
        {},
        { verdict },
      );
      expect(result.changedPaths).not.toContain(HOOKS);
      expect(existsSync(join(root, HOOKS))).toBe(false);
      expect(existsSync(outerPath(root))).toBe(false);
      expect(lines.join("")).toContain(AGY_ACTIVATION_HALT_DETAIL);
      const inspected = inspectAgentHookDeposit(root, undefined, { verdict }).find(
        (entry) => entry.host === "agy",
      );
      expect(inspected?.status).toBe("disabled");
      expect(inspected?.detail).toBe(AGY_ACTIVATION_HALT_DETAIL);
    }
  });

  it("strips an earlier agy deposit when the verdict stops admitting it", () => {
    const root = agyProject();
    writeHooks(root, { "aaaa-user": PRE });
    writeAgentHookDeposit(root, NO_IO);
    writeAgentHookDeposit(root, NO_IO, undefined, {}, { verdict: undefined });
    expect(readHooks(root)).toEqual({ "aaaa-user": PRE });
  });

  it("doctor reports the gate and stays quiet when agy is opted out", () => {
    const root = agyProject();
    expect(checkAgyActivation(root)).toMatchObject({
      name: "agy-activation",
      status: "pass",
      data: { applicable: true, admitted: true },
    });
    writeProjectDefinition(root, { agy: false });
    expect(checkAgyActivation(root).data).toEqual({ applicable: false });
  });
});
