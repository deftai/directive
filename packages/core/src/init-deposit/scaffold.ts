/**
 * Greenfield deposit scaffold helpers — TS port of cmd/deft-install/setup.go +
 * deposit.go + githooks.go surfaces consumed by directive init (#1942 S2).
 *
 * Refs #1942, #1430, #1463, #1179.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join, relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  assertDestinationNotSymlink,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { agentsRefreshPlan } from "../platform/agents-md.js";
import { MIGRATED_ARTIFACT_DIR } from "../xbrief-migrate/constants.js";
import { CANONICAL_INSTALL_ROOT, type InitDepositIo } from "./constants.js";
import { assertInstallerAllowlistHonors1430, installerManagedGuardEre } from "./hygiene.js";
import { writeAgentsSkillsFromInventory } from "./skill-discovery-deposit.js";
import { syncConsumerXbriefSchemas } from "./xbrief-projections.js";

export type { InitDepositIo };
export { CANONICAL_INSTALL_ROOT };
export const CORE_GLOB = ".deft/core/**";

/**
 * Refuse init/update projection writes that escape via repo-controlled symlinks
 * (#2446) OR that would follow an in-tree destination symlink on the write path
 * (#2912). Every consumer projection sink in this module routes through here.
 */
function projectionTarget(projectDir: string, ...relSegments: string[]): string {
  const target = join(projectDir, ...relSegments);
  assertDestinationNotSymlink(projectDir, target);
  return target;
}

/**
 * Product write sink: containment root is the project, then containedWrite
 * (#2951 / #2980 wave A). Call after projectionTarget / assertDestinationNotSymlink
 * when the early ProjectionContainmentError type is required by tests.
 */
function containedProjectWrite(projectDir: string, target: string, data: string | Buffer): void {
  containedWrite({
    root: resolve(projectDir),
    target,
    data,
    mode: "replace",
  });
}

const CODEQL_CONFIG_REL = ".github/codeql/codeql-config.yml";
const CORE_GUARD_WORKFLOW_REL = ".github/workflows/deft-core-guard.yml";
const FRAMEWORK_SELF_TEST_REL = ".deft/core/tests";
const VENDORED_TS_PACKAGES_REL = ".deft/core/packages";

const VENDORED_TS_TEST_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/i;

const CORE_GITATTRIBUTES_LINES = [
  `${CORE_GLOB} text eol=lf`,
  `${CORE_GLOB} linguist-generated=true`,
  `${CORE_GLOB} linguist-vendored=true`,
];

const VBRIEF_LIFECYCLE_DIRS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

const VBRIEF_LIFECYCLE_GITKEEP = `# This file keeps the lifecycle directory present in version control and
# survives installer packaging so the deft-directive-setup pre-cutover guard
# (condition 3, see skills/deft-directive-setup/SKILL.md:32 and main.md:159)
# does not fire on a fresh install. See #1179.
`;

const VBRIEF_README_BODY = `# vbrief/ -- scope vBRIEF lifecycle workspace

This directory is your project's scope vBRIEF lifecycle workspace.

- vbrief/proposed/  -- newly proposed scope vBRIEFs
- vbrief/pending/   -- accepted, awaiting activation
- vbrief/active/    -- in-flight implementation work
- vbrief/completed/ -- merged / shipped
- vbrief/cancelled/ -- closed without merge

Schemas: vbrief/schemas/ (mirrored from the framework copy at install time).
Reference template: .deft/core/vbrief/vbrief.md

Do not commit vbrief/.eval/ -- it is the local audit-log private state and
is covered by the canonical .gitignore baseline deposited by deft-install.
`;

export const MINIMAL_TASKFILE = `version: '3'

# Taskfile for this project.
# Installed by deft-install --yes (Epic-4). Add your own tasks below or in
# additional included files. The deft include makes all framework tasks
# (task check, task vbrief:*, task doctor, etc.) available from the project root.

includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
`;

export const CANONICAL_TASKFILE_INCLUDE = "taskfile: ./.deft/core/Taskfile.yml";

const DEFT_INCLUDE_CHILD_BLOCK =
  "  # Added by deft-install --yes (Epic-4)\n" +
  "  deft:\n" +
  "    taskfile: ./.deft/core/Taskfile.yml\n" +
  "    optional: true\n";

export interface InstallManifestFields {
  ref: string;
  sha: string;
  tag: string;
  installRoot: string;
  fetchedAt: string;
  fetchedBy: string;
  /**
   * Provenance sentinel (#2056). When the prior manifest was stamped
   * `managed_by: 'npm'` by the npm-migration path, callers thread it through a
   * manifest rebuild so a routine `directive update` / `install-upgrade` does not
   * regress provenance and re-arm the doctor signpost.
   */
  managedBy?: string;
}

const BARE_SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function buildInstallManifestText(fields: InstallManifestFields): string {
  let effectiveTag = fields.tag;
  if (effectiveTag && !effectiveTag.startsWith("v") && BARE_SEMVER.test(effectiveTag)) {
    effectiveTag = `v${effectiveTag}`;
  }
  const effectiveRef = fields.ref || effectiveTag;
  let body =
    `ref: '${effectiveRef}'\n` +
    `sha: '${fields.sha}'\n` +
    `tag: '${effectiveTag}'\n` +
    `install_root: '${fields.installRoot}'\n` +
    `fetched_at: '${fields.fetchedAt}'\n` +
    `fetched_by: '${fields.fetchedBy}'\n`;
  const managedBy = fields.managedBy?.trim();
  if (managedBy) {
    body += `managed_by: '${managedBy}'\n`;
  }
  return body;
}

