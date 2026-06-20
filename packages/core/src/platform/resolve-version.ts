import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_FALLBACK, ENV_VAR } from "./constants.js";

export { DEV_FALLBACK, ENV_VAR };

export class NonPublishableVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonPublishableVersionError";
  }
}

const PRE_KIND_MAP: Record<string, string> = {
  alpha: "a",
  beta: "b",
  rc: "rc",
};

const NON_PUBLISHABLE_KINDS = new Set(["test"]);

const PRERELEASE_RANK: Record<string, number> = {
  alpha: 0,
  beta: 1,
  rc: 2,
  "": 3,
};

function frameworkRoot(): string {
  const envRoot = process.env.DEFT_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** Parse `[v]X.Y.Z[-(rc|alpha|beta|test).N]` via linear scan. */
function parsePep440Tag(
  version: string,
): { major: number; minor: number; patch: number; kind: string | null; num: number | null } | null {
  let i = 0;
  if (version[i] === "v" || version[i] === "V") i += 1;
  const readInt = (): number | null => {
    const ch = version[i] ?? "";
    if (i >= version.length || ch < "0" || ch > "9") return null;
    let n = 0;
    while (i < version.length) {
      const digit = version[i] ?? "";
      if (digit < "0" || digit > "9") break;
      n = n * 10 + Number(digit);
      i += 1;
    }
    return n;
  };
  const major = readInt();
  if (major === null || version[i] !== ".") return null;
  i += 1;
  const minor = readInt();
  if (minor === null || version[i] !== ".") return null;
  i += 1;
  const patch = readInt();
  if (patch === null) return null;
  if (i >= version.length) return { major, minor, patch, kind: null, num: null };
  if (version[i] !== "-") return null;
  i += 1;
  const kindStart = i;
  while (i < version.length && version[i] !== ".") i += 1;
  if (i >= version.length || version[i] !== ".") return null;
  const kind = version.slice(kindStart, i);
  if (!["rc", "alpha", "beta", "test"].includes(kind)) return null;
  i += 1;
  const num = readInt();
  if (num === null || i !== version.length) return null;
  return { major, minor, patch, kind, num };
}

export function toPep440(version: string): string {
  if (typeof version !== "string") {
    throw new Error(`version must be a string, got ${typeof version}`);
  }
  const candidate = version.trim();
  if (!candidate) throw new Error("version must be a non-empty string");
  const parsed = parsePep440Tag(candidate);
  if (parsed === null) {
    throw new Error(
      `Cannot normalize ${JSON.stringify(candidate)} to PEP 440: expected [v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta|test).N`,
    );
  }
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (parsed.kind === null) return base;
  if (NON_PUBLISHABLE_KINDS.has(parsed.kind)) {
    throw new NonPublishableVersionError(
      `Version ${JSON.stringify(candidate)} carries non-publishable pre-release tag ${JSON.stringify(parsed.kind)}.${parsed.num} -- release pipeline MUST skip pyproject.toml [project].version sync for this tag.`,
    );
  }
  const pepKind = PRE_KIND_MAP[parsed.kind];
  if (pepKind === undefined) {
    throw new Error(
      `Unmapped pre-release kind ${JSON.stringify(parsed.kind)} for version ${JSON.stringify(candidate)}; add it to PRE_KIND_MAP or NON_PUBLISHABLE_KINDS to keep parser in lockstep with the publishability classifier.`,
    );
  }
  return `${base}${pepKind}${parsed.num}`;
}

export function isPublishable(version: string): boolean {
  try {
    toPep440(version);
    return true;
  } catch {
    return false;
  }
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

function publishableTagSortKey(version: string): [number, number, number, number, number] {
  const candidate = version.trim();
  const parsed = parsePep440Tag(candidate);
  if (parsed === null) {
    throw new Error(
      `Cannot sort ${JSON.stringify(candidate)}: expected [v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta).N`,
    );
  }
  if (parsed.kind !== null && NON_PUBLISHABLE_KINDS.has(parsed.kind)) {
    throw new NonPublishableVersionError(
      `Version ${JSON.stringify(candidate)} carries non-publishable pre-release tag ${JSON.stringify(parsed.kind)}.`,
    );
  }
  const kind = parsed.kind ?? "";
  const prereleaseRank = PRERELEASE_RANK[kind];
  if (prereleaseRank === undefined) {
    throw new Error(
      `Unmapped pre-release kind ${JSON.stringify(parsed.kind)} for ${JSON.stringify(candidate)}`,
    );
  }
  return [parsed.major, parsed.minor, parsed.patch, prereleaseRank, parsed.num ?? 0];
}

export function latestPublishableTag(tags: Iterable<string>): string | null {
  let bestTag: string | null = null;
  let bestKey: [number, number, number, number, number] | null = null;
  for (const raw of tags) {
    const tag = tagNameFromRef(raw);
    if (!tag || !isPublishable(tag)) continue;
    try {
      const key = publishableTagSortKey(tag);
      if (bestKey === null || compareTuple(key, bestKey) > 0) {
        bestTag = tag;
        bestKey = key;
      }
    } catch {}
  }
  return bestTag;
}

function compareTuple(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
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

export function payloadIsOwnGitRoot(payloadDir: string): boolean {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: payloadDir,
      encoding: "utf8",
      timeout: 10_000,
    });
    const toplevel = stdout.trim();
    if (!toplevel) return false;
    return resolve(toplevel) === resolve(payloadDir);
  } catch {
    return false;
  }
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
  // "-", so reject them outright. "--end-of-options" is defense-in-depth.
  if (remote.startsWith("-")) return null;
  const cwd = repoRoot ?? frameworkRoot();
  try {
    const stdout = execFileSync(
      "git",
      ["ls-remote", "--tags", "--refs", "--end-of-options", remote],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
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
