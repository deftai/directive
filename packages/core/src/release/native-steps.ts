/**
 * Native TypeScript release pipeline steps (#1860).
 * Replaces python-steps.ts (scripts/ roadmap_render, reconcile_issues, build_dist).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchIssueStates,
  isTerminalLifecyclePath,
  reconcile,
  scanVbriefDir,
} from "../intake/reconcile-issues.js";
import { resolveLifecycleFolder, resolveLifecycleRoot } from "../layout/resolve.js";
import { renderRoadmap } from "../render/roadmap-render.js";
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
  const vbriefDir = resolveLifecycleRoot(projectRoot);
  try {
    const issueToVbriefs = scanVbriefDir(vbriefDir);
    const issueStateMap = fetchIssueStates(repo, new Set(issueToVbriefs.keys()), {
      cwd: projectRoot,
    });
    if (issueStateMap === null) {
      return [false, -1, "failed to fetch issue states from gh"];
    }
    const report = reconcile(issueToVbriefs, issueStateMap);
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
  const result = spawnSync(process.execPath, [BUILD_DIST_RUNNER, version, projectRoot], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    const msg = (result.stderr ?? result.stdout ?? "").trim() || `exit ${result.status ?? 1}`;
    return [false, `build failed: ${msg}`];
  }
  const out = (result.stdout ?? "").trim();
  return [true, `build ran clean (DEFT_RELEASE_VERSION=${version}) -> ${out}`];
}
