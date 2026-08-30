/**
 * Durable attribution log for tree-wide destructive git at the write fence (#3917).
 *
 * Lives outside the repository so a `reset --hard` or a worktree prune cannot
 * erase it. This is detection, not a root-cause claim.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platformUserConfigDir } from "../user-config/resolve-user-md.js";
import type { GitDestructiveKind } from "./dest-form.js";

export const GIT_DESTRUCTIVE_LOG_ENV = "DEFT_GIT_DESTRUCTIVE_LOG";

export type GitDestructiveDisposition = "deny" | "allow-fixture";

export interface GitDestructiveRecord {
  readonly ts: string;
  readonly kind: GitDestructiveKind;
  readonly disposition: GitDestructiveDisposition;
  readonly command: string;
  readonly projectRoot: string;
  readonly host: string;
  readonly toolName: string | null;
  readonly actor: string;
  readonly pid: number;
  readonly relocators: readonly string[];
  readonly unprovable: boolean;
}

export function resolveGitDestructiveLogPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  const override = env[GIT_DESTRUCTIVE_LOG_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return join(platformUserConfigDir(platform, env, homeDir), "logs", "git-destructive.jsonl");
}

function defaultAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, { encoding: "utf8" });
}

/**
 * Best-effort append. A log failure must not block the deny.
 */
export function appendGitDestructiveRecord(
  record: GitDestructiveRecord,
  options: {
    readonly logPath?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly append?: (path: string, line: string) => void;
  } = {},
): void {
  try {
    const path = options.logPath ?? resolveGitDestructiveLogPath(options.env ?? process.env);
    const line = `${JSON.stringify(record)}\n`;
    (options.append ?? defaultAppend)(path, line);
  } catch {
    // Attribution is best-effort; the fail-closed deny still stands.
  }
}
