#!/usr/bin/env node
"use strict";

/**
 * Run package.json scripts via pnpm / Corepack without shell-interpolating
 * repository-controlled packageManager pins (#2765 / #2761).
 *
 * Consumed by tasks/engine.yml `:engine:pm-run` and `:engine:_ts-build`.
 * Lives under tasks/ so @deftai/directive-content prepack ships it beside
 * tasks/engine.yml (#2022 Phase 3).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const WIN32_ALLOWLIST = new Set(["pnpm", "corepack", "npm"]);
const SHELL_METACHAR_RE = /[;&|`$<>()\\'"!#\n\r\t]/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const SCRIPT_NAME_RE = /^[A-Za-z0-9:_-]+$/;

/** @param {string | null | undefined} version */
function isValidSemVer(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, semver: string | null, pin: string | null } | { ok: false, reason: string }}
 */
function parsePnpmPin(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, semver: null, pin: null };
  }
  const str = String(raw);
  if (str !== str.trim()) {
    return { ok: false, reason: "packageManager has leading/trailing whitespace" };
  }
  if (/\s/.test(str)) {
    return { ok: false, reason: "packageManager contains whitespace" };
  }
  if (SHELL_METACHAR_RE.test(str)) {
    return { ok: false, reason: "packageManager contains shell metacharacters" };
  }
  if (!str.startsWith("pnpm@")) {
    return { ok: false, reason: "packageManager must be pnpm@<semver> when set" };
  }
  const semver = str.slice("pnpm@".length);
  if (!semver || !isValidSemVer(semver)) {
    return { ok: false, reason: "packageManager semver is invalid" };
  }
  if (str !== `pnpm@${semver}`) {
    return { ok: false, reason: "packageManager pin malformed" };
  }
  return { ok: true, semver, pin: str };
}

/**
 * @param {unknown} name
 * @param {Record<string, unknown> | undefined} scripts
 */
function validateScriptName(name, scripts) {
  if (typeof name !== "string" || !name || !SCRIPT_NAME_RE.test(name)) {
    return false;
  }
  return !!scripts && Object.prototype.hasOwnProperty.call(scripts, name);
}

/** @param {string} arg */
function quoteWin32Arg(arg) {
  const s = String(arg);
  if (!/[\s"]/.test(s)) {
    return s;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {typeof execFileSync} execFn
 * @param {string} name
 */
function hasCmd(execFn, name) {
  const spawnOpts = (/** @type {Record<string, unknown>} */ extra) => ({
    stdio: "ignore",
    windowsHide: true,
    ...extra,
  });
  try {
    execFn(name, ["--version"], spawnOpts({}));
    return true;
  } catch {
    try {
      execFn(name, ["--version"], spawnOpts({ shell: true }));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @param {typeof execFileSync} execFn
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, spawn?: Record<string, unknown> }} opts
 */
function executeAllowlisted(execFn, cmd, args, opts) {
  if (!WIN32_ALLOWLIST.has(cmd)) {
    throw new Error(`deft: allowlisted shim required, got ${JSON.stringify(cmd)}`);
  }
  const spawnOverride = opts.spawn && typeof opts.spawn === "object" ? opts.spawn : {};
  const base = {
    cwd: opts.cwd,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
    ...spawnOverride,
    shell: false,
  };
  if (process.platform === "win32") {
    const commandLine = [quoteWin32Arg(cmd), ...args.map(quoteWin32Arg)].join(" ");
    execFn("cmd.exe", ["/d", "/s", "/c", commandLine], base);
    return;
  }
  execFn(cmd, args, base);
}

/**
 * @param {{ hasPnpm: boolean, hasCorepack: boolean, semver: string | null, script: string }} input
 */
function buildDispatchSteps(input) {
  const steps = [];
  if (input.hasPnpm) {
    steps.push({ cmd: "pnpm", args: ["run", input.script] });
  }
  if (input.hasCorepack && input.semver) {
    steps.push({ cmd: "corepack", args: [`pnpm@${input.semver}`, "run", input.script] });
  }
  if (input.hasCorepack) {
    steps.push({ cmd: "corepack", args: ["pnpm", "run", input.script] });
  }
  return steps;
}

/** @param {string} root */
function markWarm(root) {
  try {
    const dist = path.join(root, "packages", "cli", "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, ".deft-ts-build-stamp"), new Date().toISOString());
  } catch {
    // best-effort warm marker
  }
}

/**
 * @param {string} root
 * @param {string} script
 * @param {{ execFileSync?: typeof execFileSync, markWarm?: boolean }} [deps]
 */
function runPackageScript(root, script, deps = {}) {
  const execFn = deps.execFileSync || execFileSync;
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error(`deft: package.json missing at ${root}`);
    return 2;
  }
  let pkg;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`deft: package.json at ${root} is not a JSON object`);
      return 2;
    }
    pkg = parsed;
  } catch {
    console.error(`deft: package.json at ${root} is not valid JSON`);
    return 2;
  }
  if (!validateScriptName(script, pkg.scripts)) {
    console.error(`deft: package.json has no script ${JSON.stringify(script)}`);
    return 2;
  }

  const pinResult = parsePnpmPin(pkg.packageManager);
  if (!pinResult.ok) {
    console.error(`deft: invalid packageManager pin — ${pinResult.reason}`);
    return 3;
  }

  const envPm = String(process.env.DEFT_PACKAGE_MANAGER || "")
    .trim()
    .toLowerCase();
  if (envPm === "npm") {
    try {
      executeAllowlisted(execFn, "npm", ["run", script], { cwd: root });
      if (deps.markWarm) {
        markWarm(root);
      }
      return 0;
    } catch {
      console.error(`deft: npm run ${JSON.stringify(script)} failed`);
      return 1;
    }
  }

  const hasPnpm = hasCmd(execFn, "pnpm");
  const hasCorepack = hasCmd(execFn, "corepack");
  const steps = buildDispatchSteps({
    hasPnpm,
    hasCorepack,
    semver: pinResult.semver,
    script,
  });

  for (const step of steps) {
    try {
      executeAllowlisted(execFn, step.cmd, step.args, { cwd: root });
      if (deps.markWarm) {
        markWarm(root);
      }
      return 0;
    } catch {
      // fall through to Corepack / next resolver
    }
  }

  console.error(`deft: neither pnpm nor corepack is available to run ${JSON.stringify(script)}.`);
  if (pinResult.pin) {
    console.error(
      `  Enable Corepack for the pinned manager: corepack enable && corepack prepare ${pinResult.pin} --activate`,
    );
  } else {
    console.error("  Install pnpm or enable Corepack (see package.json#packageManager).");
  }
  console.error("  Or set DEFT_PACKAGE_MANAGER=npm for an explicit npm build path.");
  return 127;
}

function main() {
  const root = process.argv[2];
  const script = process.argv[3];
  const markWarmFlag = process.argv.includes("--mark-warm");
  if (!root || !script) {
    console.error("deft: engine-pm-run usage: engine-pm-run.cjs <DEFT_ROOT> <script> [--mark-warm]");
    process.exit(2);
  }
  const code = runPackageScript(root, script, { markWarm: markWarmFlag });
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  SHELL_METACHAR_RE,
  WIN32_ALLOWLIST,
  buildDispatchSteps,
  executeAllowlisted,
  hasCmd,
  isValidSemVer,
  markWarm,
  parsePnpmPin,
  quoteWin32Arg,
  runPackageScript,
  validateScriptName,
};
