/**
 * Product-state hash for AC-pass bank reuse (#3387).
 *
 * Acceptance plus product file bytes. Lifecycle dirs (xbrief/vbrief/.deft)
 * are excluded so scope:complete moves do not invalidate a green bank.
 */

import { createHash } from "node:crypto";
import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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

/** Join root (UTF-8) to a latin1 rel so invalid filename bytes are not re-encoded. */
function joinRootRelBytes(root: string, rel: string): Buffer {
  const sepBuf = Buffer.from(sep);
  const parts: Buffer[] = [Buffer.from(root, "utf8")];
  for (const seg of toPosix(rel).split("/")) {
    if (seg.length === 0 || seg === ".") continue;
    parts.push(sepBuf, Buffer.from(seg, "latin1"));
  }
  return Buffer.concat(parts);
}

function readFileHash(root: string, rel: string): string {
  try {
    return hashBytes(readFileSync(resolve(root, rel)));
  } catch {
    try {
      return hashBytes(readFileSync(joinRootRelBytes(root, rel)));
    } catch {
      return "missing";
    }
  }
}

function walkFiles(root: string, dir: string, out: string[], seen = new Set<string>()): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
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
      walkFiles(root, abs, out, seen);
      continue;
    }
    if (st.isFile()) out.push(rel);
  }
}

/**
 * Node `fs.globSync` omits leading-dot names and has no `{ dot }` option.
 * Each `*` / `?` / `[` segment gets an ordinary and a hidden variant so a
 * later hidden segment (for example app/.config.ts) or a class-selected
 * hidden name (frontend/[ab]* -> .app.ts) stays in the digest. Keep **
 * intact and add a recursive hidden-name pattern. Hidden directories
 * under ** are collected by walking the prefix (readdir includes .dirs).
 */
function hiddenSegmentVariant(segment: string): string | null {
  if (segment === "**" || segment.startsWith(".")) return null;
  if (segment.startsWith("*") || segment.startsWith("?") || segment.startsWith("[")) {
    return `.${segment}`;
  }
  return null;
}

function globPatternsIncludingDotfiles(pattern: string): readonly string[] {
  const patterns = new Set<string>([pattern]);
  let combos: string[][] = [[]];
  for (const segment of pattern.split("/")) {
    const variants = [segment];
    const hidden = hiddenSegmentVariant(segment);
    if (hidden !== null) variants.push(hidden);
    const next: string[][] = [];
    for (const combo of combos) {
      for (const variant of variants) next.push([...combo, variant]);
    }
    combos = next;
  }
  for (const combo of combos) patterns.add(combo.join("/"));
  if (pattern.includes("**")) {
    if (/\*\*(?:\/\*)?$/.test(pattern)) {
      patterns.add(pattern.replace(/\*\*(?:\/\*)?$/, "**/.*"));
    } else {
      const dottedTail = pattern.replace(/(^|\/)([^/]*)$/, (_match, slash: string, name: string) =>
        name.startsWith(".") ? `${slash}${name}` : `${slash}.${name}`,
      );
      patterns.add(dottedTail);
    }
  }
  return [...patterns];
}

