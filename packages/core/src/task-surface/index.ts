import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEGACY_VBRIEF_VERSION } from "@deftai/directive-types";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { isDeliveryBriefLandExcluded } from "../scope/delivery-evidence.js";

export interface TaskSurfaceIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

const UNRELEASED_RE = /## \[Unreleased\][ \t]*\n([\s\S]*?)(?=\n## \[|$)/;
const CHANGE_NAME_RE = /^[\w][\w-]*$/;
const COMMIT_TYPES = "feat|fix|docs|chore|refactor|test|style|perf|ci|build|revert";
const COMMIT_SUBJECT_RE = new RegExp(`^(${COMMIT_TYPES})(\\(.+\\))?!?: .+`);
const GIT_SHOW_MAX_BUFFER = 16 * 1024 * 1024;
const MERGE_BASE_REFS = ["origin/master", "origin/main"] as const;

export type ChangelogCheckOptions = {
  /** Framework-source only. Default off so consumer `change:changelog:check` stays presence-only. */
  againstMergeBase?: boolean;
};

/** Refuse task-surface writes that escape via repo-controlled symlinks (#2807). */
function projectionTarget(projectDir: string, ...relSegments: string[]): string {
  const target = join(resolve(projectDir), ...relSegments);
  assertProjectionContained(projectDir, target);
  return target;
}

function containmentExitCode(io: TaskSurfaceIo, err: unknown): number | null {
  if (err instanceof ProjectionContainmentError || err instanceof ContainedWriteError) {
    io.writeErr(`FAIL: ${err.message}\n`);
    return 2;
  }
  return null;
}

function proposalTemplate(name: string): unknown {
  return {
    vBRIEFInfo: { version: LEGACY_VBRIEF_VERSION },
    plan: {
      title: name,
      status: "draft",
      narratives: {
        Problem: "What is wrong or missing.",
        Change: "What this proposal does about it.",
        Scope: "In scope: ...  Out of scope: ...",
        Impact: "What existing code/specs are affected.",
        Risks: "What could go wrong.",
        Approach: "How to implement the change.",
        Alternatives: "What else was considered and why not.",
        Dependencies: "What must exist before this works.",
      },
    },
  };
}

function tasksTemplate(name: string): unknown {
  return {
    vBRIEFInfo: { version: LEGACY_VBRIEF_VERSION },
    plan: { title: name, status: "draft", items: [], edges: [] },
  };
}

function gitText(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_SHOW_MAX_BUFFER,
    });
  } catch {
    return null;
  }
}

/** Lines under `## [Unreleased]` that start with `- ` (trimmed). Same language as changelog-check. */
function extractUnreleasedDashEntries(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = UNRELEASED_RE.exec(normalized);
  if (match === null) {
    return [];
  }
  const body = match[1] ?? "";
  return body
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.trim());
}

function resolveChangelogMergeBase(root: string): { sha: string } | { error: string } {
  for (const ref of MERGE_BASE_REFS) {
    const sha = gitText(root, ["merge-base", "HEAD", ref])?.trim();
    if (sha !== undefined && sha.length > 0) {
      return { sha };
    }
  }
  return {
    error: "no merge-base against origin/master or origin/main. Recovery: git fetch origin master.",
  };
}

