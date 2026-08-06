/**
 * Doctor check + --fix wire for OpenClaw soft AGENTS re-bind skill (#3171).
 *
 * Complements always-pins (#3001/#3008) and L2 product commands (#3064). This
 * skill is the required durable soft post-amnesia surface for OpenClaw — not
 * claimed via file-host PreCompact hooks alone.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  formatOpenClawSoftRebindSkillMarkdown,
  isManagedOpenClawSoftRebindSkill,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
} from "../session/compact-ritual.js";
import {
  assessOpenClawSoftRebindSkill,
  depositOpenClawSoftRebindSkill,
  type OpenClawSoftRebindDepositResult,
} from "../session/openclaw-soft-rebind-deposit.js";
import { detectOpenClaw, listInScopeSkillsDirs } from "./openclaw-skills.js";
import type { OutputSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

/** Stable doctor check id for JSON findings. */
export const OPENCLAW_SOFT_REBIND_CHECK = "openclaw-soft-agents-rebind";

const DOC_OPENCLAW_HOST = "docs/openclaw-agent-host.md";
const REMEDIATION_FIX = "deft doctor --fix";

export interface RunOpenClawSoftRebindOptions {
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
  const expected = formatOpenClawSoftRebindSkillMarkdown();
  const missing: string[] = [];
  const stale: string[] = [];
  let present = 0;
  for (const skillsDir of skillsDirs) {
    const path = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID, "SKILL.md");
    if (!existsSync(path)) {
      missing.push(`${skillsDir}/${OPENCLAW_SOFT_REBIND_SKILL_ID}`);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      missing.push(`${skillsDir}/${OPENCLAW_SOFT_REBIND_SKILL_ID}`);
      continue;
    }
    // Unmanaged content at the required slug is incomplete health, not pass
    // (Greptile P1 #3171). Doctor --fix overwrites via deposit.
    if (!isManagedOpenClawSoftRebindSkill(raw) || raw !== expected) {
      stale.push(`${skillsDir}/${OPENCLAW_SOFT_REBIND_SKILL_ID}`);
      continue;
    }
    present += 1;
  }
  return { missing, stale, present };
}

/**
 * Doctor check: OpenClaw soft AGENTS re-bind skill present and current.
 * No-ops when OpenClaw is not detected. Fix mode deposits managed skill.
 */
export function runOpenClawSoftRebindCheck(
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  options: RunOpenClawSoftRebindOptions,
): OpenClawSoftRebindDepositResult | null {
  const seams = options.seams ?? {};
  const env = seams.openclawEnv ?? process.env;
  const homeDirFn = seams.openclawHomeDir ?? (() => homedir());
  const isDir = seams.isDir ?? defaultIsDir;
  const detect = detectOpenClaw(env, { homeDir: homeDirFn(), isDir });

  if (!detect.detected) {
    sink.info(`${OPENCLAW_SOFT_REBIND_CHECK}: skip -- OpenClaw not detected`);
    addFinding({
      severity: "skip",
      message: "OpenClaw not detected",
      check: OPENCLAW_SOFT_REBIND_CHECK,
      status: "skip",
      reason: "openclaw-not-detected",
    });
    return null;
  }

  const skillsDirs = listInScopeSkillsDirs(detect.stateDir, options.allAgents, {
    isDir,
  });
  const gaps = assessGaps(skillsDirs);

  if (gaps.missing.length === 0 && gaps.stale.length === 0) {
    const scope = options.allAgents ? "main + workspace-* seats" : "main workspace";
    const message =
      `${OPENCLAW_SOFT_REBIND_CHECK}: soft AGENTS re-bind skill present ` +
      `(${OPENCLAW_SOFT_REBIND_SKILL_ID}) in ${scope}`;
    sink.success(message);
    addFinding({
      severity: "skip",
      message,
      check: OPENCLAW_SOFT_REBIND_CHECK,
      status: "present",
      skill: OPENCLAW_SOFT_REBIND_SKILL_ID,
      skills_dirs: skillsDirs,
    });
    return null;
  }

  if (options.fixMode) {
    const depositResult = depositOpenClawSoftRebindSkill({
      env,
      homeDir: homeDirFn(),
      allAgents: options.allAgents,
      isDir,
      skillsDirs,
    });
    const after = assessGaps(skillsDirs);
    if (after.missing.length === 0 && after.stale.length === 0) {
      const message =
        `${OPENCLAW_SOFT_REBIND_CHECK}: deposited soft AGENTS re-bind skill; ` +
        `restart OpenClaw gateway or start a new session (${DOC_OPENCLAW_HOST})`;
      sink.success(message);
      addFinding({
        severity: "skip",
        message,
        check: OPENCLAW_SOFT_REBIND_CHECK,
        status: "fixed",
        written: depositResult.writtenPaths,
      });
      return depositResult;
    }
    // Partial fix: report remaining gaps from post-deposit assessment (SLizard P2).
    const partsAfter: string[] = [];
    if (after.missing.length > 0) {
      partsAfter.push(`missing=${after.missing.join(", ")}`);
    }
    if (after.stale.length > 0) {
      partsAfter.push(`stale=${after.stale.join(", ")}`);
    }
    const messageAfter =
      `${OPENCLAW_SOFT_REBIND_CHECK}: OpenClaw soft AGENTS re-bind skill incomplete after fix ` +
      `(${partsAfter.join("; ")}). Remediation: ${REMEDIATION_FIX} — see ${DOC_OPENCLAW_HOST}`;
    sink.warn(messageAfter);
    addFinding({
      severity: "warning",
      message: messageAfter,
      check: OPENCLAW_SOFT_REBIND_CHECK,
      status: "incomplete",
      missing: after.missing,
      stale: after.stale,
      written: depositResult.writtenPaths,
      suggestion: REMEDIATION_FIX,
      docs: [DOC_OPENCLAW_HOST],
    });
    return depositResult;
  }

  const parts: string[] = [];
  if (gaps.missing.length > 0) {
    parts.push(`missing=${gaps.missing.join(", ")}`);
  }
  if (gaps.stale.length > 0) {
    parts.push(`stale=${gaps.stale.join(", ")}`);
  }
  const message =
    `${OPENCLAW_SOFT_REBIND_CHECK}: OpenClaw soft AGENTS re-bind skill incomplete ` +
    `(${parts.join("; ")}). Remediation: ${REMEDIATION_FIX} — see ${DOC_OPENCLAW_HOST}`;
  sink.warn(message);
  addFinding({
    severity: "warning",
    message,
    check: OPENCLAW_SOFT_REBIND_CHECK,
    status: "incomplete",
    missing: gaps.missing,
    stale: gaps.stale,
    suggestion: REMEDIATION_FIX,
    docs: [DOC_OPENCLAW_HOST],
  });
  return null;
}

export { assessOpenClawSoftRebindSkill, depositOpenClawSoftRebindSkill };
