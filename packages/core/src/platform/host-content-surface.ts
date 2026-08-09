/**
 * Host content-surface class + managed-section drift (#3162).
 *
 * Directive file gates and #830/#2508 pins assume filesystem-visible work product
 * and a host that does not rewrite constitution mid-run. REPL-first and
 * self-mutating hosts break those assumptions. This module classifies the host
 * surface (capability pointer #1461/#1357) and reports managed AGENTS section
 * drift without inventing a full pin product.
 *
 * Never blocks session-start — advisory only.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentsMdSeams,
  agentsRefreshPlan,
  extractManagedSection,
  parseManagedSectionAttrs,
  stripManagedSectionAttrs,
} from "./agents-md.js";

/** Host content-surface classes for gate / pin honesty (#3162). */
export const HOST_CONTENT_SURFACE_CLASSES = [
  "file-first",
  "repl-first",
  "self-mutating",
  "unknown",
] as const;

export type HostContentSurfaceClass = (typeof HOST_CONTENT_SURFACE_CLASSES)[number];

/** Env key for explicit class override (capability descriptor pointer). */
export const ENV_HOST_CONTENT_SURFACE = "DEFT_HOST_CONTENT_SURFACE";
/** Env opt-in: host holds executable work product before files exist. */
export const ENV_HOST_REPL_FIRST = "DEFT_HOST_REPL_FIRST";
/** Env opt-in: host refine/kernel may CRUD skills/prompts mid-run. */
export const ENV_HOST_SELF_MUTATE = "DEFT_HOST_SELF_MUTATE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export interface HostContentSurfaceClassResult {
  readonly contentClass: HostContentSurfaceClass;
  readonly source: string;
  /** Signals observed (env keys present). */
  readonly signals: readonly string[];
}

export type ManagedSectionDriftState =
  | "current"
  | "stale"
  | "missing"
  | "absent"
  | "unreadable"
  | "template-missing"
  | "template-malformed"
  | "unknown";

export interface ManagedSectionDriftReport {
  readonly state: ManagedSectionDriftState;
  readonly embeddedSha: string | null;
  /** SHA-256 (12 hex) of stripped managed-section body when readable. */
  readonly bodyHash: string | null;
  readonly path: string;
}

export interface HostContentSurfaceReport {
  readonly contentClass: HostContentSurfaceClass;
  readonly classSource: string;
  readonly signals: readonly string[];
  readonly managedSection: ManagedSectionDriftReport;
  /** Runtime mode from platform capability descriptor when provided. */
  readonly runtimeMode: string | null;
}

export interface HostContentSurfaceSeams {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly agentsMdSeams?: AgentsMdSeams;
  readonly runtimeMode?: string | null;
}

function envTruthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

function normalizeClassToken(raw: string): HostContentSurfaceClass | null {
  const token = raw.trim().toLowerCase().replace(/_/g, "-");
  if ((HOST_CONTENT_SURFACE_CLASSES as readonly string[]).includes(token)) {
    return token as HostContentSurfaceClass;
  }
  // Accept aliases used in host docs.
  if (token === "file" || token === "filesystem" || token === "fs-first") return "file-first";
  if (token === "repl" || token === "kernel-first") return "repl-first";
  if (token === "self-edit" || token === "self-editing" || token === "continual-harness") {
    return "self-mutating";
  }
  return null;
}

/**
 * Classify host content surface from explicit env / capability signals (#1461/#1357 pointer).
 * Defaults to file-first (historical Directive assumption) when no signal is set.
 */
export function classifyHostContentSurface(
  environ: Readonly<Record<string, string | undefined>> = process.env,
): HostContentSurfaceClassResult {
  const signals: string[] = [];
  const explicit = (environ[ENV_HOST_CONTENT_SURFACE] ?? "").trim();
  if (explicit) {
    signals.push(ENV_HOST_CONTENT_SURFACE);
    const parsed = normalizeClassToken(explicit);
    if (parsed !== null) {
      return {
        contentClass: parsed,
        source: `env:${ENV_HOST_CONTENT_SURFACE}`,
        signals,
      };
    }
    return {
      contentClass: "unknown",
      source: `env:${ENV_HOST_CONTENT_SURFACE}:unrecognized`,
      signals,
    };
  }

  const selfMutate = envTruthy(environ[ENV_HOST_SELF_MUTATE]);
  const replFirst = envTruthy(environ[ENV_HOST_REPL_FIRST]);
  if (selfMutate) signals.push(ENV_HOST_SELF_MUTATE);
  if (replFirst) signals.push(ENV_HOST_REPL_FIRST);

  // Self-mutating supersedes REPL-first when both are set (broader honesty surface).
  if (selfMutate) {
    return {
      contentClass: "self-mutating",
      source: `env:${ENV_HOST_SELF_MUTATE}`,
      signals,
    };
  }
  if (replFirst) {
    return {
      contentClass: "repl-first",
      source: `env:${ENV_HOST_REPL_FIRST}`,
      signals,
    };
  }

  return {
    contentClass: "file-first",
    source: "assumed",
    signals,
  };
}

