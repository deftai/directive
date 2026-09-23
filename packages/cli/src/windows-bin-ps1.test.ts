import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateBinDirs,
  cmdShimTargetsPackage,
  linkerBinDir,
  NODE_OWNED_SHIM_NAMES,
  nodeModulesDir,
  PACKAGE_BIN_NAMES,
  readPackageBinNames,
  removeGeneratedPs1Shims,
  removeInstalledWindowsPs1Shims,
} from "./windows-bin-ps1.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deft-ps1-shim-"));
  temps.push(dir);
  return dir;
}

function writePair(dir: string, name: string): void {
  writeFileSync(join(dir, name), "#!/bin/sh\necho SELECTED-SH\n");
  writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\necho SELECTED-CMD\r\n");
  writeFileSync(join(dir, `${name}.ps1`), "Write-Output SELECTED-PS1\r\n");
}

function writeOwnedPair(
  binDir: string,
  name: string,
  pkgDir: string,
  form: "dp0" | "tilde" | "slash" = "dp0",
): void {
  const rel = relative(binDir, join(pkgDir, "dist", "bin.js"));
  const batchRel = rel.split("/").join("\\");
  const slashRel = rel.split("\\").join("/");
  let token = `%dp0%\\${batchRel}`;
  if (form === "tilde") token = `%~dp0\\${batchRel}`;
  if (form === "slash") token = `%dp0%/${slashRel}`;
  const cmd = `@echo off\r\nREM "${token}"\r\necho SELECTED-CMD\r\n`;
  writeFileSync(join(binDir, name), "#!/bin/sh\necho SELECTED-SH\n");
  writeFileSync(join(binDir, `${name}.cmd`), cmd);
  writeFileSync(join(binDir, `${name}.ps1`), "Write-Output SELECTED-PS1\r\n");
}

