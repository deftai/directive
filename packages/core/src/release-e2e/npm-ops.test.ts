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
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { runInitDeposit } from "../init-deposit/init-deposit.js";
import { runRefreshDeposit } from "../init-deposit/refresh.js";
import type { SpawnResult } from "../release/types.js";
import { alignNpmPackageVersions, rehearseNpmPublish, resolvePnpm } from "./npm-ops.js";
import type { E2ESeams } from "./types.js";

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
  writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
  writeFileSync(join(pkgDir, "vbrief", "schemas", "cache-meta.schema.json"), "{}\n", "utf8");
  writeFileSync(join(pkgDir, "vbrief", "vbrief.md"), "# vbrief\n", "utf8");
  writeFileSync(join(pkgDir, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(pkgDir, ".githooks", "pre-commit"), 0o755);
  writeFileSync(join(pkgDir, "Taskfile.yml"), "version: '3'\n", "utf8");
  return pkgDir;
}

function scaffoldPackages(cloneDir: string): void {
  const manifests: Record<string, unknown> = {
    types: { name: "@deftai/directive-types", version: "0.0.0" },
    core: {
      name: "@deftai/directive-core",
      version: "0.0.0",
      dependencies: { "@deftai/directive-types": "workspace:*" },
    },
    content: { name: "@deftai/directive-content", version: "0.0.0" },
    cli: {
      name: "@deftai/directive",
      version: "0.0.0",
      dependencies: {
        "@deftai/directive-types": "workspace:*",
        "@deftai/directive-core": "workspace:*",
        "@deftai/directive-content": "workspace:*",
      },
    },
  };
  for (const [name, data] of Object.entries(manifests)) {
    const pkgDir = join(cloneDir, "packages", name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(data), "utf8");
  }
}

function ok(): SpawnResult {
  return { status: 0, stdout: "", stderr: "" };
}

describe("deposit journey e2e legs (#1942 S5)", () => {
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

  it("greenfield leg: directive init deposits hybrid shape without Go binary", async () => {
    const spawnSpy = vi.spyOn(spawnSync as never, "apply" as never).mockImplementation(() => {
      throw new Error("spawnSync should not be called on TS-native init happy path");
    });

    const project = freshRoot("e2e-greenfield-");
    const contentRoot = installFakeContentPackage(project);

    const result = await runInitDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        nowIso: () => "2026-06-24T12:00:00Z",
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
      },
    );

    expect(result.deftDir).toBe(join(project, ".deft/core"));
    expect(readFileSync(join(result.deftDir, "main.md"), "utf8")).toContain("# Deft");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain("deft:managed-section");
    expect(existsSync(join(project, "vbrief", "active", ".gitkeep"))).toBe(true);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".deft/core/");
    expect(existsSync(join(project, ".githooks", "pre-commit"))).toBe(true);
    expect(readFileSync(join(project, "Taskfile.yml"), "utf8")).toContain(
      "./.deft/core/Taskfile.yml",
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("upgrade leg: directive update refresh is idempotent with no spurious AGENTS.md diff", async () => {
    const project = freshRoot("e2e-upgrade-");
    const contentRoot = installFakeContentPackage(project, "0.53.0");
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

    await runInitDeposit(args, io, {
      ...seams,
      gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
    });

    io.printf.mockClear();
    await runRefreshDeposit(args, io, seams);
    const firstAgents = readFileSync(join(project, "AGENTS.md"), "utf8");

    io.printf.mockClear();
    const second = await runRefreshDeposit(args, io, seams);
    const secondAgents = readFileSync(join(project, "AGENTS.md"), "utf8");

    expect(secondAgents).toBe(firstAgents);
    expect(second.agentsMdUpdated).toBe(false);
    expect(existsSync(join(project, ".deft/core", "main.md"))).toBe(true);
  });
});

describe("resolvePnpm", () => {
  it("prefers a pnpm binary on PATH", () => {
    expect(resolvePnpm({ which: (n) => (n === "pnpm" ? "/usr/bin/pnpm" : null) })).toEqual([
      "/usr/bin/pnpm",
    ]);
  });

  it("falls back to corepack pnpm", () => {
    expect(resolvePnpm({ which: (n) => (n === "corepack" ? "/usr/bin/corepack" : null) })).toEqual([
      "/usr/bin/corepack",
      "pnpm",
    ]);
  });

  it("returns null when neither is available", () => {
    expect(resolvePnpm({ which: () => null })).toBeNull();
  });
});

