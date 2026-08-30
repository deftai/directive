/**
 * Flatten-aware rewrite of relative markdown links from the source tree onto
 * the C1 packed layout (#3937).
 *
 * Source checkout: content/X lives under content/; root main.md / SKILL.md stay
 * at the repo root. Deposit: content/ children flatten to the payload root, and
 * harness entries land beside them. A naive `./content/` strip cannot express
 * the reverse `../../main.md` escape. This rewrite maps each relative target
 * through the source path, then emits a deposit-relative href.
 */

import { posix } from "node:path";
import { extractLinkTargets, shouldSkipLinkTarget } from "../validate-content/link-parser.js";

export const DEPOSIT_LINK_REWRITE_VERSION = "1";
export const REWRITE_MARKER_PREFIX = "<!-- deft:deposit-link-rewrite";

const HARNESS_PACK_FILES = new Set(["main.md", "SKILL.md", "Taskfile.yml"]);

export function isUrlLikeTarget(target: string): boolean {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("#")
  );
}

/** Map a repo-relative source path to its packed-deposit relative path. */
export function mapSourceToPackRelative(sourceRel: string): string | null {
  let n = sourceRel.replace(/\\/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  if (n === "." || n === "") return ".";
  if (HARNESS_PACK_FILES.has(n) || n.startsWith("tasks/") || n.startsWith(".githooks/")) {
    return n;
  }
  if (n === "content") return ".";
  if (n.startsWith("content/")) return n.slice("content/".length);
  return null;
}

/** Inverse: packed path -> source path the file was copied from. */
export function sourceRelForPackRel(packRel: string): string {
  const n = packRel.replace(/\\/g, "/");
  if (HARNESS_PACK_FILES.has(n) || n.startsWith("tasks/") || n.startsWith(".githooks/")) {
    return n;
  }
  return `content/${n}`;
}

export function resolveSourceTargetRel(sourceFileRel: string, rawPath: string): string {
  const sourceDir = posix.dirname(sourceFileRel.replace(/\\/g, "/"));
  return posix.normalize(posix.join(sourceDir, rawPath)).replace(/\\/g, "/");
}

export function splitLinkHash(target: string): { path: string; suffix: string } {
  const hash = target.indexOf("#");
  const query = target.indexOf("?");
  let cut = -1;
  if (hash === -1) cut = query;
  else if (query === -1) cut = hash;
  else cut = Math.min(hash, query);
  if (cut === -1) return { path: target, suffix: "" };
  return { path: target.slice(0, cut), suffix: target.slice(cut) };
}

export interface RewriteLinkResult {
  readonly next: string;
  readonly rewritten: boolean;
  readonly packMapped: boolean;
}

export function rewriteRelativeLink(options: {
  readonly sourceFileRel: string;
  readonly packFileRel: string;
  readonly target: string;
}): RewriteLinkResult {
  const { sourceFileRel, packFileRel, target } = options;
  if (isUrlLikeTarget(target) || shouldSkipLinkTarget(target)) {
    return { next: target, rewritten: false, packMapped: true };
  }
  const { path: rawPath, suffix } = splitLinkHash(target);
  if (!rawPath) return { next: target, rewritten: false, packMapped: true };
  const trailingSlash = rawPath.endsWith("/");
  const sourceTarget = resolveSourceTargetRel(sourceFileRel, rawPath);
  if (sourceTarget === ".." || sourceTarget.startsWith("../")) {
    return { next: target, rewritten: false, packMapped: false };
  }
  const packTarget = mapSourceToPackRelative(sourceTarget);
  if (packTarget === null) {
    return { next: target, rewritten: false, packMapped: false };
  }
  const packDir = posix.dirname(packFileRel.replace(/\\/g, "/"));
  let rel = posix.relative(packDir, packTarget).replace(/\\/g, "/");
  if (rel === "") rel = ".";
  if (trailingSlash && rel !== "." && !rel.endsWith("/")) rel = `${rel}/`;
  if (rawPath.startsWith("./") && !rel.startsWith(".") && !rel.startsWith("/")) {
    rel = `./${rel}`;
  }
  const next = `${rel}${suffix}`;
  return { next, rewritten: next !== target, packMapped: true };
}

export function rewriteMarker(sourceRel: string): string {
  return `${REWRITE_MARKER_PREFIX} v=${DEPOSIT_LINK_REWRITE_VERSION} source="${sourceRel.replace(/\\/g, "/")}" -->`;
}

export function rewriteMarkdownDepositLinks(options: {
  readonly content: string;
  readonly sourceFileRel: string;
  readonly packFileRel: string;
}): { content: string; rewriteCount: number } {
  const lines = options.content.split("\n");
  let rewriteCount = 0;
  const out: string[] = [];
  for (const line of lines) {
    const targets = extractLinkTargets(line);
    if (targets.length === 0) {
      out.push(line);
      continue;
    }
    let nextLine = line;
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const target = targets[i];
      if (target === undefined) continue;
      const result = rewriteRelativeLink({
        sourceFileRel: options.sourceFileRel,
        packFileRel: options.packFileRel,
        target,
      });
      if (!result.rewritten) continue;
      const needle = `](${target})`;
      const at = nextLine.lastIndexOf(needle);
      if (at === -1) continue;
      nextLine = `${nextLine.slice(0, at)}](${result.next})${nextLine.slice(at + needle.length)}`;
      rewriteCount += 1;
    }
    out.push(nextLine);
  }
  if (rewriteCount === 0) {
    return { content: options.content, rewriteCount: 0 };
  }
  let joined = out.join("\n");
  if (!joined.includes(REWRITE_MARKER_PREFIX)) {
    const marker = rewriteMarker(options.sourceFileRel);
    if (joined.startsWith("<!--")) {
      const end = joined.indexOf("-->");
      if (end !== -1) {
        joined = `${joined.slice(0, end + 3)}\n${marker}${joined.slice(end + 3)}`;
      } else {
        joined = `${marker}\n${joined}`;
      }
    } else {
      joined = `${marker}\n${joined}`;
    }
  }
  return { content: joined, rewriteCount };
}