describe("windows bin .ps1 removal (#4654)", () => {
  it("resolves the linker directory for scoped, unscoped, and global installs", () => {
    const scoped = join("proj", "node_modules", "@deftai", "directive");
    const unscoped = join("proj", "node_modules", "directive");
    expect(nodeModulesDir(scoped)).toBe(join("proj", "node_modules"));
    expect(nodeModulesDir(unscoped)).toBe(join("proj", "node_modules"));
    expect(linkerBinDir({ pkgDir: scoped, global: false, platform: "win32" })).toBe(
      join("proj", "node_modules", ".bin"),
    );
    expect(linkerBinDir({ pkgDir: scoped, global: true, platform: "win32" })).toBe("proj");
    expect(linkerBinDir({ pkgDir: scoped, global: true, platform: "linux" })).toBe(
      join("proj", "bin"),
    );
  });

  it("adds prefix and PNPM_HOME only for a global install, and local .bin otherwise", () => {
    const pkgDir = join("prefix", "node_modules", "@deftai", "directive");
    const globalDirs = candidateBinDirs({
      pkgDir,
      platform: "win32",
      env: { npm_config_global: "true", npm_config_prefix: "prefix", PNPM_HOME: "pnpm-home" },
    });
    expect(globalDirs).toEqual(["prefix", "pnpm-home"]);
    const unixDirs = candidateBinDirs({
      pkgDir,
      platform: "linux",
      env: { npm_config_global: "true", npm_config_prefix: "/opt/node", PNPM_HOME: "" },
    });
    expect(unixDirs).toEqual([join("prefix", "bin"), join("/opt/node", "bin")]);
    const localBin = join("repo", "node_modules", ".bin");
    const localDirs = candidateBinDirs({
      pkgDir: join("repo", "packages", "cli"),
      platform: "win32",
      env: { npm_config_local_prefix: "repo" },
    });
    expect(localDirs).toContain(localBin);
    expect(localDirs).not.toContain(join("repo", ".bin"));
    const outside = candidateBinDirs({
      pkgDir: join("repo", "packages", "cli"),
      platform: "win32",
      env: { npm_config_local_prefix: join("other", "tree") },
    });
    expect(outside).toEqual([join("other", "tree", "node_modules", ".bin")]);
  });

  it("ignores an empty prefix and does not treat a local install as global", () => {
    const pkgDir = join("prefix", "node_modules", "@deftai", "directive");
    expect(
      candidateBinDirs({
        pkgDir,
        platform: "win32",
        env: { npm_config_global: "true", npm_config_prefix: "" },
      }),
    ).toEqual(["prefix"]);
    expect(
      candidateBinDirs({
        pkgDir,
        platform: "linux",
        env: {},
      }),
    ).toEqual([join("prefix", "node_modules", ".bin")]);
  });

  it("removes the five generated .ps1 files and leaves npm, npx, and unpaired scripts", () => {
    const binDir = tempDir();
    for (const name of PACKAGE_BIN_NAMES) writePair(binDir, name);
    writePair(binDir, "npm");
    writePair(binDir, "npx");
    writeFileSync(join(binDir, "orphan.ps1"), "Write-Output ORPHAN\r\n");

    const skipped = removeGeneratedPs1Shims({
      binDir,
      binNames: PACKAGE_BIN_NAMES,
      platform: "linux",
    });
    expect(skipped).toEqual({ removed: [], failed: [] });
    expect(
      removeGeneratedPs1Shims({
        binDir,
        binNames: ["npm", "NPM", "../npm", ""],
        platform: "win32",
      }),
    ).toEqual({ removed: [], failed: [] });

    const result = removeGeneratedPs1Shims({
      binDir,
      binNames: [...PACKAGE_BIN_NAMES, "npm", "npx", "orphan"],
      platform: "win32",
    });
    expect(result.failed).toEqual([]);
    expect(result.removed.map((path) => path.slice(binDir.length + 1)).sort()).toEqual(
      PACKAGE_BIN_NAMES.map((name) => `${name}.ps1`).sort(),
    );
    for (const name of PACKAGE_BIN_NAMES) {
      expect(existsSync(join(binDir, `${name}.ps1`))).toBe(false);
      expect(existsSync(join(binDir, `${name}.cmd`))).toBe(true);
      expect(existsSync(join(binDir, name))).toBe(true);
    }
    for (const name of NODE_OWNED_SHIM_NAMES) {
      expect(existsSync(join(binDir, `${name}.ps1`))).toBe(true);
      expect(existsSync(join(binDir, `${name}.cmd`))).toBe(true);
    }
    expect(existsSync(join(binDir, "orphan.ps1"))).toBe(true);
  });

  it("records a .ps1 that cannot be unlinked", () => {
    const binDir = tempDir();
    writeFileSync(join(binDir, "directive.cmd"), "@echo off\r\n");
    mkdirSync(join(binDir, "directive.ps1"));
    const result = removeGeneratedPs1Shims({
      binDir,
      binNames: ["directive"],
      platform: "win32",
    });
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([join(binDir, "directive.ps1")]);
  });

  it("reads bin names from package.json and falls back when the file cannot be read", () => {
    expect(readPackageBinNames("{")).toEqual([]);
    expect(readPackageBinNames("null")).toEqual([]);
    expect(readPackageBinNames("[]")).toEqual([]);
    expect(readPackageBinNames("{}")).toEqual([]);
    expect(readPackageBinNames(JSON.stringify({ bin: "./dist/bin.js" }))).toEqual([]);
    expect(readPackageBinNames(JSON.stringify({ bin: ["./dist/bin.js"] }))).toEqual([]);
    expect(readPackageBinNames(JSON.stringify({ bin: { directive: "./dist/bin.js" } }))).toEqual([
      "directive",
    ]);

    const root = tempDir();
    const pkgDir = join(root, "node_modules", "@deftai", "directive");
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ bin: { directive: "./dist/bin.js", npm: "./dist/bin.js" } }),
    );
    writeOwnedPair(binDir, "directive", pkgDir);
    writePair(binDir, "npm");
    writeOwnedPair(binDir, "deft", pkgDir);
    const removed = removeInstalledWindowsPs1Shims({
      pkgDir,
      env: {},
      platform: "win32",
    });
    expect(removed.failed).toEqual([]);
    expect(removed.removed).toEqual([join(binDir, "directive.ps1")]);
    expect(existsSync(join(binDir, "npm.ps1"))).toBe(true);
    expect(existsSync(join(binDir, "deft.ps1"))).toBe(true);

    expect(
      removeInstalledWindowsPs1Shims({
        pkgDir,
        env: {},
        platform: "linux",
      }),
    ).toEqual({ removed: [], failed: [] });
    const fromThrow = removeInstalledWindowsPs1Shims({
      pkgDir,
      env: {},
      platform: "win32",
      readText: () => {
        throw new Error("missing");
      },
    });
    expect(fromThrow.removed).toEqual([join(binDir, "deft.ps1")]);
  });

  it("does not clean an unrelated PNPM_HOME during a global npm install", () => {
    const root = tempDir();
    const prefix = join(root, "npm-prefix");
    const pkgDir = join(prefix, "node_modules", "@deftai", "directive");
    const pnpmHome = join(root, "pnpm-home");
    const otherPkg = join(root, "pnpm-global", "node_modules", "@deftai", "directive");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(pnpmHome, { recursive: true });
    mkdirSync(otherPkg, { recursive: true });
    const binMap = Object.fromEntries(PACKAGE_BIN_NAMES.map((name) => [name, "./dist/bin.js"]));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: binMap }));
    for (const name of PACKAGE_BIN_NAMES) {
      writeOwnedPair(prefix, name, pkgDir);
      writeOwnedPair(pnpmHome, name, otherPkg);
    }

    const removed = removeInstalledWindowsPs1Shims({
      pkgDir,
      env: { npm_config_global: "true", npm_config_prefix: prefix, PNPM_HOME: pnpmHome },
      platform: "win32",
    });
    expect(removed.failed).toEqual([]);
    expect(removed.removed).toEqual(PACKAGE_BIN_NAMES.map((name) => join(prefix, `${name}.ps1`)));
    for (const name of PACKAGE_BIN_NAMES) {
      expect(existsSync(join(prefix, `${name}.ps1`))).toBe(false);
      expect(existsSync(join(prefix, `${name}.cmd`))).toBe(true);
      expect(existsSync(join(pnpmHome, `${name}.ps1`))).toBe(true);
      expect(existsSync(join(pnpmHome, `${name}.cmd`))).toBe(true);
    }
    expect(cmdShimTargetsPackage("@echo off\r\n", prefix, pkgDir)).toBe(false);
    expect(cmdShimTargetsPackage('"%dp0%\\node.exe"', prefix, pkgDir)).toBe(false);
  });

  it("cleans PNPM_HOME when its shims target this install", () => {
    const root = tempDir();
    const prefix = join(root, "npm-prefix");
    const pkgDir = join(prefix, "node_modules", "@deftai", "directive");
    const pnpmHome = join(root, "pnpm-home");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(pnpmHome, { recursive: true });
    const binMap = Object.fromEntries(PACKAGE_BIN_NAMES.map((name) => [name, "./dist/bin.js"]));
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: binMap }));
    for (const name of PACKAGE_BIN_NAMES) {
      const form = name === "directive" ? "tilde" : name === "deft" ? "slash" : "dp0";
      writeOwnedPair(pnpmHome, name, pkgDir, form);
    }

    const removed = removeInstalledWindowsPs1Shims({
      pkgDir,
      env: { npm_config_global: "true", npm_config_prefix: prefix, PNPM_HOME: pnpmHome },
      platform: "win32",
    });
    expect(removed.failed).toEqual([]);
    expect(removed.removed).toEqual(PACKAGE_BIN_NAMES.map((name) => join(pnpmHome, `${name}.ps1`)));
    for (const name of PACKAGE_BIN_NAMES) {
      expect(existsSync(join(pnpmHome, `${name}.ps1`))).toBe(false);
      expect(existsSync(join(pnpmHome, `${name}.cmd`))).toBe(true);
    }
  });

  it("cleans a shim whose cmd-shim target is this install through a junction", () => {
    const root = tempDir();
    const realPkg = join(root, "real", "node_modules", "@deftai", "directive");
    const linkPkg = join(root, "link", "pkg");
    const pnpmHome = join(root, "pnpm-home");
    mkdirSync(realPkg, { recursive: true });
    mkdirSync(join(realPkg, "dist"), { recursive: true });
    writeFileSync(join(realPkg, "dist", "bin.js"), "process.exit(0)\n");
    writeFileSync(
      join(realPkg, "package.json"),
      JSON.stringify({ bin: { directive: "./dist/bin.js" } }),
    );
    mkdirSync(join(root, "link"), { recursive: true });
    symlinkSync(realPkg, linkPkg, "junction");
    try {
      mkdirSync(pnpmHome, { recursive: true });
      writeOwnedPair(pnpmHome, "directive", realPkg);
      const removed = removeInstalledWindowsPs1Shims({
        pkgDir: linkPkg,
        env: { npm_config_global: "true", PNPM_HOME: pnpmHome },
        platform: "win32",
      });
      expect(removed.failed).toEqual([]);
      expect(removed.removed).toEqual([join(pnpmHome, "directive.ps1")]);
    } finally {
      rmSync(linkPkg, { force: true });
    }
  });
});

