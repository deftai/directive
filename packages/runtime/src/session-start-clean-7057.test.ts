/**
 * #7057: on a clean committed install, `session:start` changes no tracked file.
 * - The legacy triage-cache migration keeps a tracked `xbrief/.eval/README.md`
 *   (it used to delete it on every run).
 * - A current AGENTS.md managed section is not rewritten: no new `refreshed=`
 *   timestamp or `session=` id.
 * Two consecutive runs both leave `git status --porcelain` empty.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];
const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_README_REL = "xbrief/.eval/README.md";
const EVAL_README_BODY = "# `xbrief/.eval/` -- tracked policy doc (#1144)\n";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

/** Fresh install with the built runtime linked as its pin and a tracked `.eval/README.md`. */
function committedInstallWithEvalReadme(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
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
  mkdirSync(join(root, "xbrief", ".eval"), { recursive: true });
  writeFileSync(join(root, EVAL_README_REL), EVAL_README_BODY);
  mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
  symlinkSync(RUNTIME_DIR, join(root, "node_modules", "@deftai", "directive-runtime"), "junction");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "deposit");
  return root;
}

/** Run the built runtime bin in `root` without a launcher-set project root. */
function runSessionStart(root: string) {
  return spawnSync(
    process.execPath,
    [
      join(RUNTIME_DIR, "dist", "bin.js"),
      "session:start",
      "--session-id=host:test:v1:c2Vzc2lvbi1zdGFydC03MDU3",
      "--project-root",
      root,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith("DIRECTIVE_")),
        ),
        DEFT_NO_NETWORK: "1",
      },
    },
  );
}

describe("session:start leaves a clean install clean across runs (#7057)", () => {
  it("two runs keep the tracked .eval/README.md and a byte-identical AGENTS.md", () => {
    const root = committedInstallWithEvalReadme("session-start-7057-");
    const agentsBefore = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agentsBefore).toContain("deft:managed-section");

    for (const run of [1, 2]) {
      const r = runSessionStart(root);
      const output = `run ${run}\n${r.stdout}${r.stderr}`;
      // session:start really ran (it writes its gitignored runtime state)...
      expect(existsSync(join(root, ".deft", "occupancy.json")), output).toBe(true);
      // ...and left every tracked file unchanged.
      expect(git(root, "status", "--porcelain", "-uall"), output).toBe("");
      expect(readFileSync(join(root, EVAL_README_REL), "utf8"), output).toBe(EVAL_README_BODY);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8"), output).toBe(agentsBefore);
    }
  }, 180_000);
});
