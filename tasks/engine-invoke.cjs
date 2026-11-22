#!/usr/bin/env node
"use strict";

/**
 * Spawn the deft CLI from DEFT_ENGINE_CMD without shell-interpolating operator
 * text (#2547). go-task forwards user args into ENGINE_CMD; apostrophes in
 * --summary and similar free-text flags must not break mvdan/sh parsing.
 *
 * Lives under tasks/ (not repo-root scripts/) so @deftai/directive-content
 * prepack ships it beside tasks/engine.yml (#2022 Phase 3).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Consumer-deposit identity (#3324). Present on @deftai/directive-content. */
const CONSUMER_DEPOSIT_FIELD = "deftConsumerDeposit";
/** Optional marker file at DEFT_ROOT (installer / test fixture). */
const CONSUMER_DEPOSIT_MARKER_FILE = ".deft-consumer-deposit";
/** Published content-package name also identifies a deposit. */
const CONTENT_PACKAGE_NAME = "@deftai/directive-content";
/** Single remediation when a deposit has no global CLI (#3324 / #3265). */
const DEPOSIT_REMEDIATION = "npm i -g @deftai/directive";
const SOURCE_BUILD_REMEDIATION = "task build";
/**
 * Missing runtime (#5994 / AC9.12 / #6620): the `runtime-missing` row of the
 * shared message table (core `install-health/constants.ts`), with `{install}`
 * chosen from the lockfile. Never `npm i -g` (that is DEPOSIT_REMEDIATION only).
 */
const RUNTIME_MISSING_ROW =
  "Directive can't run: @deftai/directive-runtime is not installed in this project. Run {install} in a terminal in this project.";
const ANY_PROJECT_INSTALL = "`npm install` (or `pnpm install --frozen-lockfile`)";

/** The project install named by the shared table, from the lockfile at root. */
function projectInstallCommand(root) {
  if (root && fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
    return "`pnpm install --frozen-lockfile`";
  }
  if (root && fs.existsSync(path.join(root, "package-lock.json"))) return "`npm install`";
  return ANY_PROJECT_INSTALL;
}

/** The `runtime-missing` row for the project at root. */
function runtimeMissingMessage(root) {
  return RUNTIME_MISSING_ROW.replace("{install}", () => projectInstallCommand(root));
}

/** The `launcher-missing` row (shared table): no runtime package and no launcher. */
const LAUNCHER_MISSING_ROW = "Install the Directive launcher: `npm i -g @deftai/directive`.";

/**
 * Consumer branch with no usable bin and no global launcher. When the include
 * points into the project's runtime package, the runtime is what is missing
 * (project install); otherwise (an older content-only deposit) it is the
 * launcher.
 */
function consumerMissingMessage(projectRoot, deftRoot) {
  const normalized = String(deftRoot || "").replace(/\\/g, "/");
  return normalized.includes("node_modules/@deftai/directive-runtime")
    ? runtimeMissingMessage(projectRoot)
    : LAUNCHER_MISSING_ROW;
}

/** Root-independent form (no lockfile read). */
const PIN_INSTALL_REMEDIATION = RUNTIME_MISSING_ROW.replace("{install}", () => ANY_PROJECT_INSTALL);
/** Tip dogfood secondary when project install is not enough (#5805). */
const PIN_MATERIALIZE_REMEDIATION = "task materialize:runtime";
const PIN_BIN_REL = path.join("node_modules", "@deftai", "directive-runtime", "dist", "bin.js");
const DISABLE_FLAG = ".deft-directive-disable";
/**
 * Kill record (#6740): the shared whole-line contract (core
 * `policy/kill-switch-record.ts`). A bare DISABLE_FLAG turns nothing off.
 */
