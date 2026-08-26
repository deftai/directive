/**
 * Native TypeScript release pipeline steps (#1860).
 * Replaces python-steps.ts (scripts/ roadmap_render, reconcile_issues, build_dist).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLifecycleReport,
  isTerminalLifecyclePath,
  scanLifecycleAnchors,
} from "../intake/reconcile-issues.js";
import {
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
  resolveLifecycleFolder,
  resolveLifecycleRoot,
} from "../layout/resolve.js";
import { renderRoadmap } from "../render/roadmap-render.js";
import { fetchIssueStatesForRelease } from "./issue-state-fetch.js";
import type { ReleaseSeams } from "./types.js";

const BUILD_DIST_RUNNER = join(dirname(fileURLToPath(import.meta.url)), "build-dist-runner.js");

export function refreshRoadmapNative(projectRoot: string): [boolean, string] {
  const pending = resolveLifecycleFolder(projectRoot, "pending");
  const completed = resolveLifecycleFolder(projectRoot, "completed");
  const roadmap = join(projectRoot, "ROADMAP.md");
  const [ok, msg] = renderRoadmap(pending, roadmap, completed);
  if (!ok) {
    return [false, `roadmap:render failed: ${msg}`];
  }
  return [true, "ROADMAP.md re-rendered"];
}

export function checkVbriefLifecycleSyncNative(
  projectRoot: string,
  repo: string,
): [boolean, number, string] {
  let vbriefDir: string;
  try {
    vbriefDir = resolveLifecycleRoot(projectRoot);
  } catch (_err) {
    // Re-throw if this is a legacy-only vbrief/ project; fall back to canonical path otherwise.
    if (
      existsSync(join(projectRoot, LEGACY_ARTIFACT_DIR)) &&
      !existsSync(join(projectRoot, MIGRATED_ARTIFACT_DIR))
    ) {
      return [false, 0, "no xbrief/ layout found; skipping lifecycle sync check"];
    }
    vbriefDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  }
  try {
    const anchors = scanLifecycleAnchors(vbriefDir);
    const anchorIssueNumbers = new Set<number>();
    for (const anchor of anchors) {
      const num = anchor.issue_number as number | null;
      if (num !== null) {
        anchorIssueNumbers.add(num);
      }
    }
    process.stderr.write(
      `[release Step 3] ${anchors.length} lifecycle anchor(s), ${anchorIssueNumbers.size} unique issue number(s) to evaluate\n`,
    );
    const fetchResult = fetchIssueStatesForRelease(repo, anchorIssueNumbers, {
      cwd: projectRoot,
    });
    if (!fetchResult.ok) {
      return [false, -1, fetchResult.reason];
    }
    const issueStateMap = fetchResult.states;
    const report = buildLifecycleReport(anchors, issueStateMap, false);
    const mismatches: string[] = [];
    for (const entry of report.no_open_issue) {
      const files = (entry.vbrief_files ?? []) as string[];
      for (const rel of files) {
        if (!isTerminalLifecyclePath(rel)) {
          mismatches.push(rel);
        }
      }
    }
    const count = mismatches.length;
    if (count === 0) {
      return [true, 0, "no mismatches"];
    }
    const suffix = count > 5 ? " ..." : "";
    const preview = mismatches.slice(0, 5).join(", ");
    const reason = `${count} closed-issue vBRIEF(s) not in completed/ or cancelled/: ${preview}${suffix}`;
    return [false, count, reason];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [false, -1, msg];
  }
}

export function runBuildNative(
  projectRoot: string,
  version: string | null,
  _seams: ReleaseSeams = {},
): [boolean, string] {
  if (!version) {
    return [false, "build requires a release version"];
  }
  const env = { ...process.env, DEFT_RELEASE_VERSION: version };
  // Inherit stderr so build-dist-runner progress ticks stream live during
  // release Step 8; capture stdout only for the archive path (#2953).
  const result = spawnSync(process.execPath, [BUILD_DIST_RUNNER, version, projectRoot], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    const captured =
      (typeof result.stderr === "string" ? result.stderr : "") ||
      (typeof result.stdout === "string" ? result.stdout : "");
    const msg = captured.trim() || `exit ${result.status ?? 1}`;
    return [false, `build failed: ${msg}`];
  }
  const out = (typeof result.stdout === "string" ? result.stdout : "").trim();
  return [true, `build ran clean (DEFT_RELEASE_VERSION=${version}) -> ${out}`];
}
