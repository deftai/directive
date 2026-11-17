/**
 * Typed plan.policy.operatorNotify (#6275).
 *
 * Channel that tells the operator when a worker stops on an operator-only step.
 * Precedence: USER.md Personal > project policy > framework default `off`.
 * Values are channel names only (`off` | `os`). A URL-shaped value is refused:
 * webhook endpoints are never read from tracked policy or USER.md.
 */

import { readFileSync } from "node:fs";
import { resolveUserMdPath } from "../user-config/resolve-user-md.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_OPERATOR_NOTIFY = "plan.policy.operatorNotify";

export const OPERATOR_NOTIFY_CHANNELS = ["off", "os"] as const;

export type OperatorNotifyChannel = (typeof OPERATOR_NOTIFY_CHANNELS)[number];

export const DEFAULT_OPERATOR_NOTIFY_CHANNEL: OperatorNotifyChannel = "off";

export type OperatorNotifySource = "user-md" | "typed" | "default" | "default-on-error";

export interface OperatorNotifyResolved {
  readonly channel: OperatorNotifyChannel;
  readonly source: OperatorNotifySource;
  readonly error: string | null;
}

export interface ResolveOperatorNotifyOptions {
  readonly projectRoot?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: USER.md text (null = no USER.md). */
  readonly userMdText?: string | null;
}

const URL_SHAPED = /(^[a-z][a-z0-9+.-]*:\/\/)|(^www\.)|(:\/\/)|(^[^\s/]+\.[a-z]{2,}\/)/i;

/** True when a raw channel value looks like a URL or endpoint. */
export function isUrlShapedChannelValue(raw: string): boolean {
  return URL_SHAPED.test(raw.trim());
}

/**
 * Validate a raw channel value. Returns null when valid, else a refusal message.
 */
export function validateOperatorNotifyChannel(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return `${FIELD_OPERATOR_NOTIFY} must be one of ${OPERATOR_NOTIFY_CHANNELS.join("|")}; got ${typeof raw}`;
  }
  if (isUrlShapedChannelValue(raw)) {
    return (
      `${FIELD_OPERATOR_NOTIFY} takes a channel name (${OPERATOR_NOTIFY_CHANNELS.join("|")}), ` +
      "never a URL; webhook endpoints are not read from plan.policy or USER.md (#6275)"
    );
  }
  const normalized = raw.trim().toLowerCase();
  if (!(OPERATOR_NOTIFY_CHANNELS as readonly string[]).includes(normalized)) {
    return `${FIELD_OPERATOR_NOTIFY} must be one of ${OPERATOR_NOTIFY_CHANNELS.join("|")}; got '${raw}'`;
  }
  return null;
}

function normalizeChannel(raw: string): OperatorNotifyChannel {
  return raw.trim().toLowerCase() as OperatorNotifyChannel;
}

/**
 * Read the raw `operatorNotify` value from the USER.md `## Personal` section.
 * Accepts `operatorNotify: os` or `Operator notify: os`.
 */
export function parseOperatorNotifyFromUserMd(text: string): string | null {
  let inPersonal = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^##\s+personal\b/i.test(trimmed)) {
      inPersonal = true;
      continue;
    }
    if (inPersonal && /^##\s+/.test(trimmed)) break;
    if (!inPersonal) continue;
    const stripped = trimmed.replace(/\*\*/g, "").replace(/`/g, "").replace(/^-\s*/, "");
    const match = stripped.match(/^(?:operatorNotify|Operator notify)\s*:\s*(.+)$/i);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

function readUserMdText(options: ResolveOperatorNotifyOptions): string | null {
  if (options.userMdText !== undefined) return options.userMdText;
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolved = resolveUserMdPath({ projectRoot, env: options.env ?? process.env });
  if (!resolved.found) return null;
  try {
    return readFileSync(resolved.path, { encoding: "utf8" });
  } catch {
    return null;
  }
}

function readProjectChannel(projectRoot: string): {
  readonly present: boolean;
  readonly raw: unknown;
} {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) return { present: false, raw: null };
  const policy = readPlanPolicy(data.plan);
  if (
    typeof policy !== "object" ||
    policy === null ||
    Array.isArray(policy) ||
    !("operatorNotify" in policy)
  ) {
    return { present: false, raw: null };
  }
  const raw = (policy as Record<string, unknown>).operatorNotify;
  if (raw === null) return { present: false, raw: null };
  return { present: true, raw };
}

/**
 * Resolve the operator-notify channel (#6275).
 *
 * 1. USER.md Personal `operatorNotify` (an invalid or URL-shaped value fails closed to `off`)
 * 2. `plan.policy.operatorNotify` (same validation)
 * 3. Default `off`
 */
export function resolveOperatorNotifyChannel(
  options: ResolveOperatorNotifyOptions = {},
): OperatorNotifyResolved {
  const userMdText = readUserMdText(options);
  if (userMdText !== null) {
    const personal = parseOperatorNotifyFromUserMd(userMdText);
    if (personal !== null) {
      const error = validateOperatorNotifyChannel(personal);
      if (error !== null) {
        return { channel: "off", source: "default-on-error", error };
      }
      return { channel: normalizeChannel(personal), source: "user-md", error: null };
    }
  }

  const projectRoot = options.projectRoot;
  if (projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0) {
    const project = readProjectChannel(projectRoot);
    if (project.present) {
      const error = validateOperatorNotifyChannel(project.raw);
      if (error !== null) {
        return { channel: "off", source: "default-on-error", error };
      }
      return {
        channel: normalizeChannel(project.raw as string),
        source: "typed",
        error: null,
      };
    }
  }

  return { channel: DEFAULT_OPERATOR_NOTIFY_CHANNEL, source: "default", error: null };
}