function hashBody(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function mapPlanState(raw: unknown): ManagedSectionDriftState {
  if (typeof raw !== "string") return "unknown";
  switch (raw) {
    case "current":
    case "stale":
    case "missing":
    case "absent":
    case "unreadable":
    case "template-missing":
    case "template-malformed":
      return raw;
    default:
      return "unknown";
  }
}

/**
 * Probe managed AGENTS.md section drift (tamper-evident boundary, not full #830 pins).
 * Uses agents:refresh plan state + embedded marker sha + body hash.
 */
export function probeManagedSectionDrift(
  projectRoot: string,
  seams: HostContentSurfaceSeams = {},
): ManagedSectionDriftReport {
  const agentsPath = join(projectRoot, "AGENTS.md");
  const plan = agentsRefreshPlan(projectRoot, seams.agentsMdSeams ?? {});
  const state = mapPlanState(plan.state);

  let embeddedSha: string | null = null;
  let bodyHash: string | null = null;

  const readAgents =
    seams.agentsMdSeams?.readAgents ??
    ((path: string) => {
      try {
        if (!existsSync(path)) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });

  try {
    const text = readAgents(agentsPath);
    if (text !== null) {
      const extracted = extractManagedSection(text);
      if (extracted !== null) {
        const attrs = parseManagedSectionAttrs(extracted);
        embeddedSha = attrs?.sha ?? null;
        bodyHash = hashBody(stripManagedSectionAttrs(extracted));
      }
    }
  } catch {
    // body hash is best-effort
  }

  return {
    state,
    embeddedSha,
    bodyHash,
    path: typeof plan.path === "string" ? plan.path : agentsPath,
  };
}

/** Full host-surface report for session-start payload + lines. */
export function probeHostContentSurface(
  projectRoot: string,
  seams: HostContentSurfaceSeams = {},
): HostContentSurfaceReport {
  const environ = seams.environ ?? process.env;
  const classified = classifyHostContentSurface(environ);
  const managedSection = probeManagedSectionDrift(projectRoot, seams);
  return {
    contentClass: classified.contentClass,
    classSource: classified.source,
    signals: classified.signals,
    managedSection,
    runtimeMode: seams.runtimeMode ?? null,
  };
}

export function hostContentSurfaceToDict(
  report: HostContentSurfaceReport,
): Record<string, unknown> {
  return {
    content_class: report.contentClass,
    class_source: report.classSource,
    signals: [...report.signals],
    runtime_mode: report.runtimeMode,
    managed_section: {
      state: report.managedSection.state,
      embedded_sha: report.managedSection.embeddedSha,
      body_hash: report.managedSection.bodyHash,
      path: report.managedSection.path,
    },
  };
}

/**
 * Format operator-facing host-surface lines (#3162).
 * Always emits one summary line; adds honesty note for non-file-first or drift.
 */
export function formatHostContentSurfaceLines(report: HostContentSurfaceReport): string[] {
  const managed = report.managedSection.state;
  const summary =
    `[deft host-surface] class=${report.contentClass} source=${report.classSource} ` +
    `managed=${managed}` +
    (report.managedSection.embeddedSha ? ` sha=${report.managedSection.embeddedSha}` : "") +
    (report.managedSection.bodyHash ? ` body=${report.managedSection.bodyHash}` : "");

  const lines: string[] = [summary];

  if (report.contentClass === "repl-first" || report.contentClass === "self-mutating") {
    lines.push(
      "[deft host-surface] honesty: file gates and agent-only pins do not see host-kernel " +
        "or mid-run host refine work product — see content/docs/host-surface-assumptions.md (#3162)",
    );
  }

  if (managed === "stale" || managed === "missing") {
    lines.push(
      "[deft host-surface] managed AGENTS section drift — run `deft agents:refresh` " +
        "(or `task agents:refresh`) so pins/managed constitution match the deposit",
    );
  }

  return lines;
}

/**
 * Probe + format; fail-open for session-start (never throws to callers that wrap).
 */
export function maybeFormatHostContentSurfaceLines(
  projectRoot: string,
  seams: HostContentSurfaceSeams = {},
): { report: HostContentSurfaceReport; lines: string[] } {
  const report = probeHostContentSurface(projectRoot, seams);
  return { report, lines: formatHostContentSurfaceLines(report) };
}
