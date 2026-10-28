/**
 * Red proof for Locked #5807 (Grok dual PreToolUse / stale deft-hook wrapper).
 * Fail on pre-fix tip; Build turns green via ensureHostHooks upgrade/repair.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "@deftai/directive-core/dist/hooks/tools.js";
import {
  DEFAULT_HOST_HOOKS_POLICY,
  type HostHooksPolicy,
} from "@deftai/directive-core/dist/policy/host-hooks.js";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHostHooks } from "./setup-wiring.js";

const TEMPS: string[] = [];
const PRE_TOOL_MATCHERS = [
  DIRECT_WRITE_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
] as const;

const STALE_DEFT_HOOK_WRAPPER = `#!/usr/bin/env sh
# 0.126-style leftover: PATH deft-hook deny when binary missing (#5807)
if ! command -v deft-hook >/dev/null 2>&1; then
  printf '%s\\n' '{"decision":"deny","reason":"missing deft-hook"}'
  exit 0
fi
exec deft-hook --host grok --event tool.before
`;

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ovpr-hooks-red-"));
  TEMPS.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("OVPR hooks red #5807 dual PreToolUse / stale deft-hook wrapper", () => {
  it("ensureHostHooks upgrade leaves one PreToolUse entry per matcher and rewrites leftover deft-hook wrapper", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".grok", "hooks"), { recursive: true });
    writeFileSync(join(root, ".grok/hooks/deft-pretooluse-wrapper.sh"), STALE_DEFT_HOOK_WRAPPER, {
      encoding: "utf8",
    });
    chmodSync(join(root, ".grok/hooks/deft-pretooluse-wrapper.sh"), 0o755);

    const hookBin =
      "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host grok --event tool.before";
    const wrapperCmd = "./deft-pretooluse-wrapper.sh";
    const dualPreTool = PRE_TOOL_MATCHERS.flatMap((matcher) => [
      {
        matcher,
        hooks: [{ type: "command", command: wrapperCmd, timeout: 30 }],
      },
      {
        matcher,
        hooks: [{ type: "command", command: hookBin, timeout: 30 }],
      },
    ]);
    writeFileSync(
      join(root, ".grok/hooks/deft.json"),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host grok --event session.start",
                    timeout: 5,
                  },
                ],
              },
            ],
            PreToolUse: dualPreTool,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    ensureHostHooks(root);

    const after = JSON.parse(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")) as {
      hooks: {
        PreToolUse: Array<{
          matcher?: string;
          hooks?: Array<{ command?: string }>;
        }>;
      };
    };
    const preTool = after.hooks.PreToolUse ?? [];

    for (const matcher of PRE_TOOL_MATCHERS) {
      const forMatcher = preTool.filter((entry) => entry.matcher === matcher);
      expect(
        forMatcher,
        `matcher ${matcher} must have exactly one PreToolUse group after upgrade (#5807)`,
      ).toHaveLength(1);
      const command = forMatcher[0]?.hooks?.[0]?.command ?? "";
      const isOuter = /deft-hook-[a-f0-9]{8}\.mjs/.test(command) && command.includes("--host grok");
      expect(
        isOuter,
        `matcher ${matcher} command must be current .mjs outer (#5994 / #5807); got ${command}`,
      ).toBe(true);
      expect(command, "must not reintroduce bare deft-hook PreToolUse identity").not.toMatch(
        /(^|[\s"`'])deft-hook([\s"`']|$)/,
      );
    }

    expect(existsSync(join(root, ".grok/hooks/deft-pretooluse-wrapper.sh"))).toBe(false);
    expect(
      readdirSync(join(root, ".grok/hooks")).some(
        (f) => f.startsWith("deft-hook-") && f.endsWith(".mjs"),
      ),
    ).toBe(true);
  });

  it("preserves custom commands co-located with the Grok wrapper in one PreToolUse group (Greptile P1 #5886)", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".grok", "hooks"), { recursive: true });
    writeFileSync(join(root, ".grok/hooks/deft-pretooluse-wrapper.sh"), STALE_DEFT_HOOK_WRAPPER, {
      encoding: "utf8",
    });
    chmodSync(join(root, ".grok/hooks/deft-pretooluse-wrapper.sh"), 0o755);

    const wrapperCmd = "./deft-pretooluse-wrapper.sh";
    const customCmd = "./custom-grok-check.sh";
    const matcher = SHELL_HOOK_MATCHER;
    writeFileSync(
      join(root, ".grok/hooks/deft.json"),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host grok --event session.start",
                    timeout: 5,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher,
                hooks: [
                  { type: "command", command: wrapperCmd, timeout: 30 },
                  { type: "command", command: customCmd, timeout: 5 },
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

    ensureHostHooks(root);

    const afterMerge = JSON.parse(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")) as {
      hooks: {
        PreToolUse: Array<{
          matcher?: string;
          hooks?: Array<{ command?: string }>;
        }>;
      };
    };
    const mergeCommands = (afterMerge.hooks.PreToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        typeof hook.command === "string" ? [hook.command] : [],
      ),
    );
    expect(mergeCommands, "merge must keep custom command beside managed wrapper").toContain(
      customCmd,
    );
    expect(
      mergeCommands.some((cmd) => /deft-hook-[a-f0-9]{8}\.mjs/.test(cmd)),
      "merge must redeposit Grok .mjs outer",
    ).toBe(true);

    const disableGrok: HostHooksPolicy = { ...DEFAULT_HOST_HOOKS_POLICY, grok: false };
    ensureHostHooks(root, disableGrok);

    const afterStrip = JSON.parse(readFileSync(join(root, ".grok/hooks/deft.json"), "utf8")) as {
      hooks: {
        PreToolUse?: Array<{
          matcher?: string;
          hooks?: Array<{ command?: string }>;
        }>;
      };
    };
    const stripCommands = (afterStrip.hooks.PreToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        typeof hook.command === "string" ? [hook.command] : [],
      ),
    );
    expect(stripCommands, "strip must keep custom command when disabling grok").toContain(
      customCmd,
    );
    expect(
      stripCommands.some((cmd) => cmd.includes("deft-pretooluse-wrapper.sh")),
      "strip must remove managed Grok wrapper",
    ).toBe(false);
    const customGroup = (afterStrip.hooks.PreToolUse ?? []).find((group) =>
      (group.hooks ?? []).some((hook) => hook.command === customCmd),
    );
    expect(customGroup?.matcher, "strip must preserve group matcher field").toBe(matcher);
  });
});
