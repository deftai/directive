import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import { type LegacyLayoutDetection, LegacyLayoutRefusedError } from "./legacy-detect.js";
import {
  buildVersionSkewNotice,
  frameworkRefreshSideEffects,
  parseUpdateArgv,
  printRefreshSideEffects,
  printUpdateComplete,
  runRefreshDeposit,
  runRefreshDepositCli,
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
    expect(frameworkRefreshSideEffects("/proj", () => porcelain).sort()).toEqual(
      [".deft/core/VERSION", "AGENTS.md"].sort(),
    );
  });

  it("strips git-quoted porcelain paths", () => {
    const porcelain = ' M ".deft/core/VERSION"';
    expect(frameworkRefreshSideEffects("/proj", () => porcelain)).toEqual([".deft/core/VERSION"]);
  });

  it("returns empty outside git", () => {
    expect(frameworkRefreshSideEffects("/proj", () => null)).toEqual([]);
  });
});

describe("printRefreshSideEffects", () => {
  it("emits the #1671 disclosure block", () => {
    const lines: string[] = [];
    printRefreshSideEffects({ printf: (text) => lines.push(text) }, [".deft/core/VERSION"]);
    expect(lines.join("")).toContain("AGENTS.md refresh side effects (#1671)");
    expect(lines.join("")).toContain(".deft/core/VERSION");
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
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version }),
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(pkgDir, "templates/agents-entry.md"),
    );
    writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
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

    io.printf.mockClear();
    const second = await runRefreshDeposit(args, io, seams);
    const secondAgents = readFileSync(join(project, "AGENTS.md"), "utf8");

    expect(secondAgents).toBe(firstAgents);
    expect(second.agentsMdUpdated).toBe(false);
    expect(io.printf.mock.calls.flat().join("")).toContain("already advertises install root");
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
    mkdirSync(join(project, "vbrief"), { recursive: true });
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.60.0\n", "utf8");

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

    expect(readFileSync(join(project, "vbrief", ".deft-version"), "utf8").trim()).toBe("0.61.0");
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
        agentsMdUpdated: true,
        versionSkewNotice: null,
        legacyLayout: false,
        taskfileWired: false,
        stagedPaths: [],
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
        agentsMdUpdated: true,
        versionSkewNotice: null,
        legacyLayout: false,
        taskfileWired: false,
        stagedPaths: [],
      },
      { printf: (text) => lines.push(text) },
    );
    expect(lines.join("")).not.toContain("directive migrate");
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
      },
    });

    expect(code).toBe(0);
    const payload = parseJsonObject(out.join(""));
    expect(payload.taskfile_wired).toBe(true);
    expect(payload.staged_paths).toEqual(expect.arrayContaining(["Taskfile.yml", ".deft/core"]));

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
