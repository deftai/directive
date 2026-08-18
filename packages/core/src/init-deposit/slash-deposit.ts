/**
 * Multi-host init/update deposit for native slash command files (#3054 / epic #55).
 *
 * Wires #3053 emitters into the init/update deposit path:
 * - Default enabled set = hosts with real emitters (L6)
 * - Per-host opt-out via `plan.policy.hostSlashCommands`
 * - Idempotent managed rewrite (no duplicate pile-up)
 * - Prefer commit of **managed product paths only** (L8) — exact allowlist, not whole dirs
 *
 * Parallel to agent-hooks deposit; does not touch hook JSON configs.
 *
 * Ownership: only create/update/remove files that are missing or still look like
 * Directive thin wrappers (`isThinWrapperMarkdown`). Consumer-customized content
 * at a product filename is left untouched.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertDepositContained } from "../deposit/contain.js";
import {
  containedRemove,
  containedWrite,
  finishContainedAtomicReplace,
} from "../fs/contained-write.js";
import { isCollectOnlyActive } from "../fs/mutation-ledger.js";
import {
  type HostSlashCommandsPolicy,
  isHostSlashCommandDepositEnabled,
  loadHostSlashCommandsPolicyFromProject,
} from "../policy/host-slash-commands.js";
import {
  emitHostCommandFiles,
  getHostCommandLayout,
  type HostEmittedFile,
  isThinWrapperMarkdown,
  listSlashEmitterHosts,
  type SlashEmitterHostId,
} from "../slash/index.js";
import { listProductCommands, logicalIdToFilename } from "../slash/product-set.js";
import type { InitDepositIo } from "./constants.js";

export interface SlashCommandDepositResult {
  readonly changed: boolean;
  /** Repo-relative paths written or updated. */
  readonly writtenPaths: string[];
  /** Repo-relative paths removed on opt-out (managed product files only). */
  readonly removedPaths: string[];
  /** Repo-relative paths skipped because consumer content is not managed. */
  readonly preservedCustomPaths: string[];
  /** Hosts that received a deposit pass (policy enabled). */
  readonly depositedHosts: SlashEmitterHostId[];
  /** Hosts skipped by policy opt-out. */
  readonly skippedHosts: SlashEmitterHostId[];
}

/**
 * Write thin-wrapper command/prompt files for every policy-enabled host.
 *
 * Idempotent: skips files whose on-disk bytes already match emission.
 * Ownership-safe: never overwrites non-thin consumer customizations at product paths.
 * Opt-out: removes managed thin wrappers only (leaves user customizations alone).
 */
export function writeSlashCommandDeposit(
  projectRoot: string,
  io: InitDepositIo = { printf: () => undefined },
  policy: HostSlashCommandsPolicy = loadHostSlashCommandsPolicyFromProject(projectRoot),
): SlashCommandDepositResult {
  const rootAbs = resolve(projectRoot);
  const writtenPaths: string[] = [];
  const removedPaths: string[] = [];
  const preservedCustomPaths: string[] = [];
  const depositedHosts: SlashEmitterHostId[] = [];
  const skippedHosts: SlashEmitterHostId[] = [];

  for (const hostId of listSlashEmitterHosts()) {
    if (!isHostSlashCommandDepositEnabled(hostId, policy)) {
      skippedHosts.push(hostId);
      removedPaths.push(...stripManagedHostCommandFiles(rootAbs, hostId));
      continue;
    }
    depositedHosts.push(hostId);
    const files = emitHostCommandFiles(hostId);
    for (const file of files) {
      const outcome = writeHostCommandFileIfChanged(rootAbs, file);
      if (outcome === "written") writtenPaths.push(file.relativePath);
      if (outcome === "preserved") preservedCustomPaths.push(file.relativePath);
    }
  }

  if (writtenPaths.length > 0) {
    const hostSummary = depositedHosts.join(", ");
    io.printf(
      `Installed Directive slash commands for hosts [${hostSummary}]: ${writtenPaths.length} file(s)\n`,
    );
  }
  if (preservedCustomPaths.length > 0) {
    io.printf(
      `Preserved non-managed slash command customizations: ${preservedCustomPaths.join(", ")}\n`,
    );
  }
  if (removedPaths.length > 0) {
    io.printf(
      `Removed Directive-managed slash commands (plan.policy.hostSlashCommands opt-out): ${removedPaths.join(", ")}\n`,
    );
  }
  if (writtenPaths.length === 0 && removedPaths.length === 0) {
    if (depositedHosts.length === 0) {
      io.printf(
        "Directive slash commands: all hosts opted out via plan.policy.hostSlashCommands.\n",
      );
    } else {
      io.printf("Directive slash commands already current.\n");
    }
  }

  return {
    changed: writtenPaths.length + removedPaths.length > 0,
    writtenPaths,
    removedPaths,
    preservedCustomPaths,
    depositedHosts,
    skippedHosts,
  };
}

/**
 * Exact repo-relative product command paths (all emitter hosts).
 * Used by installerManagedMatchers for L8 prefer-commit staging without
 * claiming whole host command directories (consumer custom files stay app-owned).
 */
export function slashCommandManagedExactPaths(): readonly string[] {
  const paths: string[] = [];
  for (const hostId of listSlashEmitterHosts()) {
    const dir = getHostCommandLayout(hostId).relativeDir;
    for (const cmd of listProductCommands()) {
      paths.push(`${dir}/${logicalIdToFilename(cmd.logicalId)}`);
    }
  }
  return paths;
}

type WriteOutcome = "written" | "unchanged" | "preserved";

function isManagedThinContent(raw: string, file: HostEmittedFile): boolean {
  return raw === file.contents || isThinWrapperMarkdown(raw, file.dispatchPath);
}

function writeHostCommandFileIfChanged(projectRoot: string, file: HostEmittedFile): WriteOutcome {
  const absolute = join(projectRoot, file.relativePath);
  assertDepositContained(projectRoot, absolute);
  if (existsSync(absolute)) {
    let raw: string;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch {
      // Unreadable existing file: do not clobber consumer content.
      return "preserved";
    }
    if (raw === file.contents) return "unchanged";
    // Ownership gate: only rewrite managed thin wrappers.
    if (!isManagedThinContent(raw, file)) {
      return "preserved";
    }
  }

  const parent = dirname(absolute);
  if (!isCollectOnlyActive()) {
    mkdirSync(parent, { recursive: true });
  }
  // Atomic replace via temp under project root (#2951).
  const tmpName = `${basename(absolute)}.deft-${process.pid}.tmp`;
  const temporary = join(parent, tmpName);
  try {
    containedWrite({
      root: projectRoot,
      target: temporary,
      data: file.contents,
      mode: "replace",
    });
    finishContainedAtomicReplace(temporary, absolute);
  } catch (err) {
    try {
      containedRemove({ root: projectRoot, target: temporary, mutation: false });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return "written";
}

/**
 * On opt-out, remove only product-set managed thin wrappers for that host.
 * User-authored or non-thin files under the host command dir are left untouched.
 */
function stripManagedHostCommandFiles(projectRoot: string, hostId: SlashEmitterHostId): string[] {
  const removed: string[] = [];
  const files = emitHostCommandFiles(hostId);
  for (const file of files) {
    const absolute = join(projectRoot, file.relativePath);
    assertDepositContained(projectRoot, absolute);
    if (!existsSync(absolute)) continue;
    let raw: string;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (!isManagedThinContent(raw, file)) {
      continue;
    }
    try {
      if (containedRemove({ root: projectRoot, target: absolute }).removed) {
        removed.push(file.relativePath);
      }
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
