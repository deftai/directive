/**
 * #6806: automatic setup can replace `.githooks/pre-commit` while that hook is
 * running (the old hook's own `run_directive` call triggers self-complete after
 * a pin bump). Bash reads a script as it runs, so an in-place rewrite makes it
 * read the new file at the old byte offset. Setup must write a temp file in the
 * same directory and rename it over the hook, so the running shell keeps the
 * old file and the commit succeeds.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";
import { DIRECTIVE_GIT_HOOK_BODIES, ensureGitHooks } from "./setup-wiring.js";

const TEMPS: string[] = [];

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const BASH_AVAILABLE = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * An older Directive pre-commit run under bash. Its first `run_directive` call
 * triggers self-complete, which replaces this file; the lines after it must
 * still run from the old file.
 */
const OLD_BASH_PRE_COMMIT = `#!/usr/bin/env bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
run_directive verify:branch --project-root "$REPO_ROOT" || exit $?
echo "old pre-commit finished"
`;

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("setup replaces a git hook by temp file and rename (#6806)", () => {
  it("leaves no temp file behind and keeps pre-commit executable", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-replace-unit-"));
    TEMPS.push(root);
    git(root, "init", "-q");
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks", "pre-commit"), OLD_BASH_PRE_COMMIT, "utf8");
    const out = ensureGitHooks(root);
    expect(out.conflicts).toEqual([]);
    expect(out.modified).toContain(".githooks/pre-commit");
    expect(read(root, ".githooks/pre-commit")).toBe(
      DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-commit"],
    );
    const left = execFileSync("git", ["status", "--porcelain", "-uall", "--", ".githooks"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(left).not.toMatch(/directive-(tmp|old)/);
    if (process.platform !== "win32") {
      expect(statSync(join(root, ".githooks", "pre-commit")).mode & 0o111).not.toBe(0);
    }
  });

  // Runs the old hook for real against the built runtime (dist/bin.js), linked
  // into the fixture as its pinned package, as setup-wiring-tracked-hooks does.
  // The bug is bash-specific; without bash on PATH there is nothing to prove.
  it.skipIf(!BASH_AVAILABLE)(
    `a commit whose running bash pre-commit is replaced by self-complete succeeds${
      BASH_AVAILABLE ? "" : " [skipped: bash not found on PATH]"
    }`,
    () => {
      const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..");
      const root = mkdtempSync(join(tmpdir(), "hook-replace-6806-"));
      TEMPS.push(root);
      git(root, "init", "-q");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "test");
      git(root, "config", "commit.gpgsign", "false");
      git(root, "checkout", "-q", "-b", "feature/hooks");
      const installed = runSetup({ operation: "install", from: "none", root });
      expect(installed.conflicts).toEqual([]);
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify(
          {
            name: "t",
            private: true,
            devDependencies: { "@deftai/directive-runtime": installed.runtimeVersion },
          },
          null,
          2,
        )}\n`,
      );
      mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
      symlinkSync(
        runtimeDir,
        join(root, "node_modules", "@deftai", "directive-runtime"),
        "junction",
      );
      writeFileSync(join(root, ".githooks", "pre-commit"), OLD_BASH_PRE_COMMIT, "utf8");
      // Missing readiness with a current GENERATION makes the next eligible
      // `deft` call run automatic setup (AC8.6), as after a pin-only bump.
      rmSync(join(root, ".deft", "directive"), { recursive: true, force: true });
      git(root, "add", "-A");
      git(root, "commit", "-q", "--no-verify", "-m", "init");

      writeFileSync(join(root, "notes.txt"), "hello\n");
      git(root, "add", "notes.txt");
      // A launcher-set project root (when this test itself runs under `deft`)
      // would point the fixture's runtime at the outer checkout.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("DIRECTIVE_")),
      );
      const r = spawnSync("git", ["commit", "-q", "-m", "notes"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      const output = `${r.stdout}${r.stderr}`;
      expect(r.status, output).toBe(0);
      expect(output).toContain("old pre-commit finished");
      expect(output).not.toMatch(/command not found/);
      expect(read(root, ".githooks/pre-commit")).toBe(
        DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-commit"],
      );
      const leftovers = readdirSync(join(root, ".githooks")).filter((n) =>
        /\.directive-(tmp|old)$/.test(n),
      );
      expect(leftovers).toEqual([]);
    },
    120_000,
  );
});
