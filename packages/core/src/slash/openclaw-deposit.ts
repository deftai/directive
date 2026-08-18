/**
 * OpenClaw L2 product-command skill deposit (#3064 D4–D5).
 *
 * Writes thin user-invocable skills into the OpenClaw **main workspace skills**
 * root (copy/stage — not symlink-escape into npm). Idempotent managed rewrite;
 * preserves consumer custom skills at the same slug.
 *
 * Primary operator path: `deft doctor --fix` when OpenClaw is detected.
 * init/update also deposits when OC signals are present and policy is on.
 *
 * ⊗ Fake project `.openclaw/commands/` file emitter.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectOpenClaw,
  isEscapingSkillSymlink,
  listInScopeSkillsDirs,
  type OpenClawDetectResult,
} from "../doctor/openclaw-skills.js";
import {
  containedMkdir,
  containedRemove,
  containedRename,
  containedWrite,
} from "../fs/contained-write.js";
import { isPortRecordMode } from "../fs/mutation-ledger.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import { loadProjectDefinition } from "../policy/resolve.js";
import {
  generateOpenClawSkillArtifacts,
  isManagedOpenClawL2Skill,
  listOpenClawManagedSkillSlugs,
  type OpenClawSkillArtifact,
} from "./openclaw-adapter.js";

/** Typed policy key: opt-out of OpenClaw L2 product-command adapter deposit. */
export const FIELD_OPENCLAW_PRODUCT_COMMANDS = "plan.policy.openClawProductCommands";
export const FIELD_OPENCLAW_PRODUCT_COMMANDS_CLI_ALIAS = "openClawProductCommands";

/** Default: adapter on when OpenClaw is detected (real adapter — D5). */
export const DEFAULT_OPENCLAW_PRODUCT_COMMANDS = true;

export type OpenClawProductCommandsPolicy = boolean;

export interface OpenClawProductCommandsPolicyField {
  readonly name: string;
  readonly current: OpenClawProductCommandsPolicy;
  readonly default: OpenClawProductCommandsPolicy;
  readonly source: string;
}

export interface OpenClawL2DepositResult {
  readonly changed: boolean;
  /** Absolute skill directory paths written/updated. */
  readonly writtenPaths: string[];
  /** Absolute paths removed on opt-out (managed only). */
  readonly removedPaths: string[];
  /** Absolute paths skipped (consumer custom content). */
  readonly preservedCustomPaths: string[];
  readonly skillsDirs: string[];
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly detect: OpenClawDetectResult | null;
}

export interface OpenClawL2DepositOptions {
  /** Project root for policy load (optional; defaults enabled when absent). */
  readonly projectRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /** Multi-seat parity with doctor --openclaw-all-agents. */
  readonly allAgents?: boolean;
  /** Explicit policy override (tests). */
  readonly policy?: OpenClawProductCommandsPolicy;
  readonly printf?: (text: string) => void;
  readonly isDir?: (path: string) => boolean;
  readonly readDir?: (path: string) => string[];
  /**
   * When true, deposit even if OpenClaw is not detected (tests only).
   * Production paths stay fail-closed when OC signals are absent (D5).
   */
  readonly forceDeposit?: boolean;
  /** Override skills roots (tests). */
  readonly skillsDirs?: readonly string[];
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve openClawProductCommands from raw policy value. */
export function resolveOpenClawProductCommandsPolicy(raw: unknown): OpenClawProductCommandsPolicy {
  if (typeof raw === "boolean") return raw;
  return DEFAULT_OPENCLAW_PRODUCT_COMMANDS;
}

export function validateOpenClawProductCommands(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "boolean") {
    return [`${FIELD_OPENCLAW_PRODUCT_COMMANDS} must be a boolean; got ${typeof value}`];
  }
  return [];
}

