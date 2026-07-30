import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Deterministic gate: assert that OpenClaw is enumerated as a Tier-1 descriptor
 * in the swarm Phase 3 capability matrix and that routing accepts openclaw as a
 * dispatch_provider (#2875). Without this gate the "OpenClaw -> Tier 1" mapping
 * is prose-trusted; a doc edit that drops the sessions_spawn descriptor would
 * silently re-open misclassification (OpenClaw falling through to grok-build or
 * generic-terminal).
 *
 * Review-cycle skill markers for OpenClaw Approach 1 are owned by sibling #2876
 * and are intentionally out of scope for this gate.
 */

export interface OpenclawTier1Target {
  /** Project-root-relative path to the surface file. */
  readonly path: string;
  /** Human label for the surface, used in failure output. */
  readonly label: string;
  /** Whitespace-normalized substrings that MUST all be present. */
  readonly markers: readonly string[];
}

export const OPENCLAW_TIER1_TARGETS: readonly OpenclawTier1Target[] = [
  {
    path: "content/skills/deft-directive-swarm/SKILL.md",
    label: "swarm Phase 3 capability matrix (thin skill)",
    markers: [
      "Probe for the OpenClaw `sessions_spawn` tool",
      "sessions_spawn",
      "openclaw",
      "host-openclaw.md",
    ],
  },
  {
    path: "content/skills/deft-directive-swarm/references/host-openclaw.md",
    label: "swarm OpenClaw host adapter",
    // Cold-start (#2968 A7): project root + Skills Index before freestyle; keep Tier-1 launch markers.
    markers: [
      "Step 2f: OpenClaw Launch",
      "sessions_spawn",
      "openclaw",
      "Cold-start",
      "Skills Index",
      "project root",
    ],
  },
  {
    path: "content/contracts/host-lifecycle-duties.md",
    label: "host lifecycle duty list contract (#2968 A3)",
    markers: [
      "Session start",
      "Deft-shaped user intent",
      "Skills Index",
      "project root",
    ],
  },
  {
    path: "packages/core/src/swarm/routing.ts",
    label: "swarm routing dispatch_provider",
    // Prefer operative identifiers (function + return), not free-floating prose.
    markers: [
      "export function resolveDispatchProvider",
      'return "openclaw"',
      "DEFT_HAS_SESSIONS_SPAWN",
      "ROUTING_GATED_DISPATCH_PROVIDERS",
    ],
  },
  {
    path: "packages/core/src/swarm/routing-set-cli.ts",
    label: "swarm:routing-set provider resolution",
    markers: ["resolveDispatchProvider", "openclaw"],
  },
];

/** Collapse all runs of whitespace to a single space (substring-containment normalization). */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

export interface OpenclawTier1Finding {
  readonly path: string;
  readonly label: string;
  readonly missingMarkers: readonly string[];
}

export interface OpenclawTier1Result {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly OpenclawTier1Finding[];
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface OpenclawTier1Options {
  readonly targets?: readonly OpenclawTier1Target[];
  readonly quiet?: boolean;
}

export function evaluateOpenclawTier1(
  projectRoot: string,
  options: OpenclawTier1Options = {},
): OpenclawTier1Result {
  const root = resolve(projectRoot);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      code: 2,
      findings: [],
      message:
        `verify_openclaw_tier1: --project-root is not a directory: ${root}\n` +
        "  Recovery: pass an existing directory path.",
      stream: "stderr",
    };
  }

  const targets = options.targets ?? OPENCLAW_TIER1_TARGETS;
  const findings: OpenclawTier1Finding[] = [];

  for (const target of targets) {
    const full = join(root, target.path);
    if (!existsSync(full)) {
      return {
        code: 2,
        findings: [...findings],
        message:
          `verify_openclaw_tier1: required surface file not found: ${target.path}\n` +
          "  Recovery: run from the framework source root, or update OPENCLAW_TIER1_TARGETS if the path moved.",
        stream: "stderr",
      };
    }
    let normalized: string;
    try {
      normalized = normalizeWhitespace(readFileSync(full, { encoding: "utf8" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        code: 2,
        findings: [...findings],
        message: `verify_openclaw_tier1: could not read ${target.path}: ${msg}`,
        stream: "stderr",
      };
    }
    const missing = target.markers.filter(
      (marker) => !normalized.includes(normalizeWhitespace(marker)),
    );
    if (missing.length > 0) {
      findings.push({ path: target.path, label: target.label, missingMarkers: missing });
    }
  }

  if (findings.length > 0) {
    const header =
      "verify_openclaw_tier1: OpenClaw is not fully enumerated as a Tier-1 descriptor (#2875).\n" +
      "  Root cause: an OpenClaw agent has a first-class backgroundable sub-agent primitive (sessions_spawn) and\n" +
      "  is therefore Tier 1 / Approach 1. If the matrix or routing surfaces drop the openclaw descriptor, an\n" +
      "  OpenClaw session silently degrades to grok-build misclassification or generic-terminal. Re-add the missing marker(s):";
    const body = findings
      .map(
        (f) =>
          `  ${f.path} (${f.label}) missing: ${f.missingMarkers.map((m) => `"${m}"`).join(", ")}`,
      )
      .join("\n");
    return { code: 1, findings, message: `${header}\n${body}`, stream: "stderr" };
  }

  const msg = `verify_openclaw_tier1: OpenClaw enumerated as a Tier-1 descriptor in ${targets.length} surface(s) (#2875).`;
  if (options.quiet) {
    return { code: 0, findings: [], message: "", stream: "stdout" };
  }
  return { code: 0, findings: [], message: msg, stream: "stdout" };
}