function closeBraceIndex(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === "{") depth += 1;
    else if (pattern[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlts(inner: string): string[] {
  const alts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "{") depth += 1;
    else if (inner[i] === "}") depth -= 1;
    else if (inner[i] === "," && depth === 0) {
      alts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  alts.push(inner.slice(start));
  return alts;
}

/** Match a posix relpath; ** includes hidden directory segments. */
function globToRegExpSource(pattern: string): string {
  let i = 0;
  let out = "";
  while (i < pattern.length) {
    if (pattern.startsWith("**", i)) {
      i += 2;
      if (pattern[i] === "/") {
        out += "(?:[^/]+/)*";
        i += 1;
      } else {
        out += ".*";
      }
      continue;
    }
    const c = pattern[i] as string;
    if (c === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        i += 1;
        continue;
      }
      const body = pattern.slice(i + 1, end);
      // Glob [!a] is "not a"; JS [!a] is "!" or "a".
      if (body.startsWith("!") && body.length > 1) {
        out += `[^${body.slice(1)}/]`;
      } else {
        out += pattern.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }
    if (c === "{") {
      const end = closeBraceIndex(pattern, i);
      if (end === -1) {
        out += "\\{";
        i += 1;
        continue;
      }
      const alts = splitBraceAlts(pattern.slice(i + 1, end));
      out += `(?:${alts.map((alt) => globToRegExpSource(alt)).join("|")})`;
      i = end + 1;
      continue;
    }
    if ("\\^$+()|.".includes(c)) out += `\\${c}`;
    else out += c;
    i += 1;
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globToRegExpSource(pattern)}$`);
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

/** `*`/`?` plus class/brace forms so they are not hashed as a missing literal. */
function looksLikeGlob(rel: string): boolean {
  return /[*?[\]{}]/.test(rel);
}

/** Longest non-glob directory prefix before ** (wildcard mid-path walks from that dir). */
function literalDirPrefix(rel: string): string {
  const before = rel.includes("**") ? rel.slice(0, rel.indexOf("**")) : rel;
  const literal: string[] = [];
  for (const seg of before.replace(/\/$/, "").split("/")) {
    if (seg.length === 0) continue;
    if (looksLikeGlob(seg)) break;
    literal.push(seg);
  }
  return literal.join("/");
}

function expandPath(root: string, relOrGlob: string): string[] {
  const rel = toPosix(relOrGlob).replace(/^\.\//, "");
  if (looksLikeGlob(rel)) {
    try {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const pattern of globPatternsIncludingDotfiles(rel)) {
        for (const match of globSync(pattern, { cwd: root })) {
          const posix = toPosix(relative(root, resolve(root, match)));
          if (posix.length === 0 || isExcludedRel(posix) || seen.has(posix)) continue;
          seen.add(posix);
          const absMatch = resolve(root, posix);
          let st: ReturnType<typeof statSync>;
          try {
            st = statSync(absMatch);
          } catch {
            continue;
          }
          if (st.isFile()) out.push(posix);
          else if (st.isDirectory()) walkFiles(root, absMatch, out);
        }
      }
      if (rel.includes("**")) {
        const prefix = literalDirPrefix(rel);
        const startDir = prefix.length === 0 ? root : resolve(root, prefix);
        if (existsSync(startDir)) {
          let st: ReturnType<typeof statSync> | null = null;
          try {
            st = statSync(startDir);
          } catch {
            st = null;
          }
          if (st?.isDirectory()) {
            const walked: string[] = [];
            walkFiles(root, startDir, walked);
            const re = globToRegExp(rel);
            for (const file of walked) {
              if (seen.has(file) || !re.test(file)) continue;
              seen.add(file);
              out.push(file);
            }
          }
        }
      }
      return out;
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

function takeOctalByte(body: string, index: number): { value: number; next: number } | null {
  const first = body[index];
  if (first === undefined || first < "0" || first > "7") return null;
  let oct = first;
  let i = index + 1;
  while (oct.length < 3 && i < body.length) {
    const digit = body[i];
    if (digit === undefined || digit < "0" || digit > "7") break;
    oct += digit;
    i += 1;
  }
  return { value: Number.parseInt(oct, 8), next: i };
}

/** Valid UTF-8 stays UTF-8; invalid bytes stay latin1 so the path is not U+FFFD. */
function decodeOctalPathBytes(bytes: ArrayLike<number>): string {
  const buf = Buffer.from(bytes);
  const utf8 = buf.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(buf)) return utf8;
  return buf.toString("latin1");
}

function decodeCEscape(body: string, index: number): { ch: string; next: number } {
  const next = body[index];
  if (next === undefined) return { ch: "\\", next: index };
  if (next === "n") return { ch: "\n", next: index + 1 };
  if (next === "t") return { ch: "\t", next: index + 1 };
  if (next === "r") return { ch: "\r", next: index + 1 };
  if (next === '"' || next === "\\") return { ch: next, next: index + 1 };
  const oct = takeOctalByte(body, index);
  if (oct !== null) return { ch: String.fromCharCode(oct.value), next: oct.next };
  return { ch: next, next: index + 1 };
}

/** One C-quoted or unquoted porcelain path; stop unquoted tokens at ` -> `. */
function takePorcelainPathToken(raw: string): { value: string; rest: string } {
  const s = raw.trimStart();
  if (s.startsWith('"')) {
    let i = 1;
    let out = "";
    while (i < s.length) {
      const c = s[i] as string;
      if (c === "\\") {
        const bytes: number[] = [];
        let j = i;
        while (s[j] === "\\") {
          const oct = takeOctalByte(s, j + 1);
          if (oct === null) break;
          bytes.push(oct.value);
          j = oct.next;
        }
        if (bytes.length > 0) {
          out += decodeOctalPathBytes(bytes);
          i = j;
          continue;
        }
        const decoded = decodeCEscape(s, i + 1);
        out += decoded.ch;
        i = decoded.next;
        continue;
      }
      if (c === '"') return { value: out, rest: s.slice(i + 1) };
      out += c;
      i += 1;
    }
    return { value: out, rest: "" };
  }
  const arrow = s.indexOf(" -> ");
  if (arrow === -1) return { value: s.trimEnd(), rest: "" };
  return { value: s.slice(0, arrow), rest: s.slice(arrow) };
}

function porcelainFallbackRel(line: string): string {
  if (line.length < 3) return "";
  const first = takePorcelainPathToken(line.slice(3));
  const after = first.rest.trimStart();
  if (after.startsWith("->")) return takePorcelainPathToken(after.slice(2)).value;
  return first.value;
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
      const rel = toPosix(decodeOctalPathBytes(Buffer.from(pathPart, "latin1")));
      if (rel.length === 0 || isExcludedRel(rel)) continue;
      out.push(rel);
    }
    return out;
  }
  const { code, stdout } = runGit(projectRoot, ["status", "--porcelain", "-u"]);
  if (code !== 0) return [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const rel = toPosix(porcelainFallbackRel(line));
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
    fileHashes[rel] = readFileHash(root, rel);
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