export function writeInstallManifest(
  projectDir: string,
  deftDir: string,
  fields: InstallManifestFields,
): string {
  const installRoot =
    fields.installRoot ||
    relative(projectDir, deftDir).split("\\").join("/") ||
    CANONICAL_INSTALL_ROOT;
  const body = buildInstallManifestText({ ...fields, installRoot });
  const path = join(deftDir, "VERSION");
  // #2980 wave A: product write sink routes through containedWrite.
  containedProjectWrite(projectDir, path, body);
  return path;
}

/** Canonical committed pin dependency name (mirrors resolution/pin.ts). */
export const PIN_DEPENDENCY_NAME = "@deftai/directive";

export interface EnsurePackageJsonPinResult {
  readonly changed: boolean;
  /** Exact version written to the devDependency pin. */
  readonly pinVersion: string;
  /** A fresh package.json was created (vs. an existing one updated). */
  readonly created: boolean;
}

/**
 * Write the committed `package.json` version pin on `@deftai/directive`
 * (exact devDependency; `"private": true` preserved) so the resolution spine
 * has a canonical, npm-native pin to read before directive runs. This unblocks
 * #2269 (which is gated on the pin existing).
 *
 * Behavior:
 *  - existing `package.json`  -> the exact devDependency pin is set/updated;
 *    an existing `"private"` value is preserved verbatim (never clobbered).
 *  - absent `package.json`    -> a minimal `{ "private": true, ... }` is created.
 *  - idempotent               -> re-running with the same pin makes no change.
 *
 * This is a deposit primitive; wiring it into the `init` verb flow is owned by
 * #2265 (the init-consumes-plan child), per the #2264 scope guard.
 */
export function ensurePackageJsonPin(
  projectDir: string,
  version: string,
  io: InitDepositIo,
): EnsurePackageJsonPinResult {
  const pinVersion = version.trim().replace(/^v/i, "");
  const path = projectionTarget(projectDir, "package.json");
  const existed = existsSync(path);

  let pkg: Record<string, unknown> = {};
  if (existed) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        pkg = parsed as Record<string, unknown>;
      } else {
        throw new Error("package.json root must be a JSON object");
      }
    } catch (cause) {
      throw new Error(`could not parse package.json (leaving it unchanged): ${String(cause)}`);
    }
  } else {
    // Fresh scaffold: a consumer deposit is a non-published workspace.
    pkg.private = true;
  }

  const devDeps: Record<string, unknown> =
    typeof pkg.devDependencies === "object" &&
    pkg.devDependencies !== null &&
    !Array.isArray(pkg.devDependencies)
      ? { ...(pkg.devDependencies as Record<string, unknown>) }
      : {};

  if (devDeps[PIN_DEPENDENCY_NAME] === pinVersion) {
    io.printf(`package.json already pins ${PIN_DEPENDENCY_NAME}@${pinVersion} — skipping.\n`);
    return { changed: false, pinVersion, created: false };
  }

  devDeps[PIN_DEPENDENCY_NAME] = pinVersion;
  pkg.devDependencies = devDeps;

  containedProjectWrite(projectDir, path, `${JSON.stringify(pkg, null, 2)}\n`);
  io.printf(
    existed
      ? `package.json updated: pinned ${PIN_DEPENDENCY_NAME}@${pinVersion} (exact).\n`
      : `package.json created: pinned ${PIN_DEPENDENCY_NAME}@${pinVersion} (exact, private).\n`,
  );
  return { changed: true, pinVersion, created: !existed };
}

export function writeAgentsMd(projectDir: string, deftDir: string, io: InitDepositIo): boolean {
  const plan = agentsRefreshPlan(projectDir, { frameworkRoot: deftDir }) as Record<string, unknown>;
  const state = plan.state;
  if (state === "current") {
    io.printf(`AGENTS.md already advertises install root ${CANONICAL_INSTALL_ROOT} — skipping.\n`);
    return false;
  }
  if (state === "template-missing" || state === "template-malformed" || state === "unreadable") {
    throw new Error(`AGENTS.md render failed: ${String(state)}`);
  }
  const newContent = plan.new_content;
  if (typeof newContent !== "string") {
    throw new Error("AGENTS.md render produced no content");
  }
  const path = projectionTarget(projectDir, "AGENTS.md");
  containedProjectWrite(projectDir, path, newContent);
  if (state === "absent") {
    io.printf("AGENTS.md created.\n");
  } else {
    io.printf("AGENTS.md updated with deft entries.\n");
  }
  return true;
}

async function ensureVbriefLifecycleDirs(projectDir: string): Promise<void> {
  for (const sub of VBRIEF_LIFECYCLE_DIRS) {
    const dir = projectionTarget(projectDir, MIGRATED_ARTIFACT_DIR, sub);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const gitkeep = join(dir, ".gitkeep");
    try {
      await stat(gitkeep);
      continue;
    } catch {
      // absent — may write below
    }
    const entries = await readdir(dir);
    if (entries.length > 0) continue;
    containedProjectWrite(projectDir, gitkeep, VBRIEF_LIFECYCLE_GITKEEP);
  }
}

function vbriefLifecycleDirsPresent(consumerVbrief: string): boolean {
  return VBRIEF_LIFECYCLE_DIRS.every((sub) => {
    try {
      return statSync(join(consumerVbrief, sub)).isDirectory();
    } catch {
      return false;
    }
  });
}

