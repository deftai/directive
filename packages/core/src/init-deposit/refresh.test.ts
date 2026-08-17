import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolutionFacts } from "@deftai/directive-types";
import { RESOLUTION_PLAN_SCHEMA_VERSION } from "@deftai/directive-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { runChecksImpl } from "../doctor/checks.js";
import { emptyMutationSummary } from "../fs/mutation-ledger.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import type { ClassifySeams } from "../resolution/index.js";
import type { AgentHookReadinessResult } from "../verify-env/agent-hook-readiness.js";
import { evaluate as evaluateHooksInstalled } from "../verify-env/verify-hooks-installed.js";
import { detectXbriefConvergence } from "../xbrief-migrate/detect.js";
import { type LegacyLayoutDetection, LegacyLayoutRefusedError } from "./legacy-detect.js";
import {
  buildVersionSkewNotice,
  formatPrettierSensitiveAnnounce,
  frameworkRefreshSideEffects,
  NOT_INITIALIZED_MESSAGE,
  parseUpdateArgv,
  prettierSensitiveRewrites,
  printRefreshSideEffects,
  printUpdateComplete,
  runRefreshDeposit,
  runRefreshDepositCli,
  UPDATE_REFUSED_EXIT_CODE,
  updateStateFromPlan,
} from "./refresh.js";

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
  kind: "legacy-deft-prefixed",
  detail: "Found a legacy deft/-prefixed framework install.",
  evidence: ["deft/"],
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

describe("parseUpdateArgv", () => {
  it("records --upgrade from canonical argv", () => {
    const parsed = parseUpdateArgv(["--yes", "--upgrade", "--repo-root", ".", "--json"], []);
    expect(parsed.upgrade).toBe(true);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.jsonOut).toBe(true);
  });
});

describe("buildVersionSkewNotice", () => {
  it("notices engine vs content divergence", () => {
    const notice = buildVersionSkewNotice("0.55.2", "0.55.0", "0.54.0");
    expect(notice).toContain("Version skew");
    expect(notice).toContain("directive-core is v0.55.2");
    expect(notice).toContain("directive-content is v0.55.0");
  });

  it("notices content vs recorded deposit divergence when engine matches content", () => {
    const notice = buildVersionSkewNotice("0.55.0", "0.55.0", "0.54.0");
    expect(notice).toContain("recorded manifest was v0.54.0");
  });

  it("returns null when versions align", () => {
    expect(buildVersionSkewNotice("0.55.0", "0.55.0", "0.55.0")).toBeNull();
    expect(buildVersionSkewNotice("0.55.0", "0.55.0", null)).toBeNull();
  });
});

describe("frameworkRefreshSideEffects", () => {
  it("classifies core and installer-managed paths", () => {
    const porcelain = [" M .deft/core/VERSION", " M AGENTS.md", " M src/app.ts"].join("\n");
    expect(
      frameworkRefreshSideEffects("/proj", {
        readPorcelain: () => porcelain,
        readSemanticDiffNames: () => null,
      }).files.sort(),
    ).toEqual([".deft/core/VERSION", "AGENTS.md"].sort());
  });

  it("strips git-quoted porcelain paths", () => {
    const porcelain = ' M ".deft/core/VERSION"';
    expect(
      frameworkRefreshSideEffects("/proj", {
        readPorcelain: () => porcelain,
        readSemanticDiffNames: () => null,
      }).files,
    ).toEqual([".deft/core/VERSION"]);
  });

  it("returns empty outside git", () => {
    expect(frameworkRefreshSideEffects("/proj", { readPorcelain: () => null })).toEqual({
      files: [],
      crlfOnlyCoreFiles: [],
    });
  });

  it("suppresses core paths when only CRLF/LF noise remains", () => {
    const porcelain = [" M .deft/core/VERSION", " M AGENTS.md"].join("\n");
    expect(
      frameworkRefreshSideEffects("/proj", {
        readPorcelain: () => porcelain,
        readSemanticDiffNames: () => [],
      }),
    ).toEqual({
      files: ["AGENTS.md"],
      crlfOnlyCoreFiles: [".deft/core/VERSION"],
    });
  });
});

describe("printRefreshSideEffects", () => {
  it("emits the #1671 disclosure block", () => {
    const lines: string[] = [];
    printRefreshSideEffects(
      { printf: (text) => lines.push(text) },
      { files: [".deft/core/VERSION"], crlfOnlyCoreFiles: [] },
    );
    expect(lines.join("")).toContain("AGENTS.md refresh side effects (#1671)");
    expect(lines.join("")).toContain(".deft/core/VERSION");
    expect(lines.join("")).not.toContain("no post-stage stragglers");
  });

  it("prints only the Windows hint for CRLF-only core noise", () => {
    const lines: string[] = [];
    printRefreshSideEffects(
      { printf: (text) => lines.push(text) },
      { files: [], crlfOnlyCoreFiles: [".deft/core/VERSION"] },
    );
    const out = lines.join("");
    expect(out).toContain("Windows line-ending note (#2118)");
    expect(out).not.toContain("framework deposit commit");
  });
});

