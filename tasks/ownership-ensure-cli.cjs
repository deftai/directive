#!/usr/bin/env node
/**
 * Ensure a CLI with ownership recovery verbs exists (#1617).
 *
 * Prefer order:
 * 1. vendored packages/cli/dist/bin.js
 * 2. global `deft` that runs ownership:doctor --help (engine prefers deft)
 * 3. global `directive` only when `deft` is absent from PATH
 * 4. non-root: local engine:_ts-build
 * 5. root: build in a detached temp git worktree (outside the project tree),
 *    write the temp bin path for ownership.yml — never create root-owned
 *    project dist
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(process.argv[2] || process.cwd());
const bin = path.join(root, "packages", "cli", "dist", "bin.js");
const markerDir = path.join(root, ".deft-scratch");
const markerPath = path.join(markerDir, "ownership-bin-path");
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    shell: isWin,
    windowsHide: true,
    ...opts,
  });
}

function hasVersion(cmd) {
  return run(cmd, ["--version"]).status === 0;
}

function hasOwnershipDoctor(cmd) {
  return run(cmd, ["ownership:doctor", "--help"]).status === 0;
}

function clearMarker() {
  try {
    fs.unlinkSync(markerPath);
  } catch {
    /* absent */
  }
}

function writeMarker(absBin) {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(markerPath, `${absBin}\n`, "utf8");
}

clearMarker();

if (fs.existsSync(bin)) {
  process.exit(0);
}

// Align with engine:invoke: deft is preferred when present.
if (hasVersion("deft")) {
  if (hasOwnershipDoctor("deft")) process.exit(0);
  // Stale deft on PATH — do not claim success via directive (engine would
  // still pick deft). Fall through to build / temp-worktree recovery.
} else if (hasOwnershipDoctor("directive")) {
  process.exit(0);
}

let uid = null;
try {
  if (typeof process.getuid === "function") {
    uid = process.getuid();
  }
} catch {
  uid = null;
}

if (uid !== 0) {
  const build = run("task", [":engine:_ts-build"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  process.exit(build.status === 0 ? 0 : (build.status ?? 1));
}

// Root: build outside the project tree so recovery verbs exist without
// creating root-owned project dist (#1617 Greptile oscillation).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deft-own-wt-"));
process.stderr.write(
  `deft ownership: root session — building ownership CLI in temp worktree ${tmp} (#1617).\n`,
);
const add = run("git", ["worktree", "add", "--detach", tmp, "HEAD"], {
  cwd: root,
  stdio: "inherit",
});
if (add.status !== 0) {
  process.stderr.write(
    "deft ownership: temp worktree add failed. Install a CLI with ownership verbs as non-root, or upgrade global deft.\n",
  );
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(2);
}

let ok = false;
try {
  const build = run("task", [":engine:_ts-build"], {
    cwd: tmp,
    stdio: "inherit",
    shell: true,
  });
  const tmpBin = path.join(tmp, "packages", "cli", "dist", "bin.js");
  if (build.status === 0 && fs.existsSync(tmpBin)) {
    writeMarker(tmpBin);
    ok = true;
  } else {
    process.stderr.write(
      "deft ownership: temp worktree build failed; ownership recovery cannot start (#1617).\n",
    );
  }
} finally {
  // Keep temp tree when marker points into it; remove only on failure.
  if (!ok) {
    run("git", ["worktree", "remove", "--force", tmp], {
      cwd: root,
      stdio: "inherit",
    });
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.exit(ok ? 0 : 2);
