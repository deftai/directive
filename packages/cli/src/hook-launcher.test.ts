/**
 * Launcher `deft-hook` and `deft` behaviour in old-style and runtime-pinned
 * projects (#5960 / RC-02 / RC-07 / RC-12), run through the real entries:
 * `bin/deft-hook` (on Windows, npm's generated `deft-hook.cmd` runs this same
 * file with node) and the bundled `dist/bin.js` for `deft`.
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
import { PRE_OVPR_LAYOUT_MESSAGE } from "./constants.js";
import {
  DISABLE_FLAG_NAME,
  DISABLE_ONE_LINE,
  ENTRY_GUARD_PERSON_RUNS_INSTALL,
  KILL_RECORD_GIT_DIR_PREFIX,
  KILL_RECORD_REL,
  KILL_RECORD_SCHEMA_LINE,
} from "./entry-guard.js";

/** `runtime-missing` row with no lockfile in the fixture (#6620). */
const RUNTIME_MISSING_NO_LOCKFILE =
  "Directive can't run: @deftai/directive-runtime is not installed in this project. Run `npm install` (or `pnpm install --frozen-lockfile`) in a terminal in this project.";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..");
const WRAPPER_FIXTURE = join(HERE, "fixtures", "pre-ovpr", "deft-pretooluse-wrapper.v0.126.2.sh");
const IS_WIN = process.platform === "win32";

let pkgDir = "";
let globalBin = "";
const roots: string[] = [];

/** A script that records how it was run, then exits with $COPY_EXIT. */
function recorderSource(tag: string): string {
  return [
    'const fs = require("node:fs");',
    "let stdin = '';",
    "try { stdin = fs.readFileSync(0, 'utf8'); } catch {}",
    "fs.writeFileSync(process.env.MARKER_PATH + " +
      JSON.stringify(`.${tag}`) +
      ", JSON.stringify({",
    "  argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: process.env.HANDOFF_ENV || null,",
    "}));",
    `process.stdout.write(${JSON.stringify(`${tag} ran`)});`,
    "process.exit(Number(process.env.COPY_EXIT || 0));",
  ].join("\n");
}

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
  // A "global" old Directive on PATH that must never run.
  globalBin = mkdtempSync(join(tmpdir(), "deft-global-old-"));
  for (const name of ["deft", "deft-hook", "directive"]) {
    const script = join(globalBin, `${name}.js`);
    writeFileSync(script, recorderSource("global"));
    writeFileSync(join(globalBin, name), `#!/bin/sh\nexec node "${script}" "$@"\n`);
    chmodSync(join(globalBin, name), 0o755);
    writeFileSync(join(globalBin, `${name}.cmd`), `@node "${script}" %*\r\n`);
  }
}, 60_000);

