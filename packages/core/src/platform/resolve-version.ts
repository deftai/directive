import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  comparePublishableVersions,
  isPublishable,
  NonPublishableVersionError,
  toPep440,
} from "../release/version.js";
import { type GitRunner, timedGitRunner } from "../session/git.js";
import { DEV_FALLBACK, ENV_VAR } from "./constants.js";

export { DEV_FALLBACK, ENV_VAR, isPublishable, NonPublishableVersionError, toPep440 };

function frameworkRoot(): string {
  const envRoot = process.env.DEFT_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export function tagNameFromRef(ref: string): string {
  let candidate = ref.trim();
  if (!candidate) return "";
  const parts = candidate.split(/\s+/);
  if (parts.length >= 2) candidate = parts[1] ?? candidate;
  if (candidate.endsWith("^{}")) candidate = candidate.slice(0, -3);
  const prefix = "refs/tags/";
  if (candidate.startsWith(prefix)) candidate = candidate.slice(prefix.length);
  return candidate.trim();
}

export function latestPublishableTag(tags: Iterable<string>): string | null {
  let bestTag: string | null = null;
  for (const raw of tags) {
    const tag = tagNameFromRef(raw);
    if (!tag || !isPublishable(tag)) continue;
    try {
      if (bestTag === null || comparePublishableVersions(tag, bestTag) > 0) {
        bestTag = tag;
      }
    } catch {}
  }
  return bestTag;
}

function readManifestTag(baseDir: string): string | null {
  const manifest = join(baseDir, "VERSION");
  try {
    if (!existsSync(manifest)) return null;
    const text = readFileSync(manifest, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("tag:") || trimmed.startsWith("ref:")) {
        const colon = trimmed.indexOf(":");
        let value = trimmed.slice(colon + 1).trim();
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }
        if (value.startsWith("v")) value = value.slice(1);
        const cleaned = value.trim();
        if (cleaned) return cleaned;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readDeftVersion(baseDir: string): string | null {
  const marker = join(baseDir, ".deft-version");
  try {
    if (!existsSync(marker)) return null;
    let version = readFileSync(marker, "utf8").trim();
    if (version.startsWith("v")) version = version.slice(1);
    return version || null;
  } catch {
    return null;
  }
}

export function payloadIsOwnGitRoot(
  payloadDir: string,
  runGit: GitRunner = timedGitRunner(10_000),
): boolean {
  const { code, stdout } = runGit(payloadDir, ["rev-parse", "--show-toplevel"]);
  const toplevel = stdout.trim();
  if (code !== 0 || !toplevel) return false;
  return resolve(toplevel) === resolve(payloadDir);
}

function fromEnv(): string | null {
  const value = (process.env[ENV_VAR] ?? "").trim();
  return value || null;
}

function fromGit(baseDir: string): string | null {
  if (!payloadIsOwnGitRoot(baseDir)) return null;
  try {
    const stdout = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: baseDir,
      encoding: "utf8",
      timeout: 10_000,
    });
    let tag = stdout.trim();
    if (!tag) return null;
    if (tag.startsWith("v")) tag = tag.slice(1);
    return tag || null;
  } catch {
    return null;
  }
}

export function latestLocalPublishableTag(repoRoot?: string): string | null {
  const cwd = repoRoot ?? frameworkRoot();
  try {
    const stdout = execFileSync("git", ["tag", "--list"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    return latestPublishableTag(stdout.split("\n"));
  } catch {
    return null;
  }
}

export function latestRemotePublishableTag(remote = "origin", repoRoot?: string): string | null {
  // Guard against second-order command injection: a remote beginning with "-"
  // (e.g. "--upload-pack=<cmd>") would be parsed by git as an option and could
  // execute an arbitrary command. Legitimate remote names/URLs never start with
  // "-", so reject them outright; the "--" end-of-options separator below is the
  // load-bearing barrier (git stops parsing options after it).
  if (remote.startsWith("-")) return null;
  const cwd = repoRoot ?? frameworkRoot();
  try {
    const stdout = execFileSync("git", ["ls-remote", "--tags", "--refs", "--", remote], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    return latestPublishableTag(stdout.split("\n"));
  } catch {
    return null;
  }
}

export interface ResolveVersionSeams {
  readonly frameworkRoot?: string;
  readonly fromEnv?: () => string | null;
  readonly fromManifest?: (base: string) => string | null;
  readonly fromDeftVersion?: (base: string) => string | null;
  readonly fromGit?: (base: string) => string | null;
}

/** Resolve version using the documented priority chain. */
export function resolveVersion(seams: ResolveVersionSeams = {}): string {
  const base = seams.frameworkRoot ?? frameworkRoot();
  const envValue = (seams.fromEnv ?? fromEnv)();
  if (envValue) return envValue;
  const manifestValue = (seams.fromManifest ?? readManifestTag)(base);
  if (manifestValue) return manifestValue;
  const deftVersionValue = (seams.fromDeftVersion ?? readDeftVersion)(base);
  if (deftVersionValue) return deftVersionValue;
  const gitValue = (seams.fromGit ?? fromGit)(base);
  if (gitValue) return gitValue;
  return DEV_FALLBACK;
}