const itWin = it.skipIf(process.platform !== "win32");

describe("windows Get-Command after install (#4654)", () => {
  itWin(
    "selects the .cmd for each package bin under Restricted and does not touch npm or npx",
    () => {
      const prefix = tempDir();
      const pkgDir = join(prefix, "node_modules", "@deftai", "directive");
      mkdirSync(pkgDir, { recursive: true });
      const binMap = Object.fromEntries(PACKAGE_BIN_NAMES.map((name) => [name, "./dist/bin.js"]));
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: binMap }));
      for (const name of PACKAGE_BIN_NAMES) writeOwnedPair(prefix, name, pkgDir);
      writePair(prefix, "npm");
      writePair(prefix, "npx");

      const before = powershell(prefix, sourceCommand());
      expect(before.status, before.stderr).toBe(0);
      for (const name of PACKAGE_BIN_NAMES) {
        expect(before.stdout).toContain(`SRC|${name}|`);
        expect(lineSource(before.stdout, name).toLowerCase().endsWith(`${name}.ps1`)).toBe(true);
      }

      const removed = removeInstalledWindowsPs1Shims({
        pkgDir,
        env: { npm_config_global: "true" },
        platform: "win32",
      });
      expect(removed.failed).toEqual([]);
      expect(removed.removed).toHaveLength(PACKAGE_BIN_NAMES.length);

      const after = powershell(prefix, `${sourceCommand()}\n${runCommand()}`);
      expect(after.status, `${after.stderr}\n${after.stdout}`).toBe(0);
      for (const name of PACKAGE_BIN_NAMES) {
        expect(lineSource(after.stdout, name).toLowerCase().endsWith(`${name}.cmd`)).toBe(true);
      }
      const runs = after.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line === "SELECTED-CMD");
      expect(runs).toHaveLength(PACKAGE_BIN_NAMES.length);
      expect(after.stdout).not.toContain("SELECTED-PS1");
      expect(after.stdout).not.toContain("SELECTED-SH");
      expect(existsSync(join(prefix, "npm.ps1"))).toBe(true);
      expect(existsSync(join(prefix, "npx.ps1"))).toBe(true);
    },
    60_000,
  );
});

function sourceCommand(): string {
  return [
    "$names = @('directive','deft','deft-ts','deft-hook','deft-verify-encoding')",
    "foreach ($n in $names) {",
    "  $src = (Get-Command -Name $n).Source",
    "  Write-Output ('SRC|' + $n + '|' + $src)",
    "}",
  ].join("\n");
}

function runCommand(): string {
  return [
    "$names = @('directive','deft','deft-ts','deft-hook','deft-verify-encoding')",
    "foreach ($n in $names) { & $n }",
  ].join("\n");
}

function lineSource(stdout: string, name: string): string {
  const line = stdout.split(/\r?\n/).find((row) => row.startsWith(`SRC|${name}|`));
  return line?.split("|")[2] ?? "";
}

function powershell(
  binDir: string,
  command: string,
): { status: number | null; stdout: string; stderr: string } {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershellExe = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = `${binDir};${join(systemRoot, "System32")};${systemRoot}`;
  const result = spawnSync(
    powershellExe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", command],
    { encoding: "utf8", env, windowsHide: true },
  );
  const errorText = result.error === undefined ? "" : result.error.message;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: `${errorText}\n${result.stderr ?? ""}`,
  };
}
