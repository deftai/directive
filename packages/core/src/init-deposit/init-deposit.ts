/**
 * TS-native greenfield init deposit orchestrator (#1942 S2).
 *
 * Composes the S1 resolve-and-copy primitive with AGENTS.md render, vbrief
 * scaffold, skills/githooks/#1430 neutralization, and Taskfile wiring.
 * Refs #1942, #11, #1430.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertDepositContained } from "../deposit/contain.js";
import { copyTree } from "../deposit/copy-tree.js";
import { prunePythonArtifactsFromDeposit } from "../deposit/python-free.js";
import { resolveInstalledContentRoot } from "../deposit/resolve-content.js";
import { readCorePackageVersion } from "../engine-version.js";
import { renderProjectDefinition } from "../render/project-render.js";
import { writeAgentHookDeposit } from "./agent-hooks.js";
import { ensureInitGitignoreLines, reconstituteDepositFromContent } from "./gitignore.js";
import { depositStagePaths, printCommitGuidance } from "./hygiene.js";
import {
  buildLegacyRefusalJson,
  buildLegacyRefusalMessage,
  detectLegacyLayout,
  LEGACY_LAYOUT_REFUSED_EXIT_CODE,
  type LegacyLayoutDetection,
  LegacyLayoutRefusedError,
} from "./legacy-detect.js";
import { printMigrateNudgeIfNeeded } from "./migrate.js";
import { ensurePrettierIgnoreLines } from "./prettierignore.js";
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
  readonly legacyLayout: boolean;
  readonly stagedPaths: string[];
}

export interface InitDepositSeams {
  resolveContentRoot?: () => Promise<string>;
  copyContent?: (src: string, dst: string) => Promise<void>;
  readPackageVersion?: () => string;
  nowIso?: () => string;
  gitHooks?: Parameters<typeof writeConsumerGitHooks>[3];
  detectLegacy?: (projectDir: string) => LegacyLayoutDetection;
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
    legacy_layout: result.legacyLayout,
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
    staged_paths: result.stagedPaths,
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
    "  3. On first session, the agent will guide you through USER.md (if missing).\n",
  );
  io.printf(
    "  4. PROJECT-DEFINITION is seeded at init (#3013) — run `task project:render` once to refresh items from lifecycle folders; do not multi-turn invent project identity.\n",
  );
  printMigrateNudgeIfNeeded(result.projectDir, io);
  io.printf("\n");
}

/**
 * Ensure a minimal render-ready PROJECT-DEFINITION exists after lifecycle dirs
 * are deposited (#3013 / epic #3009). Idempotent: never overwrites existing identity.
 */
export function seedMinimalProjectDefinition(projectDir: string, io: InitDepositIo): boolean {
  const xbriefDir = join(projectDir, "xbrief");
  const legacyDir = join(projectDir, "vbrief");
  const root = existsSync(xbriefDir) ? xbriefDir : existsSync(legacyDir) ? legacyDir : null;
  if (root === null) {
    return false;
  }
  const isXbrief = basename(root) === "xbrief";
  const projectDefPath = join(
    root,
    isXbrief ? "PROJECT-DEFINITION.xbrief.json" : "PROJECT-DEFINITION.vbrief.json",
  );
  if (existsSync(projectDefPath)) {
    io.printf("PROJECT-DEFINITION already present — leaving identity intact (#3013).\n");
    return false;
  }
  const [ok, message] = renderProjectDefinition(root);
  if (ok) {
    io.printf(`${message} (minimal seed for one-shot project:render; #3013)\n`);
    return true;
  }
  io.printf(`PROJECT-DEFINITION seed skipped: ${message}\n`);
  return false;
}

export async function runInitDeposit(
  args: InitDepositArgs,
  io: InitDepositIo,
  seams: InitDepositSeams = {},
): Promise<InitDepositResult> {
  const projectDir = args.projectDir;
  const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);

  // #1912: refuse a legacy on-disk layout BEFORE any deposit. The npm CLI never
  // migrates -- the frozen Go bridge does (stage 1), then the npm path (stage 2).
  const detectLegacy = seams.detectLegacy ?? detectLegacyLayout;
  const legacy = detectLegacy(projectDir);
  if (legacy.legacy) {
    throw new LegacyLayoutRefusedError(legacy);
  }

  // #2305: refuse a symlink-escaping deposit boundary BEFORE the first
  // copy/reconstitute/mkdir, so a malicious `.deft`/`.deft/core` symlink cannot
  // redirect the deposit outside the resolved project tree. Deposits nothing on
  // refusal.
  assertDepositContained(projectDir, deftDir);

  const resolveContent = seams.resolveContentRoot ?? resolveInstalledContentRoot;
  const copyContent = seams.copyContent ?? copyTree;

  const contentRoot = await resolveContent();
  await reconstituteDepositFromContent(contentRoot, deftDir, copyContent);
  await prunePythonArtifactsFromDeposit(deftDir, projectDir, io);
  ensureInitGitignoreLines(projectDir, io);
  ensurePrettierIgnoreLines(projectDir, io);

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
  seedMinimalProjectDefinition(projectDir, io);
  writeConsumerGitHooks(projectDir, deftDir, io, seams.gitHooks);
  writeAgentHookDeposit(projectDir, io);

  let taskfileWired = false;
  if (args.nonInteractive) {
    taskfileWired = ensureTaskfile(projectDir, io);
  }

  const configDir = createUserConfigDir(io);

  const { stagePaths, staged, stagedPaths } = depositStagePaths(projectDir, {
    includeTaskfile: taskfileWired,
  });
  printCommitGuidance(io, stagePaths, staged);

  return {
    projectDir,
    deftDir,
    skillsCreated,
    taskfileWired,
    configDir,
    legacyLayout: false,
    stagedPaths,
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
    if (cause instanceof LegacyLayoutRefusedError) {
      io.printf(buildLegacyRefusalMessage("init", cause.detection));
      if (options.jsonOut) {
        options.writeOut(
          `${JSON.stringify(buildLegacyRefusalJson("init", resolve(options.projectDir), cause.detection), null, 2)}\n`,
        );
      }
      return LEGACY_LAYOUT_REFUSED_EXIT_CODE;
    }
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
