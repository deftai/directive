import { describe, expect, it } from "vitest";
import { classifyShellCommandForTest, classifyToolEvent, classifyToolEvents } from "./classify.js";
import type { ToolEventBucket, ToolEventInput } from "./types.js";

interface Fixture {
  readonly name: string;
  readonly event: ToolEventInput;
  readonly bucket: ToolEventBucket;
  /** Optional substring expected in reason */
  readonly reasonIncludes?: string;
}

const FIXTURES: readonly Fixture[] = [
  // --- explore (name) ---
  { name: "Read", event: { name: "Read", args: { path: "AGENTS.md" } }, bucket: "explore" },
  { name: "Grep", event: { name: "Grep", args: { pattern: "foo" } }, bucket: "explore" },
  { name: "Glob", event: { name: "Glob", args: { pattern: "**/*.ts" } }, bucket: "explore" },
  { name: "list_dir", event: { name: "list_dir" }, bucket: "explore" },
  {
    name: "SemanticSearch",
    event: { name: "SemanticSearch", args: { query: "auth" } },
    bucket: "explore",
  },
  { name: "web_search", event: { name: "web_search", args: { query: "x" } }, bucket: "explore" },
  {
    name: "WebFetch",
    event: { name: "WebFetch", args: { url: "https://example.com" } },
    bucket: "explore",
  },

  // --- commit (name) ---
  {
    name: "Write",
    event: { name: "Write", args: { path: "a.ts", contents: "x" } },
    bucket: "commit",
  },
  { name: "StrReplace", event: { name: "StrReplace", args: { path: "a.ts" } }, bucket: "commit" },
  { name: "SearchReplace", event: { name: "SearchReplace" }, bucket: "commit" },
  { name: "ApplyPatch", event: { name: "ApplyPatch" }, bucket: "commit" },
  { name: "MultiEdit", event: { name: "MultiEdit" }, bucket: "commit" },
  { name: "Delete", event: { name: "Delete", args: { path: "a.ts" } }, bucket: "commit" },
  { name: "Edit", event: { name: "Edit" }, bucket: "commit" },

  // --- coordinate (name) ---
  { name: "Task", event: { name: "Task", args: { description: "impl" } }, bucket: "coordinate" },
  { name: "spawn_subagent", event: { name: "spawn_subagent" }, bucket: "coordinate" },
  { name: "start_agent", event: { name: "start_agent" }, bucket: "coordinate" },
  { name: "sessions_spawn", event: { name: "sessions_spawn" }, bucket: "coordinate" },
  { name: "TodoWrite", event: { name: "TodoWrite" }, bucket: "coordinate" },
  { name: "AskQuestion", event: { name: "AskQuestion" }, bucket: "coordinate" },

  // --- shell explore ---
  {
    name: "Shell git status",
    event: { name: "Shell", command: "git status --short --branch" },
    bucket: "explore",
  },
  {
    name: "Bash git log",
    event: { name: "Bash", args: { command: "git log --oneline -5" } },
    bucket: "explore",
  },
  {
    name: "Shell git diff",
    event: { name: "Shell", command: "git diff HEAD" },
    bucket: "explore",
  },
  {
    name: "Shell rg",
    event: { name: "run_terminal_command", command: "rg classifyToolEvent packages/core" },
    bucket: "explore",
  },
  {
    name: "Shell gh pr view",
    event: { name: "Shell", command: "gh pr view 2967" },
    bucket: "explore",
  },
  {
    name: "Shell gh api GET",
    event: { name: "Shell", command: "gh api repos/deftai/directive/issues/2967" },
    bucket: "explore",
  },
  {
    name: "Shell ghx",
    event: { name: "Shell", command: "ghx api repos/deftai/directive/pulls/1" },
    bucket: "explore",
  },

  // --- shell commit ---
  {
    name: "Shell git commit",
    event: { name: "Shell", command: "git commit -F msg.txt" },
    bucket: "commit",
  },
  {
    name: "Shell git push",
    event: { name: "Shell", command: "git push -u origin HEAD" },
    bucket: "commit",
  },
  {
    name: "Shell git add",
    event: { name: "Shell", command: "git add packages/core/src/tool-events" },
    bucket: "commit",
  },
  {
    name: "Shell gh pr create",
    event: { name: "Shell", command: "gh pr create --title t --body-file b.md" },
    bucket: "commit",
  },
  {
    name: "Shell gh api POST",
    event: { name: "Shell", command: "gh api -X POST repos/o/r/issues/1/comments --input -" },
    bucket: "commit",
  },

  // --- shell verify (proven only) ---
  {
    name: "Shell vitest",
    event: { name: "Shell", command: "pnpm exec vitest run packages/core/src/tool-events" },
    bucket: "verify",
    reasonIncludes: "verify",
  },
  {
    name: "Shell vitest alone",
    event: { name: "Shell", command: "vitest run --reporter=dot" },
    bucket: "verify",
  },
  {
    name: "Shell task check",
    event: { name: "Shell", command: "task check" },
    bucket: "verify",
  },
  {
    name: "Shell task verify:encoding",
    event: { name: "Shell", command: "task verify:encoding" },
    bucket: "verify",
  },
  {
    name: "Shell pytest",
    event: { name: "Shell", command: "pytest -q" },
    bucket: "verify",
  },
  {
    name: "Shell go test",
    event: { name: "Shell", command: "go test ./..." },
    bucket: "verify",
  },
  {
    name: "Shell cargo test",
    event: { name: "Shell", command: "cargo test" },
    bucket: "verify",
  },
  {
    name: "Shell npm test",
    event: { name: "Shell", command: "npm test" },
    bucket: "verify",
  },
  {
    name: "Shell pnpm run lint",
    event: { name: "Shell", command: "pnpm run lint" },
    bucket: "verify",
  },
  {
    name: "Shell biome",
    event: { name: "Shell", command: "biome check ." },
    bucket: "verify",
  },
  {
    name: "Shell tsc",
    event: { name: "Shell", command: "tsc -b" },
    bucket: "verify",
  },
  {
    name: "Shell task pr:watch",
    event: { name: "Shell", command: "task pr:watch -- 2967" },
    bucket: "verify",
  },
  {
    name: "Shell python -m pytest",
    event: { name: "Shell", command: "python -m pytest tests/" },
    bucket: "verify",
  },

  // --- shell coordinate ---
  {
    name: "Shell swarm launch",
    event: { name: "Shell", command: "task swarm:launch -- --stories 2967" },
    bucket: "coordinate",
  },
  {
    name: "Shell scope activate",
    event: { name: "Shell", command: "task scope:activate -- xbrief/active/foo.xbrief.json" },
    bucket: "coordinate",
  },

  // --- unknown / residual ---
  {
    name: "empty name",
    event: { name: "" },
    bucket: "unknown",
    reasonIncludes: "missing-name",
  },
  {
    name: "Shell without command",
    event: { name: "Shell" },
    bucket: "unknown",
    reasonIncludes: "shell-missing-command",
  },
  {
    name: "Shell empty command",
    event: { name: "Shell", command: "   " },
    bucket: "unknown",
  },
  {
    name: "mystery tool",
    event: { name: "SomeVendorWidget" },
    bucket: "unknown",
  },
  {
    name: "MCP unknown",
    event: { name: "mcp__linear__save_issue" },
    bucket: "unknown",
  },
  // Prefer unknown over wrong verify (AC4)
  {
    name: "ambiguous TestHelper tool name",
    event: { name: "TestHelper" },
    bucket: "unknown",
    reasonIncludes: "ambiguous-verify",
  },
  {
    name: "npm run build is not verify",
    event: { name: "Shell", command: "npm run build" },
    bucket: "unknown",
    reasonIncludes: "unknown-script",
  },
  {
    name: "make alone is not verify",
    event: { name: "Shell", command: "make" },
    bucket: "unknown",
  },
  {
    name: "make install is not verify",
    event: { name: "Shell", command: "make install" },
    bucket: "unknown",
  },
  {
    name: "task deploy is not verify",
    event: { name: "Shell", command: "task deploy:prod" },
    bucket: "unknown",
  },
  {
    name: "node script is not verify",
    event: { name: "Shell", command: "node scripts/do-thing.mjs" },
    bucket: "unknown",
  },
  {
    name: "python script is not verify",
    event: { name: "Shell", command: "python scripts/migrate.py" },
    bucket: "unknown",
  },
  {
    name: "npx unknown package",
    event: { name: "Shell", command: "npx cowsay hello" },
    bucket: "unknown",
  },
];

