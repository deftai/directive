/**
 * Typed plan.policy.forgeOutageRetryMinutes (#3422).
 *
 * Re-probe interval after a forge / SCM API outage drop-back.
 * Precedence: USER.md Personal > project policy > framework default 30.
 * Integer minutes, minimum 5.
 */

import { readFileSync } from "node:fs";
import { resolveUserMdPath } from "../user-config/resolve-user-md.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_FORGE_OUTAGE_RETRY_MINUTES = "plan.policy.forgeOutageRetryMinutes";
export const FIELD_FORGE_OUTAGE_RETRY_MINUTES_CLI_ALIAS = "forgeOutageRetryMinutes";

export const DEFAULT_FORGE_OUTAGE_RETRY_MINUTES = 30;
export const MIN_FORGE_OUTAGE_RETRY_MINUTES = 5;

export type ForgeOutageRetrySource = "user-md" | "typed" | "default" | "default-on-error";

export interface ForgeOutageRetryResolved {
  readonly minutes: number;
  readonly source: ForgeOutageRetrySource;
  readonly error: string | null;
}

export interface ForgeOutageRetryPolicyField {
  readonly name: typeof FIELD_FORGE_OUTAGE_RETRY_MINUTES;
  readonly current: number;
  readonly default: number;
  readonly source: string;
}

export interface ResolveForgeOutageRetryOptions {
  readonly projectRoot?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly userMdText?: string | null;
}

/** Validate a raw integer-minutes value. */
export function validateForgeOutageRetryMinutes(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return (
      `${FIELD_FORGE_OUTAGE_RETRY_MINUTES} must be an integer >= ` +
      `${MIN_FORGE_OUTAGE_RETRY_MINUTES}; got ${typeof raw}`
    );
  }
  if (raw < MIN_FORGE_OUTAGE_RETRY_MINUTES) {
    return (
      `${FIELD_FORGE_OUTAGE_RETRY_MINUTES} must be >= ` +
      `${MIN_FORGE_OUTAGE_RETRY_MINUTES}; got ${raw}`
    );
  }
  return null;
}

/**
 * Parse USER.md Personal forge-outage retry minutes.
 *
 * Accepts `forgeOutageRetryMinutes: 15` or `Forge outage retry: 15m`.
 */
export function parseForgeOutageRetryMinutesFromUserMd(text: string): number | null {
  const lines = text.split(/\r?\n/);
  let inPersonal = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+personal\b/i.test(trimmed)) {
      inPersonal = true;
      continue;
    }
    if (inPersonal && /^##\s+/.test(trimmed)) {
      break;
    }
    if (!inPersonal) continue;
    const stripped = trimmed.replace(/\*\*/g, "").replace(/^-\s*/, "");
    const keyed = stripped.match(/^forgeOutageRetryMinutes\s*:\s*(.+)$/i);
    const labeled = stripped.match(/^Forge outage retry\s*:\s*(.+)$/i);
    const raw = keyed?.[1] ?? labeled?.[1];
    if (raw === undefined) continue;
    const parsed = parseMinutesToken(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseMinutesToken(raw: string): number | null {
  const token = raw.replace(/\*\*/g, "").trim();
  const match = token.match(/^(\d+)\s*(?:m(?:in(?:ute)?s?)?)?$/i);
  if (match?.[1] === undefined) return null;
  const minutes = Number(match[1]);
  if (!Number.isInteger(minutes)) return null;
  return minutes;
}

function readUserMdText(options: ResolveForgeOutageRetryOptions): string | null {
  if (options.userMdText !== undefined) {
    return options.userMdText;
  }
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolved = resolveUserMdPath({
    projectRoot,
    env: options.env ?? process.env,
  });
  if (!resolved.found) return null;
  try {
    return readFileSync(resolved.path, { encoding: "utf8" });
  } catch {
    return null;
  }
}

function readProjectMinutes(projectRoot: string): {
  readonly present: boolean;
  readonly minutes: number | null;
  readonly error: string | null;
} {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { present: false, minutes: null, error: err };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("forgeOutageRetryMinutes" in policyBlock)
  ) {
    return { present: false, minutes: null, error: null };
  }
  const raw = (policyBlock as Record<string, unknown>).forgeOutageRetryMinutes;
  if (raw === null) {
    return { present: false, minutes: null, error: null };
  }
  const validationError = validateForgeOutageRetryMinutes(raw);
  if (validationError !== null) {
    return { present: true, minutes: null, error: validationError };
  }
  return { present: true, minutes: raw as number, error: null };
}

/**
 * Resolve forge-outage re-probe minutes (#3422).
 *
 * 1. Valid USER.md Personal value
 * 2. Valid plan.policy.forgeOutageRetryMinutes
 * 3. Framework default 30
 */
export function resolveForgeOutageRetryMinutes(
  options: ResolveForgeOutageRetryOptions = {},
): ForgeOutageRetryResolved {
  const userMdText = readUserMdText(options);
  if (userMdText !== null) {
    const personal = parseForgeOutageRetryMinutesFromUserMd(userMdText);
    if (personal !== null) {
      const personalError = validateForgeOutageRetryMinutes(personal);
      if (personalError === null) {
        return { minutes: personal, source: "user-md", error: null };
      }
    }
  }

  const projectRoot = options.projectRoot;
  if (projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0) {
    const project = readProjectMinutes(projectRoot);
    if (project.minutes !== null) {
      return { minutes: project.minutes, source: "typed", error: null };
    }
    if (project.present && project.error !== null) {
      return {
        minutes: DEFAULT_FORGE_OUTAGE_RETRY_MINUTES,
        source: "default-on-error",
        error: project.error,
      };
    }
  }

  return {
    minutes: DEFAULT_FORGE_OUTAGE_RETRY_MINUTES,
    source: "default",
    error: null,
  };
}

/** Inspector row for `task policy:show --field=forgeOutageRetryMinutes`. */
export function inspectForgeOutageRetryMinutes(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): ForgeOutageRetryPolicyField {
  const resolved = resolveForgeOutageRetryMinutes({ projectRoot });
  return {
    name: FIELD_FORGE_OUTAGE_RETRY_MINUTES,
    current: resolved.minutes,
    default: DEFAULT_FORGE_OUTAGE_RETRY_MINUTES,
    source: resolved.source,
  };
}
