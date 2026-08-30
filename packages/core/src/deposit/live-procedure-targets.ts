/**
 * C3 live-procedure target validation (#3602 / #3899).
 *
 * A shipped live procedure must not name a helper the deposit does not
 * contain. Python helpers are identified via python-free; markdown is
 * walked with the validate-links skip set and extractLinkTargets. History,
 * examples, and prohibitions are skipped by declaration.
 *
 * Metric: unique live-invalid helper targets (not occurrences, not matching
 * lines). Prefer a zero unique-target assertion; do not freeze raw counts.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";
import { extractLinkTargets, shouldSkipLinkTarget } from "../validate-content/link-parser.js";
import { isDeclaredLiveProcedureExclusion } from "./live-procedure-exclusions.js";
import { isPythonHelperPath } from "./python-free.js";

const SKIP_DIRS = new Set([...NON_PRODUCT_DIRS, ".planning", "specs"]);

export interface LiveProcedureHit {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

export interface ExtraMarkdownFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface EvaluateLiveProcedureTargetsOptions {
  readonly stagedRoot: string;
  readonly extraFiles?: readonly ExtraMarkdownFile[];
}

/**
 * Metric used by C3: unique live-invalid helper targets.
 * Not occurrence count, not matching-line count.
 */
export const LIVE_PROCEDURE_METRIC = "unique-targets" as const;

export interface LiveProcedureEvaluation {
  readonly metric: typeof LIVE_PROCEDURE_METRIC;
  readonly hits: readonly LiveProcedureHit[];
  readonly uniqueTargets: readonly string[];
}

function shouldSkipPath(parts: string[]): boolean {
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  return parts.includes("history") && parts.includes("archive");
}

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

function collectMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, parts: string[]): void => {
    if (shouldSkipPath(parts)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const nextParts = [...parts, entry.name];
      if (shouldSkipPath(nextParts)) continue;
      if (entry.isDirectory()) {
        walk(full, nextParts);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(root, []);
  return out.sort();
}

const HELPER_TOKEN = /^scripts\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.py$/;

export function normalizePythonHelperTarget(raw: string): string | null {
  const clean = (raw.split("#")[0] ?? "").split("?")[0] ?? "";
  const posix = clean.replace(/\\/g, "/");
  if (posix.includes("://")) return null;
  const idx = posix.lastIndexOf("scripts/");
  if (idx < 0) return null;
  const token = posix.slice(idx);
  if (token.includes("..")) return null;
  if (!HELPER_TOKEN.test(token)) return null;
  return token;
}

function extractBacktickPythonHelpers(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (from < line.length) {
    const idx = line.indexOf("scripts/", from);
    if (idx < 0) break;
    let end = idx + "scripts/".length;
    while (end < line.length) {
      const ch = line[end];
      if (ch === undefined) break;
      if (
        (ch >= "A" && ch <= "Z") ||
        (ch >= "a" && ch <= "z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "_" ||
        ch === "." ||
        ch === "/" ||
        ch === "-"
      ) {
        end += 1;
        continue;
      }
      break;
    }
    const token = line.slice(idx, end);
    from = end > idx ? end : idx + 1;
    const normalized = normalizePythonHelperTarget(token);
    if (normalized) out.push(normalized);
  }
  return out;
}

function extractLineTargets(line: string): string[] {
  const found = new Set<string>();
  for (const raw of extractLinkTargets(line)) {
    if (
      raw.startsWith("http://") ||
      raw.startsWith("https://") ||
      raw.startsWith("mailto:") ||
      raw.startsWith("#")
    ) {
      continue;
    }
    if (shouldSkipLinkTarget(raw)) continue;
    const normalized = normalizePythonHelperTarget(raw);
    if (normalized) found.add(normalized);
  }
  for (const token of extractBacktickPythonHelpers(line)) found.add(token);
  return [...found];
}

function scanMarkdownFile(absolutePath: string, relativePath: string): LiveProcedureHit[] {
  if (isDeclaredLiveProcedureExclusion(relativePath)) return [];
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch {
    return [];
  }
  const hits: LiveProcedureHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const target of extractLineTargets(line)) {
      if (!isPythonHelperPath(target)) continue;
      hits.push({ file: relativePath, line: i + 1, target });
    }
  }
  return hits;
}

export function evaluateLiveProcedureTargets(
  options: EvaluateLiveProcedureTargetsOptions,
): LiveProcedureEvaluation {
  const stagedRoot = resolve(options.stagedRoot);
  const hits: LiveProcedureHit[] = [];
  if (existsSync(stagedRoot)) {
    for (const md of collectMarkdownFiles(stagedRoot)) {
      const rel = toPosix(relative(stagedRoot, md));
      hits.push(...scanMarkdownFile(md, rel));
    }
  }
  for (const extra of options.extraFiles ?? []) {
    const rel = extra.relativePath.replace(/\\/g, "/");
    hits.push(...scanMarkdownFile(extra.absolutePath, rel));
  }
  const unique = [...new Set(hits.map((h) => h.target))].sort();
  return { metric: LIVE_PROCEDURE_METRIC, hits, uniqueTargets: unique };
}

export function formatLiveProcedureFailure(result: LiveProcedureEvaluation): string {
  const lines = [
    `C3 live-procedure target validation failed: ${result.uniqueTargets.length} unique live-invalid helper target(s) (metric=${result.metric}).`,
  ];
  for (const hit of result.hits.slice(0, 40)) {
    lines.push(`  ${hit.file}:${hit.line} -> ${hit.target}`);
  }
  if (result.hits.length > 40) {
    lines.push(`  ... ${result.hits.length - 40} more occurrence(s)`);
  }
  return lines.join("\n");
}