export async function writeConsumerVbrief(
  projectDir: string,
  deftDir: string,
  io: InitDepositIo,
): Promise<boolean> {
  const consumerVbrief = projectionTarget(projectDir, MIGRATED_ARTIFACT_DIR);
  const schemasDst = projectionTarget(projectDir, MIGRATED_ARTIFACT_DIR, "schemas");
  const vbriefMdDst = projectionTarget(projectDir, MIGRATED_ARTIFACT_DIR, "vbrief.md");

  const schemasPresent = existsSync(schemasDst) && statSync(schemasDst).isDirectory();
  const vbriefMdPresent = existsSync(vbriefMdDst) && statSync(vbriefMdDst).isFile();
  const lifecyclePresent = vbriefLifecycleDirsPresent(consumerVbrief);
  const schemasChanged = syncConsumerXbriefSchemas(projectDir, deftDir);
  if (schemasPresent && vbriefMdPresent && lifecyclePresent) {
    io.printf(
      schemasChanged
        ? "vbrief/ schemas refreshed at project root.\n"
        : "vbrief/ already present at project root — skipping.\n",
    );
    return schemasChanged;
  }

  mkdirSync(consumerVbrief, { recursive: true });

  if (!vbriefMdPresent) {
    const fwVbriefMd = join(deftDir, "vbrief", "vbrief.md");
    if (existsSync(fwVbriefMd)) {
      copyFileSync(fwVbriefMd, vbriefMdDst);
    } else {
      containedProjectWrite(projectDir, vbriefMdDst, VBRIEF_README_BODY);
    }
  }

  await ensureVbriefLifecycleDirs(projectDir);
  io.printf("vbrief/ deposited at project root (schemas + vbrief.md + lifecycle dirs).\n");
  return true;
}

export function writeAgentsSkills(projectDir: string, io: InitDepositIo): boolean {
  // Shared inventory with multi-host skill discovery (#75 residual).
  return writeAgentsSkillsFromInventory(projectDir, io);
}

function hasTopLevelIncludes(content: string): boolean {
  if (!content) return false;
  const norm = `\n${content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")}`;
  if (norm.includes("\nincludes:")) return true;
  return content.trimStart().startsWith("includes:");
}

function insertDeftIncludeAfterIncludesLine(content: string): { content: string; ok: boolean } {
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = norm.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.length === 0 || line[0] === " " || line[0] === "\t") continue;
    const trimmed = line.trimEnd();
    if (trimmed === "includes:") {
      const out = [
        ...lines.slice(0, i + 1),
        ...DEFT_INCLUDE_CHILD_BLOCK.trimEnd().split("\n"),
        ...lines.slice(i + 1),
      ];
      return { content: out.join("\n"), ok: true };
    }
    if (trimmed.startsWith("includes:") && trimmed.length > "includes:".length) {
      const rest = trimmed.slice("includes:".length).trimStart();
      if (rest.startsWith("#")) {
        const out = [
          ...lines.slice(0, i + 1),
          ...DEFT_INCLUDE_CHILD_BLOCK.trimEnd().split("\n"),
          ...lines.slice(i + 1),
        ];
        return { content: out.join("\n"), ok: true };
      }
    }
  }
  return { content, ok: false };
}

export function ensureTaskfile(projectDir: string, io: InitDepositIo): boolean {
  const path = projectionTarget(projectDir, "Taskfile.yml");
  let existing = "";
  if (existsSync(path)) {
    existing = readFileSync(path, "utf8");
  }

  if (existing.includes(CANONICAL_TASKFILE_INCLUDE)) {
    io.printf("Taskfile.yml already includes deft — skipping wiring.\n");
    return false;
  }

  let resultText = "";
  if (existing === "") {
    resultText = MINIMAL_TASKFILE;
    io.printf("Created minimal Taskfile.yml with deft include (Epic-4).\n");
  } else if (hasTopLevelIncludes(existing)) {
    const inserted = insertDeftIncludeAfterIncludesLine(existing);
    if (inserted.ok) {
      resultText = inserted.content;
      io.printf(
        "Inserted deft entry inside existing `includes:` block in Taskfile.yml (Epic-4).\n",
      );
    } else {
      resultText =
        `${existing}${existing.endsWith("\n") ? "" : "\n"}\n` +
        "# deft-install --yes (Epic-4): could not locate the existing top-level `includes:` line for structural insertion; appended a fresh block. Manual merge recommended.\n" +
        "includes:\n" +
        "  deft:\n" +
        "    taskfile: ./.deft/core/Taskfile.yml\n" +
        "    optional: true\n";
      io.printf(
        "Appended fresh `includes:` block to Taskfile.yml -- top-level includes: detected but structural insertion fell through; manual merge recommended.\n",
      );
    }
  } else {
    resultText =
      `${existing}${existing.endsWith("\n") ? "" : "\n"}\n` +
      "# Added by deft-install --yes (Epic-4)\n" +
      "includes:\n" +
      "  deft:\n" +
      "    taskfile: ./.deft/core/Taskfile.yml\n" +
      "    optional: true\n";
    io.printf("Appended new `includes:` block with deft entry to Taskfile.yml (Epic-4).\n");
  }

  containedProjectWrite(projectDir, path, resultText);
  return true;
}

const HOOK_FILENAMES = ["pre-commit", "pre-push"] as const;
const HOOK_SUPPORT_FILENAMES = ["_deft-run.sh"] as const;
const HOOK_FILE_MODE = 0o755;

export interface GitHooksSeams {
  getHooksPath?: (projectDir: string) => string | null;
  setHooksPath?: (projectDir: string, value: string) => boolean;
}

