/**
 * Check composition: verify:ac must not soft-skip after a same-session complete (#3357).
 *
 * "No story ever active this session" remains a legitimate skip.
 * "A story completed this session" targets xbrief/completed (most recent).
 * One remediation string when that target cannot be used.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { readRitualState } from "../session/ritual-sentinel.js";
import { parseTimestamp } from "../session/time.js";

/** One remediation when check cannot target the just-completed brief (#3357). */
export const SESSION_COMPLETED_AC_REMEDIATION =
  "Run task verify:ac -- xbrief/completed/<just-completed>.xbrief.json (a story completed this session; check must not soft-skip) (#3357)";

/** Project-relative marker written by scope:complete for this session (#3357). */
export const SESSION_COMPLETED_MARKER_REL = [".deft", "last-completed.json"] as const;

export interface SessionCompletedMarker {
  readonly path: string;
  readonly sessionId: string;
  readonly completedAt: string;
}

export type SessionCompletedAcTarget =
  | { readonly kind: "none" }
  | { readonly kind: "target"; readonly path: string }
  | { readonly kind: "cannot"; readonly message: string };

export interface ResolveSessionCompletedAcInput {
  readonly projectRoot: string;
  readonly sessionId?: string | null;
  readonly sessionStartedAt?: Date | null;
  readonly env?: NodeJS.ProcessEnv;
}

interface CompletedBriefCandidate {
  readonly path: string;
  readonly completedAtMs: number;
  readonly sessionId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function sessionCompletedMarkerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...SESSION_COMPLETED_MARKER_REL);
}

/** Persist the just-completed brief so check can fail closed if that file is unreadable. */
export function writeSessionCompletedMarker(
  projectRoot: string,
  marker: SessionCompletedMarker,
): void {
  const root = resolve(projectRoot);
  const target = sessionCompletedMarkerPath(root);
  containedWrite({
    root,
    target,
    data: `${JSON.stringify(marker, null, 2)}\n`,
    mode: "replace",
    mkdir: true,
  });
}

function readSessionCompletedMarker(
  projectRoot: string,
): SessionCompletedMarker | "invalid" | null {
  const path = sessionCompletedMarkerPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const rec = asRecord(parsed);
    const briefPath = typeof rec?.path === "string" ? rec.path.trim() : "";
    const sessionId = typeof rec?.sessionId === "string" ? rec.sessionId.trim() : "";
    const completedAt = typeof rec?.completedAt === "string" ? rec.completedAt.trim() : "";
    if (briefPath.length === 0 || sessionId.length === 0) {
      return "invalid";
    }
    return { path: briefPath, sessionId, completedAt };
  } catch {
    return "invalid";
  }
}

function resolveSession(input: ResolveSessionCompletedAcInput): {
  readonly sessionId: string | null;
  readonly startedAt: Date | null;
} {
  const env = input.env ?? process.env;
  const injected = input.sessionId?.trim() ?? "";
  if (injected.length > 0) {
    return { sessionId: injected, startedAt: input.sessionStartedAt ?? null };
  }
  const fromEnv = typeof env.DEFT_SESSION_ID === "string" ? env.DEFT_SESSION_ID.trim() : "";
  const [state] = readRitualState(resolve(input.projectRoot));
  const ritualId = state?.sessionId.trim() ?? "";
  const sessionId = fromEnv.length > 0 ? fromEnv : ritualId;
  // Do not pair DEFT_SESSION_ID with a different ritual-state startedAt.
  const ritualStartedAt =
    ritualId.length > 0 && ritualId === sessionId ? (state?.startedAt ?? null) : null;
  return {
    sessionId: sessionId.length > 0 ? sessionId : null,
    startedAt: input.sessionStartedAt ?? ritualStartedAt,
  };
}

function listCompletedBriefPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  for (const dirName of ["xbrief", "vbrief"]) {
    const completed = join(projectRoot, dirName, "completed");
    if (!existsSync(completed)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(completed)
        .filter((n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      paths.push(join(completed, name));
    }
  }
  return paths;
}

function readCompletedCandidate(path: string): CompletedBriefCandidate | "unreadable" {
  if (!existsSync(path)) {
    return "unreadable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "unreadable";
  }
  const data = asRecord(parsed);
  const plan = asRecord(data?.plan);
  const meta = asRecord(plan?.metadata);
  if (plan === null || meta === null) {
    return "unreadable";
  }
  const sessionRaw =
    typeof meta.completedSessionId === "string" ? meta.completedSessionId.trim() : "";
  const completedAt = parseTimestamp(meta.completedAt);
  return {
    path,
    completedAtMs: completedAt?.getTime() ?? 0,
    sessionId: sessionRaw.length > 0 ? sessionRaw : null,
  };
}

function isSameSession(
  candidate: CompletedBriefCandidate,
  sessionId: string | null,
  startedAt: Date | null,
): boolean {
  if (sessionId !== null && candidate.sessionId === sessionId) {
    return true;
  }
  // Timestamp fallback only for pre-#3357 briefs that never stamped a session id.
  // A brief stamped for a different session must not replace this session's target.
  if (
    candidate.sessionId === null &&
    startedAt !== null &&
    candidate.completedAtMs >= startedAt.getTime()
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve the just-completed brief for this session, if check must target it.
 */
export function resolveSessionCompletedVerifyAcTarget(
  input: ResolveSessionCompletedAcInput,
): SessionCompletedAcTarget {
  const projectRoot = resolve(input.projectRoot);
  const { sessionId, startedAt } = resolveSession(input);
  const marker = readSessionCompletedMarker(projectRoot);
  if (marker === "invalid" && sessionId !== null) {
    return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
  }
  if (
    marker !== null &&
    marker !== "invalid" &&
    sessionId !== null &&
    marker.sessionId === sessionId
  ) {
    const candidate = readCompletedCandidate(marker.path);
    if (candidate === "unreadable") {
      return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
    }
    return { kind: "target", path: candidate.path };
  }
  const paths = listCompletedBriefPaths(projectRoot);
  if (paths.length === 0 || (sessionId === null && startedAt === null)) {
    return { kind: "none" };
  }

  const matched: CompletedBriefCandidate[] = [];
  let unreadableCount = 0;
  for (const path of paths) {
    const candidate = readCompletedCandidate(path);
    if (candidate === "unreadable") {
      unreadableCount += 1;
      continue;
    }
    if (isSameSession(candidate, sessionId, startedAt)) {
      matched.push(candidate);
    }
  }

  if (matched.length === 0) {
    if (unreadableCount > 0 && unreadableCount === paths.length) {
      return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
    }
    return { kind: "none" };
  }

  matched.sort((a, b) => {
    if (a.completedAtMs !== b.completedAtMs) {
      return b.completedAtMs - a.completedAtMs;
    }
    return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
  });
  const latest = matched[0];
  if (latest === undefined) {
    return { kind: "none" };
  }
  const verified = readCompletedCandidate(latest.path);
  if (verified === "unreadable") {
    return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
  }
  return { kind: "target", path: latest.path };
}
