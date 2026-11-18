/**
 * Wave 2g RED/GREEN — uninstall ownership map + bookend (R11 / AC11.*).
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSoleAuthorPackageJson as runtimeIsSoleAuthorPackageJson } from "../../runtime/src/removal-steps/steps.js";
import { type BookendIo, runUninstall, type UninstallDeps } from "./bookends.js";
import type { ProjectInstallState } from "./pin.js";
import {
  applyLauncherCleanup,
  discoverUninstallFootprint,
  isSoleAuthorPackageJson,
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

function walkFiles(root: string, rel = ""): string[] {
  const abs = rel ? join(root, rel) : root;
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (!rel && (name === ".git" || name === "node_modules")) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, childRel)).isDirectory()) out.push(...walkFiles(root, childRel));
    else out.push(childRel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// #5999 / #6007: manifest order, honest result, shared-file lines, report
// ---------------------------------------------------------------------------

const RUNTIME = "@deftai/directive-runtime";
const MANAGED_GITATTRIBUTES =
  "# Deft managed wiring: pin Directive-deposited host/command/hook/skill paths\n" +
  "# to LF so Windows core.autocrlf checkouts stay ownership-comparable (#5995).\n" +
  ".githooks/** text=auto eol=lf\n" +
  "AGENTS.md text=auto eol=lf\n";

function writeNpmLock(root: string): void {
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "t",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { devDependencies: { [RUNTIME]: "0.0.0-yolo.cp-wave2g.1" } } },
      },
      null,
      2,
    )}\n`,
  );
}

/** A package-manager remove that, like npm/pnpm, needs package.json to exist. */
function fakePmRemove(root: string, calls: string[]): UninstallDeps["runPmRemove"] {
  return ({ packageName }) => {
    const pkgPath = join(root, "package.json");
    if (!existsSync(pkgPath)) {
      calls.push("no-manifest");
      return {
        ok: false,
        message: `pnpm remove -D ${packageName} failed (exit 1)`,
        stderr: "ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND",
      };
    }
    calls.push(readFileSync(pkgPath, "utf8"));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const dev = (pkg.devDependencies ?? {}) as Record<string, unknown>;
    delete dev[packageName];
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    return { ok: true };
  };
}

function snapshotTree(root: string, rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of walkFiles(join(root, rel))) {
    out[file] = readFileSync(join(root, rel, file), "utf8");
  }
  return out;
}