export function writeConsumerGitHooks(
  projectDir: string,
  deftDir: string,
  io: InitDepositIo,
  seams: GitHooksSeams = {},
): boolean {
  const srcDir = join(deftDir, ".githooks");
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    io.printf(`git hooks source ${srcDir} absent — skipping hook wiring.\n`);
    return false;
  }

  // Ensure parent path is containment-checked before any file write.
  projectionTarget(projectDir, ".githooks");

  let filesDeposited = false;
  for (const name of [...HOOK_FILENAMES, ...HOOK_SUPPORT_FILENAMES]) {
    const src = join(srcDir, name);
    if (!existsSync(src)) continue;
    const data = readFileSync(src);
    const dst = projectionTarget(projectDir, ".githooks", name);
    const existing = existsSync(dst) ? readFileSync(dst) : null;
    const isHookScript = HOOK_FILENAMES.includes(name as (typeof HOOK_FILENAMES)[number]);
    if (!existing?.equals(data)) {
      // #2980 wave A: containedWrite (mode is applied via chmod below for hooks).
      containedProjectWrite(projectDir, dst, data);
      filesDeposited = true;
    }
    if (platform() !== "win32" && isHookScript) {
      try {
        const mode = statSync(dst).mode & 0o777;
        if ((mode & 0o111) === 0) {
          chmodSync(dst, HOOK_FILE_MODE);
          filesDeposited = true;
        }
      } catch {
        // non-fatal
      }
    }
  }

  const getHooksPath =
    seams.getHooksPath ??
    ((dir: string) => {
      try {
        return execFileSync("git", ["-C", dir, "config", "--get", "core.hooksPath"], {
          encoding: "utf8",
        }).trim();
      } catch {
        return "";
      }
    });
  const setHooksPath =
    seams.setHooksPath ??
    ((dir: string, value: string) => {
      try {
        execFileSync("git", ["-C", dir, "config", "core.hooksPath", value], { encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    });

  const target = ".githooks";
  const current = getHooksPath(projectDir) ?? "";
  let configWired = false;
  if (current !== target) {
    if (setHooksPath(projectDir, target)) {
      configWired = true;
      io.printf("git hooks wired: core.hooksPath=.githooks (#1463).\n");
    } else {
      io.printf(
        "Warning: could not set core.hooksPath=.githooks — run `git config core.hooksPath .githooks` manually.\n",
      );
    }
  } else {
    io.printf("git hooks already wired — skipping core.hooksPath write.\n");
  }

  if (filesDeposited) {
    io.printf(".githooks/ deposited at project root (#1463).\n");
  } else if (configWired) {
    io.printf(".githooks/ already present; git config updated (#1463).\n");
  }

  return filesDeposited || configWired;
}

function githubActionsExpr(expression: string): string {
  return ["$", "{{ ", expression, " }}"].join("");
}

/** Commit SHA for `actions/checkout` deposited in deft-core-guard.yml (#1672 / #1072). */
export const CORE_GUARD_CHECKOUT_SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
/** Tag comment paired with {@link CORE_GUARD_CHECKOUT_SHA}. */
export const CORE_GUARD_CHECKOUT_TAG = "v7.0.0";

const CHECKOUT_USES_PREFIX = "- uses: actions/checkout@";

/**
 * Extract the `uses: actions/checkout@…` step line from a guard workflow, if present.
 * Uses linear string scanning (no regex) to avoid CodeQL js/polynomial-redos (#1672).
 */
export function extractCoreGuardCheckoutUsesLine(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(CHECKOUT_USES_PREFIX)) continue;
    // YAML step lines are indented; a bare top-level match is not a step.
    if (trimmed.length === line.length) continue;
    return line;
  }
  return null;
}

/** Ref after `actions/checkout@` (tag, SHA, or major), stopping at whitespace. */
function checkoutActionRef(usesLine: string): string | null {
  const idx = usesLine.indexOf(CHECKOUT_USES_PREFIX);
  if (idx < 0) return null;
  const after = usesLine.slice(idx + CHECKOUT_USES_PREFIX.length);
  let end = after.length;
  for (let i = 0; i < after.length; i += 1) {
    const c = after[i];
    if (c === " " || c === "\t" || c === "\r") {
      end = i;
      break;
    }
  }
  const ref = after.slice(0, end);
  return ref.length > 0 ? ref : null;
}

/**
 * Whether refresh should keep the existing checkout pin instead of the template pin.
 * Legacy framework-deposited `@v4` tags migrate forward; consumer/Dependabot bumps do not.
 */
export function shouldPreserveCoreGuardCheckoutPin(
  existingUsesLine: string,
  desiredUsesLine: string,
): boolean {
  if (existingUsesLine === desiredUsesLine) return false;
  const existingRef = checkoutActionRef(existingUsesLine);
  if (!existingRef) return false;
  // Stale framework-deposited floating major tag — migrate to SHA template (#1672).
  return existingRef !== "v4";
}

/** Canonical SHA-pinned checkout step for the deposited deft-core-guard workflow. */
export function coreGuardCheckoutUsesLine(
  sha: string = CORE_GUARD_CHECKOUT_SHA,
  tag: string = CORE_GUARD_CHECKOUT_TAG,
): string {
  return `      - uses: actions/checkout@${sha} # ${tag}`;
}

/**
 * On refresh, preserve an existing consumer `actions/checkout@…` pin while updating
 * the managed guard script / allowlist body (#1672 option 1).
 */
export function mergeCoreGuardWorkflowRefresh(existing: string, desired: string): string {
  const existingCheckout = extractCoreGuardCheckoutUsesLine(existing);
  if (!existingCheckout) return desired;
  const desiredCheckout = extractCoreGuardCheckoutUsesLine(desired);
  if (!desiredCheckout || !shouldPreserveCoreGuardCheckoutPin(existingCheckout, desiredCheckout)) {
    return desired;
  }
  const idx = desired.indexOf(desiredCheckout);
  if (idx < 0) return desired;
  return desired.slice(0, idx) + existingCheckout + desired.slice(idx + desiredCheckout.length);
}