describe("runRefreshDeposit", () => {
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

  function installFakeContentPackage(projectRoot: string, version = "0.53.0"): string {
    const pkgDir = join(projectRoot, "node_modules", "@deftai", "directive-content");
    mkdirSync(join(pkgDir, "templates"), { recursive: true });
    mkdirSync(join(pkgDir, "vbrief", "schemas"), { recursive: true });
    mkdirSync(join(pkgDir, ".githooks"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version }),
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(pkgDir, "templates/agents-entry.md"),
    );
    // Real @deftai/directive-content ships .githooks/ (see packages/content prepack).
    for (const name of ["pre-commit", "pre-push", "_deft-run.sh"] as const) {
      copyFileSync(join(process.cwd(), ".githooks", name), join(pkgDir, ".githooks", name));
      if (name !== "_deft-run.sh") {
        chmodSync(join(pkgDir, ".githooks", name), 0o755);
      }
    }
    writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(pkgDir, "vbrief", "schemas", "vbrief-core.schema.json"), "legacy\n", "utf8");
    writeFileSync(
      join(pkgDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "current\n",
      "utf8",
    );
    return pkgDir;
  }

  function initGitRepo(root: string): void {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  }

  it("refreshes .deft/core and rewrites a stale managed section", async () => {
    const project = freshRoot("refresh-stale-");
    const contentRoot = installFakeContentPackage(project);
    initGitRepo(project);

    writeFileSync(
      join(project, "AGENTS.md"),
      `# Operator prose\n\n<!-- deft:managed-section v2 -->\nOld body\n${AGENTS_MANAGED_CLOSE}\n`,
      "utf8",
    );
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(
      join(project, ".codex", "hooks.json"),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "./consumer-check.sh" }],
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n', "utf8");

    const lines: string[] = [];
    const result = await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: (text) => lines.push(text) },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-06-24T12:00:00Z",
        gitPorcelain: () => " M AGENTS.md\n M .deft/core/VERSION\n",
      },
    );

    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(agents).toContain("Operator prose");
    expect(agents).toContain("deft:managed-section v3");
    expect(agents).not.toContain("Old body");
    expect(result.agentsMdUpdated).toBe(true);
    expect(lines.join("")).toContain("refresh side effects (#1671)");
    expect(existsSync(join(result.deftDir, "main.md"))).toBe(true);
    const codexHooks = readFileSync(join(project, ".codex", "hooks.json"), "utf8");
    expect(codexHooks).toContain("./consumer-check.sh");
    expect(codexHooks).toContain("deft-hook --host codex --event tool.before");
    expect(readFileSync(join(project, ".codex", "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
  });

  it("is idempotent on a second run (no AGENTS.md rewrite)", async () => {
    const project = freshRoot("refresh-idem-");
    const contentRoot = installFakeContentPackage(project);
    const io = { printf: vi.fn() };

    const seams = {
      resolveContentRoot: async () => contentRoot,
      readEngineVersion: () => "0.53.0",
      nowIso: () => "2026-06-24T12:00:00Z",
      gitPorcelain: () => "",
    };

    const args = {
      projectDir: project,
      jsonOut: false,
      nonInteractive: true,
      upgrade: true,
    };
    await runRefreshDeposit(args, io, seams);
    const firstAgents = readFileSync(join(project, "AGENTS.md"), "utf8");
    const firstVersion = readFileSync(join(project, ".deft", "core", "VERSION"), "utf8");
    rmSync(join(project, ".deft-version"), { force: true });

    io.printf.mockClear();
    const copyContent = vi.fn(async () => {
      throw new Error("copyContent must not run for an already-current refresh");
    });
    const nowIso = vi.fn(() => "2026-06-25T12:00:00Z");
    const second = await runRefreshDeposit(args, io, {
      ...seams,
      copyContent,
      nowIso,
      gitPorcelain: () => " M .deft/core/VERSION\n",
      gitSemanticDiffNames: () => [],
    });
    const secondAgents = readFileSync(join(project, "AGENTS.md"), "utf8");
    const secondVersion = readFileSync(join(project, ".deft", "core", "VERSION"), "utf8");

    expect(secondAgents).toBe(firstAgents);
    expect(secondVersion).toBe(firstVersion);
    expect(existsSync(join(project, ".deft-version"))).toBe(false);
    expect(second.agentsMdUpdated).toBe(false);
    expect(second.alreadyCurrent).toBe(true);
    expect(second.strategy).toBe("no-op");
    expect(second.stagedPaths).toEqual([]);
    expect(copyContent).not.toHaveBeenCalled();
    expect(nowIso).not.toHaveBeenCalled();
    const out = io.printf.mock.calls.flat().join("");
    expect(out).toContain("Framework payload already current");
    expect(out).toContain("Windows line-ending note (#2118)");
    expect(out).not.toContain("Commit hygiene");
    expect(out).not.toContain("framework deposit commit");
  });

  function seedDepositGithooks(deftDir: string): void {
    mkdirSync(join(deftDir, ".githooks"), { recursive: true });
    for (const name of ["pre-commit", "pre-push", "_deft-run.sh"] as const) {
      copyFileSync(join(process.cwd(), ".githooks", name), join(deftDir, ".githooks", name));
      if (name !== "_deft-run.sh") {
        chmodSync(join(deftDir, ".githooks", name), 0o755);
      }
    }
  }

  it("repairs missing project-root git hooks on an already-current hybrid deposit (#2530)", async () => {
    const project = freshRoot("refresh-current-hooks-");
    const contentRoot = installFakeContentPackage(project, "0.78.0");
    initGitRepo(project);
    const io = { printf: vi.fn() };
    const args = {
      projectDir: project,
      jsonOut: false,
      nonInteractive: true,
      upgrade: true,
    };
    const seams = {
      resolveContentRoot: async () => contentRoot,
      readEngineVersion: () => "0.78.0",
      nowIso: () => "2026-07-16T12:00:00Z",
      gitPorcelain: () => "",
      gitHooks: {
        getHooksPath: () => "",
        setHooksPath: () => true,
      },
    };

    await runRefreshDeposit(args, io, seams);
    seedDepositGithooks(join(project, ".deft", "core"));
    rmSync(join(project, ".githooks"), { recursive: true, force: true });

    const copyContent = vi.fn(async () => {
      throw new Error("copyContent must not run for an already-current refresh");
    });
    const repaired = await runRefreshDeposit(args, io, { ...seams, copyContent });

    expect(repaired.alreadyCurrent).toBe(true);
    expect(copyContent).not.toHaveBeenCalled();
    expect(existsSync(join(project, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(project, ".githooks", "pre-push"))).toBe(true);
    expect(existsSync(join(project, ".githooks", "_deft-run.sh"))).toBe(true);

    const hooksCheck = evaluateHooksInstalled(project, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
      platform: "win32",
    });
    expect(hooksCheck.code).toBe(0);
  });

  it("repairs stale xbrief derivatives without copying an already-current payload (#2595)", async () => {
    const project = freshRoot("refresh-current-projections-");
    const contentRoot = installFakeContentPackage(project, "0.78.0");
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "active", "seed.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Seed", status: "running", items: [] },
      }),
      "utf8",
    );
    const io = { printf: vi.fn() };
    const args = {
      projectDir: project,
      jsonOut: false,
      nonInteractive: true,
      upgrade: true,
    };
    const seams = {
      resolveContentRoot: async () => contentRoot,
      readEngineVersion: () => "0.78.0",
      nowIso: () => "2026-07-16T12:00:00Z",
      gitPorcelain: () => "",
    };

    await runRefreshDeposit(args, io, seams);
    mkdirSync(join(project, "xbrief", "schemas"), { recursive: true });
    writeFileSync(join(project, "xbrief", ".deft-version"), "0.72.0\n", "utf8");
    writeFileSync(join(project, "xbrief", "schemas", "vbrief-core.schema.json"), "stale\n", "utf8");
    rmSync(join(project, "xbrief", "schemas", "xbrief-core-0.8.schema.json"), { force: true });

    const copyContent = vi.fn(async () => {
      throw new Error("copyContent must not run for an already-current refresh");
    });
    const repaired = await runRefreshDeposit(args, io, { ...seams, copyContent });

    expect(repaired.strategy).toBe("no-op");
    expect(copyContent).not.toHaveBeenCalled();
    expect(readFileSync(join(project, "xbrief", ".deft-version"), "utf8")).toBe("0.78.0\n");
    expect(existsSync(join(project, "xbrief", "schemas", "vbrief-core.schema.json"))).toBe(false);
    expect(
      readFileSync(join(project, "xbrief", "schemas", "xbrief-core-0.8.schema.json"), "utf8"),
    ).toBe("current\n");

    await runRefreshDeposit(args, io, { ...seams, copyContent });
    expect(copyContent).not.toHaveBeenCalled();

    const doctor = runChecksImpl(project, {
      isDir: (path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      },
    });
    expect(doctor.checks.find((check) => check.name === "manifest-agreement")?.status).toBe("pass");
    expect(
      doctor.checks.find((check) => check.name === "stale-xbrief-schema-deposit")?.status,
    ).not.toBe("fail");
  });

  it.each([
    ["legacy-only", false],
    ["legacy plus cache-only support", true],
  ])("does not project schemas before xbrief migration (%s) (#2595)", async (_label, cacheOnly) => {
    const project = freshRoot("refresh-pre-migration-projections-");
    const contentRoot = installFakeContentPackage(project, "0.78.0");
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(project, "vbrief", "active", "seed.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6", description: "legacy fixture" },
        plan: { title: "Legacy seed", status: "running", items: [] },
      }),
      "utf8",
    );
    if (cacheOnly) {
      mkdirSync(join(project, "xbrief", ".triage-cache", "issues"), { recursive: true });
      writeFileSync(join(project, "xbrief", ".triage-cache", "issues", "2595.json"), "{}\n");
    }

    const io = { printf: vi.fn() };
    const args = {
      projectDir: project,
      jsonOut: false,
      nonInteractive: true,
      upgrade: true,
    };
    const seams = {
      resolveContentRoot: async () => contentRoot,
      readEngineVersion: () => "0.78.0",
      nowIso: () => "2026-07-16T12:00:00Z",
      gitPorcelain: () => "",
    };

    await runRefreshDeposit(args, io, seams);
    await runRefreshDeposit(args, io, {
      ...seams,
      copyContent: async () => {
        throw new Error("copyContent must not run for an already-current refresh");
      },
    });

    expect(existsSync(join(project, "xbrief", "schemas"))).toBe(false);
    expect(detectXbriefConvergence(project).state).toBe("legacy-only");
  });

  it("discloses core side-effects when AGENTS.md is already current", async () => {
    const project = freshRoot("refresh-core-disclosure-");
    const contentRoot = installFakeContentPackage(project);
    const lines: string[] = [];

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: (text) => lines.push(text) },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-06-24T12:00:00Z",
        gitPorcelain: () => " M .deft/core/VERSION\n",
      },
    );

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: (text) => lines.push(text) },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-06-24T12:00:00Z",
        gitPorcelain: () => " M .deft/core/VERSION\n",
      },
    );

    expect(lines.join("")).toContain("refresh side effects (#1671)");
    expect(lines.join("")).toContain(".deft/core/VERSION");
  });

  it("emits a version-skew notice when engine and content diverge", async () => {
    const project = freshRoot("refresh-skew-");
    const contentRoot = installFakeContentPackage(project, "0.52.0");
    const lines: string[] = [];

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: (text) => lines.push(text) },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-06-24T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    expect(lines.join("")).toContain("Version skew");
    expect(lines.join("")).toContain("directive-core is v0.53.0");
    expect(lines.join("")).toContain("directive-content is v0.52.0");
  });

  it("syncs vbrief/.deft-version to the deposited content version (#2055)", async () => {
    const project = freshRoot("refresh-marker-");
    const contentRoot = installFakeContentPackage(project, "0.61.0");
    mkdirSync(join(project, "xbrief"), { recursive: true });
    writeFileSync(join(project, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    writeFileSync(join(project, "xbrief", ".deft-version"), "0.60.0\n", "utf8");

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.61.0",
        nowIso: () => "2026-06-28T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    expect(readFileSync(join(project, "xbrief", ".deft-version"), "utf8").trim()).toBe("0.61.0");
  });

  it("preserves managed_by: npm across a payload refresh (#2056)", async () => {
    const project = freshRoot("refresh-managed-");
    const contentRoot = installFakeContentPackage(project, "0.61.0");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      "ref: 'v0.60.0'\ntag: 'v0.60.0'\nsha: 'content-package'\ninstall_root: '.deft/core'\nmanaged_by: 'npm'\n",
      "utf8",
    );

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.61.0",
        nowIso: () => "2026-06-28T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    const manifest = readFileSync(join(deftDir, "VERSION"), "utf8");
    expect(manifest).toContain("tag: 'v0.61.0'");
    expect(manifest).toContain("managed_by: 'npm'");
  });

  it("full-tree replace removes dst-only stale/malicious agent content on refresh (#2913)", async () => {
    const project = freshRoot("refresh-full-replace-");
    const contentRoot = installFakeContentPackage(project, "0.62.0");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "agents", "planted"), { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: 'v0.61.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "main.md"), "# old\n", "utf8");
    writeFileSync(
      join(deftDir, "agents", "planted", "malicious-skill.md"),
      "# pwned — must not survive upgrade\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "stale-bridge.go"), "package main\n", "utf8");

    const result = await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.62.0",
        nowIso: () => "2026-07-29T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    expect(result.alreadyCurrent).toBe(false);
    expect(result.strategy).toBe("file-swap");
    expect(existsSync(join(deftDir, "agents", "planted", "malicious-skill.md"))).toBe(false);
    expect(existsSync(join(deftDir, "stale-bridge.go"))).toBe(false);
    expect(existsSync(join(deftDir, "main.md"))).toBe(true);
    expect(readFileSync(join(deftDir, "main.md"), "utf8")).toBe("# Deft\n");
    expect(readFileSync(join(deftDir, "VERSION"), "utf8")).toContain("v0.62.0");
  });

  it("refuses VERSION stamp when deposit reconcile cannot clear dst-only content (#2913)", async () => {
    const project = freshRoot("refresh-refuse-version-");
    const contentRoot = installFakeContentPackage(project, "0.62.0");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: 'v0.61.0'\nsha: old\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    const priorVersion = readFileSync(join(deftDir, "VERSION"), "utf8");

    // Additive seam that leaves a dst-only leftover the prune step cannot delete.
    const { copyTree } = await import("../deposit/copy-tree.js");
    const lockedDir = join(deftDir, "locked-stale");
    await expect(
      runRefreshDeposit(
        { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
        { printf: () => {} },
        {
          resolveContentRoot: async () => contentRoot,
          // Additive copy keeps prior dst entries, then we lock a leftover mid-flight
          // via a wrapper that plants an undeletable path after copy.
          copyContent: async (src, dst) => {
            await copyTree(src, dst);
            mkdirSync(lockedDir, { recursive: true });
            writeFileSync(join(lockedDir, "orphan.md"), "EVIL\n", "utf8");
            if (process.platform === "win32") {
              // Win32 directory ACLs make a portable "undeletable" fixture unreliable;
              // assert the fail-closed VERSION contract via the same reconcile error.
              throw new Error(
                "deposit reconcile failed: 1 package-absent path(s) remain under .deft/core " +
                  "(e.g. locked-stale/orphan.md). Refusing VERSION stamp until dst-only content is removed (#2913).",
              );
            }
            chmodSync(lockedDir, 0o555);
          },
          readEngineVersion: () => "0.62.0",
          nowIso: () => "2026-07-29T12:00:00Z",
          gitPorcelain: () => null,
        },
      ),
    ).rejects.toThrow(/Refusing VERSION stamp|#2913|deposit reconcile failed/);

    if (process.platform !== "win32") {
      chmodSync(lockedDir, 0o755);
    }
    // VERSION must remain the prior stamp — refresh refused before rewrite.
    expect(readFileSync(join(deftDir, "VERSION"), "utf8")).toBe(priorVersion);
    expect(readFileSync(join(deftDir, "VERSION"), "utf8")).not.toContain("v0.62.0");
  });

  it("already-current refresh still strips dst-only leftovers without re-stamping VERSION (#2913)", async () => {
    const project = freshRoot("refresh-current-prune-");
    const contentRoot = installFakeContentPackage(project, "0.62.0");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "agents"), { recursive: true });
    // Match content package files so version is already current.
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: 'v0.62.0'\nsha: content-package\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(deftDir, "templates", "agents-entry.md"),
    );
    mkdirSync(join(deftDir, "vbrief", "schemas"), { recursive: true });
    writeFileSync(
      join(deftDir, "vbrief", "schemas", "vbrief-core.schema.json"),
      "legacy\n",
      "utf8",
    );
    writeFileSync(
      join(deftDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "current\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "agents", "stale-only.md"), "leftover\n", "utf8");
    const priorVersion = readFileSync(join(deftDir, "VERSION"), "utf8");

    const copyContent = vi.fn(async () => {
      throw new Error("copyContent must not run for an already-current refresh");
    });
    const result = await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        copyContent,
        readEngineVersion: () => "0.62.0",
        nowIso: () => "2026-07-29T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    expect(result.alreadyCurrent).toBe(true);
    expect(copyContent).not.toHaveBeenCalled();
    expect(existsSync(join(deftDir, "agents", "stale-only.md"))).toBe(false);
    expect(readFileSync(join(deftDir, "VERSION"), "utf8")).toBe(priorVersion);
  });

  it("retires a stale legacy .deft/VERSION after the payload refresh (#2064)", async () => {
    const project = freshRoot("refresh-legacy-manifest-");
    const contentRoot = installFakeContentPackage(project, "0.61.0");
    // Canonical deposit present (so the layout is not an orphan-legacy refusal)
    // plus a stale legacy manifest directly under .deft/ at a divergent version.
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "core", "VERSION"),
      "tag: 'v0.60.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(
      join(project, ".deft", "VERSION"),
      "tag: 'v0.40.0'\nsha: abc\ninstall_root: '.deft'\n",
      "utf8",
    );

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.61.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    expect(existsSync(join(project, ".deft", "VERSION"))).toBe(false);
    expect(existsSync(join(project, ".deft", "VERSION.premigrate"))).toBe(true);
    // Canonical manifest is written at the deposited version.
    expect(readFileSync(join(project, ".deft", "core", "VERSION"), "utf8")).toContain(
      "tag: 'v0.61.0'",
    );
  });

  it("leaves a legacy .deft/VERSION in place when it already agrees (#2064)", async () => {
    const project = freshRoot("refresh-legacy-manifest-agree-");
    const contentRoot = installFakeContentPackage(project, "0.61.0");
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "core", "VERSION"),
      "tag: 'v0.60.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(
      join(project, ".deft", "VERSION"),
      "tag: 'v0.61.0'\nsha: abc\ninstall_root: '.deft'\n",
      "utf8",
    );

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.61.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        gitPorcelain: () => null,
      },
    );

    expect(existsSync(join(project, ".deft", "VERSION"))).toBe(true);
    expect(existsSync(join(project, ".deft", "VERSION.premigrate"))).toBe(false);
  });

  it("printUpdateComplete nudges migrate when managed_by is absent (#2059)", () => {
    const project = freshRoot("refresh-nudge-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: 'v0.61.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    const lines: string[] = [];
    printUpdateComplete(
      {
        projectDir: project,
        deftDir,
        contentVersion: "0.61.0",
        engineVersion: "0.61.0",
        previousDepositVersion: "0.60.0",
        alreadyCurrent: false,
        strategy: "file-swap",
        agentsMdUpdated: true,
        versionSkewNotice: null,
        legacyLayout: false,
        taskfileWired: false,
        stagedPaths: [],
        mutations: emptyMutationSummary(),
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).toContain("directive migrate");
  });

  it("printUpdateComplete omits migrate nudge when deposit is npm-managed", () => {
    const project = freshRoot("refresh-nudge-skip-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: 'v0.61.0'\nsha: abc\ninstall_root: '.deft/core'\nmanaged_by: 'npm'\n",
      "utf8",
    );
    const lines: string[] = [];
    printUpdateComplete(
      {
        projectDir: project,
        deftDir,
        contentVersion: "0.61.0",
        engineVersion: "0.61.0",
        previousDepositVersion: "0.60.0",
        alreadyCurrent: false,
        strategy: "file-swap",
        agentsMdUpdated: true,
        versionSkewNotice: null,
        legacyLayout: false,
        taskfileWired: false,
        stagedPaths: [],
        mutations: emptyMutationSummary(),
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).not.toContain("directive migrate");
  });

  it("printUpdateComplete announces prettier-sensitive schema rewrites from the ledger (#3395)", () => {
    const project = freshRoot("refresh-prettier-announce-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    const mutations = {
      ...emptyMutationSummary(),
      wrote: [
        "AGENTS.md",
        "xbrief/schemas/xbrief-core-0.8.schema.json",
        "xbrief/schemas/candidates.schema.json",
        ".cursor/hooks.json",
      ],
    };
    expect(prettierSensitiveRewrites(mutations)).toEqual([
      "xbrief/schemas/xbrief-core-0.8.schema.json",
      "xbrief/schemas/candidates.schema.json",
    ]);
    expect(formatPrettierSensitiveAnnounce(prettierSensitiveRewrites(mutations))).toContain(
      "task fmt",
    );
    const lines: string[] = [];
    printUpdateComplete(
      {
        projectDir: project,
        deftDir,
        contentVersion: "0.61.0",
        engineVersion: "0.61.0",
        previousDepositVersion: "0.60.0",
        alreadyCurrent: false,
        strategy: "file-swap",
        agentsMdUpdated: true,
        versionSkewNotice: null,
        legacyLayout: false,
        taskfileWired: false,
        stagedPaths: [],
        mutations,
      },
      { printf: (text) => lines.push(text) },
    );
    const printed = lines.join("");
    expect(printed).toContain("Rewritten consumer-owned paths");
    expect(printed).toContain("task fmt");
    expect(printed).toContain("xbrief/schemas/xbrief-core-0.8.schema.json");
    expect(printed).toContain("xbrief/schemas/candidates.schema.json");
    expect(printed).not.toMatch(/Rewritten consumer-owned paths[\s\S]*AGENTS\.md/);
  });

  it("printUpdateComplete omits the prettier announce when no schema rewrites landed (#3395)", () => {
    const project = freshRoot("refresh-prettier-silent-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    const lines: string[] = [];
    printUpdateComplete(
      {
        projectDir: project,
        deftDir,
        contentVersion: "0.61.0",
        engineVersion: "0.61.0",
        previousDepositVersion: "0.60.0",
        alreadyCurrent: false,
        strategy: "file-swap",
        agentsMdUpdated: true,
        versionSkewNotice: null,
        legacyLayout: false,
        taskfileWired: false,
        stagedPaths: [],
        mutations: {
          ...emptyMutationSummary(),
          wrote: ["AGENTS.md", ".cursor/hooks.json"],
        },
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).not.toContain("Rewritten consumer-owned paths");
    expect(lines.join("")).not.toContain("task fmt");
  });

  it("wires Taskfile.yml and stages it on upgrade (#1576)", async () => {
    const project = freshRoot("refresh-taskfile-");
    const contentRoot = installFakeContentPackage(project);
    initGitRepo(project);

    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "core", "VERSION"),
      "tag: 'v0.52.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      `# Operator prose\n\n<!-- deft:managed-section v2 -->\nOld body\n${AGENTS_MANAGED_CLOSE}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\ntasks:\n  build:\n    cmds: [npm run build]\n",
      "utf8",
    );
    execFileSync("git", ["add", "-A"], { cwd: project });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: project });

    const out: string[] = [];
    const err: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);
    const payload = parseJsonObject(out.join(""));
    expect(payload.taskfile_wired).toBe(true);
    expect(payload.deposit_completed).toBe(true);
    expect(payload.agent_hook_readiness).toMatchObject({
      ready: true,
      live_status: "functional",
    });
    expect(payload.staged_paths).toEqual(expect.arrayContaining(["Taskfile.yml"]));
    expect(
      (payload.staged_paths as string[]).some(
        (path) => path === ".deft/core" || path.startsWith(".deft/core/"),
      ),
    ).toBe(true);

    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(porcelain).not.toMatch(/^.[M?] Taskfile\.yml$/m);

    const cached = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(
      cached
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toContain("Taskfile.yml");
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain("build:");
    expect(err.join("")).toContain("Commit hygiene");
  });

  it("throws LegacyLayoutRefusedError on a legacy layout (no refresh)", async () => {
    await expect(
      runRefreshDeposit(
        { projectDir: "/proj-legacy", jsonOut: false, nonInteractive: true, upgrade: true },
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
});

describe("runRefreshDepositCli legacy refusal", () => {
  it("update refuses a legacy layout with the two-step recovery (json mode)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: "/proj-legacy",
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: { detectLegacy: () => FAKE_LEGACY },
    });

    expect(code).toBe(2);
    const parsed = parseJsonObject(out.join(""));
    expect(parsed.action).toBe("refuse");
    expect(parsed.command).toBe("update");
    expect(parsed.legacy_layout).toBe(true);
    expect(parsed.legacy_layout_kind).toBe("legacy-deft-prefixed");
    expect(err.join("")).toContain("refusing to refresh");
    expect(err.join("")).toContain("npx @deftai/directive update");
  });

  it("update refuses a legacy layout in interactive mode (message on stdout)", async () => {
    const out: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: "/proj-legacy",
      jsonOut: false,
      nonInteractive: true,
      upgrade: true,
      writeOut: (text) => out.push(text),
      writeErr: () => {},
      seams: { detectLegacy: () => FAKE_LEGACY },
    });

    expect(code).toBe(2);
    expect(out.join("")).toContain("refusing to refresh");
  });
});

