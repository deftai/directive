/**
 * Doctor check + --fix wire for OpenClaw L2 product-command skills (#3064 D5).
 *
 * Primary operator recovery path when OpenClaw is detected. Deposits thin
 * user-invocable router + 13 product skills into workspace skills roots.
 * Fail-closed when OC signals are absent. Policy opt-out:
 * `plan.policy.openClawProductCommands: false`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateOpenClawSkillArtifacts,
  isManagedOpenClawL2Skill,
  listOpenClawManagedSkillSlugs,
} from "../slash/openclaw-adapter.js";
import {
  depositOpenClawL2ProductCommands,
  loadOpenClawProductCommandsPolicyFromProject,
  type OpenClawL2DepositResult,
} from "../slash/openclaw-deposit.js";
import { detectOpenClaw, listInScopeSkillsDirs } from "./openclaw-skills.js";
import type { OutputSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

/** Stable doctor check id for JSON findings. */
export const OPENCLAW_L2_ADAPTER_CHECK = "openclaw-l2-product-commands";

const DOC_OPENCLAW_HOST = "docs/openclaw-agent-host.md";
const DOC_SLASH_MULTI = "docs/slash-multi-host.md";
const REMEDIATION_FIX = "deft doctor --fix";

export interface RunOpenClawL2AdapterOptions {
  readonly projectRoot: string;
  readonly fixMode: boolean;
  readonly jsonMode: boolean;
  readonly allAgents: boolean;
  readonly seams?: DoctorSeams;
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assessGaps(skillsDirs: readonly string[]): {
  missing: string[];
  stale: string[];
  present: number;
} {
  const artifacts = generateOpenClawSkillArtifacts();
  const missing: string[] = [];
  const stale: string[] = [];
  let present = 0;
  for (const skillsDir of skillsDirs) {
    for (const art of artifacts) {
      const path = join(skillsDir, art.slug, "SKILL.md");
      if (!existsSync(path)) {
        missing.push(`${skillsDir}/${art.slug}`);
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        missing.push(`${skillsDir}/${art.slug}`);
        continue;
      }
      if (!isManagedOpenClawL2Skill(raw)) {
        // Consumer customization — not a gap for doctor (preserve).
        present += 1;
        continue;
      }
      if (raw === art.skillMarkdown) {
        present += 1;
      } else {
        stale.push(`${skillsDir}/${art.slug}`);
      }
    }
  }
  return { missing, stale, present };
}

/**
 * Doctor check: OpenClaw L2 product-command skills present and current.
 * No-ops when OpenClaw is not detected. Fix mode deposits managed skills.
 */
export function runOpenClawL2AdapterCheck(
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  options: RunOpenClawL2AdapterOptions,
): OpenClawL2DepositResult | null {
  const seams = options.seams ?? {};
  const env = seams.openclawEnv ?? process.env;
  const homeDirFn = seams.openclawHomeDir ?? (() => homedir());
  const isDir = seams.isDir ?? defaultIsDir;
  const home = homeDirFn();
  const detect = detectOpenClaw(env, { homeDir: home, isDir });
  if (!detect.detected) {
    sink.info(`${OPENCLAW_L2_ADAPTER_CHECK}: skip -- OpenClaw not detected`);
    addFinding({
      severity: "skip",
      message: "OpenClaw not detected",
      check: OPENCLAW_L2_ADAPTER_CHECK,
      status: "skip",
      reason: "openclaw-not-detected",
    });
    return null;
  }

  const policy = loadOpenClawProductCommandsPolicyFromProject(options.projectRoot);
  if (!policy) {
    sink.info(`${OPENCLAW_L2_ADAPTER_CHECK}: skip -- plan.policy.openClawProductCommands=false`);
    addFinding({
      severity: "skip",
      message: "OpenClaw L2 product commands opted out via policy",
      check: OPENCLAW_L2_ADAPTER_CHECK,
      status: "opted-out",
      reason: "policy-false",
    });
    return null;
  }

  const skillsDirs = listInScopeSkillsDirs(detect.stateDir, options.allAgents, {
    isDir,
  });
  const gaps = assessGaps(skillsDirs);
  const expectedCount = listOpenClawManagedSkillSlugs().length * skillsDirs.length;

  if (gaps.missing.length === 0 && gaps.stale.length === 0) {
    const message =
      `${OPENCLAW_L2_ADAPTER_CHECK}: OpenClaw L2 product-command skills present ` +
      `(router + 13) in ${options.allAgents ? "main + workspace-* seats" : "main workspace"}`;
    sink.success(message);
    addFinding({
      severity: "skip",
      message,
      check: OPENCLAW_L2_ADAPTER_CHECK,
      status: "present",
      skills_dirs: skillsDirs,
      expected: expectedCount,
      present: gaps.present,
      detect_reasons: detect.reasons,
    });
    return null;
  }

  let depositResult: OpenClawL2DepositResult | null = null;
  if (options.fixMode) {
    depositResult = depositOpenClawL2ProductCommands({
      projectRoot: options.projectRoot,
      env,
      homeDir: home,
      allAgents: options.allAgents,
      policy: true,
      printf: (t) => {
        if (!options.jsonMode) sink.info(t.trimEnd());
      },
      isDir,
    });
    const post = assessGaps(skillsDirs);
    if (post.missing.length === 0 && post.stale.length === 0) {
      const message =
        `${OPENCLAW_L2_ADAPTER_CHECK}: deposited OpenClaw L2 product-command skills; ` +
        "restart the OpenClaw gateway or start a new session so available_skills refreshes";
      sink.success(message);
      addFinding({
        severity: "skip",
        message,
        check: OPENCLAW_L2_ADAPTER_CHECK,
        status: "fixed",
        skills_dirs: skillsDirs,
        written: depositResult.writtenPaths,
        detect_reasons: detect.reasons,
      });
      return depositResult;
    }
  }

  const message =
    `${OPENCLAW_L2_ADAPTER_CHECK}: OpenClaw L2 product-command skills incomplete ` +
    `(missing: ${gaps.missing.length}, stale: ${gaps.stale.length}) under ${skillsDirs.join(", ")}. ` +
    `Remediation: ${REMEDIATION_FIX}. See ${DOC_OPENCLAW_HOST}, ${DOC_SLASH_MULTI}.`;
  sink.warn(message);
  addFinding({
    severity: "warning",
    message,
    check: OPENCLAW_L2_ADAPTER_CHECK,
    status: "missing",
    missing: gaps.missing,
    stale: gaps.stale,
    skills_dirs: skillsDirs,
    suggestion: REMEDIATION_FIX,
    docs: [DOC_OPENCLAW_HOST, DOC_SLASH_MULTI],
    detect_reasons: detect.reasons,
  });
  return depositResult;
}
