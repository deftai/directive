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
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    env: childEnv,
    shell: false,
    // CREATE_NO_WINDOW: hide console windows from Cursor Task / nested shells (#2563).
    windowsHide: true,
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
 * @returns {{ command: string, args: string[], shell: false } | null}
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
      const commandLine = [target, ...argv].map(quoteWin32Arg).join(" ");
      return { command: "cmd.exe", args: ["/d", "/s", "/c", commandLine], shell: false };
    }
    return { command: target, args: argv, shell: false };
  }

  return null;
}

if (require.main === module) {
  main();
}

module.exports = { shellSplit, quoteWin32Arg, buildSpawnPlan, WIN32_CMD_METACHAR_RE };