// ---------------------------------------------------------------------------
// #2266: refresh-only + self-heal narrowing.
// ---------------------------------------------------------------------------

function makeFacts(overrides: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    hasGit: false,
    hasAppCode: false,
    hasDeftCore: false,
    deftCorePayloadVersion: null,
    hasManagedSection: false,
    managedSectionSha: null,
    hasVbrief: false,
    hasXbrief: false,
    preCutoverArtifacts: false,
    engineReachable: true,
    engineVersion: "0.53.0",
    pinVersion: "0.53.0",
    ...overrides,
  };
}

describe("updateStateFromPlan (#2266 four-state classifier)", () => {
  it("maps pre-cutover artifacts to migration-required (wins over everything)", () => {
    const facts = makeFacts({ hasDeftCore: true, preCutoverArtifacts: true });
    const state = updateStateFromPlan(facts, {
      schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
      mode: "migrate",
      files: [],
      nextAction: { command: null, rootCause: "pre-cutover", remediation: "migrate first" },
      warnings: [],
    });
    expect(state).toBe("migration-required");
  });

  it("maps an empty project (no footprint) to not-initialized", () => {
    const facts = makeFacts({
      hasDeftCore: false,
      hasManagedSection: false,
      pinVersion: null,
    });
    const state = updateStateFromPlan(facts, {
      schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
      mode: "init",
      files: [],
      nextAction: {
        command: "npx @deftai/directive init",
        rootCause: "greenfield",
        remediation: "init",
      },
      warnings: [],
    });
    expect(state).toBe("not-initialized");
  });

  it("treats a managed-section-only project as initialized (deposit reconstitution = updated)", () => {
    const facts = makeFacts({ hasDeftCore: false, hasManagedSection: true, pinVersion: null });
    const state = updateStateFromPlan(facts, {
      schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
      mode: "init",
      files: [],
      nextAction: { command: null, rootCause: "deposit absent", remediation: "reconstitute" },
      warnings: [],
    });
    expect(state).toBe("updated");
  });

  it("maps a proceed plan on an initialized project to current", () => {
    const facts = makeFacts({ hasDeftCore: true });
    const state = updateStateFromPlan(facts, {
      schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
      mode: "proceed",
      files: [],
      nextAction: { command: null, rootCause: "matched", remediation: "run gate" },
      warnings: [],
    });
    expect(state).toBe("current");
  });

  it("maps an update plan on an initialized project to updated", () => {
    const facts = makeFacts({ hasDeftCore: true });
    const state = updateStateFromPlan(facts, {
      schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
      mode: "update",
      files: [],
      nextAction: {
        command: "npx @deftai/directive update",
        rootCause: "behind",
        remediation: "update",
      },
      warnings: [],
    });
    expect(state).toBe("updated");
  });
});

