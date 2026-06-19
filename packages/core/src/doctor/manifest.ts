import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseManifestKeyValueLine, stripEdgeQuotes } from "../text/redos-safe.js";
import { readTextSafe } from "./paths.js";

export function parseManifest(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const row = parseManifestKeyValueLine(line);
    if (row === null) {
      continue;
    }
    parsed[row.key] = row.value;
  }
  return parsed;
}

export function parseInstallManifest(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped || !stripped.includes(":")) {
      continue;
    }
    const colon = stripped.indexOf(":");
    const k = stripped.slice(0, colon).trim();
    let v = stripped.slice(colon + 1).trim();
    v = stripEdgeQuotes(v);
    if (k) {
      data[k] = v;
    }
  }
  return data;
}

export function manifestTagToVersion(manifest: Record<string, string>): string | null {
  for (const key of ["tag", "ref"]) {
    const raw = manifest[key];
    if (typeof raw !== "string") {
      continue;
    }
    const candidate = raw.trim().replace(/^v/, "");
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

export function manifestCandidatePaths(projectRoot: string, installRoot: string | null): string[] {
  const raw: string[] = [];
  if (installRoot) {
    raw.push(join(projectRoot, installRoot, "VERSION"));
  }
  raw.push(join(projectRoot, ".deft", "core", "VERSION"));
  raw.push(join(projectRoot, ".deft", "VERSION"));
  raw.push(join(projectRoot, "deft", "VERSION"));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of raw) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      ordered.push(candidate);
    }
  }
  return ordered;
}

export function locateManifest(
  projectRoot: string,
  installRoot: string | null,
  isFile: (p: string) => boolean = existsSync,
): string | null {
  for (const candidate of manifestCandidatePaths(projectRoot, installRoot)) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

const INSTALLED_IN_RE = /Deft is installed in\s+(\S+?)\/?\./;
const FULL_GUIDELINES_RE = /Full guidelines:\s+(\S+)\/main\.md/;

export function parseInstallRootFromAgentsMd(text: string): string | null {
  let match = INSTALLED_IN_RE.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  match = FULL_GUIDELINES_RE.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  return null;
}

const AGENTS_MANAGED_OPEN_RE = /<!--\s*deft:managed-section\s+v(2|3)(?:\s+([^>]*?))?\s*-->/;

export function extractManagedSection(text: string): string | null {
  const normalised = text.replace(/\r\n/g, "\n");
  const openMatch = AGENTS_MANAGED_OPEN_RE.exec(normalised);
  if (!openMatch) {
    return null;
  }
  const openIdx = openMatch.index;
  const closeIdx = normalised.indexOf(
    "<!-- /deft:managed-section -->",
    openMatch.index + openMatch[0].length,
  );
  if (closeIdx < 0) {
    return null;
  }
  const end = closeIdx + "<!-- /deft:managed-section -->".length;
  return normalised.slice(openIdx, end);
}

export function isDeprecationRedirectStub(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").trimStart().split("\n");
  const sentinels = new Set([
    "<!-- deft:deprecated-redirect -->",
    "<!-- deft:deprecated-skill-redirect -->",
  ]);
  return lines.slice(0, 8).some((line) => sentinels.has(line.trim()));
}

export function readManifestAt(path: string | null, readText = readTextSafe): string | null {
  if (!path) {
    return null;
  }
  return readText(path);
}