/**
 * Embedded python3 content check for package.json / lockfiles when co-travelling
 * with .deft/core/** (#3193). Mirrors TS `isUpgradePinPathContentAllowed`.
 * Uses a single-quoted heredoc so GHA does not interpolate shell variables
 * inside the Python source (BASE/HEAD are argv).
 */
function coreGuardPinContentPython(): string {
  // Keep this compact: deposited into every consumer workflow on init/update.
  return [
    '          python3 - "$BASE_SHA" "$HEAD_SHA" <<\'PY\'',
    "import json, re, subprocess, sys",
    "base_sha, head_sha = sys.argv[1], sys.argv[2]",
    "def git_show(sha, path):",
    "    try:",
    "        return subprocess.check_output(['git','show',f'{sha}:{path}'], text=True, stderr=subprocess.DEVNULL)",
    "    except subprocess.CalledProcessError:",
    "        return ''",
    "def changed_names():",
    "    out = subprocess.check_output(['git','diff','--name-only',base_sha,head_sha], text=True)",
    "    return [p for p in out.splitlines() if p]",
    "def is_dir_key(n):",
    "    return n.startswith('@deftai/directive')",
    "DEP_FIELDS = ('dependencies','devDependencies','optionalDependencies','peerDependencies')",
    "def deep_eq(a,b):",
    "    if a is b: return True",
    "    if type(a) is not type(b): return False",
    "    if isinstance(a, dict):",
    "        if set(a) != set(b): return False",
    "        return all(deep_eq(a[k], b[k]) for k in a)",
    "    if isinstance(a, list):",
    "        return len(a)==len(b) and all(deep_eq(x,y) for x,y in zip(a,b))",
    "    return a == b",
    "def strip_pins(obj):",
    "    if not isinstance(obj, dict): return obj",
    "    out = {}",
    "    for k,v in obj.items():",
    "        if k in DEP_FIELDS and isinstance(v, dict):",
    "            out[k] = {dk:dv for dk,dv in v.items() if not is_dir_key(dk)}",
    "        else:",
    "            out[k] = v",
    "    return out",
    "def pkg_pin_only(base, head):",
    "    try:",
    "        b, h = json.loads(base or '{}'), json.loads(head or '{}')",
    "    except json.JSONDecodeError:",
    "        return False",
    "    return deep_eq(strip_pins(b), strip_pins(h))",
    "def collect_deps(pkg):",
    "    out = {}",
    "    if not isinstance(pkg, dict): return out",
    "    for f in DEP_FIELDS:",
    "        block = pkg.get(f)",
    "        if isinstance(block, dict):",
    "            for k,v in block.items():",
    "                if isinstance(v, str): out[k]=v",
    "                elif isinstance(v, dict) and isinstance(v.get('version'), str): out[k]=v['version']",
    "                elif v is not None: out[k]=str(v)",
    "    return out",
    "def only_dir_diff(bd, hd):",
    "    keys = set(bd)|set(hd)",
    "    for k in keys:",
    "        if is_dir_key(k): continue",
    "        if bd.get(k) != hd.get(k): return False",
    "    return True",
    "def npm_root_deps(lock):",
    "    pkgs = lock.get('packages') if isinstance(lock, dict) else None",
    "    if isinstance(pkgs, dict) and isinstance(pkgs.get(''), dict):",
    "        return collect_deps(pkgs[''])",
    "    deps = lock.get('dependencies') if isinstance(lock, dict) else None",
    "    out = {}",
    "    if isinstance(deps, dict):",
    "        for k,v in deps.items():",
    "            if isinstance(v, dict): out[k]=str(v.get('version', v))",
    "            elif isinstance(v, str): out[k]=v",
    "    return out",
    "def npm_lock_ok(base, head):",
    "    try:",
    "        b, h = json.loads(base or '{}'), json.loads(head or '{}')",
    "    except json.JSONDecodeError:",
    "        return False",
    "    br, hr = npm_root_deps(b), npm_root_deps(h)",
    "    if not only_dir_diff(br, hr): return False",
    "    bp, hp = b.get('packages') or {}, h.get('packages') or {}",
    "    if not isinstance(bp, dict): bp = {}",
    "    if not isinstance(hp, dict): hp = {}",
    "    all_keys = set(bp)|set(hp)",
    "    for key in all_keys:",
    "        if key == '': continue",
    "        if 'node_modules/@deftai/directive' in key or '/@deftai/directive/' in key: continue",
    "        if not deep_eq(bp.get(key), hp.get(key)): return False",
    "    return True",
    "def pnpm_root_deps(raw):",
    "    out = {}",
    "    in_imp = in_root = in_dep = False",
    "    cur = None",
    "    def unq(s):",
    "        s=s.strip()",
    '        if len(s)>=2 and s[0]==s[-1] and s[0] in "\'\\"": return s[1:-1]',
    "        return s",
    "    for line in raw.splitlines():",
    "        if re.match(r'^importers:\\s*$', line):",
    "            in_imp, in_root, in_dep, cur = True, False, False, None",
    "            continue",
    "        if not in_imp: continue",
    "        if re.match(r'^[^\\s#]', line) and not line.startswith('importers'):",
    "            break",
    '        if re.match(r"^ {2}(?:\\.|\'\\.\'|\\"\\.\\"):\\s*$", line):',
    "            in_root, in_dep, cur = True, False, None",
    "            continue",
    "        if in_root and re.match(r'^ {2}\\S', line) and not re.match(r'^ {2}\\.', line):",
    "            in_root, in_dep, cur = False, False, None",
    "            continue",
    "        if not in_root: continue",
    "        if re.match(r'^ {4}(?:dependencies|devDependencies|optionalDependencies|peerDependencies):\\s*$', line):",
    "            in_dep, cur = True, None",
    "            continue",
    "        if in_dep and re.match(r'^ {4}\\S', line):",
    "            in_dep, cur = False, None",
    "            continue",
    "        if not in_dep: continue",
    "        m = re.match(r'^ {6}(.+?):\\s*$', line)",
    "        if m:",
    "            cur = unq(m.group(1)); continue",
    "        if cur:",
    "            vm = re.match(r'^ {8}version:\\s*(.+?)\\s*$', line)",
    "            if vm:",
    "                out[cur] = unq(vm.group(1)); cur = None",
    "    return out",
    "def pnpm_packages_by_name(raw):",
    "    blocks, out = {}, {}",
    "    in_pkg, cur, buf = False, None, []",
    "    def flush():",
    "        nonlocal cur, buf",
    "        if cur is None: return",
    "        blocks.setdefault(cur, []).append('\\n'.join(buf))",
    "        cur, buf = None, []",
    "    def unq(s):",
    "        s=s.strip()",
    '        if len(s)>=2 and s[0]==s[-1] and s[0] in "\'\\"": return s[1:-1]',
    "        return s",
    "    for line in raw.splitlines():",
    "        if re.match(r'^packages:\\s*$', line):",
    "            flush(); in_pkg = True; continue",
    "        if not in_pkg: continue",
    "        if re.match(r'^[^\\s#]', line) and not line.startswith('packages'):",
    "            flush(); break",
    "        m = re.match(r'^ {2}(.+?):\\s*$', line)",
    "        if m:",
    "            flush()",
    "            key = unq(m.group(1))",
    "            at = key.find('@', 1) if key.startswith('@') else key.find('@')",
    "            cur = key[:at] if at > 0 else key",
    "            buf = [line]; continue",
    "        if cur is not None: buf.append(line)",
    "    flush()",
    "    for name, blist in blocks.items():",
    "        out[name] = '\\n---\\n'.join(sorted(blist))",
    "    return out",
    "def pnpm_ok(base, head):",
    "    br, hr = pnpm_root_deps(base), pnpm_root_deps(head)",
    "    if not only_dir_diff(br, hr): return False",
    "    bp, hp = pnpm_packages_by_name(base), pnpm_packages_by_name(head)",
    "    for name in set(bp)|set(hp):",
    "        if is_dir_key(name): continue",
    "        if bp.get(name) != hp.get(name): return False",
    "    return True",
    "def yarn_blocks(raw):",
    "    blocks = {}",
    "    names, buf = [], []",
    "    def flush():",
    "        nonlocal names, buf",
    "        if not names: return",
    "        body = '\\n'.join(buf)",
    "        for n in names: blocks[n] = body",
    "        names, buf = [], []",
    "    for line in raw.splitlines():",
    "        if line == '' or line.startswith('#'):",
    "            if names and line == '': flush()",
    "            continue",
    "        if not re.match(r'^\\s', line) and line.endswith(':'):",
    "            flush()",
    "            header = line[:-1]",
    "            names = []",
    "            for part in header.split(','):",
    "                p = part.strip()",
    '                if len(p)>=2 and p[0]==p[-1] and p[0] in "\'\\"": p = p[1:-1]',
    "                at = p.find('@', 1) if p.startswith('@') else p.find('@')",
    "                names.append(p[:at] if at > 0 else p)",
    "            buf = [line]",
    "            continue",
    "        if names: buf.append(line)",
    "    flush()",
    "    return blocks",
    "def yarn_ok(base, head):",
    "    bb, hb = yarn_blocks(base), yarn_blocks(head)",
    "    for name in set(bb)|set(hb):",
    "        if is_dir_key(name): continue",
    "        if bb.get(name) != hb.get(name): return False",
    "    return True",
    "paths = changed_names()",
    "core = [p for p in paths if p == '.deft/core' or p.startswith('.deft/core/')]",
    "if not core:",
    "    sys.exit(0)",
    "checks = {",
    "    'package.json': pkg_pin_only,",
    "    'package-lock.json': npm_lock_ok,",
    "    'pnpm-lock.yaml': pnpm_ok,",
    "    'yarn.lock': yarn_ok,",
    "}",
    "bad = []",
    "for path, fn in checks.items():",
    "    if path not in paths: continue",
    "    if not fn(git_show(base_sha, path), git_show(head_sha, path)):",
    "        bad.append(path)",
    "if bad:",
    "    print('::error title=deft-core guard (#3193)::package/lock co-travel with .deft/core/** must be @deftai/directive* pin-only + lock follow-through. Rejected: ' + ', '.join(bad))",
    "    print('--- content-rejected pin/lock paths ---')",
    "    print('\\n'.join(bad))",
    "    sys.exit(1)",
    "print('OK: package/lock content is Directive pin unit (#3193).')",
    "PY",
  ].join("\n");
}

