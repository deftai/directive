import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import type { AgentHookReadinessResult } from "../verify-env/agent-hook-readiness.js";
import {
  buildInstallSummaryJson,
  createUserConfigDir,
  parseInitArgv,
  printNextSteps,
  runInitDeposit,
  runInitDepositCli,
  userConfigDir,
} from "./init-deposit.js";
import { type LegacyLayoutDetection, LegacyLayoutRefusedError } from "./legacy-detect.js";

// `JSON.parse` returns top-level `null` (not a throw) for the literal `null`,
// so a guarded parse keeps property reads from blowing up with a TypeError
// outside the parse boundary.
function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") {
    throw new Error(
      `expected a JSON object payload, received ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

const FAKE_LEGACY: LegacyLayoutDetection = {
  legacy: true,
  kind: "orphan-deft-version",
  detail: "Found an orphan .deft/VERSION manifest with no .deft/core/ directory.",
  evidence: [".deft/VERSION"],
};

function agentHookReadiness(code: 0 | 1 = 0): AgentHookReadinessResult {
  return {
    code,
    message:
      code === 0
        ? "✓ deft agent hook readiness: live green"
        : "❌ deft agent hook readiness: live failed",
    stream: code === 0 ? "stdout" : "stderr",
    skipped: false,
    liveStatus: code === 0 ? "functional" : "non-functional",
    hosts: [],
    registrations: [],
    liveProbe: {
      code,
      message: code === 0 ? "live green" : "live failed",
      cases: [],
      hosts: [],
      durationMs: 4,
    },
  };
}

describe("parseInitArgv", () => {
  it("merges canonical and user argv", () => {
    const parsed = parseInitArgv(
      ["--yes", "--repo-root", ".", "--json"],
      ["--repo-root", "/tmp/proj"],
    );
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.jsonOut).toBe(true);
    expect(parsed.projectDir).toBe(resolve("/tmp/proj"));
  });

  it("accepts Windows-style aliases", () => {
    const parsed = parseInitArgv([], ["/yes", "/json", "/repo-root", "/tmp/win"]);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.jsonOut).toBe(true);
    expect(parsed.projectDir).toBe(resolve("/tmp/win"));
  });

  it("honors DEFT_USER_PATH for the config directory", () => {
    const previous = process.env.DEFT_USER_PATH;
    const customDir = mkdtempSync(join(tmpdir(), "deft-user-"));
    process.env.DEFT_USER_PATH = customDir;
    try {
      expect(userConfigDir()).toBe(customDir);
      const lines: string[] = [];
      writeFileSync(join(customDir, "USER.md"), "# existing\n", "utf8");
      expect(createUserConfigDir({ printf: (text) => lines.push(text) })).toBe(customDir);
      expect(lines.join("")).toContain("keeping existing file");
    } finally {
      if (previous === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = previous;
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});

describe("runInitDeposit", () => {
  const created: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  function installFakeContentPackage(projectRoot: string): string {
    const pkgDir = join(projectRoot, "node_modules", "@deftai", "directive-content");
    mkdirSync(join(pkgDir, "templates"), { recursive: true });
    mkdirSync(join(pkgDir, "vbrief", "schemas"), { recursive: true });
    mkdirSync(join(pkgDir, ".githooks"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version: "0.53.0" }),
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(pkgDir, "templates/agents-entry.md"),
    );
    writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(pkgDir, "vbrief", "schemas", "cache-meta.schema.json"), "{}\n", "utf8");
    writeFileSync(join(pkgDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"), "{}\n", "utf8");
    writeFileSync(join(pkgDir, "vbrief", "vbrief.md"), "# vbrief\n", "utf8");
    writeFileSync(
      join(pkgDir, ".githooks", "pre-commit"),
      readFileSync(join(process.cwd(), ".githooks/pre-commit"), "utf8"),
      "utf8",
    );
    chmodSync(join(pkgDir, ".githooks", "pre-commit"), 0o755);
    writeFileSync(
      join(pkgDir, ".githooks", "pre-push"),
      readFileSync(join(process.cwd(), ".githooks/pre-push"), "utf8"),
      "utf8",
    );
    chmodSync(join(pkgDir, ".githooks", "pre-push"), 0o755);
    writeFileSync(
      join(pkgDir, ".githooks", "_deft-run.sh"),
      readFileSync(join(process.cwd(), ".githooks/_deft-run.sh"), "utf8"),
      "utf8",
    );
    writeFileSync(join(pkgDir, "Taskfile.yml"), "version: '3'\n", "utf8");
    return pkgDir;
  }

  it("creates a complete greenfield deposit without spawning deft-install", async () => {
    const spawnSpy = vi.spyOn(spawnSync as never, "apply" as never).mockImplementation(() => {
      throw new Error("spawnSync should not be called on TS-native init happy path");
    });

    const project = freshRoot("init-deposit-");
    const contentRoot = installFakeContentPackage(project);
    const lines: string[] = [];

    const result = await runInitDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true },
      { printf: (text) => lines.push(text) },
      {
        resolveContentRoot: async () => contentRoot,
        nowIso: () => "2026-06-24T12:00:00Z",
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
      },
    );

    expect(result.deftDir).toBe(join(project, ".deft/core"));
    expect(readFileSync(join(result.deftDir, "main.md"), "utf8")).toContain("# Deft");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain("deft:managed-section");
    expect(existsSync(join(project, "xbrief", "active", ".gitkeep"))).toBe(true);
    expect(existsSync(join(project, ".agents/skills/deft-directive-sync/SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".githooks", "pre-commit"))).toBe(true);
    expect(readFileSync(join(project, ".githooks", "pre-commit"), "utf8")).toContain(
      "deft verify:branch",
    );
    expect(readFileSync(join(project, ".githooks", "_deft-run.sh"), "utf8")).toContain(
      "run_deft()",
    );
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain(
      "./.deft/core/Taskfile.yml",
    );
    expect(readFileSync(join(project, "greptile.json"), "utf8")).toContain(".deft/core/**");
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".deft/core/");
    expect(readFileSync(join(project, ".codex", "hooks.json"), "utf8")).toContain(
      "deft-hook --host codex --event tool.before",
    );
    expect(result.taskfileWired).toBe(true);
    expect(lines.join("")).toContain("AGENTS.md created");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("emits JSON on stdout and wizard UX on stderr in --json mode", async () => {
    const project = freshRoot("init-deposit-json-");
    const contentRoot = installFakeContentPackage(project);
    const out: string[] = [];
    const err: string[] = [];

    const code = await runInitDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: {
        resolveContentRoot: async () => contentRoot,
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(out.join(""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object from init --json");
    }
    const payload = parsed as Record<string, unknown>;
    expect(payload.success).toBe(true);
    expect(payload.deposit_completed).toBe(true);
    expect(payload.action).toBe("install");
    expect(payload.taskfile_wired).toBe(true);
    expect(payload.agent_hook_readiness).toMatchObject({
      ready: true,
      live_status: "functional",
    });
    expect(err.join("")).toContain("Deft installed successfully");
    expect(err.join("")).toContain("deft agent hook readiness: live green");
  });

  it("keeps a completed deposit but exits non-zero when post-deposit hook readiness fails", async () => {
    const project = freshRoot("init-deposit-readiness-failed-");
    const contentRoot = installFakeContentPackage(project);
    const out: string[] = [];
    const err: string[] = [];

    const code = await runInitDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: {
        resolveContentRoot: async () => contentRoot,
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
        evaluateAgentHookReadiness: () => agentHookReadiness(1),
      },
    });

    expect(code).toBe(1);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(parseJsonObject(out.join(""))).toMatchObject({
      success: false,
      deposit_completed: true,
      agent_hook_readiness: {
        ready: false,
        live_status: "non-functional",
      },
    });
    expect(err.join("")).toContain("deft agent hook readiness: live failed");
  });

  it("buildInstallSummaryJson keeps stable array fields", () => {
    const summary = buildInstallSummaryJson({
      result: {
        projectDir: "/proj",
        deftDir: "/proj/.deft/core",
        skillsCreated: true,
        taskfileWired: true,
        configDir: "/home/me/.config/deft",
        legacyLayout: false,
        stagedPaths: ["Taskfile.yml", ".deft/core"],
      },
      options: { projectDir: "/proj", jsonOut: true, nonInteractive: true },
      readiness: undefined,
    });
    expect(summary.missing_tools).toEqual([]);
    expect(summary.dirty_files).toEqual([]);
    expect(summary.staged_paths).toEqual(["Taskfile.yml", ".deft/core"]);
  });

  it("printNextSteps includes friendly wizard lines", () => {
    const lines: string[] = [];
    printNextSteps(
      {
        projectDir: "/proj",
        deftDir: "/proj/.deft/core",
        skillsCreated: true,
        taskfileWired: true,
        configDir: "/cfg",
        legacyLayout: false,
        stagedPaths: [],
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).toContain("Next steps:");
  });

  it("printNextSteps nudges migrate when deposit lacks npm provenance (#2059)", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const lines: string[] = [];
    printNextSteps(
      {
        projectDir: root,
        deftDir: join(root, ".deft", "core"),
        skillsCreated: true,
        taskfileWired: true,
        configDir: "/cfg",
        legacyLayout: false,
        stagedPaths: [],
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).toContain("directive migrate");
  });

  it("printNextSteps omits migrate nudge when deposit is already npm-managed", () => {
    const root = makeProject(`${VENDORED_MANIFEST}managed_by: 'npm'\n`);
    const lines: string[] = [];
    printNextSteps(
      {
        projectDir: root,
        deftDir: join(root, ".deft", "core"),
        skillsCreated: true,
        taskfileWired: true,
        configDir: "/cfg",
        legacyLayout: false,
        stagedPaths: [],
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).not.toContain("directive migrate");
  });

  function makeProject(manifestBody: string): string {
    const root = freshRoot("init-nudge-");
    const coreDir = join(root, ".deft", "core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "VERSION"), manifestBody, "utf8");
    return root;
  }

  const VENDORED_MANIFEST = [
    "ref: 'v0.40.0'",
    "sha: 'deadbeef'",
    "tag: 'v0.40.0'",
    "install_root: '.deft/core'",
    "",
  ].join("\n");

  it("printNextSteps notes when skills were already present", () => {
    const lines: string[] = [];
    printNextSteps(
      {
        projectDir: "/proj",
        deftDir: "/proj/.deft/core",
        skillsCreated: false,
        taskfileWired: false,
        configDir: "/cfg",
        legacyLayout: false,
        stagedPaths: [],
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).toContain("already present");
  });

  it("falls back to core package version when content package.json lacks version", async () => {
    const project = freshRoot("init-version-fallback-");
    const contentRoot = installFakeContentPackage(project);
    writeFileSync(
      join(contentRoot, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME }),
      "utf8",
    );

    await runInitDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readPackageVersion: () => "0.99.0",
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
      },
    );

    expect(readFileSync(join(project, ".deft/core", "VERSION"), "utf8")).toContain("0.99.0");
  });

  it("refuses init when a live procedure names a pruned Python helper (#3602 C3)", async () => {
    const project = freshRoot("init-c3-mut-");
    const contentRoot = installFakeContentPackage(project);
    mkdirSync(join(contentRoot, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(contentRoot, "skills", "demo", "SKILL.md"),
      "! Agents MUST run `scripts/missing.py` before preflight.\n",
      "utf8",
    );
    await expect(
      runInitDeposit(
        { projectDir: project, jsonOut: false, nonInteractive: true },
        { printf: () => {} },
        {
          resolveContentRoot: async () => contentRoot,
          gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
        },
      ),
    ).rejects.toThrow(/unique live-invalid helper target/);
    expect(existsSync(join(project, ".deft/core", "VERSION"))).toBe(false);
  });

  it("returns exit code 1 when deposit fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runInitDepositCli({
      projectDir: "/nonexistent/should-not-matter",
      jsonOut: true,
      nonInteractive: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: {
        resolveContentRoot: async () => {
          throw new Error("content package missing");
        },
      },
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("init_deposit_failed");
    expect(err.join("")).toContain("content package missing");
  });

  it("runInitDeposit throws LegacyLayoutRefusedError on a legacy layout (no deposit)", async () => {
    await expect(
      runInitDeposit(
        { projectDir: "/proj-legacy", jsonOut: false, nonInteractive: true },
        { printf: () => {} },
        {
          detectLegacy: () => FAKE_LEGACY,
          resolveContentRoot: async () => {
            throw new Error("resolveContentRoot must not be reached when refusing");
          },
        },
      ),
    ).rejects.toBeInstanceOf(LegacyLayoutRefusedError);
  });

  it("init refuses a legacy layout with the two-step recovery (json mode)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runInitDepositCli({
      projectDir: "/proj-legacy",
      jsonOut: true,
      nonInteractive: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: { detectLegacy: () => FAKE_LEGACY },
    });

    expect(code).toBe(2);
    const parsed = parseJsonObject(out.join(""));
    expect(parsed.action).toBe("refuse");
    expect(parsed.legacy_layout).toBe(true);
    expect(parsed.legacy_layout_kind).toBe("orphan-deft-version");
    expect(parsed.upgrading_doc_url).toContain("UPGRADING.md");
    expect(err.join("")).toContain("refusing to deposit");
    expect(err.join("")).toContain("github.com/deftai/directive/blob/master/content/UPGRADING.md");
  });

  it("init refuses a legacy layout in interactive mode (message on stdout)", async () => {
    const out: string[] = [];
    const code = await runInitDepositCli({
      projectDir: "/proj-legacy",
      jsonOut: false,
      nonInteractive: true,
      writeOut: (text) => out.push(text),
      writeErr: () => {},
      seams: { detectLegacy: () => FAKE_LEGACY },
    });

    expect(code).toBe(2);
    expect(out.join("")).toContain("refusing to deposit");
    expect(out.join("")).toContain("npx @deftai/directive init");
  });

  it("prints wizard UX to stdout in interactive mode", async () => {
    const project = freshRoot("init-deposit-interactive-");
    const contentRoot = installFakeContentPackage(project);
    const out: string[] = [];

    const code = await runInitDepositCli({
      projectDir: project,
      jsonOut: false,
      nonInteractive: true,
      writeOut: (text) => out.push(text),
      writeErr: () => {},
      seams: {
        resolveContentRoot: async () => contentRoot,
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("Deft installed successfully");
    expect(out.join("")).toContain("deft agent hook readiness: live green");
  });
});