const KILL_RECORD_REL = path.join(".deft", "authz", "kill-switch.disable");
const KILL_RECORD_SCHEMA_LINE = "schema=deft.kill-switch.v1";
const KILL_RECORD_GIT_DIR_PREFIX = "gitDir=";
const KILL_SWITCH_BARE_FLAG_WARNING =
  "Directive warning: root `.deft-directive-disable` is present, but a bare flag file turns nothing off (#6740). " +
  "Enforcement stays on. To turn Directive off for this checkout, a person runs `deft kill-switch:on --confirm` at a terminal.";

/**
 * cmd.exe command separators / metacharacters. Free-text DEFT_ENGINE_CMD_JSON
 * tokens (release --summary text, CLI_ARGS, #2547) may legitimately contain
 * these; double-quoting renders them literal to cmd.exe's parser so a token can
 * never break out of its argv slot (subprocess-scm-01 / #2911).
 */
const WIN32_CMD_METACHAR_RE = /[\s"&|<>^()%!]/;

/**
 * Quote a single argument for `cmd.exe /d /s /c` so that shell metacharacters
 * stay inside one argv token. Mirrors tasks/engine-pm-run.cjs quoteWin32Arg but
 * also quotes cmd.exe separators (& | < > ^ ( ) % !) because engine-invoke
 * forwards operator free-text, not an allowlisted command.
 * @param {string} arg
 */
function quoteWin32Arg(arg) {
  const s = String(arg);
  if (s.length > 0 && !WIN32_CMD_METACHAR_RE.test(s)) {
    return s;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

/** Minimal POSIX-ish shell word splitter (double/single quotes, escapes). */
function shellSplit(input) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (c === "\\" && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur) {
    out.push(cur);
  }
  return out;
}

/**
 * True when DEFT_ROOT is a consumer deposit, not a framework source checkout.
 * Honors an explicit package.json field, the content-package name, or a
 * marker file. #3324: deposits must never take the self-build path.
 * @param {string} root
 * @param {{ fs?: typeof fs, path?: typeof path }} [opts]
 */
/**
 * Consumer Taskfile includes live at `.deft/core/tasks/`, so DEFT_ROOT is
 * `.deft/core`. Framework source uses repo-root `tasks/`. Go source-tarball
 * deposits keep the unmarked monorepo package.json at that core root (#3324
 * Greptile P1) — the path itself is the deposit identity.
 * @param {string} root
 */
function isVendoredCoreRoot(root, opts = {}) {
  const io = opts.fs || fs;
  const pathMod = opts.path || path;
  const norm = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!/(^|\/)\.deft\/core$/.test(norm)) {
    return false;
  }
  // Installer tarballs exclude .git (#1425). A genuine source checkout mounted
  // at this path still has .git and must keep the self-build path.
  try {
    if (io.existsSync(pathMod.join(root, ".git"))) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function hasConsumerDepositMarker(root, opts = {}) {
  const io = opts.fs || fs;
  const pathMod = opts.path || path;
  if (!root) {
    return false;
  }
  if (isVendoredCoreRoot(root, opts)) {
    return true;
  }
  const markerPath = pathMod.join(root, CONSUMER_DEPOSIT_MARKER_FILE);
  try {
    if (io.existsSync(markerPath)) {
      return true;
    }
  } catch {
    // ignore unreadable marker path
  }
  const pkgPath = pathMod.join(root, "package.json");
  try {
    const pkg = JSON.parse(io.readFileSync(pkgPath, "utf8"));
    if (pkg && pkg[CONSUMER_DEPOSIT_FIELD] === true) {
      return true;
    }
    if (pkg && pkg.name === CONTENT_PACKAGE_NAME) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Buildable-source means "may run pnpm/corepack/`task build`". A deposit
 * marker forces false even when packages/cli + scripts.build are present.
 * @param {string} root
 * @param {{ fs?: typeof fs, path?: typeof path }} [opts]
 */

/**
 * Absolute path of the checkout-local pin binary (AC9.9 / #5805).
 * @param {string} projectRoot
 * @param {{ fs?: typeof fs, path?: typeof path }} [opts]
 */
function resolveFrameworkPinBin(projectRoot, opts = {}) {
  const pathMod = opts.path || path;
  if (!projectRoot) return "";
  return pathMod.join(projectRoot, "node_modules", "@deftai", "directive-runtime", "dist", "bin.js");
}

/**
 * True when the checkout-local pin binary exists.
 * @param {string} projectRoot
 * @param {{ fs?: typeof fs, path?: typeof path }} [opts]
 */
/**
 * Kill record verdict (#6740): "absent", "valid", or an invalid reason. A
 * regular file (not a link) with the exact whole lines KILL_RECORD_SCHEMA_LINE
 * and KILL_RECORD_GIT_DIR_PREFIX + `git rev-parse --absolute-git-dir` (trailing
 * newlines removed). Every CR is removed, then lines split on LF.
 * @param {string} projectRoot
 * @param {{ fs?: typeof fs, path?: typeof path, spawnSync?: typeof spawnSync }} [opts]
 */
function killRecordVerdict(projectRoot, opts = {}) {
  const io = opts.fs || fs;
  const pathMod = opts.path || path;
  const spawn = opts.spawnSync || spawnSync;
  if (!projectRoot) return "absent";
  const recordPath = pathMod.join(projectRoot, KILL_RECORD_REL);
  let lst;
  try {
    lst = io.lstatSync(recordPath);
  } catch {
    return "absent";
  }
  if (lst.isSymbolicLink() || !lst.isFile()) return "not-a-regular-file";
  let text;
  try {
    text = io.readFileSync(recordPath, "utf8");
  } catch {
    return "unreadable";
  }
  const lines = String(text).replace(/\r/g, "").split("\n");
  if (!lines.includes(KILL_RECORD_SCHEMA_LINE)) return "missing-schema-line";
  const r = spawn("git", ["-C", projectRoot, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return "git-dir-unresolved";
  const gitDir = r.stdout.replace(/\n+$/, "");
  if (gitDir.length === 0) return "git-dir-unresolved";
  if (!lines.includes(KILL_RECORD_GIT_DIR_PREFIX + gitDir)) return "git-dir-mismatch";
  return "valid";
}

/**
 * The one warning for a bare flag or an invalid record, or "" (#6740).
 * @param {string} projectRoot
 * @param {string} verdict
 * @param {{ fs?: typeof fs, path?: typeof path }} [opts]
 */
function killSwitchWarning(projectRoot, verdict, opts = {}) {
  const io = opts.fs || fs;
  const pathMod = opts.path || path;
  let flag = false;
  try {
    const lst = io.lstatSync(pathMod.join(projectRoot, DISABLE_FLAG));
    flag = !lst.isSymbolicLink() && lst.isFile();
  } catch {
    flag = false;
  }
  if (verdict !== "absent" && verdict !== "valid") {
    const also = flag ? " The root `.deft-directive-disable` flag also turns nothing off." : "";
    return (
      "Directive warning: `.deft/authz/kill-switch.disable` is not a valid kill record for this checkout (" +
      verdict +
      "). Enforcement stays on." +
      also +
      " A person runs `deft kill-switch:on --confirm` at a terminal to write a new one, or `deft kill-switch:off --confirm` to remove it."
    );
  }
  return verdict === "absent" && flag ? KILL_SWITCH_BARE_FLAG_WARNING : "";
}

/**
 * True when the engine command is a kill record verb (#6740). Those run even
 * while the record is valid, or `task kill-switch:off` could never turn it off.
 * @param {NodeJS.ProcessEnv} [env]
 */
function engineCmdIsKillSwitch(env = process.env) {
  let cmdLine = "";
  try {
    cmdLine = env.DEFT_ENGINE_CMD_JSON
      ? String(JSON.parse(env.DEFT_ENGINE_CMD_JSON))
      : String(env.DEFT_ENGINE_CMD || "");
  } catch {
    return false;
  }
  const first = shellSplit(cmdLine.trim())[0] || "";
  return first === "kill-switch" || first.startsWith("kill-switch:");
}

/**
 * AC9.12 / #5994 / #6740: a valid kill record → quiet skip before pin require.
 * A bare DISABLE_FLAG never selects the skip.
 * @param {string} projectRoot
 * @param {{ fs?: typeof fs, path?: typeof path, spawnSync?: typeof spawnSync }} [opts]
 */
function isDirectiveDisableActive(projectRoot, opts = {}) {
  return killRecordVerdict(projectRoot, opts) === "valid";
}

function hasFrameworkPinBin(projectRoot, opts = {}) {
  const io = opts.fs || fs;
  const pin = resolveFrameworkPinBin(projectRoot, opts);
  if (!pin) return false;
  try {
    return io.existsSync(pin);
  } catch {
    return false;
  }
}

/**
 * Framework-source ordinary invoke: pin exclusive, fail closed when missing (#5805).
 * Deposit / non-buildable keep prior hasBin → vendored / global behavior.
 * @param {{
 *   hasBin: boolean,
 *   isBuildableSource: boolean,
 *   hasPinBin: boolean,
 *   isRuntimeVerb?: boolean,
 *   hasGlobalCli?: boolean,
 * }} input
 */
function resolveFrameworkSourceInvoke(input) {
  if (!input.isBuildableSource) {
    return resolveInvokeDispatch({
      hasBin: input.hasBin,
      isBuildableSource: false,
      isRuntimeVerb: Boolean(input.isRuntimeVerb),
      hasGlobalCli: Boolean(input.hasGlobalCli),
    });
  }
  if (input.hasPinBin) {
    return { action: "vendored", binKind: "pin" };
  }
  return {
    action: "fail-closed",
    remediations: [PIN_INSTALL_REMEDIATION, PIN_MATERIALIZE_REMEDIATION],
    exitCode: 2,
  };
}
function isBuildableSource(root, opts = {}) {
  if (hasConsumerDepositMarker(root, opts)) {
    return false;
  }
  const io = opts.fs || fs;
  const pathMod = opts.path || path;
  if (!root) {
    return false;
  }
  const cliPkg = pathMod.join(root, "packages", "cli", "package.json");
  const rootPkg = pathMod.join(root, "package.json");
  try {
    if (!io.existsSync(cliPkg) || !io.existsSync(rootPkg)) {
      return false;
    }
    const pkg = JSON.parse(io.readFileSync(rootPkg, "utf8"));
    return Boolean(pkg && pkg.scripts && pkg.scripts.build);
  } catch {
    return false;
  }
}

/**
 * Dispatch decision after local dist / buildable / runtime-whitelist probes.
 * Deposit marker is applied via isBuildableSource(false); this keeps the
 * runtime-verb whitelist for true source checkouts only (#3324 / #2409).
 *
 * @param {{
 *   hasBin: boolean,
 *   isBuildableSource: boolean,
 *   isRuntimeVerb: boolean,
 *   hasGlobalCli: boolean,
 * }} input
 * @returns {{
 *   action: "vendored" | "global" | "fail-closed",
 *   remediations?: string[],
 *   exitCode?: number,
 * }}
 */
function resolveInvokeDispatch(input) {
  if (input.hasBin) {
    return { action: "vendored" };
  }
  if (input.isBuildableSource) {
    if (input.isRuntimeVerb && input.hasGlobalCli) {
      return { action: "global" };
    }
    return {
      action: "fail-closed",
      remediations: input.isRuntimeVerb
        ? [DEPOSIT_REMEDIATION, SOURCE_BUILD_REMEDIATION]
        : [SOURCE_BUILD_REMEDIATION],
      exitCode: 2,
    };
  }
  if (input.hasGlobalCli) {
    return { action: "global" };
  }
  return {
    action: "fail-closed",
    remediations: [DEPOSIT_REMEDIATION],
    exitCode: 2,
  };
}

function main() {
  const mode = process.argv[2];
  const target = process.argv[3];
  let cmdLine = "";
  if (process.env.DEFT_ENGINE_CMD_JSON) {
    try {
      cmdLine = JSON.parse(process.env.DEFT_ENGINE_CMD_JSON);
    } catch {
      console.error("deft: DEFT_ENGINE_CMD_JSON is not valid JSON");
      process.exit(2);
    }
  } else {
    cmdLine = String(process.env.DEFT_ENGINE_CMD || "");
  }
  cmdLine = cmdLine.trim();
  const argv = shellSplit(cmdLine);
  if (argv.length === 0) {
    console.error("deft: DEFT_ENGINE_CMD is empty");
    process.exit(2);
  }
  if (!mode || !target) {
    console.error("deft: engine-invoke usage: engine-invoke.cjs <vendored|global> <bin-or-cli>");
    process.exit(2);
  }

  const plan = buildSpawnPlan(mode, target, argv);
  if (!plan) {
    console.error(`deft: engine-invoke unknown mode ${JSON.stringify(mode)}`);
    process.exit(2);
  }

  // Command transport is one-hop: a spawned CLI may invoke Task again with a
  // different ENGINE_CMD, which must not be shadowed by this inherited value.
  const childEnv = { ...process.env };
  delete childEnv.DEFT_ENGINE_CMD_JSON;
  delete childEnv.DEFT_ENGINE_CMD;

  // stdio inherit (not pipe): piped stdout/stderr deadlocks when the child emits
  // more than the OS pipe buffer before exit — observed as greenfield smoke
  // hanging then CI SIGTERM exit 143 with no output (#2554 / #2547).
  // shell:false is a literal at the call site (not plan.shell) so static
  // analyzers see a non-shell spawn; win32 global still uses a quoted cmd.exe
  // wrapper inside buildSpawnPlan, never shell:true (#2911 / #3175).
  // windowsVerbatimArguments is only the win32 global plan: libuv must not
  // re-escape the outer /s quotes (#4772 / #3629). Vendored argv stays a direct Node spawn.
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    env: childEnv,
    shell: false,
    // CREATE_NO_WINDOW: hide console windows from Cursor Task / nested shells (#2563).
    windowsHide: true,
    ...(plan.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
  });
  const code = result.status;
  process.exit(code === null ? 1 : code);
}

/**
 * Resolve the concrete spawn command/args for a mode+target without ever using
 * shell:true. On the win32 global path the target is a `.cmd` shim that Node
 * refuses to spawn with shell:false (CVE-2024-27980 / #2415); shell:true would
 * let cmd.exe re-parse free-text DEFT_ENGINE_CMD_JSON tokens (subprocess-scm-01
 * / #2911). Instead route through `cmd.exe /d /s /c` with every token tightly
 * quoted so metacharacters stay inside a single argv token — aligned with
 * tasks/engine-pm-run.cjs executeAllowlisted().
 *
 * Vendored vs global branches are deliberately disjoint (#3175 / CodeQL alert
 * #74): process.execPath (AbsolutePathSource) is only the vendored non-shell
 * command and must never flow into the win32 cmd.exe `/c` string, where it
 * would be shell-interpreted as part of a constructed command line.
 *
 * @param {string} mode
 * @param {string} target
 * @param {string[]} argv
 * @param {{ platform?: string, nodePath?: string }} [opts]
 * @returns {{ command: string, args: string[], shell: false, windowsVerbatimArguments?: boolean } | null}
 */
function buildSpawnPlan(mode, target, argv, opts = {}) {
  const platform = opts.platform || process.platform;

  if (mode === "vendored") {
    // Non-shell: Node binary + script path + operator argv. process.execPath is
    // only used here as the executable name with shell:false — never joined into
    // a cmd.exe command line (CodeQL js/shell-command-injection-from-environment).
    const nodePath = opts.nodePath || process.execPath;
    return { command: nodePath, args: [target, ...argv], shell: false };
  }

  if (mode === "global") {
    if (platform === "win32") {
      // Only the global shim name/path and operator argv — no process.execPath.
      // Outer quotes are the first and last characters cmd.exe /s strips.
      // windowsVerbatimArguments stops libuv from escaping that line again
      // (#4772 / #3629 spaced --project-root).
      const commandLine = [target, ...argv].map(quoteWin32Arg).join(" ");
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", `"${commandLine}"`],
        shell: false,
        windowsVerbatimArguments: true,
      };
    }
    return { command: target, args: argv, shell: false };
  }

  return null;
}

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === "deposit-marker") {
    process.exit(hasConsumerDepositMarker(process.argv[3] || "") ? 0 : 1);
  }
  if (mode === "is-buildable-source") {
    process.exit(isBuildableSource(process.argv[3] || "") ? 0 : 1);
  }
  if (mode === "runtime-missing-message") {
    // argv: <projectRoot> [<DEFT_ROOT>]; without DEFT_ROOT, the runtime row.
    const deftRoot = process.argv[4];
    console.error(
      deftRoot === undefined
        ? runtimeMissingMessage(process.argv[3] || "")
        : consumerMissingMessage(process.argv[3] || "", deftRoot),
    );
    process.exit(0);
  }
  if (mode === "disable-active") {
    // #6740: the one warning for this task run prints here (pin-bin stays quiet).
    // Kill record verbs always run, so `task kill-switch:off` can turn the record off.
    const root = process.argv[3] || "";
    if (engineCmdIsKillSwitch()) process.exit(1);
    const verdict = killRecordVerdict(root);
    if (verdict === "valid") process.exit(0);
    const warning = root ? killSwitchWarning(root, verdict) : "";
    if (warning) console.error(warning);
    process.exit(1);
  }
  if (mode === "pin-bin") {
    const root = process.argv[3] || "";
    if (!engineCmdIsKillSwitch() && isDirectiveDisableActive(root)) {
      process.exit(0);
    }
    const pin = resolveFrameworkPinBin(root);
    if (hasFrameworkPinBin(root)) {
      process.stdout.write(pin);
      process.exit(0);
    }
    console.error("deft: missing checkout pin " + pin);
    console.error("  " + runtimeMissingMessage(root));
    console.error("  Or tip dogfood: " + PIN_MATERIALIZE_REMEDIATION);
    process.exit(2);
  }
  main();
}

module.exports = {
  shellSplit,
  quoteWin32Arg,
  buildSpawnPlan,
  WIN32_CMD_METACHAR_RE,
  hasConsumerDepositMarker,
  isVendoredCoreRoot,
  isBuildableSource,
  resolveInvokeDispatch,
  resolveFrameworkPinBin,
  hasFrameworkPinBin,
  resolveFrameworkSourceInvoke,
  CONSUMER_DEPOSIT_FIELD,
  CONSUMER_DEPOSIT_MARKER_FILE,
  CONTENT_PACKAGE_NAME,
  DEPOSIT_REMEDIATION,
  SOURCE_BUILD_REMEDIATION,
  PIN_INSTALL_REMEDIATION,
  PIN_MATERIALIZE_REMEDIATION,
  projectInstallCommand,
  runtimeMissingMessage,
  consumerMissingMessage,
  LAUNCHER_MISSING_ROW,
  isDirectiveDisableActive,
  killRecordVerdict,
  killSwitchWarning,
  engineCmdIsKillSwitch,
  DISABLE_FLAG,
  KILL_RECORD_REL,
  KILL_SWITCH_BARE_FLAG_WARNING,
};
