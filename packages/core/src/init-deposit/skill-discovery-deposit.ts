/**
 * Multi-host thin skill discovery deposit (#75 residual).
 *
 * Mirrors the consumer skill inventory already written to `.agents/skills/`
 * into additional host paths (`.claude/skills/`, `.codex/skills/`,
 * `.github/skills/`, `.cursor/skills/`). Thin pointers only — no full skill
 * body copies. Windows-safe file writes (no elevated symlink requirement).
 *
 * Distinct from epic #55 slash-command deposit (#3054).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertDestinationNotSymlink } from "../fs/projection-containment.js";
import type { InitDepositIo } from "./constants.js";
import {
  type HostSkillDiscoveryPolicy,
  hostSkillRelativePath,
  isHostSkillDiscoveryEnabled,
  listSkillDiscoveryHosts,
  loadHostSkillDiscoveryPolicyFromProject,
  loadHostSkillDiscoveryRawFromProject,
  resolveHostSkillDiscoveryPolicyDetailed,
  SKILL_DISCOVERY_HOSTS,
  type SkillDiscoveryHostId,
  validateHostSkillDiscovery,
} from "./skill-discovery-hosts.js";

export type { InitDepositIo };

/**
 * Consumer skill discovery inventory shared by `.agents/skills/` and multi-host
 * deposit. Each entry is a thin SKILL.md pointer into `.deft/core/…` — never a
 * full skill body. Keep this list the single SoT for install-time discovery.
 */
export const CONSUMER_SKILL_DISCOVERY_INVENTORY: ReadonlyArray<{
  dir: string;
  content: string;
}> = [
  {
    dir: "deft",
    content: `---
name: deft
description: Apply deft framework standards for AI-assisted development. Use when starting projects, writing code, running tests, making commits, or when the user references deft, project standards, or coding guidelines.
---

Read and follow: .deft/core/SKILL.md
`,
  },
  {
    dir: "deft-directive-setup",
    content: `---
name: deft-directive-setup
description: >-
  Set up a new project with Deft framework standards. Use when the user wants
  to bootstrap user preferences, configure a project, or generate a project
  specification. Walks through setup conversationally — no separate CLI needed.
---

Read and follow: .deft/core/skills/deft-directive-setup/SKILL.md
`,
  },
  {
    dir: "deft-directive-build",
    content: `---
name: deft-directive-build
description: >-
  Build a project from scope vBRIEFs following Deft framework standards.
  Use after deft-directive-setup has generated the project definition, or when
  the user has scope vBRIEFs ready to implement. Handles scaffolding,
  implementation, testing, and quality checks phase by phase.
---

Read and follow: .deft/core/skills/deft-directive-build/SKILL.md
`,
  },
  {
    dir: "deft-directive-review-cycle",
    content: `---
name: deft-directive-review-cycle
description: >-
  Greptile bot reviewer response workflow. Use when running a review cycle
  on a PR — to audit process prerequisites, fetch bot findings, fix all
  issues in a single batch commit, and exit cleanly when no P0/P1 issues
  remain. Enables cloud agents to run autonomous PR review cycles.
---

Read and follow: .deft/core/skills/deft-directive-review-cycle/SKILL.md
`,
  },
  {
    dir: "deft-directive-refinement",
    content: `---
name: deft-directive-refinement
description: >-
  Structured refinement workflow. Compares open GitHub issues against
  the roadmap, triages new issues one-at-a-time with human review, and updates
  the roadmap with phase placement, analysis comments, and index entries.
---

Read and follow: .deft/core/skills/deft-directive-refinement/SKILL.md
`,
  },
  {
    dir: "deft-directive-swarm",
    content: `---
name: deft-directive-swarm
description: >-
  Parallel local agent orchestration. Use when running multiple agents
  on roadmap items simultaneously — to select non-overlapping tasks, set up
  isolated worktrees, launch agents with proven prompts, monitor progress,
  handle stalled review cycles, and close out PRs cleanly.
---

Read and follow: .deft/core/skills/deft-directive-swarm/SKILL.md
`,
  },
  {
    dir: "deft-directive-interview",
    content: `---
name: deft-directive-interview
description: >-
  Deterministic structured Q&A interview skill. Use when a skill or workflow
  needs to collect structured answers from the user — one question per turn,
  numbered options, default acceptance, and a confirmation gate.
---

Read and follow: .deft/core/skills/deft-directive-interview/SKILL.md
`,
  },
  {
    dir: "deft-directive-pre-pr",
    content: `---
name: deft-directive-pre-pr
description: >-
  Iterative pre-PR quality loop (Read-Write-Lint-Diff-Loop). Use before
  pushing a branch for PR creation — structured self-review that agents run
  to catch issues before they reach the bot reviewer.
---

Read and follow: .deft/core/skills/deft-directive-pre-pr/SKILL.md
`,
  },
  {
    dir: "deft-directive-sync",
    content: `---
name: deft-directive-sync
description: >-
  Session-start framework sync skill. Use at the beginning of a session to
  pull latest framework updates, validate project files, and confirm alignment
  before starting work.
---

Read and follow: .deft/core/skills/deft-directive-sync/SKILL.md
`,
  },
];