describe("uninstall keeps package.json until the package manager is done (#5999)", () => {
  it("npm greenfield cycle: no package.json or lockfile left, Directive lines gone, xbrief identical, exit 0", () => {
    const root = tempProject();
    seedModernInstall(root);
    writeNpmLock(root);
    writeFileSync(join(root, ".gitattributes"), `*.png binary\n\n${MANAGED_GITATTRIBUTES}`);
    writeFileSync(
      join(root, "greptile.json"),
      `{\n  "ignorePatterns": "build/**\\n.deft/core/**"\n}\n`,
    );
    const xbriefBefore = snapshotTree(root, "xbrief");
    const calls: string[] = [];
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, calls),
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(RUNTIME);
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe("*.png binary\n");
    expect(readFileSync(join(root, "greptile.json"), "utf8")).toBe(
      `{\n  "ignorePatterns": "build/**"\n}\n`,
    );
    expect(snapshotTree(root, "xbrief")).toEqual(xbriefBefore);
    const text = io.out();
    expect(text).toMatch(/✓ Uninstalled/);
    expect(text).toMatch(/the Directive version from development tools/);
    expect(text).toMatch(/Directive lines in \.gitattributes, greptile\.json/);
  });

  it("pnpm remove failure: exit non-zero, package.json kept, failure named, no removal claim", () => {
    const root = tempProject();
    seedModernInstall(root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const pkgBefore = readFileSync(join(root, "package.json"), "utf8");
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: ({ packageName }) => ({
          ok: false,
          message: `pnpm remove -D ${packageName} failed (exit 1)`,
          stderr: "ERR_PNPM_SOMETHING",
        }),
      },
    );
    expect(code).not.toBe(0);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(pkgBefore);
    expect(existsSync(join(root, "pnpm-lock.yaml"))).toBe(true);
    const text = io.out();
    expect(text).toMatch(/partially finished/);
    expect(text).toContain(`package.json#${RUNTIME} (pnpm remove -D ${RUNTIME} failed (exit 1))`);
    expect(text).not.toMatch(/the Directive version from development tools/);
  });

  it("older runtime that deletes package.json: launcher restores it before the package-manager remove", () => {
    const root = tempProject();
    seedModernInstall(root);
    writeNpmLock(root);
    const pkgBefore = readFileSync(join(root, "package.json"), "utf8");
    const calls: string[] = [];
    const io = captureIo();
    const code = runUninstall(root, baseState(root), ["--yes"], "0.0.0-yolo", io, {
      stdinIsTTY: false,
      invokeUninstall: () => {
        // Old order: the repository uninstaller removes the sole-author manifest first.
        rmSync(join(root, "package.json"));
        rmSync(join(root, "package-lock.json"));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ contract: 1, entry: "uninstall", removed: ["package.json"] }),
          stderr: "",
          spawned: true,
          message: null,
        };
      },
      runPmRemove: fakePmRemove(root, calls),
    });
    expect(calls).toEqual([pkgBefore]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
  });

  it("user-authored package.json keeps every non-Directive field (AC11.7)", () => {
    const root = tempProject();
    seedModernInstall(root);
    const userPkg = {
      name: "shop",
      version: "1.0.0",
      private: true,
      scripts: { test: "vitest" },
      devDependencies: { [RUNTIME]: "0.0.0-yolo.cp-wave2g.1", leftpad: "1.0.0" },
    };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(userPkg, null, 2)}\n`);
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, []),
      },
    );
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(after).toEqual({ ...userPkg, devDependencies: { leftpad: "1.0.0" } });
  });

  it("runtime package still installed after a successful remove: partial, exit non-zero, no node_modules path", () => {
    const root = tempProject();
    seedModernInstall(root);
    mkdirSync(join(root, "node_modules", "@deftai", "directive-runtime"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "@deftai", "directive-runtime", "package.json"),
      "{}\n",
    );
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, []),
      },
    );
    expect(code).not.toBe(0);
    expect(io.out()).toMatch(/partially finished/);
    expect(io.out()).toContain(`Directive package still installed (${RUNTIME})`);
    expect(io.out()).not.toContain("node_modules/@deftai");
  });

  it("launcher cleanup leftover makes the result partial (AC11.11)", () => {
    const root = tempProject();
    seedModernInstall(root);
    writeFileSync(join(root, ".deft", "directive", "unknown.txt"), "?\n");
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, []),
      },
    );
    expect(code).not.toBe(0);
    expect(io.out()).toMatch(/partially finished/);
    expect(io.out()).toContain(".deft/directive/unknown.txt");
  });

  it("a retry still removes Directive lines left by an earlier partial uninstall", () => {
    const root = tempProject();
    writeFileSync(join(root, ".gitattributes"), `*.png binary\n\n${MANAGED_GITATTRIBUTES}`);
    // The user's own hooks: no Directive evidence, so core.hooksPath must stay.
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nnpm test\n");
    execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
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
      { stdinIsTTY: false },
    );
    expect(code).toBe(0);
    expect(io.out()).not.toMatch(/Nothing to uninstall/);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe("*.png binary\n");
    expect(
      execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(".githooks");
    expect(existsSync(join(root, ".githooks", "pre-commit"))).toBe(true);
  });

  it("a retry with only the pin left still unsets Directive's core.hooksPath", () => {
    const root = tempProject();
    // An earlier run removed the hook files and record, then the package manager was interrupted.
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ private: true, devDependencies: { [RUNTIME]: "1.0.0" } }, null, 2)}\n`,
    );
    execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, []),
      },
    );
    expect(code).toBe(0);
    expect(io.out()).toContain("Unset core.hooksPath");
    expect(() =>
      execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { stdio: "pipe" }),
    ).toThrow();
  });

  it("launcher sole-author rule matches the runtime's", () => {
    const samples: Array<Record<string, unknown>> = [
      { private: true },
      { private: true, devDependencies: { [RUNTIME]: "1.0.0" } },
      { private: true, devDependencies: {}, scripts: {} },
      { private: true, dependencies: { "@deftai/directive": "1.0.0", [RUNTIME]: "1.0.0" } },
      { private: true, devDependencies: { leftpad: "1.0.0" } },
      { private: true, scripts: { test: "x" } },
      { private: false },
      { name: "app", private: true },
      { private: true, devDependencies: [] },
      {},
    ];
    for (const pkg of samples) {
      expect(isSoleAuthorPackageJson(pkg), JSON.stringify(pkg)).toBe(
        runtimeIsSoleAuthorPackageJson(pkg),
      );
    }
  });
});