export function inspectOpenClawProductCommands(
  data: Record<string, unknown> | null,
): OpenClawProductCommandsPolicyField {
  if (data === null) {
    return {
      name: FIELD_OPENCLAW_PRODUCT_COMMANDS,
      current: DEFAULT_OPENCLAW_PRODUCT_COMMANDS,
      default: DEFAULT_OPENCLAW_PRODUCT_COMMANDS,
      source: "default",
    };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("openClawProductCommands" in (policyBlock as Record<string, unknown>))
  ) {
    return {
      name: FIELD_OPENCLAW_PRODUCT_COMMANDS,
      current: DEFAULT_OPENCLAW_PRODUCT_COMMANDS,
      default: DEFAULT_OPENCLAW_PRODUCT_COMMANDS,
      source: "default",
    };
  }
  return {
    name: FIELD_OPENCLAW_PRODUCT_COMMANDS,
    current: resolveOpenClawProductCommandsPolicy(
      (policyBlock as Record<string, unknown>).openClawProductCommands,
    ),
    default: DEFAULT_OPENCLAW_PRODUCT_COMMANDS,
    source: "typed",
  };
}

export function loadOpenClawProductCommandsPolicyFromProject(
  projectRoot: string,
): OpenClawProductCommandsPolicy {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) return DEFAULT_OPENCLAW_PRODUCT_COMMANDS;
  return inspectOpenClawProductCommands(data).current;
}

type WriteOutcome = "written" | "unchanged" | "preserved";

function skillDirLstatKind(path: string): "file" | "dir" | "symlink" | "other" | "missing" {
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

function writeSkillArtifact(skillsDir: string, artifact: OpenClawSkillArtifact): WriteOutcome {
  const skillDir = join(skillsDir, artifact.slug);
  const skillFile = join(skillDir, "SKILL.md");

  // #3064 Greptile P1 / #3008 spirit: never write through an escaping skill-dir symlink.
  const dirKind = skillDirLstatKind(skillDir);
  if (dirKind === "symlink" && isEscapingSkillSymlink(skillsDir, skillDir)) {
    return "preserved";
  }

  if (existsSync(skillFile)) {
    // Leaf symlink on SKILL.md that escapes skills root — refuse (containedWrite also fails closed).
    if (
      skillDirLstatKind(skillFile) === "symlink" &&
      isEscapingSkillSymlink(skillsDir, skillFile)
    ) {
      return "preserved";
    }
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      return "preserved";
    }
    if (raw === artifact.skillMarkdown) return "unchanged";
    // Ownership: only rewrite managed thin L2 skills.
    if (!isManagedOpenClawL2Skill(raw)) {
      return "preserved";
    }
  }

  containedMkdir({ root: skillsDir, target: skillDir });
  // Re-check after mkdir: concurrent symlink plant is fail-closed.
  if (skillDirLstatKind(skillDir) === "symlink" && isEscapingSkillSymlink(skillsDir, skillDir)) {
    return "preserved";
  }

  const tmpName = `SKILL.md.deft-${process.pid}-${Date.now().toString(36)}.tmp`;
  const tmp = join(skillDir, tmpName);
  try {
    // Contained write under skills root (#2951) — refuses symlink escape on the write path.
    containedWrite({
      root: skillsDir,
      target: tmp,
      data: artifact.skillMarkdown,
      mode: "replace",
    });
    containedRename({ root: skillsDir, from: tmp, to: skillFile, mutation: false });
  } catch (err) {
    try {
      containedRemove({ root: skillsDir, target: tmp, mutation: false });
    } catch {
      /* best-effort */
    }
    // Containment / symlink refusals: treat as preserved (do not clobber outside root).
    const msg = err instanceof Error ? err.message : String(err);
    if (/contained write refused|symlink|escape/i.test(msg)) {
      return "preserved";
    }
    throw err;
  }
  return "written";
}

