import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECT_WRITE_TOOL_NAMES,
  isDirectWriteTool,
  isSpawnTool,
  SPAWN_TOOL_NAMES,
} from "../hooks/tools.js";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import {
  AGENT_HOOK_PATHS,
  DIRECT_WRITE_HOOK_MATCHER,
  inspectAgentHookDeposit,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
  writeAgentHookDeposit,
} from "./agent-hooks.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agent-hooks-"));
  temps.push(root);
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

describe("writeAgentHookDeposit", () => {
  it("deposits native Claude, Grok, Cursor, and Codex SessionStart/direct-write hooks", () => {
    const root = project();
    const lines: string[] = [];
    const result = writeAgentHookDeposit(root, { printf: (text) => lines.push(text) });

    expect(result.changed).toBe(true);
    expect(result.changedPaths).toEqual([...AGENT_HOOK_PATHS]);
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain(
      "--host claude --event tool.before",
    );
    expect(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")).toContain(
      "--host grok --event tool.before",
    );
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
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain(
      "--host claude --event session.compact",
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
  });

  it("deposits exactly one direct-write matcher for each supported host (#2790)", () => {
    const root = project();
    writeAgentHookDeposit(root);

    for (const path of AGENT_HOOK_PATHS) {
      const deposit = readFileSync(join(root, path), "utf8");
      expect(deposit.split(DIRECT_WRITE_HOOK_MATCHER)).toHaveLength(2);
      expect(deposit).toContain("deft-hook --host");
    }
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
    // direct-write + spawn + shell + MCP (#2711) managed PreToolUse groups
    expect(codex.match(/--host codex --event tool\.before/g)).toHaveLength(4);
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
});

describe("inspectAgentHookDeposit", () => {
  it("distinguishes missing and drifted registrations", () => {
    const root = project();
    expect(inspectAgentHookDeposit(root).map((entry) => entry.status)).toEqual([
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

  it("reports opted-out Claude host as healthy without requiring deposit", () => {
    const root = project();
    writeProjectDefinition(root, { claude: false });
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, claude: false };

    expect(
      inspectAgentHookDeposit(root, policy).find((entry) => entry.host === "claude"),
    ).toMatchObject({
      status: "healthy",
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
});
