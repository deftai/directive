import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SpawnResult } from "../release/types.js";
import { alignNpmPackageVersions, rehearseNpmPublish, resolvePnpm } from "./npm-ops.js";
import type { E2ESeams } from "./types.js";

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
    const publishCwds = calls.filter((c) => c.cmd.includes("publish")).map((c) => c.cwd);
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