function coreGuardWorkflowContent(): string {
  // Fail closed before emitting guard ERE if allowlist violates #1430 denylist (#3030).
  assertInstallerAllowlistHonors1430();
  const baseSha = githubActionsExpr("github.event.pull_request.base.sha");
  const headSha = githubActionsExpr("github.event.pull_request.head.sha");
  return (
    "name: deft-core-guard\n\n" +
    "# Deft framework guard (#1430 / #3127 / #3193): a single PR should not mix changes to the\n" +
    "# vendored framework payload (.deft/core/**) with true application/product files.\n" +
    "# One upgrade PR MAY include deposit + installer-managed paths + package.json pin/lock\n" +
    "# + .deft/GENERATION.json when package.json is @deftai/directive* dependency-key pin-only\n" +
    "# and lockfiles are pin follow-through (#3193). Framework updates come from `deft update`\n" +
    "# / install and should land without product feature work so reviewers treat the payload\n" +
    "# as machine-managed. Delete this file if you do not want the guard.\n" +
    "on:\n" +
    "  pull_request:\n\n" +
    "permissions:\n" +
    "  contents: read\n\n" +
    "jobs:\n" +
    "  no-mixed-core-and-app:\n" +
    "    runs-on: ubuntu-latest\n" +
    "    steps:\n" +
    `${coreGuardCheckoutUsesLine()}\n` +
    "        with:\n" +
    "          fetch-depth: 0\n" +
    "      - name: Refuse PRs that mix .deft/core/** with non-framework paths\n" +
    "        env:\n" +
    `          BASE_SHA: ${baseSha}\n` +
    `          HEAD_SHA: ${headSha}\n` +
    "        run: |\n" +
    "          set -eu\n" +
    '          changed=$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")\n' +
    '          echo "Changed files:"\n' +
    '          echo "$changed"\n' +
    "          core=$(printf '%s\\n' \"$changed\" | grep -E '^\\.deft/core/' || true)\n" +
    "          app=$(printf '%s\\n' \"$changed\" | grep -vE '^\\.deft/core/' | grep -vE '" +
    installerManagedGuardEre() +
    "' | grep -v '^$' || true)\n" +
    '          if [ -n "$core" ] && [ -n "$app" ]; then\n' +
    '            echo "::error title=deft-core guard (#1430)::This PR changes the vendored framework payload (.deft/core/**) AND non-framework files. Split the framework update into its own PR."\n' +
    '            echo "--- framework (.deft/core/**) changes ---"; printf \'%s\\n\' "$core"\n' +
    '            echo "--- non-framework changes ---"; printf \'%s\\n\' "$app"\n' +
    "            exit 1\n" +
    "          fi\n" +
    "          # Content-aware pin unit (#3193): path allowlist is not enough for package/lock.\n" +
    '          if [ -n "$core" ]; then\n' +
    `${coreGuardPinContentPython()}\n` +
    "          fi\n" +
    '          echo "OK: no mixed framework + app changes."\n'
  );
}

