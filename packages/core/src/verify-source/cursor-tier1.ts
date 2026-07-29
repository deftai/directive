import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Deterministic gate: assert that Cursor is enumerated as a Tier-1 descriptor in
 * both the swarm Phase 3 capability matrix and the review-cycle monitoring
 * tier-selection table (#1877). Without this gate the "Cursor -> Tier 1" mapping
 * is prose-trusted; a doc edit that drops the Cursor descriptor would silently
 * re-open the misclassification (Cursor falling through to a blocking poll).
 */

export interface CursorTier1Target {
  /** Project-root-relative path to the skill file. */
  readonly path: string;
  /** Human label for the surface, used in failure output. */
  readonly label: string;
  /** Whitespace-normalized substrings that MUST all be present. */
  readonly markers: readonly string[];
}

export const CURSOR_TIER1_TARGETS: readonly CursorTier1Target[] = [
  {
    path: "content/skills/deft-directive-swarm/SKILL.md",
    label: "swarm Phase 3 capability matrix (thin skill)",
    markers: [
      "Probe for the Cursor `Task` tool",
      "cursor-composer",
      "cursor-cloud-agent",
      "host-cursor.md",
    ],
  },
  {
    path: "content/skills/deft-directive-swarm/references/host-cursor.md",
    label: "swarm Cursor host adapter",
    markers: ["Step 2e: Cursor Launch", "cursor-composer", "Task"],
  },
  {
    path: "content/skills/deft-directive-review-cycle/SKILL.md",
    label: "review-cycle monitoring tier selection",
    markers: [
      "cursor-composer",
      "cursor-cloud-agent",
      "Tier 1 with the backgrounded Cursor `Task` poller path",
      "Heartbeat contract for Cursor pollers",
    ],
  },
];

/** Collapse all runs of whitespace to a single space (substring-containment normalization). */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

export interface CursorTier1Finding {
  readonly path: string;
  readonly label: string;
  readonly missingMarkers: readonly string[];
}

export interface CursorTier1Result {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly CursorTier1Finding[];
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface CursorTier1Options {
  readonly targets?: readonly CursorTier1Target[];
  readonly quiet?: boolean;
}

export function evaluateCursorTier1(
  projectRoot: string,
  options: CursorTier1Options = {},
): CursorTier1Result {
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
        `verify_cursor_tier1: --project-root is not a directory: ${root}\n` +
        "  Recovery: pass an existing directory path.",
      stream: "stderr",
    };
  }

  const targets = options.targets ?? CURSOR_TIER1_TARGETS;
  const findings: CursorTier1Finding[] = [];

  for (const target of targets) {
    const full = join(root, target.path);
    if (!existsSync(full)) {
      return {
        code: 2,
        findings: [...findings],
        message:
          `verify_cursor_tier1: required skill file not found: ${target.path}\n` +
          "  Recovery: run from the framework source root, or update CURSOR_TIER1_TARGETS if the skill moved.",
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
        message: `verify_cursor_tier1: could not read ${target.path}: ${msg}`,
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
      "verify_cursor_tier1: Cursor is not fully enumerated as a Tier-1 descriptor (#1877).\n" +
      "  Root cause: a Cursor agent has a first-class backgroundable sub-agent primitive (the Task tool) and\n" +
      "  is therefore Tier 1 / Approach 1. If the matrices below drop the Cursor descriptor, a Cursor session\n" +
      "  silently degrades to the Approach-3 blocking poll. Re-add the missing marker(s):";
    const body = findings
      .map(
        (f) =>
          `  ${f.path} (${f.label}) missing: ${f.missingMarkers.map((m) => `"${m}"`).join(", ")}`,
      )
      .join("\n");
    return { code: 1, findings, message: `${header}\n${body}`, stream: "stderr" };
  }

  const msg = `verify_cursor_tier1: Cursor enumerated as a Tier-1 descriptor in ${targets.length} matrix surface(s) (#1877).`;
  if (options.quiet) {
    return { code: 0, findings: [], message: "", stream: "stdout" };
  }
  return { code: 0, findings: [], message: msg, stream: "stdout" };
}
