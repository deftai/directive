import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteText } from "../cache/io.js";
import { contentRoot } from "../content-root.js";
import { defaultGitRunner } from "../session/git.js";
import { type LockDeps, withAppendLock } from "../slice/lock.js";
import { composeGreenfieldAgentsMd } from "./agents-consumer-header.js";
import { AGENTS_MANAGED_CLOSE, AGENTS_MANAGED_OPEN_V3_LITERAL } from "./constants.js";
import { findManagedOpenMarker } from "./linear-scan.js";
import { payloadIsOwnGitRoot } from "./resolve-version.js";

export interface ManagedSectionAttrs {
  readonly version: number;
  readonly sha: string | null;
  readonly refreshed: string | null;
  readonly session: string | null;
  readonly extras: Record<string, string>;
}

export interface AgentsMdSeams {
  readonly frameworkRoot?: string;
  readonly readTemplate?: () => string | null;
  readonly resolveSha?: () => string;
  readonly nowIso?: () => string;
  readonly newSession?: () => string;
  readonly readAgents?: (path: string) => string | null;
}

/** Return the framework root (directory owning `templates/`). */
export function frameworkRoot(seams: AgentsMdSeams = {}): string {
  if (seams.frameworkRoot) return resolve(seams.frameworkRoot);
  const envRoot = process.env.DEFT_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    // #1875: templates/ moved under content/ in the source repo; the C1 flatten
    // deposits it at templates/ in a consumer install. Accept either layout.
    if (
      existsSync(join(dir, "content", "templates", "agents-entry.md")) ||
      existsSync(join(dir, "templates", "agents-entry.md"))
    )
      return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function agentsTemplatePath(seams: AgentsMdSeams = {}): string {
  // #1875: resolve through contentRoot so the template is found in both the
  // source checkout (content/templates/agents-entry.md) and the flattened
  // consumer deposit (templates/agents-entry.md). Mirrors scripts/_agents_md.py.
  return join(contentRoot(frameworkRoot(seams)), "templates", "agents-entry.md");
}

function readAgentsTemplate(seams: AgentsMdSeams = {}): string | null {
  if (seams.readTemplate) return seams.readTemplate();
  const candidate = agentsTemplatePath(seams);
  try {
    if (!existsSync(candidate)) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

function resolveFrameworkSha(seams: AgentsMdSeams = {}): string {
  if (seams.resolveSha) return seams.resolveSha();
  const root = frameworkRoot(seams);
  if (!payloadIsOwnGitRoot(root)) return "unknown";
  const result = defaultGitRunner(root, ["rev-parse", "--short=12", "HEAD"]);
  if (result.code !== 0) return "unknown";
  const sha = result.stdout.trim();
  return sha || "unknown";
}

function nowUtcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newSessionId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function parseManagedSectionAttrs(extracted: string): ManagedSectionAttrs | null {
  const open = findManagedOpenMarker(extracted, 0);
  if (open === null) return null;
  let result: ManagedSectionAttrs = {
    version: open.version,
    sha: null,
    refreshed: null,
    session: null,
    extras: {},
  };
  for (const rawPair of open.attrsRaw.split(/\s+/)) {
    const eq = rawPair.indexOf("=");
    if (eq < 0) continue;
    const key = rawPair.slice(0, eq).trim().toLowerCase();
    let value = rawPair.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (key === "sha") result = { ...result, sha: value };
    else if (key === "refreshed") result = { ...result, refreshed: value };
    else if (key === "session") result = { ...result, session: value };
    else result.extras[key] = value;
  }
  return result;
}

export function stripManagedSectionAttrs(section: string): string {
  const open = findManagedOpenMarker(section, 0);
  if (open === null) return section;
  return section.slice(0, open.start) + AGENTS_MANAGED_OPEN_V3_LITERAL + section.slice(open.end);
}

export function renderManagedSection(templateText: string): string | null {
  const normalised = templateText.replace(/\r\n/g, "\n");
  const open = findManagedOpenMarker(normalised, 0);
  if (open === null) return null;
  const closeIdx = normalised.indexOf(AGENTS_MANAGED_CLOSE, open.end);
  if (closeIdx < 0) return null;
  const end = closeIdx + AGENTS_MANAGED_CLOSE.length;
  return stripManagedSectionAttrs(normalised.slice(open.start, end));
}

export function extractManagedSection(text: string): string | null {
  const normalised = text.replace(/\r\n/g, "\n");
  const open = findManagedOpenMarker(normalised, 0);
  if (open === null) return null;
  const closeIdx = normalised.indexOf(AGENTS_MANAGED_CLOSE, open.end);
  if (closeIdx < 0) return null;
  const end = closeIdx + AGENTS_MANAGED_CLOSE.length;
  return normalised.slice(open.start, end);
}

export function iterManagedSections(text: string): Array<[number, number, string]> {
  const results: Array<[number, number, string]> = [];
  let pos = 0;
  while (pos <= text.length) {
    const open = findManagedOpenMarker(text, pos);
    if (open === null) break;
    const closeIdx = text.indexOf(AGENTS_MANAGED_CLOSE, open.end);
    if (closeIdx < 0) break;
    const end = closeIdx + AGENTS_MANAGED_CLOSE.length;
    results.push([open.start, end, text.slice(open.start, end)]);
    pos = end;
  }
  return results;
}

export function attributeRenderManagedSection(
  rendered: string,
  attrs: { frameworkSha: string; refreshed: string; sessionId: string },
): string {
  const attrString = `v3 sha=${attrs.frameworkSha} refreshed=${attrs.refreshed} session=${attrs.sessionId}`;
  const attributedOpen = `<!-- deft:managed-section ${attrString} -->`;
  return rendered.replace(AGENTS_MANAGED_OPEN_V3_LITERAL, attributedOpen);
}

function wrapLegacyInMarkers(existing: string, rendered: string): string {
  const body = existing.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (body) return `${body}\n\n${rendered}\n`;
  return `${rendered}\n`;
}

/** Compute AGENTS.md managed-section freshness plan (mirrors scripts/_agents_md.py). */
export function agentsRefreshPlan(
  projectRoot: string,
  seams: AgentsMdSeams = {},
): Record<string, unknown> {
  const readTemplate = seams.readTemplate ?? (() => readAgentsTemplate(seams));
  const resolveSha = seams.resolveSha ?? (() => resolveFrameworkSha(seams));
  const nowIso = seams.nowIso ?? nowUtcIso;
  const newSession = seams.newSession ?? newSessionId;
  const readAgents =
    seams.readAgents ??
    ((path: string) => {
      try {
        if (!existsSync(path)) return null;
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
      new_content: composeGreenfieldAgentsMd(attributedRendered, {
        frameworkRoot: frameworkRoot(seams),
      }),
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
      sha: frameworkSha,
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

/** Managed-section states whose plan yields a new AGENTS.md body to write. */
const AGENTS_REFRESH_WRITABLE_STATES: ReadonlySet<string> = new Set(["absent", "missing", "stale"]);

export interface ApplyAgentsRefreshOptions {
  /** Compute state only, never write — mirrors `agents:refresh --check`. */
  readonly check?: boolean;
  /** Compute the plan but skip the write — mirrors `agents:refresh --dry-run`. */
  readonly dryRun?: boolean;
}

export interface AgentsRefreshApplyResult {
  readonly state: string;
  readonly path: string;
  /** True only when the managed section was written to disk on this call. */
  readonly wrote: boolean;
  /** True when the plan produced writable `new_content` for a writable state. */
  readonly writable: boolean;
}

/**
 * Serialize the AGENTS.md managed-section read->compute->write behind an advisory
 * file lock and write atomically (temp file + rename), so concurrent
 * install/upgrade/migrate/refresh writers cannot clobber one another's `session=`
 * write or leave a partially-written file (#1329).
 *
 * Reuses the existing cross-process append lock (`withAppendLock`, keyed here on
 * the AGENTS.md path -> `AGENTS.md.lock`) and atomic writer (`atomicWriteText`)
 * rather than introducing a competing lock utility. The parallel
 * `projectDefinitionMutationLock` remains owned by #1260; a general lock helper is
 * deliberately not added here to avoid two competing mutation-lock utilities.
 */
export function applyAgentsRefresh(
  projectRoot: string,
  options: ApplyAgentsRefreshOptions = {},
  seams: AgentsMdSeams = {},
  lockDeps: LockDeps = {},
): AgentsRefreshApplyResult {
  const agentsMd = join(projectRoot, "AGENTS.md");
  return withAppendLock(
    agentsMd,
    () => {
      const plan = agentsRefreshPlan(projectRoot, seams);
      const state = String(plan.state ?? "unknown");
      const path = String(plan.path ?? agentsMd);
      const newContent = plan.new_content;
      if (
        options.check === true ||
        options.dryRun === true ||
        !AGENTS_REFRESH_WRITABLE_STATES.has(state) ||
        typeof newContent !== "string"
      ) {
        const writable =
          AGENTS_REFRESH_WRITABLE_STATES.has(state) && typeof newContent === "string";
        return { state, path, wrote: false, writable };
      }
      atomicWriteText(path, newContent, { projectRoot });
      return { state, path, wrote: true, writable: true };
    },
    lockDeps,
  );
}

export function hasV3ManagedMarker(
  projectRoot: string,
  readText: (path: string) => string | null = defaultReadAgents,
): boolean {
  const agentsMd = join(projectRoot, "AGENTS.md");
  const text = readText(agentsMd);
  if (text === null) return false;
  let pos = 0;
  while (pos < text.length) {
    const open = findManagedOpenMarker(text, pos);
    if (open === null) return false;
    if (open.version === 3) return true;
    pos = open.end;
  }
  return false;
}

function defaultReadAgents(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