/** Max bytes for a thin pointer body — fat full-skill copies fail this guard. */
export const MAX_THIN_SKILL_POINTER_BYTES = 1200;

/**
 * True when content is a thin discovery pointer (not an inlined skill body).
 * Managed deposit must stay pointer-shaped so updates do not rot full copies.
 */
export function isThinSkillPointer(content: string): boolean {
  if (content.length > MAX_THIN_SKILL_POINTER_BYTES) return false;
  if (!content.includes("Read and follow:")) return false;
  // Canonical consumer target lives under the deposited framework root.
  if (!content.includes(".deft/core/")) return false;
  // Reject bodies that look like full skill process docs.
  if (/\n##\s+Phase\b/i.test(content)) return false;
  if (/\n##\s+Anti-?[Pp]atterns\b/i.test(content)) return false;
  return true;
}

function projectionTarget(projectDir: string, ...relSegments: string[]): string {
  const target = join(projectDir, ...relSegments);
  assertDestinationNotSymlink(projectDir, target);
  return target;
}

function containedProjectWrite(projectDir: string, target: string, data: string): void {
  containedWrite({
    root: resolve(projectDir),
    target,
    data,
    mode: "replace",
  });
}

export interface MultiHostSkillDiscoveryDepositResult {
  readonly changed: boolean;
  /** Repo-relative posix paths written or rewritten. */
  readonly changedPaths: string[];
  /** Hosts that received at least one write. */
  readonly hostsTouched: SkillDiscoveryHostId[];
  /** Hosts skipped because `plan.policy.hostSkillDiscovery.<host>` is false. */
  readonly hostsSkipped: SkillDiscoveryHostId[];
}

export interface WriteMultiHostSkillDiscoveryOptions {
  /** Override policy (tests); default loads from PROJECT-DEFINITION. */
  policy?: HostSkillDiscoveryPolicy;
  /**
   * Skill inventory to deposit. Defaults to the shared consumer inventory
   * (same set as `.agents/skills/`).
   */
  inventory?: ReadonlyArray<{ dir: string; content: string }>;
}

/**
 * Deposit thin skill discovery pointers into enabled multi-host paths.
 * Idempotent: skips write when on-disk content already matches. Never creates
 * symlinks (Windows-safe without elevation).
 */
export function writeMultiHostSkillDiscovery(
  projectDir: string,
  io: InitDepositIo,
  options: WriteMultiHostSkillDiscoveryOptions = {},
): MultiHostSkillDiscoveryDepositResult {
  const rawPolicy =
    options.policy !== undefined
      ? options.policy
      : loadHostSkillDiscoveryRawFromProject(projectDir);
  // Production validation surface (#75 SLizard P1): report malformed opt-outs
  // before resolving the deposit enablement map.
  for (const err of validateHostSkillDiscovery(rawPolicy)) {
    io.printf(`WARNING: ${err}\n`);
  }
  const resolved = resolveHostSkillDiscoveryPolicyDetailed(rawPolicy);
  for (const warning of resolved.warnings) {
    io.printf(`WARNING: ${warning}\n`);
  }
  if (resolved.refuseAll) {
    return {
      changed: false,
      changedPaths: [],
      hostsTouched: [],
      hostsSkipped: [...listSkillDiscoveryHosts()],
    };
  }
  // Prefer the public project-root loader when reading disk so policy inspection
  // and deposit share one production call path (not test-only exports).
  const policy =
    options.policy !== undefined
      ? resolved.policy
      : loadHostSkillDiscoveryPolicyFromProject(projectDir);
  const inventory = options.inventory ?? CONSUMER_SKILL_DISCOVERY_INVENTORY;

  for (const skill of inventory) {
    if (!isThinSkillPointer(skill.content)) {
      throw new Error(
        `skill discovery inventory entry "${skill.dir}" is not a thin pointer; ` +
          `refusing multi-host deposit (#75 non-inlining).`,
      );
    }
  }

  const changedPaths: string[] = [];
  const hostsTouched = new Set<SkillDiscoveryHostId>();
  const hostsSkipped: SkillDiscoveryHostId[] = [];

  for (const hostId of listSkillDiscoveryHosts()) {
    if (!isHostSkillDiscoveryEnabled(hostId, policy)) {
      hostsSkipped.push(hostId);
      continue;
    }

    for (const skill of inventory) {
      const rel = hostSkillRelativePath(hostId, skill.dir);
      const segments = rel.split("/");
      const abs = projectionTarget(projectDir, ...segments);

      let existing: string | null = null;
      if (existsSync(abs)) {
        try {
          existing = readFileSync(abs, "utf8");
        } catch {
          existing = null;
        }
      }
      if (existing === skill.content) {
        continue;
      }
      // Never clobber consumer-authored host skills. Only create missing
      // files or rewrite prior managed thin pointers (#75 Greptile P1).
      if (existing !== null && !isThinSkillPointer(existing)) {
        io.printf(
          `Skill discovery (#75): preserving consumer skill at ${rel} (not a managed thin pointer).\n`,
        );
        continue;
      }

      containedProjectWrite(projectDir, abs, skill.content);
      changedPaths.push(rel.replace(/\\/g, "/"));
      hostsTouched.add(hostId);
    }
  }

  if (hostsSkipped.length > 0) {
    io.printf(
      `Skill discovery multi-host opt-out (plan.policy.hostSkillDiscovery): skipped ${hostsSkipped.join(", ")}\n`,
    );
  }

  if (changedPaths.length > 0) {
    const hostList = [...hostsTouched].join(", ");
    io.printf(
      `Multi-host skill discovery deposit (#75): wrote ${changedPaths.length} thin pointer(s) for host(s): ${hostList}\n`,
    );
  } else if (hostsSkipped.length < SKILL_DISCOVERY_HOSTS.length) {
    io.printf("Multi-host skill discovery deposit (#75): already current — skipping.\n");
  }

  return {
    changed: changedPaths.length > 0,
    changedPaths,
    hostsTouched: [...hostsTouched],
    hostsSkipped,
  };
}

/**
 * Shared inventory helper for `.agents/skills/` (canonical) deposit.
 * Returns true when any pointer was created (matching writeAgentsSkills).
 */
export function writeAgentsSkillsFromInventory(
  projectDir: string,
  io: InitDepositIo,
  inventory: ReadonlyArray<{ dir: string; content: string }> = CONSUMER_SKILL_DISCOVERY_INVENTORY,
): boolean {
  projectionTarget(projectDir, ".agents");

  const allExist = inventory.every((skill) =>
    existsSync(join(projectDir, ".agents", "skills", skill.dir, "SKILL.md")),
  );
  if (allExist) {
    io.printf(".agents/skills/ already present — skipping.\n");
    return false;
  }

  for (const skill of inventory) {
    if (!isThinSkillPointer(skill.content)) {
      throw new Error(
        `skill discovery inventory entry "${skill.dir}" is not a thin pointer (#75).`,
      );
    }
    const path = projectionTarget(projectDir, ".agents", "skills", skill.dir, "SKILL.md");
    if (existsSync(path)) continue;
    containedProjectWrite(projectDir, path, skill.content);
  }

  io.printf(".agents/skills/ created — deft skills will be auto-discovered.\n");
  return true;
}