afterAll(() => {
  if (pkgDir !== "") rmSync(pkgDir, { recursive: true, force: true });
  if (globalBin !== "") rmSync(globalBin, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  /** `hook` runs `bin/deft-hook`; `deft` runs the bundled launcher entry. */
  readonly entry?: "hook" | "deft";
}

function run(cwd: string, args: string[], options: RunOptions = {}): Run {
  const file =
    options.entry === "deft" ? join(pkgDir, "dist", "bin.js") : join(pkgDir, "bin", "deft-hook");
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd,
    env: {
      ...process.env,
      DEFT_LAUNCHER_MODE: "",
      MARKER_PATH: join(cwd, "marker"),
      PATH: `${globalBin}${delimiter}${process.env.PATH ?? ""}`,
      ...options.env,
    },
    encoding: "utf8",
    input: options.input ?? "",
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

/** Records written under `<dir>/marker.<tag>`, or null. */
function marker(dir: string, tag: string): Record<string, unknown> | null {
  const path = join(dir, `marker.${tag}`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : null;
}

const RUNTIME_DIR = "node_modules/@deftai/directive-runtime";
const COPY_DIR = "node_modules/@deftai/directive";

function runtimeFiles(version = "0.129.14"): Record<string, string> {
  return {
    [`${RUNTIME_DIR}/package.json`]: JSON.stringify({
      name: "@deftai/directive-runtime",
      version,
      directive: { contract: 1 },
    }),
    [`${RUNTIME_DIR}/dist/hook-bin.js`]: recorderSource("runtime"),
  };
}

/** The project's own pre-split copy (its own bin map; depends on core). */
function oldCopyFiles(version = "0.126.2"): Record<string, string> {
  return {
    [`${COPY_DIR}/package.json`]: JSON.stringify({
      name: "@deftai/directive",
      version,
      bin: { deft: "dist/bin.js", directive: "dist/bin.js", "deft-hook": "dist/hook-bin.js" },
      dependencies: { "@deftai/directive-core": `^${version}` },
    }),
    [`${COPY_DIR}/dist/bin.js`]: recorderSource("copy-bin"),
    [`${COPY_DIR}/dist/hook-bin.js`]: recorderSource("copy-hook"),
  };
}

/** Old-style project: exact pre-split pin + .deft/core; optional own copy. */
function oldRepo(withCopy: boolean, extra: Record<string, string> = {}): string {
  return fixture({
    "package.json": JSON.stringify({ dependencies: { "@deftai/directive": "0.126.2" } }),
    ".deft/core/VERSION": "0.126.2\n",
    ...runtimeFiles(),
    ...(withCopy ? oldCopyFiles() : {}),
    ...extra,
  });
}

function newRepo(installed: boolean, installedVersion = "0.129.14"): string {
  return fixture({
    "package.json": JSON.stringify({
      devDependencies: { "@deftai/directive-runtime": "0.129.14" },
    }),
    ...(installed ? runtimeFiles(installedVersion) : {}),
  });
}

function toolBefore(host: string): string[] {
  return ["--host", host, "--event", "tool.before"];
}

function nothingElseRan(dir: string): void {
  expect(marker(dir, "global")).toBeNull();
  expect(marker(dir, "runtime")).toBeNull();
}

describe("old-style project with its own pre-split copy installed (RC-12)", () => {
  it("deft-hook hands the call to the copy's deft-hook bin: same args, stdin, env, cwd, exit", () => {
    const root = oldRepo(true);
    const sub = join(root, "src");
    mkdirSync(sub);
    const result = run(sub, toolBefore("claude"), {
      env: { COPY_EXIT: "2", HANDOFF_ENV: "kept", MARKER_PATH: join(root, "marker") },
      input: '{"tool_name":"Bash"}',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("copy-hook ran");
    expect(marker(root, "copy-hook")).toEqual({
      argv: toolBefore("claude"),
      cwd: sub,
      stdin: '{"tool_name":"Bash"}',
      env: "kept",
    });
    nothingElseRan(root);
  });

  it("deft <command> hands every ordinary command to the copy's deft bin", () => {
    const root = oldRepo(true);
    const result = run(root, ["verify:branch", "--json"], {
      entry: "deft",
      env: { COPY_EXIT: "3" },
    });
    expect(result.status).toBe(3);
    expect(marker(root, "copy-bin")?.argv).toEqual(["verify:branch", "--json"]);
    nothingElseRan(root);
  });

  it("deft hook:dispatch hands the call to the copy as `deft hook:dispatch …`", () => {
    const root = oldRepo(true);
    const result = run(root, ["hook:dispatch", ...toolBefore("codex")], { entry: "deft" });
    expect(result.status).toBe(0);
    expect(marker(root, "copy-bin")?.argv).toEqual(["hook:dispatch", ...toolBefore("codex")]);
    nothingElseRan(root);
  });

  it("upgrade, --version and --help stay with the launcher", () => {
    const root = oldRepo(true);
    expect(run(root, ["upgrade", "--help"], { entry: "deft" }).status).toBe(0);
    expect(run(root, ["--version"], { entry: "deft" }).stdout).toMatch(/^launcher /);
    expect(run(root, ["--help"], { entry: "deft" }).status).toBe(0);
    expect(marker(root, "copy-bin")).toBeNull();
    nothingElseRan(root);
  });

  it("a copy at another version than the exact pin is never run", () => {
    const root = oldRepo(false, oldCopyFiles("0.125.0"));
    const result = run(root, toolBefore("claude"));
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    expect(marker(root, "copy-hook")).toBeNull();
    nothingElseRan(root);
  });
});

describe("old-style project with no copy installed (AC 1, 2)", () => {
  it.each(["claude", "codex"])("%s: exit 2, message on stderr, nothing run", (host) => {
    const root = oldRepo(false);
    const result = run(root, toolBefore(host));
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    expect(result.stdout).toBe("");
    nothingElseRan(root);
  });

  it("cursor: one deny JSON on stdout, exit 0", () => {
    const root = oldRepo(false);
    const result = run(root, toolBefore("cursor"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      permission: "deny",
      user_message: PRE_OVPR_LAYOUT_MESSAGE,
      agent_message: PRE_OVPR_LAYOUT_MESSAGE,
    });
    nothingElseRan(root);
  });

  it("grok: one deny JSON on stdout, exit 0", () => {
    const root = oldRepo(false);
    const result = run(root, toolBefore("grok"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: "deny",
      reason: PRE_OVPR_LAYOUT_MESSAGE,
    });
    nothingElseRan(root);
  });

  it("non-tool event: exit 1, message on stderr", () => {
    const root = oldRepo(false);
    const result = run(root, ["--host", "claude", "--event", "session.start"]);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    nothingElseRan(root);
  });

  it("deft <command>: exit 1 with the message; the global old CLI never runs", () => {
    const root = oldRepo(false);
    const result = run(root, ["verify:branch"], { entry: "deft" });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    nothingElseRan(root);
  });

  it("deft hook:dispatch blocks in the host's form", () => {
    const root = oldRepo(false);
    const result = run(root, ["hook:dispatch", ...toolBefore("claude")], { entry: "deft" });
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(PRE_OVPR_LAYOUT_MESSAGE);
    nothingElseRan(root);
  });
});

describe("runtime-pinned project (AC10.11)", () => {
  it.each([
    ["claude", 2],
    ["grok", 0],
  ] as const)("runtime missing (%s): blocks with project install text (AC 3)", (host, code) => {
    const result = run(newRepo(false), toolBefore(host));
    expect(result.status).toBe(code);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain(RUNTIME_MISSING_NO_LOCKFILE);
    expect(out).toContain(ENTRY_GUARD_PERSON_RUNS_INSTALL);
    expect(out).not.toContain("npm i -g @deftai/directive");
    expect(out).not.toContain("install --repair");
    expect(out).not.toContain("or yarn");
  });

  it.each([
    ["pnpm-lock.yaml", "`pnpm install --frozen-lockfile`"],
    ["package-lock.json", "`npm install`"],
  ])("runtime missing with %s: names %s (#6620)", (lockfile, command) => {
    const root = newRepo(false);
    writeFileSync(join(root, lockfile), "");
    const result = run(root, toolBefore("claude"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Run ${command} in a terminal in this project.`);
  });

  it("runtime at another version than the pin: blocks with the pin-mismatch row", () => {
    const root = newRepo(true, "0.129.13");
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const result = run(root, toolBefore("claude"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Directive can't run: the installed @deftai/directive-runtime 0.129.13 is not the pinned 0.129.14. Run `pnpm install --frozen-lockfile` in a terminal in this project.",
    );
    expect(marker(root, "runtime")).toBeNull();
  });

  it("no runtime pin and no old layout: blocks with the no-project row", () => {
    const root = fixture({ "package.json": JSON.stringify({ dependencies: {} }) });
    const result = run(root, toolBefore("claude"));
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(
      "deft-hook: No Directive project here. Run `directive install`.",
    );
  });

  it("a range runtime pin: blocks with the fix-the-pin row (D-042)", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        devDependencies: { "@deftai/directive-runtime": "^0.129.0" },
      }),
    });
    const result = run(root, toolBefore("claude"));
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(
      'deft-hook: package.json must name one exact Directive version, like `"@deftai/directive-runtime": "0.129.0"`. It currently says `^0.129.0`. Change it to an exact version, then run `npm install` (or `pnpm install`).',
    );
  });

  describe("valid kill record comes first (AC9.12 step 1, #6620 / #6740)", () => {
    function disable(root: string): void {
      expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
      const gitDir = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
      }).stdout.replace(/\n+$/, "");
      const record = join(root, KILL_RECORD_REL);
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, `${KILL_RECORD_SCHEMA_LINE}\n${KILL_RECORD_GIT_DIR_PREFIX}${gitDir}\n`);
    }

    it("deft-hook: pin mismatch + flag → exit 0, no output, runtime never started", () => {
      const root = newRepo(true, "0.129.13");
      disable(root);
      const result = run(root, toolBefore("claude"));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      nothingElseRan(root);
    });

    it("deft-hook: old layout + flag → exit 0, the old copy never runs", () => {
      const root = oldRepo(true);
      disable(root);
      const result = run(root, toolBefore("grok"));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(marker(root, "copy-hook")).toBeNull();
      nothingElseRan(root);
    });

    it("deft-hook: runtime missing + flag → exit 0", () => {
      const root = newRepo(false);
      disable(root);
      expect(run(root, toolBefore("claude")).status).toBe(0);
    });

    it("deft <command>: pin mismatch + flag → exit 0 with the disabled notice", () => {
      const root = newRepo(true, "0.129.13");
      disable(root);
      const result = run(root, ["verify:branch"], { entry: "deft" });
      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe(DISABLE_ONE_LINE);
      nothingElseRan(root);
    });

    it.each([
      [["kill-switch:off", "--confirm"]],
      [["kill-switch", "off", "--confirm"]],
    ])("deft %j passes the stop so the record can be removed", (argv) => {
      const root = newRepo(true);
      writeFileSync(join(root, RUNTIME_DIR, "dist", "bin.js"), recorderSource("runtime-bin"));
      disable(root);
      const result = run(root, argv, { entry: "deft" });
      expect(result.stderr).not.toContain(DISABLE_ONE_LINE);
      expect(marker(root, "runtime-bin")?.argv).toEqual(argv);
    });

    it("a bare root flag does not stop anything (#6740)", () => {
      const root = newRepo(false);
      expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
      writeFileSync(join(root, DISABLE_FLAG_NAME), "1\n");
      expect(run(root, toolBefore("claude")).status).toBe(2);
    });
  });

  it("runtime present, child exits 0: output passes through unchanged (AC 4)", () => {
    const root = newRepo(true);
    const result = run(root, toolBefore("claude"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("runtime ran");
    expect(marker(root, "runtime")?.argv).toEqual(toolBefore("claude"));
    expect(marker(root, "global")).toBeNull();
  });

  it.each(["claude", "codex"])("child exits 1 on %s tool.before: exit 2", (host) => {
    expect(run(newRepo(true), toolBefore(host), { env: { COPY_EXIT: "1" } }).status).toBe(2);
  });

  it("child exits 1 on cursor: status passes through", () => {
    expect(run(newRepo(true), toolBefore("cursor"), { env: { COPY_EXIT: "1" } }).status).toBe(1);
  });

  it("child exits 1 on a non-tool event: status passes through", () => {
    const args = ["--host", "claude", "--event", "session.start"];
    expect(run(newRepo(true), args, { env: { COPY_EXIT: "1" } }).status).toBe(1);
  });
});

describe("old v0.126.2 Grok wrapper with the new deft-hook on PATH", () => {
  it.skipIf(IS_WIN)("passes the old-project deny through to Grok", () => {
    const root = oldRepo(false);
    const wrapper = join(root, ".grok", "hooks", "deft-pretooluse-wrapper.sh");
    mkdirSync(dirname(wrapper), { recursive: true });
    copyFileSync(WRAPPER_FIXTURE, wrapper);
    const result = spawnSync("sh", [wrapper], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DEFT_LAUNCHER_MODE: "",
        PATH: `${join(pkgDir, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: "deny",
      reason: PRE_OVPR_LAYOUT_MESSAGE,
    });
    nothingElseRan(root);
  });
});
