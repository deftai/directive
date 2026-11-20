/**
 * #6795: on a fresh install, `session:start` writes runtime state
 * (`.deft/occupancy.json`, `.deft/ritual-state.json`, `.deft/applying-host.json`,
 * `.deft-cache/`). The deposited `.gitignore` must cover all of it, so the tree
 * stays clean and story-ready / commit gates are not tripped by Directive's own
 * files.
 *
 * #6842: the same `.gitignore` must keep `.deft/directive/data-schema.json`
 * committable, so the deposit commit carries it and doctor reports no hidden
 * Directive file.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];
const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

/** Fresh install with the built runtime linked as its pin, deposit committed. */
function freshInstallCommitted(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
  symlinkSync(RUNTIME_DIR, join(root, "node_modules", "@deftai", "directive-runtime"), "junction");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "deposit");
  return root;
}

/** Run the built runtime bin in `root` without a launcher-set project root. */
function runBin(root: string, args: readonly string[]) {
  return spawnSync(process.execPath, [join(RUNTIME_DIR, "dist", "bin.js"), ...args], {
    cwd: root,
    encoding: "utf8",
    // Drop a launcher-set project root (when this test runs under `deft`).
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("DIRECTIVE_")),
      ),
      DEFT_NO_NETWORK: "1",
    },
  });
}

// Runs `session:start` and `doctor` for real against the built runtime
// (dist/bin.js), linked into the fixture as its pinned package.
describe("session:start leaves a fresh install clean (#6795)", () => {
  it("git status --porcelain lists no Directive runtime file after session:start", () => {
    const root = freshInstallCommitted("session-start-6795-");
    const r = runBin(root, [
      "session:start",
      "--session-id=host:test:v1:c2Vzc2lvbi1zdGFydC02Nzk1",
      "--project-root",
      root,
    ]);
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

  it("the deposit commit carries data-schema.json and doctor --full reports no hidden file (#6842)", () => {
    const root = freshInstallCommitted("fresh-install-6842-");
    const committed = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n");
    expect(committed).toContain(DATA_SCHEMA_MARKER_REL);
    // The install wrote a readiness marker; it stays ignored after the `!.deft/directive/` lines.
    const markers = readdirSync(join(root, ".deft", "directive")).filter((n) =>
      n.startsWith("wiring-ready."),
    );
    expect(markers.length).toBeGreaterThan(0);
    expect(committed.filter((p) => p.startsWith(".deft/directive/wiring-ready."))).toEqual([]);

    // `directive doctor --full` forwards --full to this contract entry.
    const r = runBin(root, ["doctor", "--full", "--json", "--root", root]);
    const report = JSON.parse(r.stdout) as { install_sync?: { hidden_files?: unknown } };
    expect(report.install_sync?.hidden_files, r.stderr).toEqual([]);
  }, 120_000);
});
