/** Linear-time helpers replacing CodeQL-flagged polynomial regexes (#1810). */

const WS = /\s/;

function isRootPathChar(ch: string): boolean {
  return /[\w./-]/.test(ch);
}

function isSkillNameStart(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

function isSkillNameChar(ch: string): boolean {
  return (
    isSkillNameStart(ch) ||
    ch === "_" ||
    (ch >= "0" && ch <= "9") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "-"
  );
}

/** Equivalent of ``value.replace(/[\\/]+$/, "")`` without backtracking. */
export function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1] as string;
    if (ch === "/" || ch === "\\") {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

/** Equivalent of ``value.replace(/^['"]|['"]$/g, "")`` without backtracking. */
export function stripEdgeQuotes(value: string): string {
  let result = value;
  if (result.length > 0 && (result[0] === '"' || result[0] === "'")) {
    result = result.slice(1);
  }
  if (result.length > 0) {
    const last = result[result.length - 1] as string;
    if (last === '"' || last === "'") {
      result = result.slice(0, -1);
    }
  }
  return result;
}

/**
 * Expand compact JSON structural ``:`` / ``,`` to Python ``json.dumps`` spacing
 * without touching separators inside string literals.
 */
export function expandPythonJsonSeparators(compactJson: string): string {
  let out = "";
  let i = 0;
  while (i < compactJson.length) {
    const ch = compactJson[i] as string;
    if (ch === '"') {
      out += '"';
      i += 1;
      let escaped = false;
      while (i < compactJson.length) {
        const current = compactJson[i] as string;
        out += current;
        i += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === ":") {
      out += ": ";
      i += 1;
      continue;
    }
    if (ch === ",") {
      out += ", ";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Mirrors ``^(#{1,6})\s+(.*\S.*)$`` without polynomial backtracking. */
export function parseMarkdownHeading(line: string): { hashes: string; text: string } | null {
  if (!line.startsWith("#")) {
    return null;
  }
  let i = 0;
  while (i < line.length && i < 6 && line[i] === "#") {
    i += 1;
  }
  if (i === 0 || i > 6) {
    return null;
  }
  const hashes = line.slice(0, i);
  if (i === line.length) {
    return null;
  }
  while (i < line.length && WS.test(line[i] as string)) {
    i += 1;
  }
  if (i === line.length) {
    return null;
  }
  const text = line.slice(i);
  let hasNonWs = false;
  for (const ch of text) {
    if (!WS.test(ch)) {
      hasNonWs = true;
      break;
    }
  }
  if (!hasNonWs) {
    return null;
  }
  return { hashes, text };
}

/** Mirrors doctor ``_SKILL_PATH_RE`` without non-greedy backtracking. */
export function findSkillPathsInText(text: string): string[] {
  const found = new Set<string>();
  const marker = "/skills/";
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf(marker, pos);
    if (idx < 0) {
      break;
    }
    let start = idx;
    while (start > 0 && isRootPathChar(text[start - 1] as string)) {
      start -= 1;
    }
    const nameStart = idx + marker.length;
    if (nameStart >= text.length || !isSkillNameStart(text[nameStart] as string)) {
      pos = idx + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < text.length && isSkillNameChar(text[nameEnd] as string)) {
      nameEnd += 1;
    }
    const suffix = "/SKILL.md";
    if (text.slice(nameEnd, nameEnd + suffix.length) !== suffix) {
      pos = idx + 1;
      continue;
    }
    found.add(text.slice(start, nameEnd + suffix.length));
    pos = idx + 1;
  }
  return [...found];
}

const LAST_REVIEWED_PREFIX = "Last reviewed commit:";

function readHexSha(body: string, start: number): { sha: string; end: number } | null {
  let sha = "";
  let i = start;
  while (i < body.length) {
    const ch = body[i] as string;
    const lower = ch.toLowerCase();
    const isHex = (lower >= "0" && lower <= "9") || (lower >= "a" && lower <= "f");
    if (!isHex) {
      break;
    }
    sha += lower;
    i += 1;
  }
  if (sha.length < 7 || sha.length > 40) {
    return null;
  }
  return { sha, end: i };
}

/** Return the last Greptile ``Last reviewed commit:`` SHA (linear scan). */
export function findLastReviewedCommitSha(body: string): string | null {
  let lastSha: string | null = null;
  let searchFrom = 0;
  while (true) {
    const idx = body.indexOf(LAST_REVIEWED_PREFIX, searchFrom);
    if (idx < 0) {
      break;
    }
    let i = idx + LAST_REVIEWED_PREFIX.length;
    while (i < body.length && WS.test(body[i] as string)) {
      i += 1;
    }
    if (body[i] !== "[") {
      searchFrom = idx + 1;
      continue;
    }
    i += 1;
    while (i < body.length && body[i] !== "]") {
      i += 1;
    }
    if (i >= body.length || body[i] !== "]") {
      searchFrom = idx + 1;
      continue;
    }
    i += 1;
    if (body[i] !== "(") {
      searchFrom = idx + 1;
      continue;
    }
    i += 1;
    const http = "http://github.com/";
    const https = "https://github.com/";
    let matched = false;
    if (body.startsWith(https, i)) {
      i += https.length;
      matched = true;
    } else if (body.startsWith(http, i)) {
      i += http.length;
      matched = true;
    }
    if (!matched) {
      searchFrom = idx + 1;
      continue;
    }
    let slashes = 0;
    while (slashes < 3 && i < body.length) {
      const slash = body.indexOf("/", i);
      if (slash < 0) {
        break;
      }
      i = slash + 1;
      slashes += 1;
    }
    if (slashes < 3) {
      searchFrom = idx + 1;
      continue;
    }
    const shaRead = readHexSha(body, i);
    if (shaRead !== null) {
      lastSha = shaRead.sha;
    }
    searchFrom = idx + 1;
  }
  return lastSha;
}

/** Parse a single manifest ``key: value`` line (linear; mirrors MANIFEST_LINE_RE). */
export function parseManifestKeyValueLine(line: string): { key: string; value: string } | null {
  const stripped = line.trim();
  if (!stripped || stripped.startsWith("#")) {
    return null;
  }
  const colon = stripped.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const rawKey = stripped.slice(0, colon).trim();
  if (!rawKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) {
    return null;
  }
  const value = stripEdgeQuotes(stripped.slice(colon + 1).trim());
  return { key: rawKey.toLowerCase(), value };
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function parseBareRepoSlug(trimmed: string): string | null {
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const owner = trimmed.slice(0, slash);
  const repo = trimmed.slice(slash + 1);
  if (owner.includes(" ") || repo.includes(" ") || owner.includes("/") || repo.includes("/")) {
    return null;
  }
  return `${owner}/${repo}`;
}

function parseGitAtSlug(trimmed: string): string | null {
  const prefix = "git@github.com:";
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  let rest = stripTrailingPathSeparators(trimmed.slice(prefix.length));
  if (rest.endsWith(".git")) {
    rest = rest.slice(0, -4);
  }
  const space = rest.search(/\s/);
  if (space >= 0) {
    rest = rest.slice(0, space);
  }
  return parseBareRepoSlug(rest);
}

function parseGitHubUrlSlug(trimmed: string): string | null {
  try {
    const url = new URL(trimmed);
    if (!GITHUB_HOSTS.has(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }
    let repo = parts[1];
    if (repo.endsWith(".git")) {
      repo = repo.slice(0, -4);
    }
    return `${parts[0]}/${repo}`;
  } catch {
    return null;
  }
}

/** Accept OWNER/NAME or a GitHub remote URL with strict host checks. */
export function parseGitHubRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const gitAt = parseGitAtSlug(trimmed);
  if (gitAt !== null) {
    return gitAt;
  }
  if (trimmed.includes("://") || trimmed.startsWith("git@")) {
    return parseGitHubUrlSlug(trimmed);
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/** Infer owner/name from a git remote URL (strict github.com host; no substring checks). */
export function parseGitHubRemoteRepo(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let cleaned = stripTrailingPathSeparators(trimmed);
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }
  return parseGitHubRepoSlug(cleaned);
}
