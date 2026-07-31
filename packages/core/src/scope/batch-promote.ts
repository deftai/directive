/**
 * Batch promote: proposed/ -> pending/ for multi-scope pins (#3011 / epic #3009).
 *
 * Keeps one-active-implement intact: this only stages scopes into pending/.
 * Activate + implement remain one-at-a-time.
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleFolder } from "../layout/resolve.js";
import { stripTrailingPathSeparators } from "../text/redos-safe.js";
import { resolveProjectRoot } from "./project-context.js";
import { recordWipCapOverride, runTransition } from "./transition.js";
import { checkWipCapForAdditional, formatWipCapRefusal } from "./wip-cap-check.js";

export interface BatchPromoteOptions {
  /** Explicit files (absolute or project-relative). Empty = all proposed/ artifacts. */
  readonly files?: readonly string[];
  readonly force?: boolean;
  readonly projectRoot?: string;
}

export interface BatchPromoteResult {
  readonly ok: boolean;
  readonly promoted: number;
  readonly skipped: string[];
  readonly messages: string[];
  readonly exitCode: number;
  readonly wipCapOverride?: boolean;
}

/**
 * Promote one or more proposed scopes to pending/, checking WIP once for the
 * full batch size before any move (#3011).
 */
export function batchPromote(options: BatchPromoteOptions = {}): BatchPromoteResult {
  const root = resolveProjectRoot(options.projectRoot);
  if (root === null) {
    return {
      ok: false,
      promoted: 0,
      skipped: [],
      messages: ["Could not resolve project root (pass --project-root)."],
      exitCode: 2,
    };
  }

  const candidates = resolvePromoteCandidates(root, options.files ?? []);
  if (candidates.error !== null) {
    return {
      ok: false,
      promoted: 0,
      skipped: [],
      messages: [candidates.error],
      exitCode: 2,
    };
  }
  const files = candidates.files;
  if (files.length === 0) {
    return {
      ok: true,
      promoted: 0,
      skipped: [],
      messages: ["Batch promote: 0 promoted (no proposed/ scopes matched)."],
      exitCode: 0,
    };
  }

  const capCheck = checkWipCapForAdditional(root, files.length, options.force === true);
  if (!capCheck.allowed) {
    return {
      ok: false,
      promoted: 0,
      skipped: [],
      messages: [
        formatWipCapRefusal(capCheck) +
          `\nBatch promote needs room for ${files.length} additional scope(s); ` +
          `current WIP is ${capCheck.count}/${capCheck.cap}.`,
      ],
      exitCode: 1,
    };
  }

  const skipped: string[] = [];
  const messages: string[] = [];
  let promoted = 0;

  for (const filePath of files) {
    const result = runTransition("promote", filePath);
    if (result.ok) {
      promoted += 1;
      messages.push(result.message);
      if (capCheck.forceOverride) {
        recordWipCapOverride(filePath, root, capCheck);
      }
    } else {
      skipped.push(`${filePath.split(/[/\\]/).pop() ?? filePath}: ${result.message}`);
    }
  }

  if (capCheck.forceOverride && promoted > 0) {
    messages.push(
      `WIP cap exceeded (count_before=${capCheck.count}, cap=${capCheck.cap}, ` +
        `batch=${files.length}); promote allowed via --force. audit tagged wip_cap_override (#1124/#3011).`,
    );
  }

  messages.unshift(
    `Batch promote: ${promoted} promoted, ${skipped.length} skipped` +
      (files.length > 0 ? ` (candidates=${files.length})` : "") +
      ".",
  );

  return {
    ok: skipped.length === 0,
    promoted,
    skipped,
    messages,
    exitCode: skipped.length === 0 ? 0 : promoted > 0 ? 0 : 1,
    wipCapOverride: capCheck.forceOverride && promoted > 0,
  };
}

function resolvePromoteCandidates(
  projectRoot: string,
  explicit: readonly string[],
): { files: string[]; error: string | null } {
  if (explicit.length > 0) {
    const resolved: string[] = [];
    for (const raw of explicit) {
      const stripped = stripTrailingPathSeparators(raw.trim());
      if (stripped.length === 0) {
        continue;
      }
      const abs = isAbsolute(stripped) ? resolve(stripped) : resolve(projectRoot, stripped);
      if (!existsSync(abs)) {
        return { files: [], error: `File not found: ${abs}` };
      }
      const base = abs.split(/[/\\]/).pop() ?? "";
      if (!hasArtifactSuffix(base)) {
        return {
          files: [],
          error: `Not a vBRIEF file (expected .vbrief.json or .xbrief.json): ${base}`,
        };
      }
      resolved.push(abs);
    }
    return { files: resolved, error: null };
  }

  const proposedDir = resolveLifecycleFolder(projectRoot, "proposed");
  if (!existsSync(proposedDir)) {
    return { files: [], error: null };
  }
  const files = readdirSync(proposedDir)
    .filter((name) => hasArtifactSuffix(name))
    .sort()
    .map((name) => join(proposedDir, name));
  return { files, error: null };
}