describe("alignNpmPackageVersions", () => {
  it("bumps versions and resolves the workspace protocol", () => {
    const clone = mkdtempSync(join(tmpdir(), "deft-npm-align-"));
    scaffoldPackages(clone);
    const [okFlag, reason] = alignNpmPackageVersions(clone, "1.2.3");
    expect(okFlag).toBe(true);
    expect(reason).toContain("aligned 4 package versions to 1.2.3");
    for (const name of ["types", "core", "content", "cli"]) {
      const data = JSON.parse(
        readFileSync(join(clone, "packages", name, "package.json"), "utf8"),
      ) as { version: string };
      expect(data.version).toBe("1.2.3");
    }
    const cli = JSON.parse(
      readFileSync(join(clone, "packages", "cli", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(cli.dependencies["@deftai/directive-core"]).toBe("^1.2.3");
    expect(Object.values(cli.dependencies).every((v) => !v.startsWith("workspace:"))).toBe(true);
  });

  it("returns false when a manifest is missing", () => {
    const clone = mkdtempSync(join(tmpdir(), "deft-npm-align-miss-"));
    mkdirSync(join(clone, "packages", "types"), { recursive: true });
    writeFileSync(
      join(clone, "packages", "types", "package.json"),
      JSON.stringify({ name: "@deftai/directive-types", version: "0.0.0" }),
      "utf8",
    );
    const [okFlag, reason] = alignNpmPackageVersions(clone, "1.2.3");
    expect(okFlag).toBe(false);
    expect(reason).toContain("version-align FAIL");
  });
});

describe("rehearseNpmPublish", () => {
  it("soft-skips when npm is absent", () => {
    const [okFlag, reason] = rehearseNpmPublish("/proj", "0.0.1", { which: () => null });
    expect(okFlag).toBe(true);
    expect(reason).toContain("SKIP");
    expect(reason).toContain("npm not on PATH");
  });

  it("fails when neither pnpm nor corepack is on PATH", () => {
    const [okFlag, reason] = rehearseNpmPublish("/proj", "0.0.1", {
      which: (n) => (n === "npm" ? "/usr/bin/npm" : null),
    });
    expect(okFlag).toBe(false);
    expect(reason).toContain("neither pnpm nor corepack");
  });

  it("installs, builds, aligns, then publishes in dependency order", () => {
    const clone = mkdtempSync(join(tmpdir(), "deft-npm-pub-"));
    scaffoldPackages(clone);
    const calls: Array<{ cmd: string[]; cwd?: string }> = [];
    const seams: E2ESeams = {
      which: (n) => `/usr/bin/${n}`,
      spawnText: (cmd, args, options) => {
        calls.push({ cmd: [cmd, ...args], cwd: options?.cwd });
        return ok();
      },
    };
    const [okFlag, reason] = rehearseNpmPublish(clone, "0.0.1", seams);
    expect(okFlag).toBe(true);
    expect(reason).toContain("npm publish --dry-run clean for 4 packages");
    expect(calls[0]?.cmd).toContain("install");
    expect(calls[1]?.cmd).toContain("build");
    const publishCalls = calls.filter((c) => c.cmd.includes("publish"));
    expect(
      publishCalls.every((c) => c.cmd.includes("--tag") && c.cmd.includes("e2e-rehearsal")),
    ).toBe(true);
    const publishCwds = publishCalls.map((c) => c.cwd);
    expect(publishCwds).toEqual([
      join(clone, "packages", "types"),
      join(clone, "packages", "core"),
      join(clone, "packages", "content"),
      join(clone, "packages", "cli"),
    ]);
    const types = JSON.parse(
      readFileSync(join(clone, "packages", "types", "package.json"), "utf8"),
    ) as { version: string };
    expect(types.version).toBe("0.0.1");
  });

  it("short-circuits before publish when the build fails", () => {
    const clone = mkdtempSync(join(tmpdir(), "deft-npm-build-fail-"));
    scaffoldPackages(clone);
    const calls: string[][] = [];
    const seams: E2ESeams = {
      which: (n) => `/usr/bin/${n}`,
      spawnText: (cmd, args) => {
        const full = [cmd, ...args];
        calls.push(full);
        return full.includes("build") ? { status: 1, stdout: "", stderr: "boom" } : ok();
      },
    };
    const [okFlag, reason] = rehearseNpmPublish(clone, "0.0.1", seams);
    expect(okFlag).toBe(false);
    expect(reason).toContain("pnpm build failed");
    expect(calls.some((c) => c.includes("publish"))).toBe(false);
  });

  it("short-circuits when the core publish fails", () => {
    const clone = mkdtempSync(join(tmpdir(), "deft-npm-pub-fail-"));
    scaffoldPackages(clone);
    const publishCwds: Array<string | undefined> = [];
    const seams: E2ESeams = {
      which: (n) => `/usr/bin/${n}`,
      spawnText: (cmd, args, options) => {
        const full = [cmd, ...args];
        if (full.includes("publish")) {
          publishCwds.push(options?.cwd);
          if (options?.cwd === join(clone, "packages", "core")) {
            return { status: 1, stdout: "", stderr: "EPERM" };
          }
        }
        return ok();
      },
    };
    const [okFlag, reason] = rehearseNpmPublish(clone, "0.0.1", seams);
    expect(okFlag).toBe(false);
    expect(reason).toContain("packages/core");
    expect(publishCwds).not.toContain(join(clone, "packages", "content"));
    expect(publishCwds).not.toContain(join(clone, "packages", "cli"));
  });
});