describe("classifyToolEvent fixture table (#2967)", () => {
  for (const fx of FIXTURES) {
    it(`${fx.name} → ${fx.bucket}`, () => {
      const result = classifyToolEvent(fx.event);
      expect(result.bucket).toBe(fx.bucket);
      if (fx.reasonIncludes !== undefined) {
        expect(result.reason).toContain(fx.reasonIncludes);
      }
    });
  }
});

describe("classifyToolEvents", () => {
  it("preserves order and maps each event", () => {
    const events: ToolEventInput[] = [
      { name: "Read" },
      { name: "Write" },
      { name: "Shell", command: "vitest run" },
    ];
    const results = classifyToolEvents(events);
    expect(results.map((r) => r.bucket)).toEqual(["explore", "commit", "verify"]);
  });
});

describe("misclassification policy: prefer unknown over wrong verify", () => {
  const ambiguousCommands = [
    "npm run build",
    "npm run start",
    "pnpm run dev",
    "yarn run compile",
    "make all",
    "make install",
    "task release:cut",
    "task deploy",
    "node dist/server.js",
    "python app.py",
    "npx create-next-app",
    "docker build .",
    "curl https://example.com",
    "wget https://example.com",
    "./scripts/custom-gate.sh",
  ];

  for (const cmd of ambiguousCommands) {
    it(`does not classify as verify: ${cmd}`, () => {
      const r = classifyShellCommandForTest(cmd);
      expect(r.bucket).not.toBe("verify");
    });
  }

  it("ambiguous *test* tool names are unknown not verify", () => {
    expect(classifyToolEvent({ name: "TestHelper" }).bucket).toBe("unknown");
    expect(classifyToolEvent({ name: "run_my_test_suite" }).bucket).toBe("unknown");
    expect(classifyToolEvent({ name: "LintyMcLintface" }).bucket).toBe("unknown");
  });
});

