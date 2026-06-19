#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  loadWorktreeMapFile,
  resolveWorktreeMap,
  WorktreeMapConfigError,
  WorktreeMapError,
} from "./worktrees.js";

export function parseWorktreesArgv(argv: readonly string[]): {
  mapPath: string;
  baseBranch: string;
  repoRoot: string;
  createMissing: boolean;
} {
  let mapPath = "";
  let baseBranch = "";
  let repoRoot = ".";
  let createMissing = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--map" && argv[i + 1] !== undefined) {
      mapPath = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--base-branch" && argv[i + 1] !== undefined) {
      baseBranch = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--repo-root" && argv[i + 1] !== undefined) {
      repoRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg === "--no-create-missing") {
      createMissing = false;
    }
  }
  return { mapPath, baseBranch, repoRoot, createMissing };
}

export function worktreesMain(argv: string[] = process.argv.slice(2)): number {
  const { mapPath, baseBranch, repoRoot, createMissing } = parseWorktreesArgv(argv);
  if (mapPath.length === 0 || baseBranch.length === 0) {
    process.stderr.write("config error: --map and --base-branch are required\n");
    return 2;
  }
  try {
    const mapping = loadWorktreeMapFile(mapPath);
    const resolved = resolveWorktreeMap(mapping, baseBranch, createMissing, { repoRoot });
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof WorktreeMapError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof WorktreeMapConfigError) {
      process.stderr.write(`config error: ${String(err)}\n`);
      return 2;
    }
    process.stderr.write(`config error: ${String(err)}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(worktreesMain());
}
