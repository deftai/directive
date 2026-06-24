/**
 * TS-native greenfield init deposit orchestrator (#1942 S2).
 *
 * Composes the S1 resolve-and-copy primitive with AGENTS.md render, vbrief
 * scaffold, skills/githooks/#1430 neutralization, and Taskfile wiring.
 * Refs #1942, #11, #1430.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { copyTree } from "../deposit/copy-tree.js";
import { resolveInstalledContentRoot } from "../deposit/resolve-content.js";
import { readCorePackageVersion } from "../engine-version.js";
import { ensureInitGitignoreLines, reconstituteDepositFromContent } from "./gitignore.js";
import {
  CANONICAL_INSTALL_ROOT,
  depositNeutralization,
  ensureTaskfile,
  type InitDepositIo,
  type InstallManifestFields,
  writeAgentsMd,
  writeAgentsSkills,
  writeConsumerGitHooks,
  writeConsumerVbrief,
  writeInstallManifest,
} from "./scaffold.js";

export interface InitDepositArgs {
  readonly projectDir: string;
  readonly jsonOut: boolean;
  readonly nonInteractive: boolean;
}

export interface InitDepositResult {
  readonly projectDir: string;
  readonly deftDir: string;
  readonly skillsCreated: boolean;
  readonly taskfileWired: boolean;
  readonly configDir: string;
}

export interface InitDepositSeams {
  resolveContentRoot?: () => Promise<string>;
  copyContent?: (src: string, dst: string) => Promise<void>;
  readPackageVersion?: () => string;
  nowIso?: () => string;
  gitHooks?: Parameters<typeof writeConsumerGitHooks>[3];
}

export function parseInitArgv(
  canonicalArgv: readonly string[],
  userArgv: readonly string[] = [],
): InitDepositArgs {
  const args = [...canonicalArgv, ...userArgv];
  let projectDir = process.cwd();
  let jsonOut = false;
  let nonInteractive = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json" || arg === "/json") jsonOut = true;
    if (
      arg === "--yes" ||
      arg === "--non-interactive" ||
      arg === "/yes" ||
      arg === "/non-interactive"
    ) {
      nonInteractive = true;
    }
    if ((arg === "--repo-root" || arg === "/repo-root") && args[i + 1]) {
      projectDir = resolve(args[i + 1] ?? projectDir);
      i += 1;
    }
  }

  return { projectDir: resolve(projectDir), jsonOut, nonInteractive };
}

export function userConfigDir(): string {
  const override = process.env.DEFT_USER_PATH?.trim();
  if (override) return resolve(override);
  if (platform() === "win32") {
    const appData = process.env.APPDATA?.trim();
    return appData ? join(appData, "deft") : join(homedir(), "AppData", "Roaming", "deft");
  }
  return join(homedir(), ".config", "deft");
}

export function createUserConfigDir(io: InitDepositIo): string {
  const dir = userConfigDir();
  mkdirSync(dir, { recursive: true });
  const userMd = join(dir, "USER.md");
  if (existsSync(userMd)) {
    io.printf(`USER.md already exists at ${userMd} — keeping existing file.\n`);
  }
  return dir;
}

function readContentVersion(contentRoot: string, readVersion = readCorePackageVersion): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(contentRoot, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const version = (parsed as { version?: string }).version;
      if (version?.trim()) return version.trim();
    }
  } catch {
    // fall through
  }
  return readVersion();
}

export function buildInstallSummaryJson(
  result: InitDepositResult,
  options: InitDepositArgs,
): Record<string, unknown> {
  return {
    success: true,
    action: "install",
    version: readCorePackageVersion(),
    project_dir: result.projectDir,
    deft_dir: result.deftDir,
    legacy_layout: false,
    update: false,
    non_interactive: options.nonInteractive,
    upgrade: false,
    taskfile_wired: result.taskfileWired,
    missing_tools: [],
    maintainer_mode: false,
    maintainer_tools: [],
    skipped_consumer_projections: [],
    user_config_dir: result.configDir,
    skills_created: result.skillsCreated,
    payload_layout: "vendored",
    strategy: "vendor",
    dirty_tree: false,
    dirty_files: [],
    staged_paths: [],
    backup_path: "",
    previous_version: "",
  };
}

export function printNextSteps(result: InitDepositResult, io: InitDepositIo): void {
  const skillsStatus = result.skillsCreated ? "created" : "already present";
  io.printf("\n✓ Deft installed successfully!\n\n");
  io.printf(`  Location     : ${result.deftDir}\n`);
  io.printf("  AGENTS.md    : updated\n");
  io.printf(`  Skills       : .agents/skills/ ${skillsStatus} (auto-discovered by AI agents)\n`);
  io.printf(`  User config  : ${result.configDir}\n`);
  io.printf("\nNext steps:\n");
  io.printf(`  1. Open your AI coding assistant in ${result.projectDir}\n`);
  io.printf("  2. Deft skill auto-discovery is partially implemented — if your agent doesn't\n");
  io.printf('     start setup automatically, tell it: "Use AGENTS.md"\n');
  io.printf(
    "  3. On first session, the agent will guide you through creating USER.md and PROJECT-DEFINITION.vbrief.json\n",
  );
  io.printf("\n");
}

export async function runInitDeposit(
  args: InitDepositArgs,
  io: InitDepositIo,
  seams: InitDepositSeams = {},
): Promise<InitDepositResult> {
  const projectDir = args.projectDir;
  const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);
  const resolveContent = seams.resolveContentRoot ?? resolveInstalledContentRoot;
  const copyContent = seams.copyContent ?? copyTree;

  const contentRoot = await resolveContent();
  await reconstituteDepositFromContent(contentRoot, deftDir, copyContent);
  ensureInitGitignoreLines(projectDir, io);

  const nowIso = seams.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const version = readContentVersion(
    contentRoot,
    seams.readPackageVersion ?? readCorePackageVersion,
  );
  const manifestFields: InstallManifestFields = {
    ref: version.startsWith("v") ? version : `v${version}`,
    sha: "content-package",
    tag: version.startsWith("v") ? version : `v${version}`,
    installRoot: CANONICAL_INSTALL_ROOT,
    fetchedAt: nowIso(),
    fetchedBy: "directive-init",
  };
  writeInstallManifest(projectDir, deftDir, manifestFields);

  writeAgentsMd(projectDir, deftDir, io);
  const skillsCreated = writeAgentsSkills(projectDir, io);
  await depositNeutralization(projectDir, io);
  await writeConsumerVbrief(projectDir, deftDir, io);
  writeConsumerGitHooks(projectDir, deftDir, io, seams.gitHooks);

  let taskfileWired = false;
  if (args.nonInteractive) {
    taskfileWired = ensureTaskfile(projectDir, io);
  }

  const configDir = createUserConfigDir(io);

  return {
    projectDir,
    deftDir,
    skillsCreated,
    taskfileWired,
    configDir,
  };
}

export interface RunInitDepositCliOptions extends InitDepositArgs {
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: InitDepositSeams;
}

/** CLI-facing wrapper: runs deposit, emits JSON or wizard UX, returns exit code. */
export async function runInitDepositCli(options: RunInitDepositCliOptions): Promise<number> {
  const io: InitDepositIo = {
    printf: (text) => {
      if (options.jsonOut) {
        options.writeErr(text);
      } else {
        options.writeOut(text);
      }
    },
  };

  try {
    const result = await runInitDeposit(options, io, options.seams);
    if (options.jsonOut) {
      options.writeOut(`${JSON.stringify(buildInstallSummaryJson(result, options), null, 2)}\n`);
      printNextSteps(result, { printf: options.writeErr });
    } else {
      printNextSteps(result, io);
    }
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    options.writeErr(`directive init: ${message}\n`);
    if (options.jsonOut) {
      options.writeOut(
        `${JSON.stringify({ success: false, error: message, error_code: "init_deposit_failed" }, null, 2)}\n`,
      );
    }
    return 1;
  }
}
