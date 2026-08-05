/**
 * Shared `--author` filter for triage:queue and triage:classify (#3129 / #1318 Layer 1).
 *
 * Matches existing bulk/bootstrap semantics: exact login match on cached author.login
 * (or user.login). `@me` resolves via authenticated `gh api user --jq .login`.
 * Comma allow-lists are accepted. Missing author on cache rows is "unknown" — not a match,
 * and callers should disclose the unknown count rather than silent-drop.
 */
import { spawnSync } from "node:child_process";
import { extractAuthor } from "./scope-drift/cache-walker.js";

/** Injectable authenticated-login resolver (tests inject; production uses gh). */
export type ResolveAuthenticatedLogin = () => string | null;

export interface AuthorFilter {
  /** Raw CLI value before resolution (e.g. `@me` or `alice,bob`). */
  readonly raw: string;
  /** Resolved allow-list logins (exact match; case-sensitive like bulk). */
  readonly allowLogins: readonly string[];
  /** True when any token was `@me` / `--author-mine`. */
  readonly usedMe: boolean;
  /** Header/digest display string. */
  readonly display: string;
}

export interface AuthorFilterResolveResult {
  readonly filter?: AuthorFilter;
  readonly error?: string;
}

export interface AuthorPartitionResult<T> {
  readonly matched: readonly T[];
  readonly unknownCount: number;
  readonly nonMatchingCount: number;
}

/** Split comma allow-list; trim; drop empties. */
export function parseAuthorTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Resolve `@me` (and bare tokens) into an AuthorFilter.
 * Returns error when raw is empty/whitespace-only or `@me` cannot be resolved.
 */
export function resolveAuthorFilter(
  raw: string,
  resolveMe?: ResolveAuthenticatedLogin | null,
): AuthorFilterResolveResult {
  const resolveAuthenticated = resolveMe ?? defaultResolveAuthenticatedLogin;
  const tokens = parseAuthorTokens(raw);
  if (tokens.length === 0) {
    return { error: "argument --author: expected a non-empty login (or @me)" };
  }

  let usedMe = false;
  let meLogin: string | null | undefined;
  const allow: string[] = [];
  const displayParts: string[] = [];

  for (const token of tokens) {
    if (token === "@me" || token.toLowerCase() === "@me") {
      usedMe = true;
      if (meLogin === undefined) {
        meLogin = resolveAuthenticated();
      }
      if (meLogin === null || meLogin.length === 0) {
        return {
          error:
            "argument --author: @me could not be resolved (gh api user --jq .login failed; authenticate gh or pass an explicit login)",
        };
      }
      allow.push(meLogin);
      displayParts.push(`@me (resolved -> ${meLogin})`);
    } else {
      allow.push(token);
      displayParts.push(token);
    }
  }

  // Dedup while preserving order
  const seen = new Set<string>();
  const allowLogins: string[] = [];
  for (const login of allow) {
    if (!seen.has(login)) {
      seen.add(login);
      allowLogins.push(login);
    }
  }

  return {
    filter: {
      raw,
      allowLogins,
      usedMe,
      display: displayParts.join(", "),
    },
  };
}

/**
 * Default `@me` resolution via live `gh` (not ghx — multi-arg api --jq; #2275 / #954).
 */
export function defaultResolveAuthenticatedLogin(): string | null {
  try {
    const result = spawnSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
    });
    if (result.status !== 0) {
      return null;
    }
    const text = String(result.stdout ?? "").trim();
    if (text.length === 0) {
      return null;
    }
    // jq may emit a JSON string with quotes; strip surrounding quotes when present
    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))
    ) {
      return text.slice(1, -1);
    }
    return text;
  } catch {
    return null;
  }
}

/** Login from a CachedIssue.author string (empty = unknown). */
export function normalizeAuthorLogin(login: string | null | undefined): string | null {
  if (login === null || login === undefined) {
    return null;
  }
  const trimmed = login.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Login from a raw cache payload (author.login / user.login / string author).
 * Empty / missing → null (unknown).
 */
export function authorLoginFromRawIssue(
  issue: Record<string, unknown> | null | undefined,
): string | null {
  if (issue === null || issue === undefined) {
    return null;
  }
  return normalizeAuthorLogin(extractAuthor(issue));
}

/** Exact allow-list match (bulk parity). Unknown/missing never matches. */
export function matchesAuthorFilter(
  login: string | null | undefined,
  filter: AuthorFilter,
): boolean {
  const normalized = normalizeAuthorLogin(login);
  if (normalized === null) {
    return false;
  }
  return filter.allowLogins.includes(normalized);
}

/**
 * Partition items by author filter. Unknown (missing login) counted separately
 * and excluded from matched — callers disclose unknownCount in headers.
 */
export function partitionByAuthorFilter<T>(
  items: readonly T[],
  getLogin: (item: T) => string | null | undefined,
  filter: AuthorFilter,
): AuthorPartitionResult<T> {
  const matched: T[] = [];
  let unknownCount = 0;
  let nonMatchingCount = 0;
  for (const item of items) {
    const login = normalizeAuthorLogin(getLogin(item));
    if (login === null) {
      unknownCount += 1;
      continue;
    }
    if (filter.allowLogins.includes(login)) {
      matched.push(item);
    } else {
      nonMatchingCount += 1;
    }
  }
  return { matched, unknownCount, nonMatchingCount };
}

/** Single-line header fragment for queue / classify digest. */
export function formatAuthorFilterLine(
  filter: AuthorFilter,
  options: { readonly unknownCount?: number } = {},
): string {
  const unknown = options.unknownCount ?? 0;
  const unknownPart =
    unknown > 0 ? `; ${unknown} cached issue(s) missing author (unknown — excluded)` : "";
  return `author filter: ${filter.display}${unknownPart}`;
}
