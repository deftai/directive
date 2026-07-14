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

  let execPath;
  let execArgv;
  if (mode === "vendored") {
    execPath = process.execPath;
    execArgv = [target, ...argv];
  } else if (mode === "global") {
    execPath = target;
    execArgv = argv;
  } else {
    console.error(`deft: engine-invoke unknown mode ${JSON.stringify(mode)}`);
    process.exit(2);
  }

  const result = spawnSync(execPath, execArgv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    // Global deft/directive on Windows are .cmd shims; shell:false cannot spawn them (#2415).
    shell: mode === "global" && process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const code = result.status;
  process.exit(code === null ? 1 : code);
}

if (require.main === module) {
  main();
}

module.exports = { shellSplit };
