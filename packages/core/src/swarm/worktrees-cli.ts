#!/usr/bin/env node
import { resolve } from "node:path";
/**
 * Swarm worktrees CLI — map resolve + one-path linked-worktree prep (#6100).
 */
import { fileURLToPath } from "node:url";
import { prepareLinkedWorktree } from "./worktree-pm-install.js";
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

const PREP_USAGE =
  "usage: deft swarm-worktrees prep --path <linked-worktree> [--repo-root <path>] [--session-id <id>]\n" +
  "  Prepare one linked worktree (ownership + live-lease gates, then deposit/PM as needed).\n" +
  "  --help, -h  Show this help without mutating the worktree.\n";

const MAP_USAGE =
  "usage: deft swarm-worktrees --map <file> --base-branch <branch> [--repo-root <path>] [--no-create-missing]\n" +
  "  Or: deft swarm-worktrees prep --path <linked-worktree> [...]\n" +
  "  --help, -h  Show this help.\n";

export function parsePrepArgv(argv: readonly string[]): {
  path: string;
  repoRoot: string;
  sessionId: string;
  help: boolean;
} {
  let path = "";
  let repoRoot = ".";
  let sessionId = "";
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if ((arg === "--path" || arg === "--worktree") && argv[i + 1] !== undefined) {
      path = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--repo-root" && argv[i + 1] !== undefined) {
      repoRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if ((arg === "--session-id" || arg === "--presenter") && argv[i + 1] !== undefined) {
      sessionId = argv[i + 1] ?? "";
      i += 1;
    } else if (!arg.startsWith("-") && path.length === 0) {
      path = arg;
    }
  }
  return { path, repoRoot, sessionId, help };
}

function prepMain(argv: readonly string[]): number {
  const { path, repoRoot, sessionId, help } = parsePrepArgv(argv);
  if (help) {
    process.stdout.write(PREP_USAGE);
    return 0;
  }
  if (path.trim().length === 0) {
    process.stderr.write("config error: swarm-worktrees prep requires --path <linked-worktree>\n");
    return 2;
  }
  const result = prepareLinkedWorktree(resolve(path), {
    repoRoot: resolve(repoRoot),
    ...(sessionId.trim().length > 0 ? { presenterSessionId: sessionId.trim() } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`error: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        worktreePath: result.worktreePath,
        pinRel: result.pinRel,
        skippedInstall: result.skippedInstall,
        pm: result.pm,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

export function worktreesMain(argv: string[] = process.argv.slice(2)): number {
  if (argv.some((a) => a === "--help" || a === "-h") && (argv[0] ?? "").trim() !== "prep") {
    process.stdout.write(MAP_USAGE);
    return 0;
  }
  if ((argv[0] ?? "").trim() === "prep") {
    return prepMain(argv.slice(1));
  }
  const { mapPath, baseBranch, repoRoot, createMissing } = parseWorktreesArgv(argv);
  if (mapPath.length === 0 || baseBranch.length === 0) {
    process.stderr.write(
      "config error: --map and --base-branch are required (or use: prep --path <worktree>)\n",
    );
    return 2;
  }
  try {
    const mapping = loadWorktreeMapFile(mapPath);
    const resolved = resolveWorktreeMap(mapping, baseBranch, createMissing, { repoRoot });
    if (!resolved.ok) {
      process.stderr.write(`config error: ${resolved.message}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify(resolved.records, null, 2)}\n`);
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
