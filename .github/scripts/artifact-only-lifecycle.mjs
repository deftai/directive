#!/usr/bin/env node
/**
 * Artifact-only lifecycle predicate (#3678).
 *
 * Allowlist is exactly {xbrief/completed/**, CHANGELOG.md}. Widening it is a
 * gate change, not maintenance. Evaluated on the complete merge-base diff
 * (caller supplies the path list); any other path takes the full CI stack.
 *
 * Empty input fails closed to the full stack.
 *
 * CLI: node artifact-only-lifecycle.mjs [--stdin | path...]
 * stdout: artifact_only=true|false
 */

import { readFileSync } from "node:fs";

/** @param {string} path */
export function normalizeRepoPath(path) {
  return String(path ?? "")
    .trim()
    .replaceAll("\\", "/");
}

/** @param {string} path */
export function isAllowlistedLifecyclePath(path) {
  const n = normalizeRepoPath(path);
  if (!n) return false;
  if (n === "CHANGELOG.md") return true;
  return n.startsWith("xbrief/completed/");
}

/**
 * @param {string[]} paths
 * @returns {boolean}
 */
export function isArtifactOnlyLifecycle(paths) {
  const cleaned = (Array.isArray(paths) ? paths : []).map(normalizeRepoPath).filter(Boolean);
  if (cleaned.length === 0) return false;
  return cleaned.every(isAllowlistedLifecyclePath);
}

/**
 * @param {string[]} argv
 * @param {{ stdin?: string }} [io]
 * @returns {{ artifact_only: boolean, paths: string[] }}
 */
export function evaluateArgv(argv, io = {}) {
  let paths;
  if (argv[0] === "--stdin") {
    const raw = io.stdin ?? readFileSync(0, { encoding: "utf8" });
    paths = raw.split(/\r?\n/);
  } else {
    paths = argv;
  }
  const artifact_only = isArtifactOnlyLifecycle(paths);
  return { artifact_only, paths: paths.map(normalizeRepoPath).filter(Boolean) };
}

function main(argv) {
  const { artifact_only } = evaluateArgv(argv);
  console.log(`artifact_only=${artifact_only ? "true" : "false"}`);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  process.argv[1].replaceAll("\\", "/").endsWith("artifact-only-lifecycle.mjs");

if (invokedDirectly) {
  main(process.argv.slice(2));
}
