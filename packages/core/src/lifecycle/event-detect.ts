import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentRoot } from "../content-root.js";
import { findSkillPathsInText } from "../text/redos-safe.js";

/** Sentinel used by SKILL.md redirect stubs. */
export const DEPRECATED_SKILL_REDIRECT_SENTINEL = "<!-- deft:deprecated-skill-redirect -->";

const SKILL_SENTINEL_WINDOW = 200;
const MAX_PAYLOAD_LIST_LEN = 50;

let registryCache: Record<string, unknown> | null = null;

function defaultRegistryPath(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  // #1875: the event registry is shippable content (content/events/ in source,
  // flattened to events/ in a consumer deposit).
  return join(contentRoot(repoRoot), "events", "registry.json");
}

export class EventEmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventEmissionError";
  }
}

/** Reset the in-process registry cache. Used by tests. */
export function clearRegistryCache(): void {
  registryCache = null;
}

/** Return the parsed event registry. Cached after first call. */
export function loadRegistry(registryPath?: string): Record<string, unknown> {
  const path = registryPath ?? defaultRegistryPath();
  if (registryPath === undefined && registryCache !== null) {
    return registryCache;
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (registryPath === undefined) {
    registryCache = data;
  }
  return data;
}

/** Return the set of canonical event names in the registry. */
export function registeredEventNames(registryPath?: string): Set<string> {
  const registry = loadRegistry(registryPath);
  const events = registry.events;
  if (!Array.isArray(events)) {
    return new Set();
  }
  const names = new Set<string>();
  for (const evt of events) {
    if (typeof evt === "object" && evt !== null && !Array.isArray(evt)) {
      const name = (evt as Record<string, unknown>).name;
      if (typeof name === "string") {
        names.add(name);
      }
    }
  }
  return names;
}

/** UTC ISO-8601 timestamp at seconds precision. */
export function nowUtcIso(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 19)}Z`;
}

function coercePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value) && value.length > MAX_PAYLOAD_LIST_LEN) {
      coerced[key] = value.slice(0, MAX_PAYLOAD_LIST_LEN);
    } else {
      coerced[key] = value;
    }
  }
  return coerced;
}

export interface EventRecord {
  readonly event: string;
  readonly detected_at: string;
  readonly payload: Record<string, unknown>;
}

/** Build a uniform event record and optionally append it to a log file. */
export function emit(
  name: string,
  payload: Record<string, unknown> | null = null,
  options: { registryPath?: string; logPathEnv?: string } = {},
): EventRecord {
  const registryPath = options.registryPath;
  const logPathEnv = options.logPathEnv ?? "DEFT_EVENT_LOG";
  const body = payload ?? {};
  if (!registeredEventNames(registryPath).has(name)) {
    throw new EventEmissionError(
      `Event '${name}' is not registered in events/registry.json. Add it to the registry before emitting.`,
    );
  }
  const record: EventRecord = {
    event: name,
    detected_at: nowUtcIso(),
    payload: coercePayload(body),
  };

  const logTarget = process.env[logPathEnv];
  if (logTarget !== undefined && logTarget.length > 0) {
    try {
      const logPath = resolve(logTarget);
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Swallow log-write failures.
    }
  }

  return record;
}

/** Return an agents-md:stale payload if AGENTS.md references stale paths. */
export function detectAgentsMdStale(
  projectRoot: string,
  options: { frameworkRoot?: string } = {},
): Record<string, string | string[]> | null {
  const agentsMd = join(resolve(projectRoot), "AGENTS.md");
  if (!existsSync(agentsMd)) {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(agentsMd, "utf8");
  } catch {
    return null;
  }

  const framework =
    options.frameworkRoot !== undefined
      ? resolve(options.frameworkRoot)
      : join(resolve(projectRoot), "deft");
  const missingPaths: string[] = [];
  const redirectPaths: string[] = [];
  const seen = new Set<string>();

  for (const token of findSkillPathsInText(content)) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    const parts = token.split("/");
    const slug = parts[2];
    if (slug === undefined) {
      continue;
    }
    // #1875: skills are shippable content (content/skills/ in source, flattened
    // to skills/ in a consumer deposit).
    const candidate = join(contentRoot(framework), "skills", slug, "SKILL.md");
    if (!existsSync(candidate)) {
      missingPaths.push(token);
      continue;
    }
    try {
      const head = readFileSync(candidate, "utf8").slice(0, SKILL_SENTINEL_WINDOW);
      if (head.includes(DEPRECATED_SKILL_REDIRECT_SENTINEL)) {
        redirectPaths.push(token);
      }
    } catch {
      missingPaths.push(token);
    }
  }

  if (missingPaths.length === 0 && redirectPaths.length === 0) {
    return null;
  }

  return {
    agents_md_path: resolve(agentsMd),
    missing_paths: missingPaths,
    redirect_paths: redirectPaths,
  };
}

/** Build a framework:remote-drift payload from a probe result. */
export function detectRemoteDrift(
  projectRoot: string,
  options: { probeResult?: Record<string, unknown> | null } = {},
): Record<string, unknown> | null {
  const probeResult = options.probeResult ?? null;
  if (probeResult === null) {
    return null;
  }
  if (probeResult.status !== "behind") {
    return null;
  }
  return {
    commits_behind: probeResult.commits_behind ?? null,
    current_version: probeResult.current,
    project_root: resolve(projectRoot),
    remote_version: probeResult.remote,
    upstream_url: probeResult.upstream_url ?? "",
  };
}
