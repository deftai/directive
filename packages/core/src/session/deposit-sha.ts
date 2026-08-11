/**
 * Deposit fingerprint for orientation fast-path (#3286).
 *
 * Covers all refresh inputs named by the dual-path Now AC: payload, templates,
 * and engine version. When this fingerprint is unchanged, agents:refresh and
 * verify:cache-fresh may print a one-line sha-match no-op.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "../content-root.js";
import { readCorePackageVersion } from "../engine-version.js";
import { readLiveGeneration } from "../freshness/generation.js";
import { frameworkRoot as resolveAgentsFrameworkRoot } from "../platform/agents-md.js";

export const DEPOSIT_SHA_HEX_LEN = 12;

/** Canonical one-line no-op message for deposit-sha fast-path (#3286). */
export const DEPOSIT_SHA_MATCH_NOOP = "unchanged - sha match";

export interface DepositShaInputs {
  readonly engineVersion: string;
  readonly payloadVersion: string;
  readonly templatesHash: string;
}

export interface ComputeDepositShaOptions {
  readonly projectRoot?: string;
  readonly frameworkRoot?: string;
  /** Inject inputs for hermetic tests (skips filesystem/version probes). */
  readonly inputs?: Partial<DepositShaInputs>;
  /** Override engine version probe. */
  readonly readEngineVersion?: () => string;
  /** Override payload version probe. */
  readonly readPayloadVersion?: (projectRoot: string, frameworkRoot: string) => string;
  /** Override templates hash probe. */
  readonly readTemplatesHash?: (frameworkRoot: string) => string;
}

function sha12(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, DEPOSIT_SHA_HEX_LEN);
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash templates that feed agents:refresh (agents-entry + related entry points).
 * Missing templates yield a stable "missing" sentinel so the fingerprint still
 * changes when templates appear or disappear.
 */
export function hashDepositTemplates(frameworkRoot: string): string {
  const root = contentRoot(frameworkRoot);
  const candidates = [
    join(root, "templates", "agents-entry.md"),
    join(root, "templates", "agent-prompt-preamble.md"),
  ];
  const parts: string[] = [];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) {
        parts.push(`${path}:missing`);
        continue;
      }
      parts.push(`${path}:${hashText(readFileSync(path, "utf8"))}`);
    } catch {
      parts.push(`${path}:unreadable`);
    }
  }
  return sha12(parts.join("\n"));
}

/**
 * Resolve payload / content version for the deposit fingerprint.
 * Prefer live generation token, then VERSION files under framework root.
 */
export function resolveDepositPayloadVersion(
  projectRoot: string,
  frameworkRoot: string,
): string {
  try {
    const live = readLiveGeneration(projectRoot);
    if (live?.contentVersion) {
      return live.contentVersion;
    }
  } catch {
    // fall through
  }
  for (const cand of [
    join(frameworkRoot, "VERSION"),
    join(frameworkRoot, "scripts", "VERSION"),
    join(projectRoot, ".deft-version"),
  ]) {
    try {
      if (existsSync(cand)) {
        const v = readFileSync(cand, "utf8").trim();
        if (v.length > 0) return v;
      }
    } catch {
      // continue
    }
  }
  return "unknown-payload";
}

/** Resolve the three deposit-sha inputs (payload, templates, engine). */
export function resolveDepositShaInputs(
  options: ComputeDepositShaOptions = {},
): DepositShaInputs {
  const frameworkRoot = resolveAgentsFrameworkRoot({
    frameworkRoot: options.frameworkRoot,
  });
  const projectRoot = options.projectRoot ?? process.cwd();
  const engineVersion =
    options.inputs?.engineVersion ??
    (options.readEngineVersion ?? readCorePackageVersion)();
  const payloadVersion =
    options.inputs?.payloadVersion ??
    (options.readPayloadVersion ?? resolveDepositPayloadVersion)(projectRoot, frameworkRoot);
  const templatesHash =
    options.inputs?.templatesHash ??
    (options.readTemplatesHash ?? hashDepositTemplates)(frameworkRoot);
  return { engineVersion, payloadVersion, templatesHash };
}

/**
 * Compute the 12-hex deposit fingerprint covering payload + templates + engine.
 */
export function computeDepositSha(options: ComputeDepositShaOptions = {}): string {
  const inputs = resolveDepositShaInputs(options);
  const material = [
    `engine=${inputs.engineVersion}`,
    `payload=${inputs.payloadVersion}`,
    `templates=${inputs.templatesHash}`,
  ].join("\n");
  return sha12(material);
}

/** True when two deposit fingerprints match (case-insensitive, trimmed). */
export function depositShaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length === 0 || right.length === 0) return false;
  return left === right;
}

/** One-line status for orientation / CLI stdout. */
export function formatDepositShaMatchLine(surface: string): string {
  return `${surface}: ${DEPOSIT_SHA_MATCH_NOOP}`;
}
