#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const {
  buildDispatchSteps,
  executeAllowlisted,
  hasCmd,
  parsePnpmPin,
  runPackageScript,
  validateScriptName,
} = require("./engine-pm-run.cjs");

describe("parsePnpmPin", () => {
  it("accepts stable, prerelease, and build-metadata pins", () => {
    for (const pin of ["pnpm@11.8.0", "pnpm@1.0.0-alpha.1", "pnpm@1.0.0+build.1"]) {
      const result = parsePnpmPin(pin);
      assert.equal(result.ok, true);
    }
  });

  it("accepts missing/empty pins for unpinned fallback", () => {
    assert.deepEqual(parsePnpmPin(undefined), { ok: true, semver: null, pin: null });
    assert.deepEqual(parsePnpmPin(""), { ok: true, semver: null, pin: null });
  });

  it("rejects shell metacharacters and malformed pins before spawn", () => {
    for (const pin of [
      "pnpm@9.0.0; echo pwned",
      "pnpm@9.0.0 & echo pwned",
      "pnpm@^1.0.0",
      "npm@1.0.0",
      "pnpm@1.0.0 extra",
      " pnpm@1.0.0",
      "pnpm@1.0.0 ",
      "pnpm@1.0.0\n",
    ]) {
      const result = parsePnpmPin(pin);
      assert.equal(result.ok, false, pin);
    }
  });
});

describe("validateScriptName", () => {
  it("accepts only declared script keys with safe names", () => {
    const scripts = { build: "tsc", "test:unit": "vitest" };
    assert.equal(validateScriptName("build", scripts), true);
    assert.equal(validateScriptName("test:unit", scripts), true);
    assert.equal(validateScriptName("missing", scripts), false);
    assert.equal(validateScriptName("build;rm", scripts), false);
  });
});

describe("buildDispatchSteps", () => {
  it("preserves installed pnpm -> pinned corepack -> unpinned corepack order", () => {
    const steps = buildDispatchSteps({
      hasPnpm: true,
      hasCorepack: true,
      semver: "11.8.0",
      script: "build",
    });
    assert.deepEqual(steps, [
      { cmd: "pnpm", args: ["run", "build"] },
      { cmd: "corepack", args: ["pnpm@11.8.0", "run", "build"] },
      { cmd: "corepack", args: ["pnpm", "run", "build"] },
    ]);
  });
});

describe("runPackageScript security", () => {
  function mkFixture(/** @type {Record<string, unknown>} */ pkgExtra) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-engine-pm-run-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgExtra, null, 2), "utf8");
    return dir;
  }

  it("rejects malicious pins before any execution call", () => {
    const dir = mkFixture({
      packageManager: "pnpm@9.0.0; echo pwned",
      scripts: { build: "node -e \"\"" },
    });
    const sentinel = path.join(dir, "sentinel.txt");
    let execCalls = 0;
    const code = runPackageScript(dir, "build", {
      execFileSync() {
        execCalls += 1;
        fs.writeFileSync(sentinel, "pwned", "utf8");
      },
    });
    assert.equal(code, 3);
    assert.equal(execCalls, 0);
    assert.equal(fs.existsSync(sentinel), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records exact argv on execution without shell:true", () => {
    const dir = mkFixture({
      packageManager: "pnpm@11.8.0",
      scripts: { build: "tsc" },
    });
    /** @type {Array<{ cmd: string, args: string[], shell?: boolean, stdio?: string }>} */
    const calls = [];
    const code = runPackageScript(dir, "build", {
      execFileSync(cmd, args, opts) {
        calls.push({ cmd, args: [...args], shell: opts?.shell, stdio: opts?.stdio });
        if (opts?.stdio === "inherit") {
          return;
        }
      },
    });
    assert.equal(code, 0);
    const execCalls = calls.filter((c) => c.stdio === "inherit");
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].shell, false);
    assert.equal(execCalls[0].stdio, "inherit");
    if (process.platform === "win32") {
      assert.equal(execCalls[0].cmd, "cmd.exe");
      assert.deepEqual(execCalls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(execCalls[0].args[3], /pnpm.*run.*build/);
    } else {
      assert.deepEqual(execCalls[0], {
        cmd: "pnpm",
        args: ["run", "build"],
        shell: false,
        stdio: "inherit",
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("allows probe hasCmd to use shell:true separately from execution", () => {
    /** @type {Array<{ shell?: boolean, stdio?: string }>} */
    const calls = [];
    let probeAttempts = 0;
    const execFn = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {{ shell?: boolean, stdio?: string }} */ opts) => {
      if (opts?.stdio === "ignore") {
        probeAttempts += 1;
        if (probeAttempts === 1 && !opts.shell) {
          throw new Error("probe without shell failed");
        }
      }
      calls.push({ shell: opts?.shell, stdio: opts?.stdio });
    };
    assert.equal(hasCmd(execFn, "pnpm"), true);
    assert.ok(calls.some((c) => c.shell === true && c.stdio === "ignore"));
    const execCalls = calls.filter((c) => c.stdio === "inherit");
    assert.equal(execCalls.length, 0);
  });

  it("rejects invalid package.json before probing PATH", () => {
    const dir = mkFixture({ packageManager: "pnpm@11.8.0", scripts: { build: "tsc" } });
    fs.writeFileSync(path.join(dir, "package.json"), "null", "utf8");
    let execCalls = 0;
    const code = runPackageScript(dir, "build", {
      execFileSync() {
        execCalls += 1;
      },
    });
    assert.equal(code, 2);
    assert.equal(execCalls, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unknown scripts before probing PATH", () => {
    const dir = mkFixture({ packageManager: "pnpm@11.8.0", scripts: { build: "tsc" } });
    let execCalls = 0;
    const code = runPackageScript(dir, "lint", {
      execFileSync() {
        execCalls += 1;
      },
    });
    assert.equal(code, 2);
    assert.equal(execCalls, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses cmd.exe on win32 without shell:true on the Node spawn", () => {
    if (process.platform !== "win32") {
      return;
    }
    /** @type {{ cmd?: string, args?: string[], shell?: boolean } | null} */
    let recorded = null;
    executeAllowlisted(
      (cmd, args, opts) => {
        recorded = { cmd, args: [...args], shell: opts?.shell };
      },
      "pnpm",
      ["run", "build"],
      { cwd: process.cwd() },
    );
    assert.ok(recorded);
    assert.equal(recorded.cmd, "cmd.exe");
    assert.equal(recorded.args[0], "/d");
    assert.equal(recorded.shell, false);
    assert.match(recorded.args[3], /^pnpm run build$|^"pnpm" "run" "build"$/);
  });
});
