/**
 * Multi-host init/update deposit for native slash command files (#3054 / epic #55).
 *
 * Wires #3053 emitters into the init/update deposit path:
 * - Default enabled set = hosts with real emitters (L6)
 * - Per-host opt-out via `plan.policy.hostSlashCommands`
 * - Idempotent managed rewrite (no duplicate pile-up)
 * - Prefer commit of generated dirs (L8) — staged via installer allowlist, not gitignored
 *
 * Parallel to agent-hooks deposit; does not touch hook JSON configs.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertDepositContained } from "../deposit/contain.js";
import { containedWrite } from "../fs/contained-write.js";
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
import type { InitDepositIo } from "./constants.js";

export interface SlashCommandDepositResult {
  readonly changed: boolean;
  /** Repo-relative paths written or updated. */
  readonly writtenPaths: string[];
  /** Repo-relative paths removed on opt-out (managed product files only). */
  readonly removedPaths: string[];
  /** Hosts that received a deposit pass (policy enabled). */
  readonly depositedHosts: SlashEmitterHostId[];
  /** Hosts skipped by policy opt-out. */
  readonly skippedHosts: SlashEmitterHostId[];
}

/**
 * Write thin-wrapper command/prompt files for every policy-enabled host.
 *
 * Idempotent: skips files whose on-disk bytes already match emission.
 * Opt-out: does not write that host; removes managed product-set files that still
 * match thin-wrapper shape (leaves user-customized files in those dirs alone).
 */
export function writeSlashCommandDeposit(
  projectRoot: string,
  io: InitDepositIo = { printf: () => undefined },
  policy: HostSlashCommandsPolicy = loadHostSlashCommandsPolicyFromProject(projectRoot),
): SlashCommandDepositResult {
  const rootAbs = resolve(projectRoot);
  const writtenPaths: string[] = [];
  const removedPaths: string[] = [];
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
      if (writeHostCommandFileIfChanged(rootAbs, file)) {
        writtenPaths.push(file.relativePath);
      }
    }
  }

  if (writtenPaths.length > 0) {
    const hostSummary = depositedHosts.join(", ");
    io.printf(
      `Installed Directive slash commands for hosts [${hostSummary}]: ${writtenPaths.length} file(s)\n`,
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
    depositedHosts,
    skippedHosts,
  };
}

/**
 * Repo-relative directory prefixes for installer allowlist / staging (L8 prefer commit).
 * Derived from emitter layouts — do not hardcode a second host list.
 */
export function slashCommandDepositDirPrefixes(): readonly string[] {
  return listSlashEmitterHosts().map((hostId) => `${getHostCommandLayout(hostId).relativeDir}/`);
}

function writeHostCommandFileIfChanged(projectRoot: string, file: HostEmittedFile): boolean {
  const absolute = join(projectRoot, file.relativePath);
  assertDepositContained(projectRoot, absolute);
  if (existsSync(absolute)) {
    try {
      if (readFileSync(absolute, "utf8") === file.contents) {
        return false;
      }
    } catch {
      // Fall through to rewrite if unreadable.
    }
  }

  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true });
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
    renameSync(temporary, absolute);
  } catch (err) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return true;
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
    // Only strip managed thin wrappers — never user customizations that fail the thin check.
    if (!isThinWrapperMarkdown(raw, file.dispatchPath) && raw !== file.contents) {
      continue;
    }
    try {
      rmSync(absolute, { force: true });
      removed.push(file.relativePath);
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