describe("MCP nested name resolution", () => {
  it("classifies mcp__server__Read as explore when nested name matches", () => {
    // last segment "Read" is an explore name
    const r = classifyToolEvent({ name: "mcp__host__Read" });
    expect(r.bucket).toBe("explore");
  });

  it("classifies slash-separated nested Write as commit", () => {
    expect(classifyToolEvent({ name: "server/Write" }).bucket).toBe("commit");
  });

  it("leaves MCP with unknown nested segment as unknown", () => {
    expect(classifyToolEvent({ name: "mcp__linear__save_issue" }).bucket).toBe("unknown");
  });
});

describe("branch coverage edges (#2967)", () => {
  it("resolves command from args.cmd and args.script", () => {
    expect(classifyToolEvent({ name: "Shell", args: { cmd: "git status" } }).bucket).toBe(
      "explore",
    );
    expect(classifyToolEvent({ name: "Shell", args: { script: "vitest run" } }).bucket).toBe(
      "verify",
    );
  });

  it("prefers top-level command over args.command", () => {
    expect(
      classifyToolEvent({
        name: "Shell",
        command: "git status",
        args: { command: "git commit -m x" },
      }).bucket,
    ).toBe("explore");
  });

  it("skips sudo/env wrappers and env assigns", () => {
    expect(classifyShellCommandForTest("sudo git status").bucket).toBe("explore");
    expect(classifyShellCommandForTest("env FOO=1 git log -1").bucket).toBe("explore");
    expect(classifyShellCommandForTest("FOO=1 BAR=2 vitest run").bucket).toBe("verify");
    expect(classifyShellCommandForTest("time cargo test").bucket).toBe("verify");
  });

  it("strips path noise and .exe on bins", () => {
    expect(classifyShellCommandForTest("C:\\\\tools\\\\git.exe status").bucket).toBe("explore");
    expect(classifyShellCommandForTest("/usr/bin/vitest run").bucket).toBe("verify");
  });

  it("classifies git stash mutate vs explore", () => {
    expect(classifyShellCommandForTest("git stash").bucket).toBe("explore");
    expect(classifyShellCommandForTest("git stash list").bucket).toBe("explore");
    expect(classifyShellCommandForTest("git stash push -m wip").bucket).toBe("commit");
    expect(classifyShellCommandForTest("git stash pop").bucket).toBe("commit");
    expect(classifyShellCommandForTest("git stash apply").bucket).toBe("commit");
  });

  it("classifies unknown git subcommands as unknown", () => {
    expect(classifyShellCommandForTest("git foobar").bucket).toBe("unknown");
  });

  it("classifies sed explore vs inplace commit", () => {
    expect(classifyShellCommandForTest("sed -n '1,5p' file").bucket).toBe("explore");
    expect(classifyShellCommandForTest("sed -i 's/a/b/' file").bucket).toBe("commit");
  });

  it("classifies fs mutators and commit bins", () => {
    expect(classifyShellCommandForTest("rm -rf tmp").bucket).toBe("commit");
    expect(classifyShellCommandForTest("mkdir -p out").bucket).toBe("commit");
    expect(classifyShellCommandForTest("chmod +x script.sh").bucket).toBe("commit");
    expect(classifyShellCommandForTest("cp a b").bucket).toBe("commit");
    expect(classifyShellCommandForTest("touch x").bucket).toBe("commit");
  });

  it("classifies gh api mutate methods and incomplete gh", () => {
    expect(classifyShellCommandForTest("gh api --method POST /repos/o/r/issues").bucket).toBe(
      "commit",
    );
    expect(classifyShellCommandForTest("gh api -X PUT /repos/o/r").bucket).toBe("commit");
    expect(classifyShellCommandForTest("gh pr").bucket).toBe("unknown");
    expect(classifyShellCommandForTest("gh auth status").bucket).toBe("explore");
    expect(classifyShellCommandForTest("gh weirdcmd").bucket).toBe("unknown");
  });

  it("classifies cargo clippy/check, make test, node --test, npx eslint", () => {
    expect(classifyShellCommandForTest("cargo clippy").bucket).toBe("verify");
    expect(classifyShellCommandForTest("cargo check").bucket).toBe("verify");
    expect(classifyShellCommandForTest("make test").bucket).toBe("verify");
    expect(classifyShellCommandForTest("make lint").bucket).toBe("verify");
    expect(classifyShellCommandForTest("node --test").bucket).toBe("verify");
    expect(classifyShellCommandForTest("npx eslint .").bucket).toBe("verify");
    expect(classifyShellCommandForTest("pnpm exec eslint .").bucket).toBe("verify");
    expect(classifyShellCommandForTest("yarn run typecheck").bucket).toBe("verify");
  });

  it("classifies task/deft doctor namespaces and coordinate verbs", () => {
    expect(classifyShellCommandForTest("task doctor").bucket).toBe("verify");
    expect(classifyShellCommandForTest("task check:unit").bucket).toBe("verify");
    expect(classifyShellCommandForTest("task test:unit").bucket).toBe("verify");
    expect(classifyShellCommandForTest("deft session:start").bucket).toBe("coordinate");
    expect(classifyShellCommandForTest("directive swarm:launch").bucket).toBe("coordinate");
  });

  it("classifies VERIFY_NAMES and name heuristics", () => {
    expect(classifyToolEvent({ name: "run_tests" }).bucket).toBe("verify");
    expect(classifyToolEvent({ name: "MyCustomReader" }).bucket).toBe("explore");
    expect(classifyToolEvent({ name: "CustomFileWriter" }).bucket).toBe("commit");
    expect(classifyToolEvent({ name: "agent_dispatch" }).bucket).toBe("coordinate");
    expect(classifyToolEvent({ name: "weird_spawn_helper" }).bucket).toBe("coordinate");
  });

  it("classifies terminal-ish tool names as shell", () => {
    expect(classifyToolEvent({ name: "MyTerminalRunner", command: "git status" }).bucket).toBe(
      "explore",
    );
  });

  it("handles quoted tokens and tabs in shell", () => {
    expect(classifyShellCommandForTest("git\tstatus").bucket).toBe("explore");
    expect(classifyShellCommandForTest(`"git" "status"`).bucket).toBe("explore");
  });

  it("handles empty shell-no-bin after wrappers", () => {
    // only env assigns, no bin
    expect(classifyShellCommandForTest("FOO=1").bucket).toBe("unknown");
  });

  it("ignores non-string and blank command args", () => {
    expect(classifyToolEvent({ name: "Shell", args: { command: 42 } }).bucket).toBe("unknown");
    expect(classifyToolEvent({ name: "Shell", args: { command: "   " } }).bucket).toBe("unknown");
    expect(classifyToolEvent({ name: "Shell", command: "  ", args: { cmd: "ls" } }).bucket).toBe(
      "explore",
    );
    expect(classifyToolEvent({ name: "Shell", args: null }).bucket).toBe("unknown");
  });

  it("covers bun/yarn/dlx package-manager paths", () => {
    expect(classifyShellCommandForTest("bun test").bucket).toBe("verify");
    expect(classifyShellCommandForTest("yarn test").bucket).toBe("verify");
    expect(classifyShellCommandForTest("pnpm dlx cowsay hi").bucket).toBe("unknown");
    expect(classifyShellCommandForTest("yarn x eslint .").bucket).toBe("verify");
    expect(classifyShellCommandForTest("npm run").bucket).toBe("unknown");
    expect(classifyShellCommandForTest("npm run ci").bucket).toBe("verify");
  });

  it("covers command wrapper and typecheck npm script", () => {
    expect(classifyShellCommandForTest("command git status").bucket).toBe("explore");
    expect(classifyShellCommandForTest("pnpm run type-check").bucket).toBe("verify");
  });

  it("classifies whitespace-only shell command string as unknown", () => {
    // Direct shell path (bypasses resolveCommand empty filter)
    expect(classifyShellCommandForTest("   \t  ").bucket).toBe("unknown");
    expect(classifyShellCommandForTest("   \t  ").reason).toContain("shell-empty");
  });

  it("covers residual task with no verb and env-assign edge tokens", () => {
    expect(classifyShellCommandForTest("task").bucket).toBe("unknown");
    expect(classifyShellCommandForTest("task").reason).toContain("shell-task-unknown");
    // leading '=' is not a valid env assign; falls through as unknown bin
    expect(classifyShellCommandForTest("=bad git status").bucket).toBe("unknown");
    // bare scope verb without namespace
    expect(classifyShellCommandForTest("task scope").bucket).toBe("coordinate");
    expect(classifyShellCommandForTest("task swarm").bucket).toBe("coordinate");
  });

  it("covers non-string name and empty MCP segment", () => {
    // Runtime guard: name must be string
    expect(classifyToolEvent({ name: 123 as unknown as string }).bucket).toBe("unknown");
    expect(classifyToolEvent({ name: "mcp__" }).bucket).toBe("unknown");
    expect(classifyToolEvent({ name: "server/" }).bucket).toBe("unknown");
  });
});