export function ensureGitattributes(projectDir: string, io: InitDepositIo): boolean {
  const path = projectionTarget(projectDir, ".gitattributes");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const additions = CORE_GITATTRIBUTES_LINES.filter((line) => !present.has(line));
  if (additions.length === 0) {
    io.printf(
      `.gitattributes already marks ${CORE_GLOB} as LF-pinned/generated/vendored — skipping.\n`,
    );
    return false;
  }
  let body = existing;
  if (body && !body.endsWith("\n")) body += "\n";
  if (body && !body.endsWith("\n\n")) body += "\n";
  body +=
    "# Deft framework: the vendored payload is packaged framework code, not\n" +
    "# consumer source. Pin LF endings and mark it generated + vendored so\n" +
    "# Git does not rewrite it and diffs treat .deft/core/** as machine-managed (#1430, #2118).\n";
  for (const add of additions) {
    body += `${add}\n`;
  }
  containedProjectWrite(projectDir, path, body);
  io.printf(`.gitattributes updated with Deft core markers: ${additions.join(", ")}\n`);
  return true;
}

function greptilePatternPresent(patterns: string, glob: string): boolean {
  return patterns.split("\n").some((line) => line.trim() === glob);
}

function appendGreptilePattern(patterns: string, glob: string): string {
  if (patterns.trim() === "") return glob;
  if (patterns.endsWith("\n")) return `${patterns}${glob}`;
  return `${patterns}\n${glob}`;
}

export function ensureGreptileIgnore(projectDir: string, io: InitDepositIo): boolean {
  const path = projectionTarget(projectDir, "greptile.json");
  const fileExisted = existsSync(path);
  let raw = fileExisted ? readFileSync(path, "utf8") : "";
  if (!raw.trim()) raw = "{}";
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("greptile.json root must be a JSON object");
    }
    obj = parsed as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`could not parse greptile.json (leaving it unchanged): ${String(cause)}`);
  }
  let patterns = "";
  if ("ignorePatterns" in obj) {
    if (typeof obj.ignorePatterns !== "string") {
      throw new Error("greptile.json ignorePatterns is not a newline-separated string");
    }
    patterns = obj.ignorePatterns;
  }
  if (fileExisted && greptilePatternPresent(patterns, CORE_GLOB)) {
    io.printf(`greptile.json already ignores ${CORE_GLOB} — skipping.\n`);
    return false;
  }
  obj.ignorePatterns = appendGreptilePattern(patterns, CORE_GLOB);
  containedProjectWrite(projectDir, path, `${JSON.stringify(obj, null, 2)}\n`);
  io.printf(
    fileExisted
      ? `greptile.json updated: bot review now ignores ${CORE_GLOB}.\n`
      : `greptile.json created: bot review ignores ${CORE_GLOB}.\n`,
  );
  return true;
}

function codeqlConfigDefault(): string {
  return (
    "# Deft framework: exclude the vendored payload from CodeQL analysis (#1430).\n" +
    "# .deft/core/** is packaged framework code, not consumer source.\n" +
    'name: "CodeQL config (deft)"\n' +
    "paths-ignore:\n" +
    `  - '${CORE_GLOB}'\n`
  );
}

