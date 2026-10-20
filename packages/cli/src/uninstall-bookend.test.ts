/**
 * Wave 2g RED/GREEN — uninstall ownership map + bookend (R11 / AC11.*).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BookendIo, runUninstall, type UninstallDeps } from "./bookends.js";
import type { ProjectInstallState } from "./pin.js";
import {
  applyLauncherCleanup,
  discoverUninstallFootprint,
  verifyUninstallComplete,
} from "./uninstall-map.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function tempProject(name = "wave2g"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "yolo@local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "yolo"], { cwd: root });
  return root;
}

function captureIo(): BookendIo & { out: () => string; err: () => string } {
  let o = "";
  let e = "";
  return {
    writeOut: (t) => {
      o += t;
    },
    writeErr: (t) => {
      e += t;
    },
    out: () => o,
    err: () => e,
  };
}

function writeGeneration(root: string, ownership: Array<Record<string, string>>): void {
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "GENERATION.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runtimeVersion: "0.0.0-yolo.cp-wave2g.1",
        packageManager: "npm",
        ownership,
      },
      null,
      2,
    )}\n`,
  );
}

function seedModernInstall(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        devDependencies: { "@deftai/directive-runtime": "0.0.0-yolo.cp-wave2g.1" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    `# User title\n\nKeep me.\n\n<!-- deft:managed-section v3 -->\nFull guidelines: node_modules/@deftai/directive-runtime/main.md\n<!-- /deft:managed-section -->\n`,
  );
  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(
    join(root, ".githooks", "_directive-run.sh"),
    `#!/bin/sh\nRUNTIME_BIN="$REPO_ROOT/node_modules/@deftai/directive-runtime/dist/bin.js"\nrun_directive() { node "$RUNTIME_BIN" "$@"; }\n`,
  );
  writeFileSync(
    join(root, ".githooks", "pre-commit"),
    `#!/bin/sh\n. "$REPO_ROOT/.githooks/_directive-run.sh"\n`,
  );
  writeFileSync(
    join(root, ".githooks", "pre-push"),
    `#!/bin/sh\n. "$REPO_ROOT/.githooks/_directive-run.sh"\n`,
  );
  mkdirSync(join(root, ".cursor"), { recursive: true });
  writeFileSync(
    join(root, ".cursor", "hooks.json"),
    `${JSON.stringify(
      {
        version: 1,
        hooks: {
          sessionStart: [
            {
              command:
                "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor --event session.start",
            },
          ],
          userHook: [{ command: "echo keep-user-hook" }],
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "Taskfile.yml"),
    `version: '3'\n\nincludes:\n  deft:\n    taskfile: ./node_modules/@deftai/directive-runtime/Taskfile.yml\n    optional: true\n  other:\n    taskfile: ./other.yml\n`,
  );
  mkdirSync(join(root, ".agents", "skills", "deft"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "skills", "deft", "SKILL.md"),
    `---\nname: deft\n---\nRead: node_modules/@deftai/directive-runtime/SKILL.md\n`,
  );
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "directive", "wiring-ready.0.0.0-yolo.cp-wave2g.1.json"),
    `${JSON.stringify({ runtimeVersion: "0.0.0-yolo.cp-wave2g.1" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, ".deft", "settings.json"),
    `${JSON.stringify({ keep: "settings" }, null, 2)}\n`,
  );
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "xbrief", "USER-NOTE.txt"), "preserve me\n");
  writeGeneration(root, [
    {
      path: "AGENTS.md",
      kind: "marked-section",
      fingerprint: "abc",
      markerId: "deft:managed-section",
    },
    {
      path: ".cursor/hooks.json",
      kind: "structured-entry",
      fingerprint: "def",
      entryKey: "hooks",
    },
    {
      path: "Taskfile.yml",
      kind: "structured-entry",
      fingerprint: "ghi",
      entryKey: "includes.deft",
    },
    {
      path: ".githooks/_directive-run.sh",
      kind: "whole-file",
      fingerprint: "jkl",
    },
    {
      path: ".githooks/pre-commit",
      kind: "whole-file",
      fingerprint: "mno",
    },
    {
      path: ".githooks/pre-push",
      kind: "whole-file",
      fingerprint: "pqr",
    },
    { path: "xbrief", kind: "retained", fingerprint: "stu" },
    { path: ".deft/settings.json", kind: "retained", fingerprint: "vwx" },
  ]);
  execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
}

function baseState(
  root: string,
  overrides: Partial<ProjectInstallState> = {},
): ProjectInstallState {
  return {
    pin: { kind: "exact", version: "0.0.0-yolo.cp-wave2g.1", raw: "0.0.0-yolo.cp-wave2g.1" },
    installed: {
      version: "0.0.0-yolo.cp-wave2g.1",
      contract: 1,
      packageJsonPath: join(root, "node_modules", "@deftai", "directive-runtime", "package.json"),
      entryPath: join(root, "node_modules", "@deftai", "directive-runtime", "dist", "bin.js"),
    },
    pinMatchesInstalled: true,
    contractSupported: true,
    oldStyle: false,
    ...overrides,
  };
}

describe("uninstall discovery (AC11.2)", () => {
  it("merges ownership record with known artifacts and retains settings/xbrief", () => {
    const root = tempProject();
    seedModernInstall(root);
    const d = discoverUninstallFootprint(root);
    expect(d.hasFootprint).toBe(true);
    expect(d.ownershipInspection).toBe("valid");
    expect(d.artifacts.some((a) => a.path === "xbrief" && a.kind === "retained")).toBe(true);
    expect(d.artifacts.some((a) => a.path === ".deft/settings.json" && a.kind === "retained")).toBe(
      true,
    );
    expect(d.artifacts.some((a) => a.path === "AGENTS.md" && a.kind === "marked-section")).toBe(
      true,
    );
    expect(
      d.artifacts.some((a) => a.path === ".cursor/hooks.json" && a.kind === "structured-entry"),
    ).toBe(true);
  });

  it("known-map works when GENERATION is missing (AC11.1 / AC14.63)", () => {
    const root = tempProject();
    seedModernInstall(root);
    rmSync(join(root, ".deft", "GENERATION.json"), { force: true });
    const d = discoverUninstallFootprint(root);
    expect(d.ownershipInspection).toBe("absent");
    expect(d.hasFootprint).toBe(true);
    expect(d.artifacts.some((a) => a.path === ".githooks/_directive-run.sh")).toBe(true);
  });
});

describe("launcher cleanup ownership kinds (AC11.5 / AC11.7)", () => {
  it("removes whole files, strips marked sections and structured entries, preserves xbrief/settings/user content", () => {
    const root = tempProject();
    seedModernInstall(root);
    const discovery = discoverUninstallFootprint(root);
    const report = applyLauncherCleanup(root, discovery);

    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(false);
    expect(existsSync(join(root, ".githooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(false);
    expect(existsSync(join(root, ".agents", "skills", "deft", "SKILL.md"))).toBe(false);

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("Keep me.");
    expect(agents).not.toContain("deft:managed-section");

    const cursor = JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf8")) as {
      hooks?: { userHook?: unknown; sessionStart?: unknown };
    };
    expect(cursor.hooks?.userHook).toEqual([{ command: "echo keep-user-hook" }]);
    expect(cursor.hooks?.sessionStart).toBeUndefined();

    const task = readFileSync(join(root, "Taskfile.yml"), "utf8");
    expect(task).toContain("other:");
    expect(task).not.toMatch(/^\s*deft:/m);

    expect(readFileSync(join(root, "xbrief", "USER-NOTE.txt"), "utf8")).toContain("preserve me");
    expect(readFileSync(join(root, ".deft", "settings.json"), "utf8")).toContain("settings");
    expect(report.preserved).toEqual(expect.arrayContaining(["xbrief", ".deft/settings.json"]));
  });
});

describe("runUninstall bookend (AC11.3 / AC11.8)", () => {
  it("dry-run plans without mutating", () => {
    const root = tempProject();
    seedModernInstall(root);
    const io = captureIo();
    const code = runUninstall(root, baseState(root), ["--dry-run"], "0.0.0-yolo", io, {
      stdinIsTTY: false,
    });
    expect(code).toBe(0);
    const text = io.out();
    expect(text).toMatch(/Uninstall Directive/i);
    expect(text).toMatch(/If you approve, Directive will:/i);
    expect(text).not.toMatch(/Remove command:/i);
    expect(text).not.toMatch(/^Remove: /m);
    expect(text).toMatch(/\[dry-run\]/);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
    expect(existsSync(join(root, ".githooks", "pre-commit"))).toBe(true);
  });

  it("no footprint exits 0 (AC11.8)", () => {
    const root = tempProject();
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    const io = captureIo();
    const code = runUninstall(
      root,
      {
        pin: { kind: "none", version: null, raw: null },
        installed: null,
        pinMatchesInstalled: false,
        contractSupported: true,
        oldStyle: false,
      },
      ["--yes"],
      "0.0.0-yolo",
      io,
    );
    expect(code).toBe(0);
    expect(io.out()).toMatch(/Nothing to uninstall/i);
  });

  it("--yes with unavailable runtime still cleans via launcher fallback (AC11.1 / AC14.33)", () => {
    const root = tempProject();
    seedModernInstall(root);
    const io = captureIo();
    const deps: UninstallDeps = {
      stdinIsTTY: false,
      runPmRemove: () => {
        // Simulate PM remove by editing package.json.
        writeFileSync(
          join(root, "package.json"),
          `${JSON.stringify({ private: true }, null, 2)}\n`,
        );
        return { ok: true };
      },
    };
    const code = runUninstall(
      root,
      baseState(root, {
        installed: null,
        pinMatchesInstalled: false,
        contractSupported: true,
      }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      deps,
    );
    expect(code).toBe(0);
    expect(io.out()).toMatch(/launcher fallback/i);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(false);
    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(false);
    expect(existsSync(join(root, "xbrief", "USER-NOTE.txt"))).toBe(true);
    expect(verifyUninstallComplete(root).complete).toBe(true);
  });

  it("prefers repository uninstaller then still runs launcher fallback", () => {
    const root = tempProject();
    seedModernInstall(root);
    const io = captureIo();
    let invoked = false;
    const deps: UninstallDeps = {
      stdinIsTTY: false,
      invokeUninstall: () => {
        invoked = true;
        // Partial: remove GENERATION only; launcher must finish.
        rmSync(join(root, ".deft", "GENERATION.json"), { force: true });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            contract: 1,
            entry: "uninstall",
            removed: [".deft/GENERATION.json"],
            remaining: [],
            message: "ok",
          }),
          stderr: "",
          spawned: true,
          message: null,
        };
      },
      runPmRemove: () => {
        writeFileSync(
          join(root, "package.json"),
          `${JSON.stringify({ private: true }, null, 2)}\n`,
        );
        return { ok: true };
      },
    };
    const code = runUninstall(root, baseState(root), ["--yes"], "0.0.0-yolo", io, deps);
    expect(invoked).toBe(true);
    expect(code).toBe(0);
    expect(existsSync(join(root, ".githooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("Keep me.");
  });

  it("repository uninstaller failure still succeeds when fallback completes (AC11.11)", () => {
    const root = tempProject();
    seedModernInstall(root);
    const io = captureIo();
    const deps: UninstallDeps = {
      stdinIsTTY: false,
      invokeUninstall: () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          contract: 1,
          entry: "uninstall",
          removed: [],
          remaining: [".githooks/pre-commit"],
          message: "partial",
        }),
        stderr: "",
        spawned: true,
        message: null,
      }),
      runPmRemove: () => {
        writeFileSync(
          join(root, "package.json"),
          `${JSON.stringify({ private: true }, null, 2)}\n`,
        );
        return { ok: true };
      },
    };
    const code = runUninstall(root, baseState(root), ["--yes"], "0.0.0-yolo", io, deps);
    expect(code).toBe(0);
    expect(io.out()).toMatch(/fallback verified complete|complete/i);
  });
});
