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
