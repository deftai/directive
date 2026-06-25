/**
 * Doc ↔ CLI parity gate (#1996).
 *
 * Extracts npm-canonical CLI invocations from UPGRADING.md and the AGENTS.md
 * managed-section template, then asserts each resolves through the top-level
 * router to a registered dispatcher verb (or an explicitly allowlisted legacy
 * back-compat surface documented post-#1912).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasCommand } from "@deftai/directive-core/render";
import { routeArgv } from "./cli-router/route-argv.js";
import { registeredVerbs, resolveCanonicalVerb, VERB_ALIASES } from "./dispatch.js";

/** Documented legacy surfaces that remain in prose but are not npm-router verbs. */
export const LEGACY_DOC_VERB_KEYS = new Set(["setup", "upgrade", "relocate"]);

const CLI_PREFIX_RE = /^(?:directive|deft|npx @deftai\/directive)\s+/;
const BACKTICK_COMMAND_RE = /`((?:directive|deft|npx @deftai\/directive)\s+[^`]+)`/g;

const TOP_LEVEL_UX = new Set(["init", "update", "migrate"]);

export interface DocCliReference {
  readonly source: string;
  readonly raw: string;
  readonly normalized: string;
}

export interface DocCliParityFailure {
  readonly source: string;
  readonly raw: string;
  readonly reason: string;
}

function repoRootFromModule(): string {
  return resolve(import.meta.dirname, "..", "..", "..");
}

function extractManagedSection(text: string): string {
  const open = text.indexOf("<!-- deft:managed-section");
  if (open < 0) return text;
  const close = text.indexOf("<!-- /deft:managed-section -->", open);
  if (close < 0) return text.slice(open);
  return text.slice(open, close);
}

/** Pull CLI command references from UPGRADING.md + agents-entry managed section. */
export function extractDocCliReferences(
  repoRoot: string = repoRootFromModule(),
): DocCliReference[] {
  const sources: Array<[string, string]> = [
    ["content/UPGRADING.md", readFileSync(join(repoRoot, "content/UPGRADING.md"), "utf8")],
    [
      "content/templates/agents-entry.md",
      extractManagedSection(
        readFileSync(join(repoRoot, "content/templates/agents-entry.md"), "utf8"),
      ),
    ],
  ];
  const seen = new Set<string>();
  const out: DocCliReference[] = [];
  for (const [source, text] of sources) {
    for (const match of text.matchAll(BACKTICK_COMMAND_RE)) {
      const raw = match[1]?.trim() ?? "";
      if (!CLI_PREFIX_RE.test(raw)) continue;
      const normalized = normalizeDocCommand(raw);
      if (normalized === null) continue;
      const key = `${source}\0${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source, raw, normalized });
    }
  }
  return out.sort(
    (a, b) => a.source.localeCompare(b.source) || a.normalized.localeCompare(b.normalized),
  );
}

function stripAnglePlaceholders(text: string): string {
  let out = text;
  let start = out.indexOf("<");
  while (start >= 0) {
    const end = out.indexOf(">", start + 1);
    if (end < 0) break;
    out = `${out.slice(0, start)}${out.slice(end + 1)}`;
    start = out.indexOf("<");
  }
  return out.trim();
}

/** Strip flags/placeholders; return null when the literal is not a CLI verb invocation. */
export function normalizeDocCommand(raw: string): string | null {
  let rest = raw.replace(CLI_PREFIX_RE, "").trim();
  if (rest.length === 0) return null;

  const dd = rest.indexOf(" --");
  if (dd >= 0) rest = rest.slice(0, dd).trim();

  rest = rest.replace(/\s+\[[^\]]*\]/g, "").trim();
  rest = rest.replace(/\s+--[^\s]+(\s+[^\s]+)?/g, "").trim();
  rest = stripAnglePlaceholders(rest);

  if (rest.includes("/") || rest.includes(".md") || rest.includes("*")) return null;
  if (/^deft-install\b/.test(rest)) return null;
  if (/^deft-directive\b/.test(rest)) return null;
  if (/^deftai\b/.test(rest)) return null;

  const first = rest.split(/\s+/)[0] ?? "";
  if (!/^[\w:-]+$/.test(first)) return null;

  if (first.includes(":")) {
    return first;
  }
  return first;
}

function tokenizeDocVerb(normalized: string): string[] {
  if (normalized.includes(":")) {
    const colon = normalized.indexOf(":");
    return [normalized.slice(0, colon), normalized.slice(colon + 1)];
  }
  return [normalized];
}

function colonKeyFromNormalized(normalized: string): string | null {
  if (normalized.includes(":")) return normalized;
  return null;
}

function isRegisteredHandler(flatVerb: string): boolean {
  const verbs = new Set(registeredVerbs());
  if (verbs.has(flatVerb)) return true;
  const canon = resolveCanonicalVerb(flatVerb);
  return canon !== null && verbs.has(canon);
}

/** Validate one normalized doc command against the router + registeredVerbs(). */
export function validateDocCliCommand(normalized: string): string | null {
  const colonKey = colonKeyFromNormalized(normalized);
  if (colonKey !== null) {
    if (LEGACY_DOC_VERB_KEYS.has(colonKey)) {
      return null;
    }
    if (colonKey in VERB_ALIASES || hasCommand(colonKey)) {
      return null;
    }
  } else if (LEGACY_DOC_VERB_KEYS.has(normalized)) {
    return null;
  }

  const tokens = tokenizeDocVerb(normalized);
  const routed = routeArgv(tokens);
  if (routed.kind === "stub") {
    return routed.stubMessage ?? "routes to stub handler";
  }

  const head = routed.argv[0];
  if (head === undefined || head.length === 0) {
    return "router produced empty argv";
  }

  if (TOP_LEVEL_UX.has(head)) {
    return null;
  }

  if (isRegisteredHandler(head)) {
    return null;
  }

  return `unregistered handler '${head}' (tokens=${JSON.stringify(tokens)}, routed=${JSON.stringify(routed.argv.slice(0, 3))})`;
}

/** Run the parity gate; returns failure rows (empty == pass). */
export function collectDocCliParityFailures(
  repoRoot: string = repoRootFromModule(),
): DocCliParityFailure[] {
  const failures: DocCliParityFailure[] = [];
  for (const ref of extractDocCliReferences(repoRoot)) {
    const reason = validateDocCliCommand(ref.normalized);
    if (reason !== null) {
      failures.push({ source: ref.source, raw: ref.raw, reason });
    }
  }
  return failures;
}