/** `git diff --name-only --no-renames <merge-base>...HEAD`, or null on failure. */
function changeSetAgainstMergeBase(root: string, mergeBaseSha: string): string[] | null {
  const out = gitText(root, ["diff", "--name-only", "--no-renames", `${mergeBaseSha}...HEAD`]);
  if (out === null) {
    return null;
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isDeliveryBriefLandChangeSet(root: string, mergeBaseSha: string): boolean {
  const files = changeSetAgainstMergeBase(root, mergeBaseSha);
  if (files === null) {
    return false;
  }
  return isDeliveryBriefLandExcluded(files.map((filename) => ({ status: "modified", filename })));
}

function compareUnreleasedAgainstMergeBase(
  root: string,
  currentEntries: readonly string[],
  io: TaskSurfaceIo,
): number {
  const mergeBase = resolveChangelogMergeBase(root);
  if ("error" in mergeBase) {
    io.writeOut(`FAIL: ${mergeBase.error}\n`);
    return 2;
  }
  const head = gitText(root, ["rev-parse", "HEAD"])?.trim();
  if (head === mergeBase.sha) {
    return 0;
  }
  // #680 P4: a delivery-brief-land change set (lifecycle briefs, CHANGELOG, the
  // spec-drift ledger only) needs no new entry. Oracle is the committed change
  // set vs merge-base; --no-renames lists rename sources too. A failed or empty
  // diff is not exempt (fail closed). Product/code diffs keep the requirement.
  if (isDeliveryBriefLandChangeSet(root, mergeBase.sha)) {
    return 0;
  }
  const baseText = gitText(root, ["show", `${mergeBase.sha}:CHANGELOG.md`]);
  const baseEntries = baseText === null ? [] : extractUnreleasedDashEntries(baseText);
  const baseSet = new Set(baseEntries);
  const added = currentEntries.filter((entry) => !baseSet.has(entry));
  if (added.length === 0) {
    io.writeOut('FAIL: [Unreleased] section has no new "- " entries versus merge-base\n');
    return 1;
  }
  return 0;
}

/** Port of ``task change:changelog:check`` inline Python (#2022 Phase 2). */
export function runChangelogCheck(
  projectRoot: string,
  io: TaskSurfaceIo,
  options: ChangelogCheckOptions = {},
): number {
  const root = resolve(projectRoot);
  const path = join(root, "CHANGELOG.md");
  if (!existsSync(path) || !statSync(path).isFile()) {
    io.writeOut("FAIL: CHANGELOG.md not found\n");
    return 1;
  }
  // Normalize CRLF -> LF before matching (#2329). On Windows checkouts with
  // core.autocrlf=true the working tree uses CRLF, and the `[ \t]*\n` header
  // pattern does not consume the `\r`, so the section falsely reads as absent.
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const match = UNRELEASED_RE.exec(text);
  if (match === null) {
    io.writeOut("FAIL: No [Unreleased] section found in CHANGELOG.md\n");
    return 1;
  }
  const entries = extractUnreleasedDashEntries(text);
  if (entries.length === 0) {
    io.writeOut('FAIL: [Unreleased] section has no entries (no lines starting with "- ")\n');
    return 1;
  }
  if (options.againstMergeBase === true) {
    const compared = compareUnreleasedAgainstMergeBase(root, entries, io);
    if (compared !== 0) {
      return compared;
    }
  }
  io.writeOut(`OK: CHANGELOG.md [Unreleased] section has ${entries.length} entries\n`);
  return 0;
}

/** Port of ``task change:init`` inline Python (#2022 Phase 2). */
export function runChangeInit(projectRoot: string, name: string, io: TaskSurfaceIo): number {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    io.writeOut("FAIL: Usage: task change:init -- <name>\n");
    return 1;
  }
  if (!CHANGE_NAME_RE.test(trimmed)) {
    io.writeOut("FAIL: Name must contain only alphanumeric characters, underscores, and hyphens\n");
    return 1;
  }
  const projectAbs = resolve(projectRoot);
  try {
    const base = projectionTarget(projectAbs, join("history", "changes", trimmed));
    if (existsSync(base)) {
      io.writeOut(`FAIL: ${base} already exists\n`);
      return 1;
    }
    const specsDir = join(base, "specs");
    assertProjectionContained(projectAbs, specsDir);
    mkdirSync(specsDir, { recursive: true });
    const proposalPath = join(base, "proposal.xbrief.json");
    const tasksPath = join(base, "tasks.xbrief.json");
    // #2980 wave D: product write sinks route through containedWrite.
    containedWrite({
      root: projectAbs,
      target: proposalPath,
      data: `${JSON.stringify(proposalTemplate(trimmed), null, 2)}\n`,
      mode: "create",
    });
    containedWrite({
      root: projectAbs,
      target: tasksPath,
      data: `${JSON.stringify(tasksTemplate(trimmed), null, 2)}\n`,
      mode: "create",
    });
    io.writeOut(`OK: Created change proposal at ${base}/\n`);
    for (const file of ["proposal.xbrief.json", "tasks.xbrief.json", "specs/"]) {
      io.writeOut(`  - ${file}\n`);
    }
    return 0;
  } catch (err) {
    const code = containmentExitCode(io, err);
    if (code !== null) {
      return code;
    }
    throw err;
  }
}

/** Port of ``task commit:lint`` inline Python (#2022 Phase 2). */
export function runCommitLint(projectRoot: string, io: TaskSurfaceIo): number {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["log", "--format=%B", "-1"], {
      cwd: resolve(projectRoot),
      encoding: "utf8",
    });
  } catch {
    io.writeOut("FAIL: Could not read HEAD commit message\n");
    return 1;
  }
  const msg = stdout.trim();
  const subject = msg.split("\n")[0] ?? "";
  if (!COMMIT_SUBJECT_RE.test(subject)) {
    io.writeOut("FAIL: Commit message does not match conventional commit format\n");
    io.writeOut(`  Got:      ${subject}\n`);
    io.writeOut("  Expected: type(scope): description\n");
    io.writeOut(
      "  Types:    feat, fix, docs, chore, refactor, test, style, perf, ci, build, revert\n",
    );
    return 1;
  }
  io.writeOut("OK: Commit message is valid conventional commit\n");
  io.writeOut(`  Subject: ${subject}\n`);
  return 0;
}

/** Port of ``task install:uninstall`` inline Python (#2022 Phase 2). */
export function runInstallUninstall(projectRoot: string, io: TaskSurfaceIo): number {
  const path = join(resolve(projectRoot), "AGENTS.md");
  if (!existsSync(path) || !statSync(path).isFile()) {
    io.writeOut("No deft entry found in AGENTS.md\n");
    return 0;
  }
  const original = readFileSync(path, "utf8");
  const lines = original.split(/(?<=\n)/);
  const filtered = lines.filter(
    (line) => !line.startsWith("See deft/main.md") && !line.startsWith("Skills: deft/skills/"),
  );
  const next = filtered.join("");
  if (next !== original) {
    try {
      // #2980 wave D: product write sink routes through containedWrite.
      containedWrite({
        root: resolve(projectRoot),
        target: path,
        data: next,
        mode: "replace",
      });
      io.writeOut("Removed deft entry from AGENTS.md\n");
    } catch (err) {
      const code = containmentExitCode(io, err);
      if (code !== null) {
        return code;
      }
      throw err;
    }
  } else {
    io.writeOut("No deft entry found in AGENTS.md\n");
  }
  return 0;
}
