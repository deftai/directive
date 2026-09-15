import { execFileSync } from "node:child_process";
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
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stageContentPack } from "../deposit/stage-content-pack.js";
import { writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { installerManagedMatchers, isPass2CommitPath } from "../init-deposit/hygiene.js";
import { classifyUpdateState } from "../init-deposit/refresh.js";
import { writeMultiHostSkillDiscovery } from "../init-deposit/skill-discovery-deposit.js";
import { writeSlashCommandDeposit } from "../init-deposit/slash-deposit.js";
import { detectPreCutover } from "../vbrief-validate/precutover.js";
import { spawnCommandText } from "../verify-env/command-spawn.js";
import {
  expandPass2PorcelainPaths,
  PASS2_XBRIEF_LIFECYCLE_FOLDERS,
  parsePorcelainPaths,
  runPostPublishTwoPassFixture,
} from "./npm-ops.js";

const silentIo = { printf: () => undefined };

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("post-publish Pass 2 host-root porcelain (#4507)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fresh(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  it("does not bind #4398 warn-only, npm view, or continue-on-error", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/core/src/release-e2e/npm-ops.ts"),
      "utf8",
    );
    const yml = readFileSync(join(process.cwd(), ".github/workflows/npm-publish.yml"), "utf8");
    expect(src).toContain('["status", "--porcelain"]');
    expect(src).not.toContain("--untracked-files=all");
    expect(src).not.toMatch(/status", "--porcelain", "-uall/);
    expect(src).not.toContain("pollWorkspacePackages");
    expect(src).not.toContain("/->\\s+");
    expect(src).not.toContain(".replace(/\\/+$/");
    expect(src).toContain("pass2UpdateEnv");
    expect(src).toContain('node_modules", ".bin"');
    const fixtureFn = src.slice(src.indexOf("export function runPostPublishTwoPassFixture"));
    expect(fixtureFn.includes("npm view")).toBe(false);
    expect(yml).not.toMatch(/continue-on-error/);
    expect(yml).toContain("Post-publish two-pass fixture (#4271)");
  });

  it("does not prefix whole host dirs so consumer files stay app-owned", () => {
    const prefixes = installerManagedMatchers()
      .map((matcher) => matcher.prefix)
      .filter((prefix): prefix is string => typeof prefix === "string");
    expect(prefixes).not.toContain(".claude/");
    expect(prefixes).not.toContain(".cursor/");
    expect(prefixes).not.toContain(".codex/");
    expect(prefixes).not.toContain(".grok/");
    expect(prefixes).not.toContain(".github/");
    expect(isPass2CommitPath(".claude/")).toBe(false);
    expect(isPass2CommitPath(".cursor/")).toBe(false);
    expect(isPass2CommitPath(".codex/")).toBe(false);
    expect(isPass2CommitPath(".grok/")).toBe(false);
    expect(isPass2CommitPath(".github/")).toBe(false);
    expect(isPass2CommitPath(".claude/custom.md")).toBe(false);
    expect(isPass2CommitPath(".github/workflows/ci.yml")).toBe(false);
    expect(isPass2CommitPath(".agents/")).toBe(true);
    expect(isPass2CommitPath(".githooks/")).toBe(true);
  });

  it("seeds lifecycle folders so classifyUpdateState is not migration-required", () => {
    const clean = fresh("deft-4507-seed-");
    const consumer = join(clean, "consumer");
    mkdirSync(join(clean, "node_modules", "@deftai", "directive", "dist"), { recursive: true });
    writeFileSync(
      join(clean, "node_modules", "@deftai", "directive", "package.json"),
      JSON.stringify({ name: "@deftai/directive", version: "1.2.3" }),
    );
    writeFileSync(
      join(clean, "node_modules", "@deftai", "directive", "dist", "bin.js"),
      "export {};\n",
    );
    const [okFlag, reason] = runPostPublishTwoPassFixture(
      {
        cleanDir: clean,
        workspaceRoot: process.cwd(),
        version: "1.2.3",
        consumerDir: consumer,
        skipInstall: false,
      },
      {
        which: () => "/usr/bin/npm",
        spawnText: () => ({ status: 0, stdout: "{}", stderr: "" }),
        runGit: (_root, args) => {
          if (args.includes("--porcelain")) {
            return { status: 0, stdout: " M .deft/core/main.md\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(okFlag).toBe(true);
    expect(reason).toContain("two-pass fixture green");
    for (const folder of PASS2_XBRIEF_LIFECYCLE_FOLDERS) {
      expect(existsSync(join(consumer, "xbrief", folder))).toBe(true);
    }
    expect(detectPreCutover(consumer).preCutover).toBe(false);
    expect(classifyUpdateState(consumer).state).not.toBe("migration-required");
  });

  it("expands dest host-root porcelain dirs to files that pass isPass2CommitPath", () => {
    const consumer = fresh("deft-4507-porc-");
    git(consumer, ["init"]);
    git(consumer, ["config", "user.email", "deft-fixture@example.com"]);
    git(consumer, ["config", "user.name", "deft-fixture"]);
    writeFileSync(join(consumer, "README.md"), "seed\n");
    git(consumer, ["add", "-A"]);
    git(consumer, ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "seed"]);
    writeAgentHookDeposit(consumer, silentIo);
    writeSlashCommandDeposit(consumer, silentIo);
    writeMultiHostSkillDiscovery(consumer, silentIo);
    const porcelain = git(consumer, ["status", "--porcelain"]);
    expect(porcelain).not.toContain("-uall");
    const parsed = parsePorcelainPaths(porcelain);
    expect(parsed.some((path) => path === ".claude/" || path === ".claude")).toBe(true);
    expect(parsed.some((path) => path === ".github/" || path === ".github")).toBe(true);
    for (const path of parsed) {
      if (
        path === ".agents/" ||
        path === ".githooks/" ||
        path.startsWith(".agents/") ||
        path.startsWith(".githooks/")
      ) {
        continue;
      }
      expect(isPass2CommitPath(path.replace(/\\/g, "/"))).toBe(false);
    }
    const expanded = expandPass2PorcelainPaths(consumer, parsed);
    expect(expanded.some((path) => path.endsWith("/"))).toBe(false);
    const illegal = expanded.filter((path) => !isPass2CommitPath(path));
    expect(illegal).toEqual([]);
  });

  it("keeps Pass 2 fail-closed when a host-root dir contains an app file", () => {
    const consumer = fresh("deft-4507-mixed-");
    mkdirSync(join(consumer, ".claude", "commands"), { recursive: true });
    writeFileSync(join(consumer, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(consumer, ".claude", "custom.md"), "app\n");
    const expanded = expandPass2PorcelainPaths(consumer, [".claude/"]);
    expect(expanded).toContain(".claude/custom.md");
    expect(isPass2CommitPath(".claude/custom.md")).toBe(false);
    expect(expanded.some((path) => !isPass2CommitPath(path))).toBe(true);
  });

  it("parses rename dests and quoted paths without regex", () => {
    expect(parsePorcelainPaths("R  old.ts -> new.ts\n")).toEqual(["new.ts"]);
    expect(parsePorcelainPaths('R  "old a.ts" -> "new b.ts"\n')).toEqual(['"new b.ts"']);
    expect(parsePorcelainPaths(" M .deft/core/main.md\n")).toEqual([".deft/core/main.md"]);
    const padded = `R  old.ts ->${" ".repeat(20000)}new.ts\n`;
    expect(parsePorcelainPaths(padded)).toEqual(["new.ts"]);
  });

  it("keeps Pass 2 fail-closed when a collapsed dir cannot be fully inspected", () => {
    const consumer = fresh("deft-4507-unread-");
    writeFileSync(join(consumer, ".claude"), "not-a-dir\n");
    const expanded = expandPass2PorcelainPaths(consumer, [".claude/"]);
    expect(expanded).toContain(".claude/");
    expect(expanded.some((path) => !isPass2CommitPath(path))).toBe(true);
  });

  it("keeps Pass 2 fail-closed when expansion hits a non-regular entry", () => {
    const consumer = fresh("deft-4507-symlink-");
    mkdirSync(join(consumer, ".claude", "commands"), { recursive: true });
    writeFileSync(join(consumer, ".claude", "settings.json"), "{}\n");
    try {
      symlinkSync(join(consumer, ".claude", "settings.json"), join(consumer, ".claude", "alias"));
    } catch {
      return;
    }
    const expanded = expandPass2PorcelainPaths(consumer, [".claude/"]);
    expect(expanded).toContain(".claude/alias");
    expect(isPass2CommitPath(".claude/alias")).toBe(false);
  });

  it("locks live dest CLI update plus unstubbed git status --porcelain", () => {
    const clean = fresh("deft-4507-live-");
    const consumer = join(clean, "consumer");
    const contentRoot = join(clean, "content-pack");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(
      join(contentRoot, "package.json"),
      JSON.stringify({ name: "@deftai/directive-content", version: "0.0.0" }),
    );
    stageContentPack({ repoRoot: process.cwd(), destDir: contentRoot });
    const cliDir = join(clean, "node_modules", "@deftai", "directive", "dist");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(clean, "node_modules", "@deftai", "directive", "package.json"),
      JSON.stringify({ name: "@deftai/directive", version: "0.0.0", type: "module" }),
    );
    const refreshHref = pathToFileURL(
      join(process.cwd(), "packages", "core", "dist", "init-deposit", "refresh.js"),
    ).href;
    writeFileSync(
      join(cliDir, "bin.js"),
      [
        "import { runRefreshDepositCli, parseUpdateArgv } from " +
          JSON.stringify(refreshHref) +
          ";",
        "const contentRoot = process.env.DEFT_TEST_CONTENT_ROOT;",
        'const userArgv = process.argv.slice(2).filter((arg) => arg !== "update");',
        'const args = parseUpdateArgv(["--yes", "--upgrade", "--repo-root", ".", "--json"], userArgv);',
        "const code = await runRefreshDepositCli({",
        "  ...args,",
        "  writeOut: (text) => process.stdout.write(text),",
        "  writeErr: (text) => process.stderr.write(text),",
        "  seams: {",
        "    resolveContentRoot: async () => contentRoot,",
        "    evaluateAgentHookReadiness: () => ({",
        "      code: 0,",
        '      message: "fixture: hook readiness skipped",',
        '      stream: "stdout",',
        "      skipped: true,",
        '      liveStatus: "skipped",',
        "      hosts: [],",
        "      registrations: [],",
        "      liveProbe: null,",
        "    }),",
        "  },",
        "});",
        "process.exit(code);",
        "",
      ].join("\n"),
      "utf8",
    );
    const [okFlag, reason] = runPostPublishTwoPassFixture(
      {
        cleanDir: clean,
        workspaceRoot: process.cwd(),
        version: "0.0.0",
        consumerDir: consumer,
        skipInstall: false,
      },
      {
        which: () => "npm",
        spawnText: (cmd, args, opts) => {
          if (args.includes("install") && !args.includes("update")) {
            return { status: 0, stdout: "", stderr: "" };
          }
          const env = { ...(opts?.env ?? process.env), DEFT_TEST_CONTENT_ROOT: contentRoot };
          return spawnCommandText(cmd, args, { ...opts, env });
        },
      },
    );
    expect(okFlag, reason).toBe(true);
    expect(reason).toContain("two-pass fixture green");
  }, 120_000);
});
