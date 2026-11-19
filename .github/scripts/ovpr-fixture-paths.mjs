#!/usr/bin/env node
/**
 * OVPR fixture path filter (#6749).
 *
 * On pull requests, the `changes` job in ci.yml runs this script (loaded from
 * the merge-base tree) over the merge-base diff. The ubuntu OVPR fixture job
 * skips only when it prints `ovpr_paths=false`.
 *
 * The list names the launcher, runtime, hook, deposit and install paths, the
 * direct packaging inputs of the runtime bundle (content, types, core
 * package.json), the fixture itself, ci.yml, this script and the root
 * toolchain files. Other core changes get fixture feedback on merge_group.
 *
 * Fail open: empty input prints `ovpr_paths=true`.
 *
 * CLI: node ovpr-fixture-paths.mjs [--stdin | path...]
 * stdout: ovpr_paths=true|false
 */

import { readFileSync } from "node:fs";

/** Folder prefixes: a path under one of these matches. */
export const OVPR_PATH_PREFIXES = Object.freeze([
  "packages/cli/",
  "packages/runtime/",
  "packages/content/",
  "packages/types/",
  "packages/core/src/hooks/",
  "packages/core/src/deposit/",
  "packages/core/src/init-deposit/",
  "packages/core/src/install-contract/",
  "packages/core/src/install-health/",
  "packages/core/src/release-e2e/",
]);

/** Exact files that match. */
export const OVPR_PATH_FILES = Object.freeze([
  "packages/core/package.json",
  ".github/workflows/ci.yml",
  ".github/scripts/ovpr-fixture-paths.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".nvmrc",
]);

/** @param {string} path */
export function normalizeRepoPath(path) {
  return String(path ?? "")
    .trim()
    .replaceAll("\\", "/");
}

/** @param {string} path */
export function isOvprFixturePath(path) {
  const n = normalizeRepoPath(path);
  if (!n) return false;
  if (OVPR_PATH_FILES.includes(n)) return true;
  return OVPR_PATH_PREFIXES.some((prefix) => n.startsWith(prefix));
}

/**
 * True when the fixture should run for this change set. Empty input is true.
 * @param {string[]} paths
 * @returns {boolean}
 */
export function ovprFixtureNeeded(paths) {
  const cleaned = (Array.isArray(paths) ? paths : []).map(normalizeRepoPath).filter(Boolean);
  if (cleaned.length === 0) return true;
  return cleaned.some(isOvprFixturePath);
}

/**
 * @param {string[]} argv
 * @param {{ stdin?: string }} [io]
 * @returns {{ ovpr_paths: boolean }}
 */
export function evaluateArgv(argv, io = {}) {
  let paths;
  if (argv[0] === "--stdin") {
    const raw = io.stdin ?? readFileSync(0, { encoding: "utf8" });
    paths = raw.split(/\r?\n/);
  } else {
    paths = argv;
  }
  return { ovpr_paths: ovprFixtureNeeded(paths) };
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  process.argv[1].replaceAll("\\", "/").endsWith("ovpr-fixture-paths.mjs");

if (invokedDirectly) {
  const { ovpr_paths } = evaluateArgv(process.argv.slice(2));
  console.log(`ovpr_paths=${ovpr_paths ? "true" : "false"}`);
}
