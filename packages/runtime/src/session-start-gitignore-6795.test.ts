/**
 * #6795: on a fresh install, `session:start` writes runtime state
 * (`.deft/occupancy.json`, `.deft/ritual-state.json`, `.deft/applying-host.json`,
 * `.deft-cache/`). The deposited `.gitignore` must cover all of it, so the tree
 * stays clean and story-ready / commit gates are not tripped by Directive's own
 * files.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

// Runs `session:start` for real against the built runtime (dist/bin.js),
// linked into the fixture as its pinned package.
describe("session:start leaves a fresh install clean (#6795)", () => {
  it("git status --porcelain lists no Directive runtime file after session:start", () => {
    const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const root = mkdtempSync(join(tmpdir(), "session-start-6795-"));
    TEMPS.push(root);
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "test");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "checkout", "-q", "-b", "feature/first");
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
    symlinkSync(runtimeDir, join(root, "node_modules", "@deftai", "directive-runtime"), "junction");
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-verify", "-m", "deposit");

    const r = spawnSync(
      process.execPath,
      [
        join(runtimeDir, "dist", "bin.js"),
        "session:start",
        "--session-id=host:test:v1:c2Vzc2lvbi1zdGFydC02Nzk1",
        "--project-root",
        root,
      ],
      {
        cwd: root,
        encoding: "utf8",
        // Drop a launcher-set project root (when this test runs under `deft`).
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith("DIRECTIVE_")),
          ),
          DEFT_NO_NETWORK: "1",
        },
      },
    );
    const output = `${r.stdout}${r.stderr}`;
    // session:start ran and wrote its runtime state…
    expect(existsSync(join(root, ".deft", "occupancy.json")), output).toBe(true);
    // …and none of it shows in git status.
    const status = execFileSync("git", ["status", "--porcelain", "-uall"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status, output).toBe("");
  }, 120_000);
});