function codeqlPathsIgnorePresent(content: string, glob: string): boolean {
  const candidates = [`- '${glob}'`, `- "${glob}"`, `- ${glob}`];
  let inBlock = false;
  for (const line of content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line.length > 0 && line[0] !== " " && line[0] !== "\t") {
      const trimmed = line.trimEnd();
      if (trimmed === "paths-ignore:") {
        inBlock = true;
        continue;
      }
      inBlock = false;
      continue;
    }
    if (inBlock && candidates.includes(line.trim())) return true;
  }
  return false;
}

function insertCodeqlPathsIgnore(content: string, glob: string): { content: string; ok: boolean } {
  const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = norm.split("\n");
  const entry = `  - '${glob}'`;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.length === 0 || line[0] === " " || line[0] === "\t") continue;
    if ((line.trimEnd() ?? "") === "paths-ignore:") {
      const out = [...lines.slice(0, i + 1), entry, ...lines.slice(i + 1)];
      return { content: out.join("\n"), ok: true };
    }
  }
  return { content, ok: false };
}

export function ensureCodeqlPathsIgnore(projectDir: string, io: InitDepositIo): boolean {
  const path = projectionTarget(projectDir, CODEQL_CONFIG_REL);
  if (!existsSync(path)) {
    containedProjectWrite(projectDir, path, codeqlConfigDefault());
    io.printf(`${CODEQL_CONFIG_REL} created: CodeQL ignores ${CORE_GLOB}.\n`);
    return true;
  }
  const existing = readFileSync(path, "utf8");
  if (codeqlPathsIgnorePresent(existing, CORE_GLOB)) {
    io.printf(`${CODEQL_CONFIG_REL} already ignores ${CORE_GLOB} — skipping.\n`);
    return false;
  }
  const inserted = insertCodeqlPathsIgnore(existing, CORE_GLOB);
  const updated = inserted.ok
    ? inserted.content
    : `${existing}${existing.endsWith("\n") ? "" : "\n"}paths-ignore:\n  - '${CORE_GLOB}'\n`;
  containedProjectWrite(projectDir, path, updated);
  io.printf(`${CODEQL_CONFIG_REL} updated: CodeQL now ignores ${CORE_GLOB}.\n`);
  return true;
}

export function ensureCoreGuardWorkflow(projectDir: string, io: InitDepositIo): boolean {
  const path = projectionTarget(projectDir, CORE_GUARD_WORKFLOW_REL);
  const desired = coreGuardWorkflowContent();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (!existing.includes("name: deft-core-guard")) {
      io.printf(`${CORE_GUARD_WORKFLOW_REL} present but not deft-managed — leaving unchanged.\n`);
      return false;
    }
    const refreshed = mergeCoreGuardWorkflowRefresh(existing, desired);
    if (existing === refreshed) {
      io.printf(`${CORE_GUARD_WORKFLOW_REL} already current — skipping.\n`);
      return false;
    }
    containedProjectWrite(projectDir, path, refreshed);
    io.printf(`${CORE_GUARD_WORKFLOW_REL} refreshed: deft-core-guard allowlist updated (#1478).\n`);
    return true;
  }
  containedProjectWrite(projectDir, path, desired);
  io.printf(
    `${CORE_GUARD_WORKFLOW_REL} created: CI refuses PRs mixing ${CORE_GLOB} with app files.\n`,
  );
  return true;
}

export async function pruneFrameworkSelfTests(
  projectDir: string,
  io: InitDepositIo,
): Promise<boolean> {
  const path = join(projectDir, FRAMEWORK_SELF_TEST_REL);
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return false;
  } catch {
    return false;
  }
  await rm(path, { recursive: true, force: true });
  io.printf(
    `Removed vendored framework self-tests (${FRAMEWORK_SELF_TEST_REL}) from the consumer deposit (#1474).\n`,
  );
  return true;
}

export async function pruneVendoredTsTests(projectDir: string, io: InitDepositIo): Promise<number> {
  const root = join(projectDir, VENDORED_TS_PACKAGES_REL);
  try {
    if (!(await stat(root)).isDirectory()) return 0;
  } catch {
    return 0;
  }
  let removed = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && VENDORED_TS_TEST_RE.test(entry.name)) {
        await rm(full, { force: true });
        removed += 1;
      }
    }
  }
  await walk(root);
  if (removed > 0) {
    io.printf(
      `Removed ${removed} vendored TypeScript test file(s) under ${VENDORED_TS_PACKAGES_REL} from the consumer deposit (#1878).\n`,
    );
  }
  return removed;
}

export interface DepositNeutralizationOptions {
  /**
   * #2148: skip depositing `.github/workflows/deft-core-guard.yml` when the
   * framework deposit is not git-tracked (npm-managed / gitignored layout). The
   * guard CI check is meaningless when there is no committed `.deft/core/**` to
   * guard; skipping it prevents the file from re-appearing as untracked noise
   * after every `directive update`.
   */
  readonly skipGuardWorkflow?: boolean;
}

/** Best-effort #1430 neutralization deposit (mirrors depositNeutralization). */
export async function depositNeutralization(
  projectDir: string,
  io: InitDepositIo,
  options: DepositNeutralizationOptions = {},
): Promise<void> {
  const steps: Array<() => boolean | Promise<boolean>> = [
    () => ensureGitattributes(projectDir, io),
    () => ensureGreptileIgnore(projectDir, io),
    () => ensureCodeqlPathsIgnore(projectDir, io),
    ...(options.skipGuardWorkflow ? [] : [() => ensureCoreGuardWorkflow(projectDir, io)]),
    () => pruneFrameworkSelfTests(projectDir, io),
    async () => (await pruneVendoredTsTests(projectDir, io)) > 0,
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (cause) {
      if (cause instanceof ProjectionContainmentError) {
        throw cause;
      }
      io.printf(`Warning: neutralization step failed: ${String(cause)}\n`);
    }
  }
}