describe("uninstall says what it kept (#6007 / D-025)", () => {
  it("lists kept Directive data and exits 0 for it", () => {
    const root = tempProject();
    seedModernInstall(root);
    writeFileSync(join(root, ".deft", "occupancy.json"), "{}\n");
    writeFileSync(join(root, ".deft", "forward-coverage.allow"), "x\n");
    mkdirSync(join(root, ".deft", "session-binds"), { recursive: true });
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    writeFileSync(join(root, ".deft-cache", "c.json"), "{}\n");
    writeFileSync(join(root, ".deft-run-summary.json"), "{}\n");
    writeFileSync(join(root, ".gitignore"), "dist/\n.deft/directive/wiring-ready.*.json\n");
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, []),
      },
    );
    expect(code).toBe(0);
    const text = io.out();
    const kept = text.split("\n").filter((l) => l.startsWith("Kept (Directive data"));
    // Once in the plan, once in the report.
    expect(kept).toHaveLength(2);
    for (const line of kept) {
      for (const item of [
        ".deft/forward-coverage.allow",
        ".deft/occupancy.json",
        ".deft/session-binds/",
        ".deft-cache/",
        ".deft-run-summary.json",
        ".gitignore (Directive lines)",
      ]) {
        expect(line).toContain(item);
      }
    }
    expect(existsSync(join(root, ".deft", "occupancy.json"))).toBe(true);
    expect(existsSync(join(root, ".deft-cache", "c.json"))).toBe(true);
    expect(existsSync(join(root, ".deft-run-summary.json"))).toBe(true);
  });

  it("keeps core.hooksPath for a sibling worktree, says so, and names the worktree", () => {
    const root = tempProject();
    execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "init"]);
    execFileSync("git", [
      "-C",
      root,
      "worktree",
      "add",
      "-q",
      "-b",
      "wt1",
      join(root, ".deft-scratch", "worktrees", "wt1"),
    ]);
    const wt = join(root, ".deft-scratch", "worktrees", "wt1");
    mkdirSync(join(wt, ".githooks"), { recursive: true });
    writeFileSync(join(wt, ".githooks", "_directive-run.sh"), "#!/bin/sh\n");
    seedModernInstall(root);
    const io = captureIo();
    const code = runUninstall(
      root,
      baseState(root, { installed: null }),
      ["--yes"],
      "0.0.0-yolo",
      io,
      {
        stdinIsTTY: false,
        runPmRemove: fakePmRemove(root, []),
      },
    );
    expect(code).toBe(0);
    expect(
      execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(".githooks");
    const text = io.out();
    expect(text).toMatch(
      /Kept core\.hooksPath=\.githooks: 1 other worktree still uses Directive hooks \(.*wt1\)\./,
    );
    expect(text).toContain("git config --unset core.hooksPath");
    // Plan names the worktree; report gives the count and folder.
    expect(text).toMatch(/^ {2}\.deft-scratch\/worktrees\/wt1$/m);
    expect(text).toMatch(/Don't delete \.deft-scratch\//);
    expect(text).toContain(
      "Not touched: 1 registered Git worktree in .deft-scratch/worktrees/ (1).",
    );
    expect(existsSync(join(wt, ".githooks", "_directive-run.sh"))).toBe(true);
  });
});