function stripManagedSkills(skillsDir: string): string[] {
  const removed: string[] = [];
  for (const slug of listOpenClawManagedSkillSlugs()) {
    const skillDir = join(skillsDir, slug);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    if (!isManagedOpenClawL2Skill(raw)) continue;
    try {
      if (containedRemove({ root: skillsDir, target: skillDir, recursive: true }).removed) {
        removed.push(skillDir);
      }
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/**
 * Deposit OpenClaw L2 product-command skills into workspace skills roots.
 *
 * Fail-closed when OpenClaw is not detected (unless forceDeposit for tests).
 * Policy false → remove managed skills only (opt-out).
 */
export function depositOpenClawL2ProductCommands(
  options: OpenClawL2DepositOptions = {},
): OpenClawL2DepositResult {
  const printf = options.printf ?? (() => undefined);
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const isDir = options.isDir ?? defaultIsDir;
  const policy =
    options.policy ??
    (options.projectRoot
      ? loadOpenClawProductCommandsPolicyFromProject(options.projectRoot)
      : DEFAULT_OPENCLAW_PRODUCT_COMMANDS);

  const detect = detectOpenClaw(env, { homeDir: home, isDir });
  if (!detect.detected && !options.forceDeposit) {
    printf("OpenClaw L2 product commands: skip -- OpenClaw not detected\n");
    return {
      changed: false,
      writtenPaths: [],
      removedPaths: [],
      preservedCustomPaths: [],
      skillsDirs: [],
      skipped: true,
      skipReason: "openclaw-not-detected",
      detect,
    };
  }

  const skillsDirs =
    options.skillsDirs !== undefined
      ? [...options.skillsDirs]
      : listInScopeSkillsDirs(detect.stateDir, options.allAgents === true, {
          isDir,
          readDir: options.readDir,
        });

  const writtenPaths: string[] = [];
  const removedPaths: string[] = [];
  const preservedCustomPaths: string[] = [];

  if (!policy) {
    for (const skillsDir of skillsDirs) {
      if (!isPortRecordMode()) mkdirSync(skillsDir, { recursive: true });
      removedPaths.push(...stripManagedSkills(skillsDir));
    }
    if (removedPaths.length > 0) {
      printf(
        `Removed Directive-managed OpenClaw L2 product skills (plan.policy.openClawProductCommands opt-out): ${removedPaths.length}\n`,
      );
    } else {
      printf("OpenClaw L2 product commands: opted out (policy false); nothing to remove\n");
    }
    return {
      changed: removedPaths.length > 0,
      writtenPaths,
      removedPaths,
      preservedCustomPaths,
      skillsDirs,
      skipped: false,
      detect,
    };
  }

  const artifacts = generateOpenClawSkillArtifacts();
  for (const skillsDir of skillsDirs) {
    if (!isPortRecordMode()) mkdirSync(skillsDir, { recursive: true });
    for (const artifact of artifacts) {
      const outcome = writeSkillArtifact(skillsDir, artifact);
      const abs = join(skillsDir, artifact.slug);
      if (outcome === "written") writtenPaths.push(abs);
      if (outcome === "preserved") preservedCustomPaths.push(abs);
    }
  }

  if (writtenPaths.length > 0) {
    printf(
      `Installed OpenClaw L2 product-command skills (${artifacts.length} per skills root; router + ${PRODUCT_COUNT_LABEL}): ${writtenPaths.length} path(s)\n`,
    );
  } else if (preservedCustomPaths.length === 0) {
    printf("OpenClaw L2 product-command skills already current.\n");
  }
  if (preservedCustomPaths.length > 0) {
    printf(
      `Preserved non-managed OpenClaw skills at product slugs: ${preservedCustomPaths.join(", ")}\n`,
    );
  }

  return {
    changed: writtenPaths.length + removedPaths.length > 0,
    writtenPaths,
    removedPaths,
    preservedCustomPaths,
    skillsDirs,
    skipped: false,
    detect,
  };
}

const PRODUCT_COUNT_LABEL = "13 product";

/** Resolve absolute main skills dir for a state dir (test helper re-export path). */
export function resolveOpenClawMainSkillsDirForState(stateDir: string): string {
  return join(resolve(stateDir), "workspace", "skills");
}
