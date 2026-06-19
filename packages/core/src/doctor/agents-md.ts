import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_MANAGED_CLOSE } from "./constants.js";
import { resolveDefaultFrameworkRoot } from "./paths.js";

const AGENTS_MANAGED_OPEN_SINGLE = /<!--\s*deft:managed-section\s+v(1|2|3)(?:\s+([^>]*?))?\s*-->/;
const AGENTS_MANAGED_OPEN_V3_LITERAL = "<!-- deft:managed-section v3 -->";

export interface AgentsMdSeams {
  readonly frameworkRoot?: string;
  readonly readTemplate?: () => string | null;
  readonly resolveSha?: () => string;
  readonly nowIso?: () => string;
  readonly newSession?: () => string;
  readonly readAgents?: (path: string) => string | null;
}

function frameworkRoot(seams: AgentsMdSeams = {}): string {
  return seams.frameworkRoot ?? resolveDefaultFrameworkRoot();
}

function readAgentsTemplate(seams: AgentsMdSeams = {}): string | null {
  if (seams.readTemplate) {
    return seams.readTemplate();
  }
  const candidate = join(frameworkRoot(seams), "templates", "agents-entry.md");
  try {
    if (!existsSync(candidate)) {
      return null;
    }
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

function resolveFrameworkSha(seams: AgentsMdSeams = {}): string {
  if (seams.resolveSha) {
    return seams.resolveSha();
  }
  const root = frameworkRoot(seams);
  try {
    const proc = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    });
    if (proc.status !== 0) {
      return "unknown";
    }
    const sha = (proc.stdout ?? "").trim();
    return sha || "unknown";
  } catch {
    return "unknown";
  }
}

function stripManagedSectionAttrs(section: string): string {
  return section.replace(AGENTS_MANAGED_OPEN_SINGLE, AGENTS_MANAGED_OPEN_V3_LITERAL);
}

function renderManagedSection(templateText: string): string | null {
  const normalised = templateText.replace(/\r\n/g, "\n");
  const openMatch = AGENTS_MANAGED_OPEN_SINGLE.exec(normalised);
  if (!openMatch) {
    return null;
  }
  const openIdx = openMatch.index;
  const closeIdx = normalised.indexOf(AGENTS_MANAGED_CLOSE, openMatch.index + openMatch[0].length);
  if (closeIdx < 0) {
    return null;
  }
  const end = closeIdx + AGENTS_MANAGED_CLOSE.length;
  return stripManagedSectionAttrs(normalised.slice(openIdx, end));
}

function iterManagedSections(text: string): Array<[number, number, string]> {
  const results: Array<[number, number, string]> = [];
  let pos = 0;
  while (pos <= text.length) {
    const slice = text.slice(pos);
    const openMatch = AGENTS_MANAGED_OPEN_SINGLE.exec(slice);
    if (!openMatch) {
      break;
    }
    const absStart = pos + openMatch.index;
    const closeIdx = text.indexOf(AGENTS_MANAGED_CLOSE, absStart + openMatch[0].length);
    if (closeIdx < 0) {
      break;
    }
    const end = closeIdx + AGENTS_MANAGED_CLOSE.length;
    results.push([absStart, end, text.slice(absStart, end)]);
    pos = end;
  }
  return results;
}

function parseManagedSectionAttrs(extracted: string): { version: number } | null {
  const match = AGENTS_MANAGED_OPEN_SINGLE.exec(extracted);
  if (!match?.[1]) {
    return null;
  }
  return { version: Number(match[1]) };
}

function attributeRenderManagedSection(
  rendered: string,
  attrs: { frameworkSha: string; refreshed: string; sessionId: string },
): string {
  const attrString = `v3 sha=${attrs.frameworkSha} refreshed=${attrs.refreshed} session=${attrs.sessionId}`;
  const attributedOpen = `<!-- deft:managed-section ${attrString} -->`;
  return rendered.replace(AGENTS_MANAGED_OPEN_V3_LITERAL, attributedOpen);
}

function wrapLegacyInMarkers(existing: string, rendered: string): string {
  const body = existing.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (body) {
    return `${body}\n\n${rendered}\n`;
  }
  return `${rendered}\n`;
}

