import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  depositStagePaths,
  frameworkStagePaths,
  installerManagedGuardEre,
  isInstallerManagedPath,
  stageFrameworkPaths,
} from "./hygiene.js";
import { CANONICAL_TASKFILE_INCLUDE } from "./scaffold.js";

describe("installer-managed allowlist (#1576)", () => {
  it("treats Taskfile.yml as installer-managed", () => {
    expect(isInstallerManagedPath("Taskfile.yml")).toBe(true);
    expect(installerManagedGuardEre()).toContain("Taskfile\\.yml");
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