describe("directive update refresh-only + self-heal (#2266)", () => {
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

  function installFakeContentPackage(projectRoot: string, version = "0.53.0"): string {
    const pkgDir = join(projectRoot, "node_modules", "@deftai", "directive-content");
    mkdirSync(join(pkgDir, "templates"), { recursive: true });
    mkdirSync(join(pkgDir, "vbrief", "schemas"), { recursive: true });
    mkdirSync(join(pkgDir, ".githooks"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version }),
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(pkgDir, "templates/agents-entry.md"),
    );
    for (const name of ["pre-commit", "pre-push", "_deft-run.sh"] as const) {
      copyFileSync(join(process.cwd(), ".githooks", name), join(pkgDir, ".githooks", name));
      if (name !== "_deft-run.sh") {
        chmodSync(join(pkgDir, ".githooks", name), 0o755);
      }
    }
    writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(
      join(pkgDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "current\n",
      "utf8",
    );
    return pkgDir;
  }

  /** Write a minimal initialized install (deposit + managed AGENTS.md + committed pin). */
  function writeInitializedProject(
    project: string,
    opts: { contentVersion: string; pinVersion: string; sha?: string },
  ): void {
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    mkdirSync(join(deftDir, "vbrief", "schemas"), { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      `tag: 'v${opts.contentVersion}'\nsha: abc\ninstall_root: '.deft/core'\n`,
      "utf8",
    );
    writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(
      join(deftDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "current\n",
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(deftDir, "templates/agents-entry.md"),
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      `# Operator prose\n\n<!-- deft:managed-section v3 sha=${opts.sha ?? "deadbeefcafe"} -->\nbody\n${AGENTS_MANAGED_CLOSE}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, devDependencies: { "@deftai/directive": opts.pinVersion } }),
      "utf8",
    );
  }

  function classifySeams(engine: { reachable: boolean; version: string | null }): ClassifySeams {
    return { engineProbe: () => engine, preCutoverProbe: () => false };
  }

  function initGitRepo(root: string): void {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  }

  it("STOPS on an un-initialized project without writing a partial install (a1)", async () => {
    const project = freshRoot("update-noinit-");
    const out: string[] = [];
    const err: string[] = [];

    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: false, version: null }),
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: {
        resolveContentRoot: async () => {
          throw new Error("resolveContentRoot must NOT run for a not-initialized project");
        },
      },
    });

    expect(code).toBe(UPDATE_REFUSED_EXIT_CODE);
    expect(err.join("")).toContain(NOT_INITIALIZED_MESSAGE);
    const payload = parseJsonObject(out.join(""));
    expect(payload.update_state).toBe("not-initialized");
    expect(payload.success).toBe(false);
    // No partial install: the deposit directory was never created.
    expect(existsSync(join(project, ".deft", "core"))).toBe(false);
  });

  it("STOPS with migration-required when pre-cutover artifacts are present", async () => {
    const project = freshRoot("update-migrate-");
    writeInitializedProject(project, { contentVersion: "0.53.0", pinVersion: "0.53.0" });
    const out: string[] = [];
    const err: string[] = [];

    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: {
        engineProbe: () => ({ reachable: true, version: "0.53.0" }),
        preCutoverProbe: () => true,
      },
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: {
        resolveContentRoot: async () => {
          throw new Error("resolveContentRoot must NOT run when migration is required");
        },
      },
    });

    expect(code).toBe(UPDATE_REFUSED_EXIT_CODE);
    const payload = parseJsonObject(out.join(""));
    expect(payload.update_state).toBe("migration-required");
    expect(err.join("")).toContain("migration");
  });

  it("--dry-run prints the classified plan without executing the refresh (a5)", async () => {
    const project = freshRoot("update-dryrun-");
    writeInitializedProject(project, { contentVersion: "0.53.0", pinVersion: "0.53.0" });
    const out: string[] = [];
    const err: string[] = [];

    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      dryRun: true,
      classifySeams: classifySeams({ reachable: true, version: "0.53.0" }),
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: {
        resolveContentRoot: async () => {
          throw new Error("resolveContentRoot must NOT run in dry-run mode");
        },
      },
    });

    expect(code).toBe(0);
    const payload = parseJsonObject(out.join(""));
    expect(payload.dry_run).toBe(true);
    expect(payload.update_state).toBe("current");
    expect(payload.mode).toBeDefined();
    // VERSION untouched -> nothing was re-stamped.
    expect(readFileSync(join(project, ".deft", "core", "VERSION"), "utf8")).toContain("v0.53.0");
  });

  it("reports current and refreshes idempotently on an up-to-date install (a2/a5)", async () => {
    const project = freshRoot("update-current-");
    const contentRoot = installFakeContentPackage(project, "0.53.0");
    writeInitializedProject(project, { contentVersion: "0.53.0", pinVersion: "0.53.0" });
    const copyContent = vi.fn(async () => {
      throw new Error("copyContent must not run for a current update");
    });
    const seams = {
      resolveContentRoot: async () => contentRoot,
      copyContent,
      readEngineVersion: () => "0.53.0",
      nowIso: () => "2026-07-03T12:00:00Z",
      gitPorcelain: () => null,
      gitLsFiles: () => null,
      evaluateAgentHookReadiness: () => agentHookReadiness(),
    };

    const run = async (): Promise<Record<string, unknown>> => {
      const out: string[] = [];
      const code = await runRefreshDepositCli({
        projectDir: project,
        jsonOut: true,
        nonInteractive: true,
        upgrade: true,
        classifySeams: classifySeams({ reachable: true, version: "0.53.0" }),
        writeOut: (t) => out.push(t),
        writeErr: () => {},
        seams,
      });
      expect(code).toBe(0);
      return parseJsonObject(out.join(""));
    };

    const first = await run();
    expect(first.update_state).toBe("current");
    expect(first.already_current).toBe(true);
    expect(first.strategy).toBe("no-op");
    const second = await run();
    expect(second.update_state).toBe("current");
    expect(second.already_current).toBe(true);
    expect(second.strategy).toBe("no-op");
    expect(copyContent).not.toHaveBeenCalled();
  });

  it("reports updated and re-stamps VERSION when content is behind the pin (a2)", async () => {
    const project = freshRoot("update-updated-");
    const contentRoot = installFakeContentPackage(project, "0.54.0");
    writeInitializedProject(project, { contentVersion: "0.53.0", pinVersion: "0.54.0" });
    const out: string[] = [];

    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: true, version: "0.54.0" }),
      writeOut: (t) => out.push(t),
      writeErr: () => {},
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.54.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);
    const payload = parseJsonObject(out.join(""));
    expect(payload.update_state).toBe("updated");
    expect(payload.agent_hook_readiness).toMatchObject({ ready: true });
    expect(readFileSync(join(project, ".deft", "core", "VERSION"), "utf8")).toContain("v0.54.0");
  });

  it("keeps a completed refresh but exits non-zero when post-deposit hook readiness fails", async () => {
    const project = freshRoot("update-readiness-failed-");
    const contentRoot = installFakeContentPackage(project, "0.54.0");
    writeInitializedProject(project, { contentVersion: "0.53.0", pinVersion: "0.54.0" });
    const out: string[] = [];
    const err: string[] = [];

    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: true, version: "0.54.0" }),
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.54.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => agentHookReadiness(1),
      },
    });

    expect(code).toBe(1);
    expect(readFileSync(join(project, ".deft", "core", "VERSION"), "utf8")).toContain("v0.54.0");
    expect(parseJsonObject(out.join(""))).toMatchObject({
      success: false,
      deposit_completed: true,
      agent_hook_readiness: { ready: false, live_status: "non-functional" },
    });
    expect(err.join("")).toContain("deft agent hook readiness: live failed");
  });

  it("self-heals a mismatched engine via the global-first ladder, then completes the refresh (a3)", async () => {
    const project = freshRoot("update-selfheal-");
    const contentRoot = installFakeContentPackage(project, "0.54.0");
    writeInitializedProject(project, { contentVersion: "0.53.0", pinVersion: "0.54.0" });
    const out: string[] = [];
    const err: string[] = [];

    const installRunner = vi.fn(() => ({
      installed: true,
      version: "0.54.0",
      detail: "fake npm i -g @deftai/directive@0.54.0",
    }));

    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      // Engine unreachable in the execution env -> triggers the self-heal delegation.
      classifySeams: classifySeams({ reachable: false, version: null }),
      ladderFacts: {
        pinVersion: "0.54.0",
        globalEngineVersion: null,
        localEngine: null,
        registryUp: true,
        globalPrefixWritable: true,
        stagedTarballAvailable: false,
        platform: "linux",
      },
      engineInstallRunner: installRunner,
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.54.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);
    // The ladder ran the install with zero manual npm/PATH steps.
    expect(installRunner).toHaveBeenCalledWith(
      expect.objectContaining({ rung: "install-global", pinVersion: "0.54.0" }),
    );
    expect(err.join("")).toContain("engine self-heal (global-first ladder)");
    // The refresh still completed after the self-heal.
    expect(existsSync(join(project, ".deft", "core", "main.md"))).toBe(true);
  });

  it("writes the .gitignore entry but NEVER un-tracks .deft/core (boundary test, a4)", async () => {
    const project = freshRoot("update-boundary-");
    const contentRoot = installFakeContentPackage(project, "0.54.0");
    initGitRepo(project);
    writeInitializedProject(project, { contentVersion: "0.54.0", pinVersion: "0.54.0" });
    execFileSync("git", ["add", "-A"], { cwd: project });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: project });

    const trackedBefore = execFileSync("git", ["ls-files", "--", ".deft/core"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(trackedBefore.trim().length).toBeGreaterThan(0);

    const out: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: true, version: "0.54.0" }),
      writeOut: (t) => out.push(t),
      writeErr: () => {},
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.54.0",
        nowIso: () => "2026-07-03T12:00:00Z",
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);

    // Boundary: the committed deposit stays tracked -- `update` never runs the
    // destructive `git rm --cached .deft/core` (that is migrate --untrack-core,
    // #2269). If it had, ls-files would be empty here.
    const trackedAfter = execFileSync("git", ["ls-files", "--", ".deft/core"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(trackedAfter.trim().length).toBeGreaterThan(0);

    // And nothing under .deft/core is staged for deletion (a git rm --cached would
    // surface as a staged `D` entry in porcelain).
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(porcelain).not.toMatch(/^D..*\.deft\/core/m);
    expect(porcelain).not.toMatch(/^.D.*\.deft\/core/m);

    // The non-destructive .gitignore write DID land the canonical baseline.
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".deft-cache/");
  });

  it("#2148: does NOT deposit deft-core-guard.yml when .deft/core is gitignored / not tracked", async () => {
    const project = freshRoot("refresh-no-guard-untracked-");
    const contentRoot = installFakeContentPackage(project);
    initGitRepo(project);

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: false, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-06-24T12:00:00Z",
        gitPorcelain: () => "",
        // Simulate gitignored / not-tracked deposit (npm-managed layout).
        gitLsFiles: () => "",
      },
    );

    expect(existsSync(join(project, ".github", "workflows", "deft-core-guard.yml"))).toBe(false);
  });

  it("#2148: DOES deposit deft-core-guard.yml when .deft/core is git-tracked (vendored layout)", async () => {
    const project = freshRoot("refresh-guard-tracked-");
    const contentRoot = installFakeContentPackage(project);
    initGitRepo(project);
    // Simulate a tracked deposit by making gitLsFiles return a tracked path.
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(join(project, ".deft", "core", "main.md"), "# tracked\n", "utf8");

    await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: false, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-06-24T12:00:00Z",
        gitPorcelain: () => "",
        // Simulate a tracked deposit.
        gitLsFiles: () => ".deft/core/main.md\n",
      },
    );

    expect(existsSync(join(project, ".github", "workflows", "deft-core-guard.yml"))).toBe(true);
  });

  it("prints Removed/wrote/stripped from the same ledger as refresh JSON (#3392)", async () => {
    const project = freshRoot("refresh-ledger-");
    const contentRoot = installFakeContentPackage(project);
    initGitRepo(project);
    writeFileSync(
      join(project, "AGENTS.md"),
      `# Operator prose\n\n<!-- deft:managed-section v2 -->\nOld body\n${AGENTS_MANAGED_CLOSE}\n`,
      "utf8",
    );
    mkdirSync(join(project, ".cursor", "hooks"), { recursive: true });
    writeFileSync(join(project, ".cursor/hooks/deft-cursor-hook-adapter.mjs"), "legacy\n", "utf8");
    writeFileSync(
      join(project, ".cursor/hooks/deft-cursor-hook-adapter.test.mjs"),
      "legacy\n",
      "utf8",
    );

    const out: string[] = [];
    const err: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-08-16T12:00:00Z",
        gitPorcelain: () => "",
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });

    expect(code).toBe(0);
    expect(existsSync(join(project, ".cursor/hooks/deft-cursor-hook-adapter.mjs"))).toBe(false);
    const payload = parseJsonObject(out.join(""));
    const mutations = payload.mutations;
    expect(mutations).toEqual(
      expect.objectContaining({
        deleted: [
          ".cursor/hooks/deft-cursor-hook-adapter.mjs",
          ".cursor/hooks/deft-cursor-hook-adapter.test.mjs",
        ],
      }),
    );
    expect(mutations).toEqual(
      expect.objectContaining({
        wrote: expect.arrayContaining(["AGENTS.md", ".cursor/hooks.json"]),
      }),
    );
    const printed = err.join("");
    const deleted = (mutations as { deleted: string[] }).deleted;
    const wrote = (mutations as { wrote: string[] }).wrote;
    expect(printed).toContain(`Removed: ${deleted.join(", ")}`);
    expect(printed).toContain(`wrote: ${wrote.join(", ")}`);
    expect(printed).not.toMatch(/\.deft-\d+\.tmp/);
  });

  it("includes tree-replace and prune mutations in the refresh snapshot (#3392 residual)", async () => {
    const project = freshRoot("refresh-ledger-tree-");
    const contentRoot = installFakeContentPackage(project);
    mkdirSync(join(contentRoot, "scripts"), { recursive: true });
    writeFileSync(join(contentRoot, "scripts", "probe.py"), "# probe\n", "utf8");
    writeFileSync(join(contentRoot, "legacy.pyc"), "\x00\n", "utf8");
    writeFileSync(join(contentRoot, "run"), "#!/usr/bin/env python3\n", "utf8");

    mkdirSync(join(project, ".deft", "core", "nested"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "core", "VERSION"),
      "tag: 'v0.52.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(join(project, ".deft", "core", "main.md"), "# old\n", "utf8");
    writeFileSync(join(project, ".deft", "core", "nested", "stale.md"), "EVIL\n", "utf8");
    writeFileSync(join(project, "run"), "#!/usr/bin/env python3\n", "utf8");

    const result = await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-08-16T12:00:00Z",
        gitPorcelain: () => "",
      },
    );

    expect(existsSync(join(project, ".deft", "core", "nested", "stale.md"))).toBe(false);
    expect(existsSync(join(project, ".deft", "core", "scripts"))).toBe(false);
    expect(existsSync(join(project, ".deft", "core", "legacy.pyc"))).toBe(false);
    expect(existsSync(join(project, "run"))).toBe(false);

    const { deleted, wrote } = result.mutations;
    expect(deleted).toEqual(
      expect.arrayContaining([
        ".deft/core/nested/stale.md",
        ".deft/core/scripts",
        ".deft/core/legacy.pyc",
        "run",
      ]),
    );
    expect(wrote).toEqual(expect.arrayContaining([".deft/core/main.md"]));
  });

  it("announces rewritten xbrief/schemas paths from the ledger and does not run prettier (#3395)", async () => {
    const project = freshRoot("refresh-prettier-ledger-");
    const contentRoot = installFakeContentPackage(project);
    writeFileSync(
      join(contentRoot, "vbrief", "schemas", "candidates.schema.json"),
      '{"description":"new"}\n',
      "utf8",
    );
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    mkdirSync(join(project, "xbrief", "schemas"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "active", "2026-08-16-seed.xbrief.json"),
      '{"xBRIEFInfo":{"version":"0.8"},"plan":{"title":"seed","status":"running"}}\n',
      "utf8",
    );
    writeFileSync(
      join(project, "xbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "stale-core\n",
      "utf8",
    );
    writeFileSync(
      join(project, "xbrief", "schemas", "candidates.schema.json"),
      "stale-cand\n",
      "utf8",
    );

    const result = await runRefreshDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true, upgrade: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.53.0",
        nowIso: () => "2026-08-16T12:00:00Z",
        gitPorcelain: () => "",
      },
    );

    expect(result.mutations.wrote).toEqual(
      expect.arrayContaining([
        "xbrief/schemas/xbrief-core-0.8.schema.json",
        "xbrief/schemas/candidates.schema.json",
      ]),
    );
    expect(prettierSensitiveRewrites(result.mutations)).toEqual(
      expect.arrayContaining([
        "xbrief/schemas/xbrief-core-0.8.schema.json",
        "xbrief/schemas/candidates.schema.json",
      ]),
    );
    const lines: string[] = [];
    printUpdateComplete(result, { printf: (text) => lines.push(text) });
    const printed = lines.join("");
    expect(printed).toContain("Rewritten consumer-owned paths");
    expect(printed).toContain("task fmt");
    expect(printed).toContain("xbrief/schemas/xbrief-core-0.8.schema.json");
    expect(printed).toContain("xbrief/schemas/candidates.schema.json");
    expect(
      readFileSync(join(process.cwd(), "packages/core/src/init-deposit/refresh.ts"), "utf8"),
    ).not.toMatch(/prettier --write|npx prettier|pnpm exec prettier/);
  });
});
