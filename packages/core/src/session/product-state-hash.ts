/**
 * Product-state hash for AC-pass bank reuse (#3387).
 *
 * Acceptance plus product file bytes. Lifecycle dirs (xbrief/vbrief/.deft)
 * are excluded so scope:complete moves do not invalidate a green bank.
 */

import { createHash } from "node:crypto";
import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defaultGitRunner, type GitRunner, gitHead } from "./git.js";

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".deft",
  ".deft-scratch",
  ".deft-cache",
  "node_modules",
  "dist",
  "coverage",
  ".planning",
]);

const EXCLUDED_PATH_PREFIXES = ["xbrief/", "vbrief/", ".deft/", ".git/"];

export interface HashProductStateInput {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  /** Explicit product files (tests / callers). Relative to projectRoot. */
  readonly productPaths?: readonly string[];
  readonly runGit?: GitRunner;
}

export interface ProductStateHash {
  readonly digest: string;
  /** False when no product surface could be enumerated — refuse reuse. */
  readonly complete: boolean;
  readonly files: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

function toPosix(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function isExcludedRel(rel: string): boolean {
  const posix = toPosix(rel);
  if (posix === "." || posix.length === 0) return false;
  const first = posix.split("/")[0] ?? "";
  if (EXCLUDED_DIR_NAMES.has(first)) return true;
  return EXCLUDED_PATH_PREFIXES.some(
    (prefix) => posix === prefix.slice(0, -1) || posix.startsWith(prefix),
  );
}

function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readFileHash(abs: string): string {
  try {
    return hashBytes(readFileSync(abs));
  } catch {
    return "missing";
  }
}

function walkFiles(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const rel = toPosix(relative(root, abs));
    if (isExcludedRel(rel)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(name)) continue;
      walkFiles(root, abs, out);
      continue;
    }
    if (st.isFile()) out.push(rel);
  }
}

function fileScopePaths(plan: Record<string, unknown>): string[] {
  const meta = asRecord(plan.metadata);
  const swarm = asRecord(meta?.swarm);
  const raw = swarm?.file_scope;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function expandPath(root: string, relOrGlob: string): string[] {
  const rel = toPosix(relOrGlob).replace(/^\.\//, "");
  if (rel.includes("*") || rel.includes("?")) {
    try {
      return globSync(rel, { cwd: root })
        .map((match) => toPosix(relative(root, resolve(root, match))))
        .filter((posix) => posix.length > 0 && !isExcludedRel(posix))
        .filter((posix) => {
          try {
            return statSync(resolve(root, posix)).isFile();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }
  const abs = resolve(root, rel);
  if (!existsSync(abs)) return [rel];
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      const out: string[] = [];
      walkFiles(root, abs, out);
      return out;
    }
    if (st.isFile()) return [toPosix(relative(root, abs))];
  } catch {
    return [rel];
  }
  return [rel];
}

function unquotePorcelainPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([ntr"\\])/g, (_, ch: string) => {
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      if (ch === "r") return "\r";
      return ch;
    });
  }
  return trimmed;
}

function dirtyProductFiles(projectRoot: string, runGit: GitRunner): string[] {
  const zed = runGit(projectRoot, ["status", "--porcelain", "-u", "-z"]);
  const out: string[] = [];
  if (zed.code === 0 && zed.stdout.length > 0) {
    const parts = zed.stdout.split("\0").filter((part) => part.length > 0);
    for (let i = 0; i < parts.length; i += 1) {
      const rec = parts[i] as string;
      if (rec.length < 4) continue;
      const code = rec.slice(0, 2);
      const pathPart = rec.slice(3);
      const renamed = code.includes("R") || code.includes("C");
      // -z rename/copy is `XY dest\0orig\0` — keep dest, skip orig.
      if (renamed && i + 1 < parts.length) {
        i += 1;
      }
      const rel = toPosix(pathPart);
      if (rel.length === 0 || isExcludedRel(rel)) continue;
      out.push(rel);
    }
    return out;
  }
  const { code, stdout } = runGit(projectRoot, ["status", "--porcelain", "-u"]);
  if (code !== 0) return [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const pathPart = unquotePorcelainPath(line.slice(3));
    const renamed = pathPart.split(" -> ");
    const rel = toPosix(renamed[renamed.length - 1] ?? pathPart);
    if (rel.length === 0 || isExcludedRel(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Hash plan.acceptance plus product files. Missing/empty product surface
 * is incomplete so callers fail closed to a full walk (#3387).
 */
export function hashProductState(input: HashProductStateInput): ProductStateHash {
  const root = resolve(input.projectRoot);
  const runGit = input.runGit ?? defaultGitRunner;
  const files = new Set<string>();

  if (input.productPaths !== undefined) {
    for (const rel of input.productPaths) {
      for (const expanded of expandPath(root, rel)) files.add(expanded);
    }
  } else {
    const scope = fileScopePaths(input.plan);
    if (scope.length > 0) {
      for (const entry of scope) {
        for (const expanded of expandPath(root, entry)) files.add(expanded);
      }
    } else {
      const git = existsSync(join(root, ".git"));
      if (git) {
        for (const rel of dirtyProductFiles(root, runGit)) files.add(rel);
      } else {
        const walked: string[] = [];
        walkFiles(root, root, walked);
        for (const rel of walked) files.add(rel);
      }
    }
  }

  const sorted = [...files].sort();
  const fileHashes: Record<string, string> = {};
  for (const rel of sorted) {
    fileHashes[rel] = readFileHash(resolve(root, rel));
  }

  const head = existsSync(join(root, ".git")) ? gitHead(root, runGit).head : null;
  const specifiedSurface =
    input.productPaths !== undefined || fileScopePaths(input.plan).length > 0;
  const hasSurface = specifiedSurface ? sorted.length > 0 : sorted.length > 0 || head !== null;
  const digest = createHash("sha256")
    .update(
      stableJson({
        acceptance: input.plan.acceptance ?? null,
        head,
        files: fileHashes,
      }),
    )
    .digest("hex");

  return { digest, complete: hasSurface, files: sorted };
}
