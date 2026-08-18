/**
 * Shared workspace session identity for run-summary emitters (#3399).
 *
 * Ritual-state holds the workspace session id written by session:start.
 * #3350 persisted seq by counting JSONL lines; it is not the identity store.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRitualState } from "../session/ritual-sentinel.js";
import { resolveRunSummaryDestination } from "./path.js";
import { parseRunSummaryJsonl } from "./share.js";

export interface ResolveRunSummarySessionIdInput {
  readonly projectRoot: string;
  readonly explicit?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly mint?: () => string;
}

const mintedByProjectRoot = new Map<string, string>();

function trimNonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function lastSessionIdFromJsonl(path: string): string | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    const lines = parseRunSummaryJsonl(readFileSync(path, "utf8"));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const id = trimNonEmpty(lines[i]?.session_id);
      if (id !== undefined) {
        return id;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function ritualSessionId(projectRoot: string): string | undefined {
  try {
    const [state] = readRitualState(projectRoot);
    return trimNonEmpty(state?.sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Resolve one workspace session id for a run-summary line.
 *
 * Order: explicit option → DEFT_SESSION_ID → ritual-state session_id →
 * last session_id already in the destination JSONL → mint only when no
 * workspace session exists yet.
 */
export function resolveRunSummarySessionId(input: ResolveRunSummarySessionIdInput): string {
  const explicit = trimNonEmpty(input.explicit);
  if (explicit !== undefined) {
    return explicit;
  }

  const env = input.env ?? process.env;
  const fromEnv = trimNonEmpty(env.DEFT_SESSION_ID);
  if (fromEnv !== undefined) {
    return fromEnv;
  }

  const fromRitual = ritualSessionId(input.projectRoot);
  if (fromRitual !== undefined) {
    return fromRitual;
  }

  const dest = resolveRunSummaryDestination(input.projectRoot, { env });
  if (dest.kind === "file") {
    const fromJsonl = lastSessionIdFromJsonl(dest.path);
    if (fromJsonl !== undefined) {
      return fromJsonl;
    }
  }

  const rootKey = resolve(input.projectRoot);
  if (input.mint !== undefined) {
    const minted = trimNonEmpty(input.mint());
    if (minted !== undefined) {
      mintedByProjectRoot.set(rootKey, minted);
      return minted;
    }
  }
  const cached = mintedByProjectRoot.get(rootKey);
  if (cached !== undefined) {
    return cached;
  }
  const minted = randomUUID();
  mintedByProjectRoot.set(rootKey, minted);
  return minted;
}
