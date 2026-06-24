/**
 * Greenfield deposit scaffold helpers — TS port of cmd/deft-install/setup.go +
 * deposit.go + githooks.go surfaces consumed by directive init (#1942 S2).
 *
 * Refs #1942, #1430, #1463, #1179.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, relative } from "node:path";
import { copyTree } from "../deposit/copy-tree.js";
import { agentsRefreshPlan } from "../platform/agents-md.js";

export interface InitDepositIo {
  printf: (text: string) => void;
}

export const CANONICAL_INSTALL_ROOT = ".deft/core";
export const CORE_GLOB = ".deft/core/**";

const CODEQL_CONFIG_REL = ".github/codeql/codeql-config.yml";
const CORE_GUARD_WORKFLOW_REL = ".github/workflows/deft-core-guard.yml";
const FRAMEWORK_SELF_TEST_REL = ".deft/core/tests";
const VENDORED_TS_PACKAGES_REL = ".deft/core/packages";

const VENDORED_TS_TEST_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/i;

const CORE_GITATTRIBUTES_LINES = [
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

const AGENTS_SKILLS: ReadonlyArray<{ dir: string; content: string }> = [
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

export interface InstallManifestFields {
  ref: string;
  sha: string;
  tag: string;
  installRoot: string;
  fetchedAt: string;
  fetchedBy: string;
}

const BARE_SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function buildInstallManifestText(fields: InstallManifestFields): string {
  let effectiveTag = fields.tag;
  if (effectiveTag && !effectiveTag.startsWith("v") && BARE_SEMVER.test(effectiveTag)) {
    effectiveTag = `v${effectiveTag}`;
  }
  const effectiveRef = fields.ref || effectiveTag;
  return (
    `ref: '${effectiveRef}'\n` +
    `sha: '${fields.sha}'\n` +
    `tag: '${effectiveTag}'\n` +
    `install_root: '${fields.installRoot}'\n` +
    `fetched_at: '${fields.fetchedAt}'\n` +
    `fetched_by: '${fields.fetchedBy}'\n`
  );
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
  mkdirSync(deftDir, { recursive: true });
  const path = join(deftDir, "VERSION");
  writeFileSync(path, body, "utf8");
  return path;
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
  const path = join(projectDir, "AGENTS.md");
  writeFileSync(path, newContent, "utf8");
  if (state === "absent") {
    io.printf("AGENTS.md created.\n");
  } else {
    io.printf("AGENTS.md updated with deft entries.\n");
  }
  return true;
}

async function ensureVbriefLifecycleDirs(consumerVbrief: string): Promise<void> {
  for (const sub of VBRIEF_LIFECYCLE_DIRS) {
    const dir = join(consumerVbrief, sub);
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
    await writeFile(gitkeep, VBRIEF_LIFECYCLE_GITKEEP, "utf8");
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
  const consumerVbrief = join(projectDir, "vbrief");
  const schemasDst = join(consumerVbrief, "schemas");
  const vbriefMdDst = join(consumerVbrief, "vbrief.md");

  const schemasPresent = existsSync(schemasDst) && statSync(schemasDst).isDirectory();
  const vbriefMdPresent = existsSync(vbriefMdDst) && statSync(vbriefMdDst).isFile();
  const lifecyclePresent = vbriefLifecycleDirsPresent(consumerVbrief);
  if (schemasPresent && vbriefMdPresent && lifecyclePresent) {
    io.printf("vbrief/ already present at project root — skipping.\n");
    return false;
  }

  mkdirSync(consumerVbrief, { recursive: true });

  if (!schemasPresent) {
    const fwSchemas = join(deftDir, "vbrief", "schemas");
    if (existsSync(fwSchemas) && statSync(fwSchemas).isDirectory()) {
      await copyTree(fwSchemas, schemasDst);
    } else {
      mkdirSync(schemasDst, { recursive: true });
    }
  }

  if (!vbriefMdPresent) {
    const fwVbriefMd = join(deftDir, "vbrief", "vbrief.md");
    if (existsSync(fwVbriefMd)) {
      copyFileSync(fwVbriefMd, vbriefMdDst);
    } else {
      writeFileSync(vbriefMdDst, VBRIEF_README_BODY, "utf8");
    }
  }

  await ensureVbriefLifecycleDirs(consumerVbrief);
  io.printf("vbrief/ deposited at project root (schemas + vbrief.md + lifecycle dirs).\n");
  return true;
}

export function writeAgentsSkills(projectDir: string, io: InitDepositIo): boolean {
  const allExist = AGENTS_SKILLS.every((skill) =>
    existsSync(join(projectDir, ".agents", "skills", skill.dir, "SKILL.md")),
  );
  if (allExist) {
    io.printf(".agents/skills/ already present — skipping.\n");
    return false;
  }

  for (const skill of AGENTS_SKILLS) {
    const dir = join(projectDir, ".agents", "skills", skill.dir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    if (existsSync(path)) continue;
    writeFileSync(path, skill.content, "utf8");
  }

  io.printf(".agents/skills/ created — deft skills will be auto-discovered.\n");
  return true;
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
  const path = join(projectDir, "Taskfile.yml");
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

  writeFileSync(path, resultText, "utf8");
  return true;
}

const HOOK_FILENAMES = ["pre-commit", "pre-push"] as const;
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

  const dstDir = join(projectDir, ".githooks");
  mkdirSync(dstDir, { recursive: true });

  let filesDeposited = false;
  for (const name of HOOK_FILENAMES) {
    const src = join(srcDir, name);
    if (!existsSync(src)) continue;
    const data = readFileSync(src);
    const dst = join(dstDir, name);
    const existing = existsSync(dst) ? readFileSync(dst) : null;
    if (!existing?.equals(data)) {
      writeFileSync(dst, data, { mode: HOOK_FILE_MODE });
      filesDeposited = true;
    }
    if (platform() !== "win32") {
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

function escapeEre(value: string): string {
  return value.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function installerManagedGuardEre(): string {
  const matchers: Array<{ exact?: string; prefix?: string }> = [
    { exact: "AGENTS.md" },
    { prefix: ".agents/" },
    { prefix: ".githooks/" },
    { exact: ".gitattributes" },
    { exact: ".gitignore" },
    { exact: "greptile.json" },
    { exact: CODEQL_CONFIG_REL },
    { exact: CORE_GUARD_WORKFLOW_REL },
    { exact: "vbrief/.deft-version" },
    { exact: "vbrief/vbrief.md" },
    { prefix: "vbrief/schemas/" },
    { prefix: "vbrief/migration/" },
    ...VBRIEF_LIFECYCLE_DIRS.map((sub) => ({ exact: `vbrief/${sub}/.gitkeep` })),
  ];
  return matchers
    .map((m) => (m.exact ? `^${escapeEre(m.exact)}$` : `^${escapeEre(m.prefix ?? "")}`))
    .join("|");
}

function githubActionsExpr(expression: string): string {
  return ["$", "{{ ", expression, " }}"].join("");
}

function coreGuardWorkflowContent(): string {
  const baseSha = githubActionsExpr("github.event.pull_request.base.sha");
  const headSha = githubActionsExpr("github.event.pull_request.head.sha");
  return (
    "name: deft-core-guard\n\n" +
    "# Deft framework guard (#1430): a single PR should not mix changes to the\n" +
    "# vendored framework payload (.deft/core/**) with changes to your own project\n" +
    "# files. Framework updates come from `deft-install` / upgrade and should\n" +
    "# land in their own PR so reviewers (and bot reviewers) can treat them as\n" +
    "# packaged, machine-managed assets. Delete this file if you do not want the guard.\n" +
    "on:\n" +
    "  pull_request:\n\n" +
    "permissions:\n" +
    "  contents: read\n\n" +
    "jobs:\n" +
    "  no-mixed-core-and-app:\n" +
    "    runs-on: ubuntu-latest\n" +
    "    steps:\n" +
    "      - uses: actions/checkout@v4\n" +
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
    '          echo "OK: no mixed framework + app changes."\n'
  );
}

export function ensureGitattributes(projectDir: string, io: InitDepositIo): boolean {
  const path = join(projectDir, ".gitattributes");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const additions = CORE_GITATTRIBUTES_LINES.filter((line) => !present.has(line));
  if (additions.length === 0) {
    io.printf(`.gitattributes already marks ${CORE_GLOB} as generated/vendored — skipping.\n`);
    return false;
  }
  let body = existing;
  if (body && !body.endsWith("\n")) body += "\n";
  if (body && !body.endsWith("\n\n")) body += "\n";
  body +=
    "# Deft framework: the vendored payload is packaged framework code, not\n" +
    "# consumer source. Mark it generated + vendored so language stats and\n" +
    "# diffs treat .deft/core/** as machine-managed (#1430).\n";
  for (const add of additions) {
    body += `${add}\n`;
  }
  writeFileSync(path, body, "utf8");
  io.printf(`.gitattributes updated with linguist markers: ${additions.join(", ")}\n`);
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
  const path = join(projectDir, "greptile.json");
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
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
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
  const path = join(projectDir, CODEQL_CONFIG_REL);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, codeqlConfigDefault(), "utf8");
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
  writeFileSync(path, updated, "utf8");
  io.printf(`${CODEQL_CONFIG_REL} updated: CodeQL now ignores ${CORE_GLOB}.\n`);
  return true;
}

export function ensureCoreGuardWorkflow(projectDir: string, io: InitDepositIo): boolean {
  const path = join(projectDir, CORE_GUARD_WORKFLOW_REL);
  const desired = coreGuardWorkflowContent();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing === desired) {
      io.printf(`${CORE_GUARD_WORKFLOW_REL} already current — skipping.\n`);
      return false;
    }
    if (!existing.includes("name: deft-core-guard")) {
      io.printf(`${CORE_GUARD_WORKFLOW_REL} present but not deft-managed — leaving unchanged.\n`);
      return false;
    }
    writeFileSync(path, desired, "utf8");
    io.printf(`${CORE_GUARD_WORKFLOW_REL} refreshed: deft-core-guard allowlist updated (#1478).\n`);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, "utf8");
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

/** Best-effort #1430 neutralization deposit (mirrors depositNeutralization). */
export async function depositNeutralization(projectDir: string, io: InitDepositIo): Promise<void> {
  const steps: Array<() => boolean | Promise<boolean>> = [
    () => ensureGitattributes(projectDir, io),
    () => ensureGreptileIgnore(projectDir, io),
    () => ensureCodeqlPathsIgnore(projectDir, io),
    () => ensureCoreGuardWorkflow(projectDir, io),
    () => pruneFrameworkSelfTests(projectDir, io),
    async () => (await pruneVendoredTsTests(projectDir, io)) > 0,
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (cause) {
      io.printf(`Warning: neutralization step failed: ${String(cause)}\n`);
    }
  }
}
