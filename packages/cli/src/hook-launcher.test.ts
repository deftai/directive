/**
 * Launcher `deft-hook` behaviour (#5960 / RC-01 / RC-02 / RC-07), run through
 * the PATH entry `bin/deft-hook` (on Windows, npm's generated `deft-hook.cmd`
 * runs this same file with node).
 * The bundle goes to a private temp package so it never races other tests
 * that rebuild `dist/bin.js`.
 */
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
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE, PRE_OVPR_LAYOUT_MESSAGE } from "./constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..");
const WRAPPER_FIXTURE = join(HERE, "fixtures", "pre-ovpr", "deft-pretooluse-wrapper.v0.126.2.sh");
const IS_WIN = process.platform === "win32";

let pkgDir = "";
const roots: string[] = [];

beforeAll(async () => {
  pkgDir = mkdtempSync(join(tmpdir(), "deft-hook-pkg-"));
  mkdirSync(join(pkgDir, "bin"));
  copyFileSync(join(CLI_ROOT, "bin", "deft-hook"), join(pkgDir, "bin", "deft-hook"));
  chmodSync(join(pkgDir, "bin", "deft-hook"), 0o755);
  copyFileSync(join(CLI_ROOT, "package.json"), join(pkgDir, "package.json"));
  await esbuild.build({
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
    entryPoints: [join(CLI_ROOT, "src", "bin.ts")],
    outfile: join(pkgDir, "dist", "bin.js"),
  });
}, 60_000);

afterAll(() => {
  if (pkgDir !== "") rmSync(pkgDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the PATH entry the way npm's shim does: `node bin/deft-hook <args>`. */
function runHook(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(process.execPath, [join(pkgDir, "bin", "deft-hook"), ...args], {
    cwd,
    env: { ...process.env, DEFT_LAUNCHER_MODE: "", ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-hook-repo-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const RUNTIME_DIR = "node_modules/@deftai/directive-runtime";
const MARKER = "hook-bin-ran.txt";

/** Installed runtime whose hook-bin records that it ran, prints allow, exits $HOOK_TEST_EXIT. */
function runtimeFiles(): Record<string, string> {
  return {
    [`${RUNTIME_DIR}/package.json`]: JSON.stringify({
      name: "@deftai/directive-runtime",
      version: "0.129.14",
      directive: { contract: 1 },
    }),
    [`${RUNTIME_DIR}/dist/hook-bin.js`]: [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(MARKER)}, process.argv.slice(2).join(" "));`,
      'process.stdout.write(JSON.stringify({ decision: "allow" }));',
      "process.exit(Number(process.env.HOOK_TEST_EXIT || 0));",
    ].join("\n"),
  };
}

/** Old (pre-OVPR) repo that also happens to have a runtime folder: must not run it. */
function oldRepo(): string {
  return fixture({
    "package.json": JSON.stringify({ dependencies: { "@deftai/directive": "0.126.2" } }),
    ".deft/core/VERSION": "0.126.2\n",
    ...runtimeFiles(),
  });
}

function newRepo(installed: boolean): string {
  return fixture({
    "package.json": JSON.stringify({
      devDependencies: { "@deftai/directive-runtime": "0.129.14" },
    }),
    ...(installed ? runtimeFiles() : {}),
  });
}

function toolBefore(host: string): string[] {
  return ["--host", host, "--event", "tool.before"];
}

describe("deft-hook in a pre-OVPR repo (AC 1, 2)", () => {
  it.each([
    "claude",
    "codex",
  ])("%s: exit 2, old-repo message on stderr, nothing spawned", (host) => {
    const root = oldRepo();
    const run = runHook(root, toolBefore(host));
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    expect(run.stdout).toBe("");
    expect(existsSync(join(root, MARKER))).toBe(false);
  });

  it("cursor: one deny JSON on stdout, exit 0, nothing spawned", () => {
    const root = oldRepo();
    const run = runHook(root, toolBefore("cursor"));
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      permission: "deny",
      user_message: PRE_OVPR_LAYOUT_MESSAGE,
      agent_message: PRE_OVPR_LAYOUT_MESSAGE,
    });
    expect(existsSync(join(root, MARKER))).toBe(false);
  });

  it("grok: one deny JSON on stdout, exit 0, nothing spawned", () => {
    const root = oldRepo();
    const run = runHook(root, toolBefore("grok"));
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "deny", reason: PRE_OVPR_LAYOUT_MESSAGE });
    expect(existsSync(join(root, MARKER))).toBe(false);
  });

  it("non-tool event: exit 1, message on stderr (no compaction/prompt block)", () => {
    const root = oldRepo();
    const run = runHook(root, ["--host", "claude", "--event", "session.start"]);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    expect(existsSync(join(root, MARKER))).toBe(false);
  });
});

describe("deft-hook in a new-layout repo", () => {
  it.each([
    ["claude", 2],
    ["grok", 0],
  ] as const)("runtime missing (%s): blocks with project install text (AC 3)", (host, code) => {
    const run = runHook(newRepo(false), toolBefore(host));
    expect(run.status).toBe(code);
    const out = `${run.stdout}${run.stderr}`;
    expect(out).toContain(HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
    expect(out).not.toContain("npm i -g @deftai/directive");
    expect(out).not.toContain("install --repair");
  });

  it("runtime present, child exits 0: output passes through unchanged (AC 4)", () => {
    const root = newRepo(true);
    const run = runHook(root, toolBefore("claude"));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(JSON.stringify({ decision: "allow" }));
    expect(readFileSync(join(root, MARKER), "utf8")).toBe("--host claude --event tool.before");
  });

  it.each([
    "claude",
    "codex",
  ])("runtime present, child exits 1 on %s tool.before: exit 2", (host) => {
    const run = runHook(newRepo(true), toolBefore(host), { HOOK_TEST_EXIT: "1" });
    expect(run.status).toBe(2);
  });

  it("runtime present, child exits 1 on cursor: status passes through", () => {
    const run = runHook(newRepo(true), toolBefore("cursor"), { HOOK_TEST_EXIT: "1" });
    expect(run.status).toBe(1);
  });

  it("runtime present, child exits 1 on a non-tool event: status passes through", () => {
    const run = runHook(newRepo(true), ["--host", "claude", "--event", "session.start"], {
      HOOK_TEST_EXIT: "1",
    });
    expect(run.status).toBe(1);
  });
});

describe("old v0.126.2 Grok wrapper with the new deft-hook on PATH", () => {
  it.skipIf(IS_WIN)("passes the old-repo deny through to Grok", () => {
    const root = oldRepo();
    const wrapper = join(root, ".grok", "hooks", "deft-pretooluse-wrapper.sh");
    mkdirSync(dirname(wrapper), { recursive: true });
    copyFileSync(WRAPPER_FIXTURE, wrapper);
    const run = spawnSync("sh", [wrapper], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DEFT_LAUNCHER_MODE: "",
        PATH: `${join(pkgDir, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "deny", reason: PRE_OVPR_LAYOUT_MESSAGE });
    expect(existsSync(join(root, MARKER))).toBe(false);
  });
});
