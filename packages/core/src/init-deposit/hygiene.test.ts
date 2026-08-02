import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  depositStagePaths,
  findPackageAbsentDepositPaths,
  findPackageAbsentDepositPathsSync,
  frameworkStagePaths,
  installerManagedGuardEre,
  isDepositGeneratedMetadata,
  isInstallerManagedPath,
  prunePackageAbsentDepositPaths,
  pruneStrayDepositPaths,
  reconcileDepositToContentPackage,
  stageFrameworkPaths,
} from "./hygiene.js";
import { CANONICAL_TASKFILE_INCLUDE } from "./scaffold.js";

describe("installer-managed allowlist (#1576)", () => {
  it("treats Taskfile.yml as installer-managed", () => {
    expect(isInstallerManagedPath("Taskfile.yml")).toBe(true);
    expect(installerManagedGuardEre()).toContain("Taskfile\\.yml");
  });

  it("allowlists and stages the project-scoped Codex hook deposit", () => {
    const root = mkdtempSync(join(tmpdir(), "hygiene-codex-hook-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      mkdirSync(join(root, ".codex"), { recursive: true });
      writeFileSync(join(root, ".codex", "hooks.json"), "{}\n", "utf8");

      expect(isInstallerManagedPath(".codex/hooks.json")).toBe(true);
      expect(installerManagedGuardEre()).toContain("\\.codex/hooks\\.json");
      expect(frameworkStagePaths(root, join(root, ".deft", "core"))).toContain(".codex/hooks.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes Taskfile.yml in framework stage paths when present", () => {
    const root = mkdtempSync(join(tmpdir(), "hygiene-stage-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "main.md"), "# Deft\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "# Agent\n", "utf8");
      writeFileSync(
        join(root, "Taskfile.yml"),
        "version: '3'\ntasks:\n  hello:\n    cmds: [echo hi]\n",
        "utf8",
      );
      const paths = frameworkStagePaths(root, join(root, ".deft", "core"), {
        includeTaskfile: true,
      });
      expect(paths).toContain("Taskfile.yml");
      expect(paths).toContain(".deft/core");
      expect(paths).toContain("AGENTS.md");
      // When the include was not wired this run, Taskfile.yml is excluded.
      expect(frameworkStagePaths(root, join(root, ".deft", "core"))).not.toContain("Taskfile.yml");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe(".prettierignore allowlist (#2629)", () => {
  it("treats installer-deposited .prettierignore as installer-managed", () => {
    expect(isInstallerManagedPath(".prettierignore")).toBe(true);
    expect(installerManagedGuardEre()).toContain("\\.prettierignore$");
  });
});

describe("xbrief/ allowlist parity (#2277)", () => {
  const xbriefLifecycleDirs = ["proposed", "pending", "active", "completed", "cancelled"] as const;

  it("treats xbrief/.deft-version as installer-managed", () => {
    expect(isInstallerManagedPath("xbrief/.deft-version")).toBe(true);
  });

  it("treats each xbrief/<lifecycle>/.gitkeep marker as installer-managed", () => {
    for (const sub of xbriefLifecycleDirs) {
      expect(isInstallerManagedPath(`xbrief/${sub}/.gitkeep`)).toBe(true);
    }
  });

  it("treats xbrief/xbrief.md and the xbrief/ schema+migration prefixes as installer-managed", () => {
    expect(isInstallerManagedPath("xbrief/xbrief.md")).toBe(true);
    expect(isInstallerManagedPath("xbrief/schemas/scope.schema.json")).toBe(true);
    expect(isInstallerManagedPath("xbrief/migration/2026-07-03.md")).toBe(true);
  });

  it("allowlists xbrief/.deft-version in the deposited guard ERE alternation", () => {
    const ere = installerManagedGuardEre();
    expect(ere).toContain("xbrief/\\.deft-version");
    for (const sub of xbriefLifecycleDirs) {
      expect(ere).toContain(`xbrief/${sub}/\\.gitkeep`);
    }
  });

  it("keeps the legacy vbrief/ allowlist entries for not-yet-migrated projects", () => {
    expect(isInstallerManagedPath("xbrief/.deft-version")).toBe(true);
    for (const sub of xbriefLifecycleDirs) {
      expect(isInstallerManagedPath(`xbrief/${sub}/.gitkeep`)).toBe(true);
    }
    expect(installerManagedGuardEre()).toContain("xbrief/\\.deft-version");
  });
});

describe("PROJECT-DEFINITION is not installer-managed (#3029 / #1430)", () => {
  const pdPaths = [
    "xbrief/PROJECT-DEFINITION.xbrief.json",
    "vbrief/PROJECT-DEFINITION.vbrief.json",
  ] as const;

  it("does not treat consumer PROJECT-DEFINITION as installer-managed", () => {
    for (const path of pdPaths) {
      expect(isInstallerManagedPath(path)).toBe(false);
    }
  });

  it("does not embed PROJECT-DEFINITION in the deposited guard ERE", () => {
    const ere = installerManagedGuardEre();
    expect(ere).not.toContain("PROJECT-DEFINITION");
    // Scaffolding markers remain correctly allowlisted (#2277).
    expect(ere).toContain("xbrief/\\.deft-version");
  });

  it("does not stage PROJECT-DEFINITION via frameworkStagePaths", () => {
    const root = mkdtempSync(join(tmpdir(), "hygiene-pd-stage-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "main.md"), "# Deft\n", "utf8");
      mkdirSync(join(root, "xbrief"), { recursive: true });
      writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}\n", "utf8");
      mkdirSync(join(root, "vbrief"), { recursive: true });
      writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}\n", "utf8");
      writeFileSync(join(root, "xbrief", ".deft-version"), "0.91.0\n", "utf8");

      const paths = frameworkStagePaths(root, join(root, ".deft", "core"));
      expect(paths).not.toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
      expect(paths).not.toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
      // Framework scaffolding still stages.
      expect(paths).toContain("xbrief/.deft-version");
      expect(paths).toContain(".deft/core");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies core+PD as mixed (app non-empty) for no-mixed-core-and-app", () => {
    // Mirrors deposited guard semantics: core = .deft/core/**; app = not core and
    // not installer-managed. Both core and app non-empty ⇒ guard fails (#1430).
    const changed = [".deft/core/VERSION", "xbrief/PROJECT-DEFINITION.xbrief.json"];
    const core = changed.filter((p) => p.startsWith(".deft/core/"));
    const app = changed.filter((p) => !p.startsWith(".deft/core/") && !isInstallerManagedPath(p));
    expect(core.length).toBeGreaterThan(0);
    expect(app).toEqual(["xbrief/PROJECT-DEFINITION.xbrief.json"]);
  });
});

describe("scoped staging", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  function initGitRepo(root: string): void {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
  }

  it("stages Taskfile.yml after ensureTaskfile writes the deft include (#1576)", async () => {
    const { ensureTaskfile } = await import("./scaffold.js");
    const project = freshRoot("hygiene-taskfile-");

    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(join(project, ".deft", "core", "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# Agent\n", "utf8");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "app.ts"), "export const app = 1;\n", "utf8");
    initGitRepo(project);

    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\ntasks:\n  build:\n    cmds: [npm run build]\n",
      "utf8",
    );

    expect(ensureTaskfile(project, { printf: () => {} })).toBe(true);
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain(
      CANONICAL_TASKFILE_INCLUDE,
    );
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain("build:");

    const { stagedPaths } = depositStagePaths(project, { includeTaskfile: true });
    expect(stagedPaths).toContain("Taskfile.yml");

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
    expect(cached).not.toContain("src/app.ts");
  });

  it("stagedPaths reports only paths with real index changes, not every candidate (#1576)", async () => {
    const { ensureTaskfile } = await import("./scaffold.js");
    const project = freshRoot("hygiene-actually-staged-");

    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(join(project, ".deft", "core", "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# Agent\n", "utf8");
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\ntasks:\n  build:\n    cmds: [npm run build]\n",
      "utf8",
    );
    initGitRepo(project);

    // Only Taskfile.yml is modified after baseline; AGENTS.md / .deft/core are clean.
    expect(ensureTaskfile(project, { printf: () => {} })).toBe(true);

    const { stagePaths, stagedPaths } = depositStagePaths(project, { includeTaskfile: true });
    expect(stagePaths).toContain("AGENTS.md");
    expect(stagedPaths).toContain("Taskfile.yml");
    expect(stagedPaths).not.toContain("AGENTS.md");
    expect(stagedPaths).not.toContain(".deft/core");
  });

  it("honors includeCore=false while staging repaired projections (#2118)", () => {
    const project = freshRoot("hygiene-no-core-stage-");

    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(join(project, ".deft", "core", "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# Agent\n", "utf8");
    initGitRepo(project);

    writeFileSync(join(project, ".deft", "core", "main.md"), "# Deft\r\n", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# Agent\n\nupdated\n", "utf8");

    const { stagePaths, stagedPaths } = depositStagePaths(project, { includeCore: false });

    expect(stagePaths).not.toContain(".deft/core");
    expect(stagedPaths).toContain("AGENTS.md");
    expect(stagedPaths).not.toContain(".deft/core");

    const cached = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(cached).toContain("AGENTS.md");
    expect(cached).not.toContain(".deft/core/main.md");
  });

  it("does not stage Taskfile.yml when the include was not wired this run (#1576)", async () => {
    const project = freshRoot("hygiene-unwired-taskfile-");

    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(join(project, ".deft", "core", "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# Agent\n", "utf8");
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\ntasks:\n  build:\n    cmds: [npm run build]\n",
      "utf8",
    );
    initGitRepo(project);

    // Simulate an interactive run: the user edits their own Taskfile.yml, but
    // the installer never wired the deft include (includeTaskfile omitted).
    writeFileSync(
      join(project, "Taskfile.yml"),
      "version: '3'\ntasks:\n  build:\n    cmds: [npm run build]\n  test:\n    cmds: [npm test]\n",
      "utf8",
    );

    const { stagePaths, stagedPaths } = depositStagePaths(project);
    expect(stagePaths).not.toContain("Taskfile.yml");
    expect(stagedPaths).not.toContain("Taskfile.yml");

    // The user's Taskfile.yml edit is left un-staged for them to handle.
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    expect(porcelain).toMatch(/Taskfile\.yml/);
  });

  it("stageFrameworkPaths is a no-op outside git", () => {
    const project = freshRoot("hygiene-nogit-");
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    writeFileSync(join(project, ".deft", "core", "main.md"), "# Deft\n", "utf8");
    const paths = frameworkStagePaths(project, join(project, ".deft", "core"));
    const result = stageFrameworkPaths(project, paths, { gitPorcelain: () => null });
    expect(result.staged).toBe(false);
    expect(existsSync(join(project, ".deft", "core", "main.md"))).toBe(true);
  });
});

describe("pruneStrayDepositPaths (#2347)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  it("removes stray packages/ from .deft/core when absent from content package", async () => {
    const root = freshRoot("prune-stray-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(join(deftDir, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(deftDir, "packages", "core", "src", "index.ts"), "export {};\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    const lines: string[] = [];
    const result = await pruneStrayDepositPaths(deftDir, contentRoot, {
      printf: (t) => lines.push(t),
    });

    expect(result.pruned).toContain("packages");
    expect(existsSync(join(deftDir, "packages"))).toBe(false);
    expect(lines.join("")).toContain("Pruned stray framework-source tree");
    expect(lines.join("")).toContain("#2347");
  });

  it("does NOT prune packages/ when content package also ships it", async () => {
    const root = freshRoot("prune-skip-content-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(join(deftDir, "packages"), { recursive: true });
    mkdirSync(join(contentRoot, "packages"), { recursive: true });
    writeFileSync(join(contentRoot, "packages", "README.md"), "# shipped\n", "utf8");

    const result = await pruneStrayDepositPaths(deftDir, contentRoot, { printf: () => {} });

    expect(result.pruned).toHaveLength(0);
    expect(existsSync(join(deftDir, "packages"))).toBe(true);
  });

  it("is a no-op when the stray path is already absent", async () => {
    const root = freshRoot("prune-absent-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(deftDir, { recursive: true });
    mkdirSync(contentRoot, { recursive: true });

    const result = await pruneStrayDepositPaths(deftDir, contentRoot, { printf: () => {} });

    expect(result.pruned).toHaveLength(0);
  });
});

describe("package-absent deposit prune (#2804)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  it("treats VERSION as generated deposit metadata", () => {
    expect(isDepositGeneratedMetadata("VERSION")).toBe(true);
    expect(isDepositGeneratedMetadata("main.md")).toBe(false);
  });

  it("finds bridge-era leftovers absent from the content package", () => {
    const root = freshRoot("package-absent-find-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(join(deftDir, "cmd", "deft-install"), { recursive: true });
    writeFileSync(join(deftDir, "cmd", "deft-install", "main.go"), "package main\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "v0.84.0\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    expect(findPackageAbsentDepositPathsSync(deftDir, contentRoot)).toEqual([
      "cmd/deft-install/main.go",
    ]);
  });

  it("removes package-absent bridge leftovers while preserving VERSION", async () => {
    const root = freshRoot("package-absent-prune-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(join(deftDir, "cmd", "deft-install"), { recursive: true });
    writeFileSync(join(deftDir, "cmd", "deft-install", "main.go"), "package main\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "v0.84.0\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    const lines: string[] = [];
    const result = await prunePackageAbsentDepositPaths(deftDir, contentRoot, {
      printf: (text) => lines.push(text),
    });

    expect(result.pruned).toEqual(["cmd/deft-install/main.go"]);
    expect(existsSync(join(deftDir, "cmd", "deft-install", "main.go"))).toBe(false);
    expect(existsSync(join(deftDir, "VERSION"))).toBe(true);
    expect(await findPackageAbsentDepositPaths(deftDir, contentRoot)).toEqual([]);
    expect(lines.join("")).toContain("#2804");
  });

  it("is a no-op when the deposit already matches the content package", async () => {
    const root = freshRoot("package-absent-clean-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "v0.84.0\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    const result = await prunePackageAbsentDepositPaths(deftDir, contentRoot, { printf: () => {} });

    expect(result.pruned).toHaveLength(0);
    expect(result.prunedDirs).toHaveLength(0);
  });

  it("also prunes package-absent files under packages/ when absent from the content package", async () => {
    const root = freshRoot("package-absent-packages-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(join(deftDir, "packages", "core"), { recursive: true });
    writeFileSync(join(deftDir, "packages", "core", "index.ts"), "export {};\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    const result = await prunePackageAbsentDepositPaths(deftDir, contentRoot, { printf: () => {} });

    expect(result.pruned).toContain("packages/core/index.ts");
    expect(await findPackageAbsentDepositPaths(deftDir, contentRoot)).toEqual([]);
  });
});

describe("reconcileDepositToContentPackage fail-closed (#2913)", () => {
  const created: string[] = [];
  const itUnix = it.skipIf(process.platform === "win32");

  afterEach(() => {
    for (const dir of created.splice(0)) {
      try {
        // Best-effort restore perms so cleanup can delete locked fixtures.
        chmodSync(dir, 0o755);
      } catch {
        // ignore
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  it("prunes dst-only leftovers and returns clean", async () => {
    const root = freshRoot("reconcile-ok-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    mkdirSync(join(deftDir, "agents"), { recursive: true });
    writeFileSync(join(deftDir, "agents", "stale-skill.md"), "EVIL\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "tag: 'v0.87.0'\n", "utf8");
    writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    const result = await reconcileDepositToContentPackage(deftDir, contentRoot, {
      printf: () => {},
    });

    expect(result.pruned).toContain("agents/stale-skill.md");
    expect(existsSync(join(deftDir, "agents", "stale-skill.md"))).toBe(false);
    expect(existsSync(join(deftDir, "VERSION"))).toBe(true);
  });

  itUnix("throws when a package-absent path cannot be removed (refuse VERSION stamp)", async () => {
    const root = freshRoot("reconcile-locked-");
    const deftDir = join(root, ".deft", "core");
    const contentRoot = join(root, "content-pkg");
    const lockedDir = join(deftDir, "locked");
    mkdirSync(lockedDir, { recursive: true });
    writeFileSync(join(lockedDir, "stale.md"), "EVIL\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "tag: 'v0.87.0'\n", "utf8");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");

    // Directory without owner write/execute → unlink of children fails.
    chmodSync(lockedDir, 0o555);

    await expect(
      reconcileDepositToContentPackage(deftDir, contentRoot, { printf: () => {} }),
    ).rejects.toThrow(/Refusing VERSION stamp|#2913|deposit reconcile failed/);

    // Restore perms so afterEach can clean up.
    chmodSync(lockedDir, 0o755);
  });
});
