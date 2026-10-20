/**
 * Wave 2j RED — SEC-ESC / SEC-ROOT owner-boundary containment (AC3.4, AC3.8,
 * AC11.10, AC14.43, D4.15).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject } from "./discover.js";
import { applyLauncherCleanup, discoverUninstallFootprint } from "./uninstall-map.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function tempGitProject(name: string): string {
  const root = tempDir(name);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "yolo@local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "yolo"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ private: true, name: name }, null, 2)}\n`,
  );
  return root;
}

describe("SEC-ESC ownership path escape (AC3.4 / AC11.10 / D4.15)", () => {
  it("refuses ../ ownership paths — outside victim survives cleanup", () => {
    const parent = tempDir("sec-esc-parent");
    const project = join(parent, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q"], { cwd: project });
    const victim = join(parent, "mal-victim.txt");
    writeFileSync(victim, "do-not-delete\n");
    writeFileSync(join(project, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "GENERATION.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtimeVersion: "0.0.0-yolo.test",
          packageManager: "npm",
          ownership: [{ path: "../mal-victim.txt", kind: "whole-file" }],
        },
        null,
        2,
      )}\n`,
    );

    const discovery = discoverUninstallFootprint(project);
    const escapeClaim = discovery.artifacts.find((a) => a.path.includes(".."));
    expect(escapeClaim).toBeUndefined();

    const report = applyLauncherCleanup(project, discovery);
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("do-not-delete\n");
    expect(report.removed).not.toContain("../mal-victim.txt");
    expect(
      report.uncertainty.some((u) => /escape|reject|unsafe|outside/i.test(u)) ||
        report.leftovers.some((l) => l.includes("..")) ||
        escapeClaim === undefined,
    ).toBe(true);
  });

  it("refuses absolute ownership paths — absolute victim survives", () => {
    const project = tempGitProject("sec-esc-abs");
    const outside = tempDir("sec-esc-abs-victim");
    const victim = join(outside, "abs-victim.txt");
    writeFileSync(victim, "absolute-keep\n");
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "GENERATION.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtimeVersion: "0.0.0-yolo.test",
          packageManager: "npm",
          ownership: [{ path: victim, kind: "whole-file" }],
        },
        null,
        2,
      )}\n`,
    );

    const discovery = discoverUninstallFootprint(project);
    expect(discovery.artifacts.some((a) => a.path === victim || a.path.startsWith("/"))).toBe(
      false,
    );
    applyLauncherCleanup(project, discovery);
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("absolute-keep\n");
  });

  it("still removes owned in-project whole-file artifacts", () => {
    const project = tempGitProject("sec-esc-happy");
    mkdirSync(join(project, ".deft"), { recursive: true });
    mkdirSync(join(project, ".githooks"), { recursive: true });
    const owned = join(project, ".githooks", "_directive-run.sh");
    writeFileSync(owned, "#!/bin/sh\n");
    writeFileSync(
      join(project, ".deft", "GENERATION.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtimeVersion: "0.0.0-yolo.test",
          packageManager: "npm",
          ownership: [{ path: ".githooks/_directive-run.sh", kind: "whole-file" }],
        },
        null,
        2,
      )}\n`,
    );

    const discovery = discoverUninstallFootprint(project);
    const report = applyLauncherCleanup(project, discovery);
    expect(existsSync(owned)).toBe(false);
    expect(report.removed).toContain(".githooks/_directive-run.sh");
  });

  it("refuses ownership path '.' / 'subdir/..' so the checkout is not deleted", () => {
    const project = tempGitProject("sec-esc-dot");
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(join(project, "keep.txt"), "alive\n");
    writeFileSync(
      join(project, ".deft", "GENERATION.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtimeVersion: "0.0.0-yolo.test",
          packageManager: "npm",
          ownership: [
            { path: ".", kind: "whole-file" },
            { path: "nested/..", kind: "whole-file" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const discovery = discoverUninstallFootprint(project);
    expect(discovery.artifacts.some((a) => a.path === "." || a.path.includes(".."))).toBe(false);
    expect(discovery.rejectedOwnershipPaths).toEqual(expect.arrayContaining([".", "nested/.."]));
    applyLauncherCleanup(project, discovery);
    expect(existsSync(project)).toBe(true);
    expect(existsSync(join(project, "keep.txt"))).toBe(true);
    expect(existsSync(join(project, "package.json"))).toBe(true);
  });
});

describe("SEC-ROOT --root symlink refuse (AC3.8 / AC14.43)", () => {
  it("refuses --root symlink whose realpath is $HOME", () => {
    const staging = tempDir("sec-root-home");
    const link = join(staging, "home-link");
    const home = realpathSync(homedir());
    try {
      symlinkSync(home, link);
    } catch {
      // Some CI sandboxes forbid home symlinks — skip only when link cannot be made.
      return;
    }
    const result = discoverProject({ cwd: staging, rootFlag: link });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("refused_home");
    }
  });

  it("refuses --root symlink whose realpath is filesystem root", () => {
    const staging = tempDir("sec-root-fs");
    const link = join(staging, "root-link");
    try {
      symlinkSync("/", link);
    } catch {
      return;
    }
    const result = discoverProject({ cwd: staging, rootFlag: link });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("refused_root");
    }
  });

  it("still refuses literal $HOME and /", () => {
    const home = discoverProject({ cwd: tmpdir(), rootFlag: homedir() });
    expect(home.ok).toBe(false);
    if (!home.ok) expect(home.kind).toBe("refused_home");

    const root = discoverProject({ cwd: tmpdir(), rootFlag: "/" });
    expect(root.ok).toBe(false);
    if (!root.ok) expect(root.kind).toBe("refused_root");
  });

  it("accepts --root symlink to a normal git project", () => {
    const project = tempGitProject("sec-root-ok");
    writeFileSync(join(project, "README.md"), "ok\n");
    execFileSync("git", ["-C", project, "add", "package.json", "README.md"]);
    execFileSync("git", ["-C", project, "commit", "--no-gpg-sign", "-qm", "init"]);
    const staging = tempDir("sec-root-ok-link");
    const link = join(staging, "proj-link");
    try {
      // Directory symlink (Windows requires type: "dir"); skip when host forbids it.
      symlinkSync(project, link, "dir");
    } catch {
      return;
    }
    const result = discoverProject({ cwd: staging, rootFlag: link });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(realpathSync(result.root)).toBe(realpathSync(project));
    }
  });
});
