/**
 * OpenClaw durable soft AGENTS re-bind skill deposit (#3171 / #2769).
 *
 * Deposits a managed workspace skill generated from the shared checklist SoT
 * in compact-ritual.ts. Fail-closed when OpenClaw is not detected (unless
 * forceDeposit for tests). Real directory copy — not symlink-escape into npm.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  detectOpenClaw,
  isEscapingSkillSymlink,
  listInScopeSkillsDirs,
  type OpenClawDetectResult,
} from "../doctor/openclaw-skills.js";
import { containedWrite } from "../fs/contained-write.js";
import {
  formatOpenClawSoftRebindSkillMarkdown,
  isManagedOpenClawSoftRebindSkill,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
} from "./compact-ritual.js";

export interface OpenClawSoftRebindDepositResult {
  readonly changed: boolean;
  readonly writtenPaths: string[];
  readonly preservedCustomPaths: string[];
  readonly skillsDirs: string[];
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly detect: OpenClawDetectResult | null;
  readonly present: boolean;
}

export interface OpenClawSoftRebindDepositOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly allAgents?: boolean;
  readonly forceDeposit?: boolean;
  readonly skillsDirs?: readonly string[];
  readonly isDir?: (path: string) => boolean;
  readonly readDir?: (path: string) => string[];
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultLstatKind(path: string): "file" | "dir" | "symlink" | "other" | "missing" {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

/**
 * Assess whether the managed soft re-bind skill is present and current.
 */
export function assessOpenClawSoftRebindSkill(
  skillsDir: string,
  options: { readonly expectedBody?: string } = {},
): { readonly present: boolean; readonly custom: boolean; readonly path: string } {
  const path = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID, "SKILL.md");
  if (!existsSync(path)) {
    return { present: false, custom: false, path };
  }
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { present: false, custom: false, path };
  }
  if (!isManagedOpenClawSoftRebindSkill(body)) {
    return { present: true, custom: true, path };
  }
  const expected = options.expectedBody ?? formatOpenClawSoftRebindSkillMarkdown();
  return { present: body === expected, custom: false, path };
}

/**
 * Deposit the managed OpenClaw soft re-bind skill into workspace skills roots.
 */
export function depositOpenClawSoftRebindSkill(
  options: OpenClawSoftRebindDepositOptions = {},
): OpenClawSoftRebindDepositResult {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const isDir = options.isDir ?? defaultIsDir;
  const detect = detectOpenClaw(env, { homeDir: home, isDir });

  if (!detect.detected && !options.forceDeposit) {
    return {
      changed: false,
      writtenPaths: [],
      preservedCustomPaths: [],
      skillsDirs: [],
      skipped: true,
      skipReason: "openclaw-not-detected",
      detect,
      present: false,
    };
  }

  const skillsDirs =
    options.skillsDirs !== undefined
      ? [...options.skillsDirs]
      : listInScopeSkillsDirs(detect.stateDir, options.allAgents === true, {
          isDir,
          readDir: options.readDir,
        });

  const expected = formatOpenClawSoftRebindSkillMarkdown();
  const writtenPaths: string[] = [];
  const preservedCustomPaths: string[] = [];
  let changed = false;
  let presentCount = 0;

  for (const skillsDir of skillsDirs) {
    const skillDir = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID);
    const skillFile = join(skillDir, "SKILL.md");
    const kind = defaultLstatKind(skillDir);

    if (kind === "symlink" && isEscapingSkillSymlink(skillsDir, skillDir)) {
      // Replace unusable escaping symlink with a real copy.
      try {
        rmSync(skillDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    if (existsSync(skillFile)) {
      let existing = "";
      try {
        existing = readFileSync(skillFile, "utf8");
      } catch {
        existing = "";
      }
      if (existing.length > 0 && !isManagedOpenClawSoftRebindSkill(existing)) {
        preservedCustomPaths.push(skillFile);
        presentCount += 1;
        continue;
      }
      if (existing === expected) {
        presentCount += 1;
        continue;
      }
    }

    mkdirSync(skillDir, { recursive: true });
    const tmpName = `SKILL.md.deft-${process.pid}-${Date.now().toString(36)}.tmp`;
    const staging = join(skillDir, tmpName);
    try {
      // Contained write under skills root (#2951) — refuses symlink escape.
      containedWrite({
        root: skillsDir,
        target: staging,
        data: expected,
        mode: "replace",
      });
      renameSync(staging, skillFile);
    } catch (err) {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* best-effort */
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/contained write refused|symlink|escape/i.test(msg)) {
        preservedCustomPaths.push(skillFile);
        continue;
      }
      throw err;
    }
    writtenPaths.push(skillFile);
    changed = true;
    presentCount += 1;
  }

  return {
    changed,
    writtenPaths,
    preservedCustomPaths,
    skillsDirs,
    skipped: false,
    detect,
    present: presentCount === skillsDirs.length && skillsDirs.length > 0,
  };
}