/** Compute AGENTS.md managed-section freshness plan (mirrors scripts/_agents_md.py). */
export function agentsRefreshPlan(
  projectRoot: string,
  seams: AgentsMdSeams = {},
): Record<string, unknown> {
  const readTemplate = seams.readTemplate ?? (() => readAgentsTemplate(seams));
  const resolveSha = seams.resolveSha ?? (() => resolveFrameworkSha(seams));
  const nowIso = seams.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const newSession = seams.newSession ?? (() => randomUUID().replace(/-/g, "").slice(0, 12));
  const readAgents =
    seams.readAgents ??
    ((path: string) => {
      try {
        if (!existsSync(path)) {
          return null;
        }
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });

  const templateText = readTemplate();
  if (templateText === null) {
    return {
      state: "template-missing",
      path: join(projectRoot, "AGENTS.md"),
      rendered: null,
      existing: null,
      new_content: null,
    };
  }
  const rendered = renderManagedSection(templateText);
  if (rendered === null) {
    return {
      state: "template-malformed",
      path: join(projectRoot, "AGENTS.md"),
      rendered: null,
      existing: null,
      new_content: null,
    };
  }
  const frameworkSha = resolveSha();
  const refreshed = nowIso();
  const sessionId = newSession();
  const attributedRendered = attributeRenderManagedSection(rendered, {
    frameworkSha,
    refreshed,
    sessionId,
  });
  const agentsMd = join(projectRoot, "AGENTS.md");
  let existing: string | null;
  try {
    existing = readAgents(agentsMd);
  } catch (exc) {
    return {
      state: "unreadable",
      path: agentsMd,
      rendered,
      existing: null,
      new_content: null,
      error: String(exc),
    };
  }
  if (existing === null) {
    return {
      state: "absent",
      path: agentsMd,
      rendered,
      attributed_rendered: attributedRendered,
      sha: frameworkSha,
      refreshed,
      session: sessionId,
      existing: null,
      new_content: `${attributedRendered}\n`,
    };
  }
  const normalised = existing.replace(/\r\n/g, "\n");
  const blocks = iterManagedSections(normalised);
  if (blocks.length === 0) {
    return {
      state: "missing",
      path: agentsMd,
      rendered,
      attributed_rendered: attributedRendered,
      sha: frameworkSha,
      refreshed,
      session: sessionId,
      existing,
      new_content: wrapLegacyInMarkers(normalised, attributedRendered),
    };
  }
  if (blocks.length > 1) {
    const firstStart = blocks[0]?.[0] ?? 0;
    let newContent = normalised;
    for (const [start, end] of [...blocks].reverse()) {
      newContent = newContent.slice(0, start) + newContent.slice(end);
    }
    newContent =
      newContent.slice(0, firstStart) + attributedRendered + newContent.slice(firstStart);
    return {
      state: "stale",
      path: agentsMd,
      rendered,
      attributed_rendered: attributedRendered,
      sha: frameworkSha,
      refreshed,
      session: sessionId,
      existing,
      new_content: newContent,
    };
  }
  const extracted = blocks[0]?.[2] ?? "";
  const extractedAttrs = parseManagedSectionAttrs(extracted);
  const isLegacyMarker = extractedAttrs !== null && [1, 2].includes(extractedAttrs.version);
  if (!isLegacyMarker && stripManagedSectionAttrs(extracted) === rendered) {
    return {
      state: "current",
      path: agentsMd,
      rendered,
      existing,
      new_content: existing,
    };
  }
  const newContent = normalised.replace(extracted, attributedRendered);
  return {
    state: "stale",
    path: agentsMd,
    rendered,
    attributed_rendered: attributedRendered,
    sha: frameworkSha,
    refreshed,
    session: sessionId,
    existing,
    new_content: newContent,
  };
}

export function hasV3ManagedMarker(projectRoot: string, readText = defaultReadAgents): boolean {
  const agentsMd = join(projectRoot, "AGENTS.md");
  const text = readText(agentsMd);
  if (text === null) {
    return false;
  }
  return /<!--\s*deft:managed-section\s+v3(?:\s+[^>]*?)?\s*-->/.test(text);
}

function defaultReadAgents(path: string): string | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
