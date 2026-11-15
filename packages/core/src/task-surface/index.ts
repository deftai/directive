import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEGACY_VBRIEF_VERSION } from "@deftai/directive-types";
import { readEffectiveUnreleased } from "../changelog/effective-unreleased.js";
import {
  CHANGELOG_FILE_REL,
  isChangelogEntryPath,
  isChangelogFragmentPath,
} from "../changelog/entry-path.js";
import {
  type ChangelogChangeSetEntry,
  evaluateChangelogGate,
  evaluateFragmentIntegrity,
  readChangelogFragment,
} from "../changelog/fragment.js";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { resolveChangelogMode } from "../policy/changelog-mode.js";
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

/**
 * `git diff --name-status --no-renames <merge-base>...HEAD`, or null on failure.
 * With no renames a renamed file is a `D` row plus an `A` row.
 */
function changeSetAgainstMergeBase(
  root: string,
  mergeBaseSha: string,
): ChangelogChangeSetEntry[] | null {
  const out = gitText(root, ["diff", "--name-status", "--no-renames", `${mergeBaseSha}...HEAD`]);
  if (out === null) {
    return null;
  }
  const rows: ChangelogChangeSetEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [status, path] = line.split("\t");
    if (status !== undefined && path !== undefined && status.trim().length > 0) {
      rows.push({ status: status.trim(), path: path.trim() });
    }
  }
  return rows;
}

function isDeliveryBriefLandChangeSet(rows: readonly ChangelogChangeSetEntry[]): boolean {
  return isDeliveryBriefLandExcluded(
    rows.map((row) => ({ status: "modified", filename: row.path })),
  );
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

type MergeBaseVerdict = { readonly exit: number; readonly final: boolean };

const NO_ENTRIES = 'FAIL: [Unreleased] section has no entries (no lines starting with "- ")\n';

/**
 * Merge-base half of `verify:changelog-unreleased` (#633 / #680 / #6315).
 * `final` means the caller returns `exit` without its own OK line.
 */
function checkAgainstMergeBase(
  root: string,
  text: string,
  entries: readonly string[],
  total: number,
  io: TaskSurfaceIo,
): MergeBaseVerdict {
  const mergeBase = resolveChangelogMergeBase(root);
  if ("error" in mergeBase) {
    if (total === 0) {
      io.writeOut(NO_ENTRIES);
      return { exit: 1, final: true };
    }
    io.writeOut(`FAIL: ${mergeBase.error}\n`);
    return { exit: 2, final: true };
  }
  const head = gitText(root, ["rev-parse", "HEAD"])?.trim();
  if (head === mergeBase.sha) {
    if (total === 0) {
      io.writeOut(NO_ENTRIES);
      return { exit: 1, final: true };
    }
    return { exit: 0, final: false };
  }
  const resolvedMode = resolveChangelogMode(root);
  if (resolvedMode.error !== null) {
    io.writeOut(`WARN: ${resolvedMode.error}; reading changelog mode as inline\n`);
  }
  const mode = resolvedMode.mode;
  // A failed diff is never exempt (fail closed). Inline mode keeps today's
  // line compare; the fragment modes cannot judge without the change set.
  const changeSet = changeSetAgainstMergeBase(root, mergeBase.sha);
  if (changeSet === null && mode !== "inline") {
    io.writeOut("FAIL: could not list the change set versus merge-base (git diff failed)\n");
    return { exit: 2, final: true };
  }
  const rows = changeSet ?? [];
  const readFragment = (rel: string) => readChangelogFragment(root, rel);
  // #6315: in every mode a change set only adds fragments, and each is valid.
  const integrity = evaluateFragmentIntegrity(rows, readFragment);
  if (!integrity.ok) {
    for (const problem of integrity.problems) io.writeOut(`FAIL: ${problem}\n`);
    return { exit: 1, final: true };
  }
  // #680 P4: a delivery-brief-land change set (lifecycle briefs, changelog entry
  // paths, the spec-drift ledger only) needs no new entry. Oracle is the
  // committed change set vs merge-base; --no-renames lists rename sources too.
  // An empty change set is not exempt. Product/code diffs keep the requirement.
  if (changeSet !== null && isDeliveryBriefLandChangeSet(changeSet)) {
    if (total === 0) {
      io.writeOut(
        "OK: CHANGELOG.md [Unreleased] section has 0 entries; lifecycle-only change set needs none (#680)\n",
      );
      return { exit: 0, final: true };
    }
    return { exit: 0, final: false };
  }
  if (total === 0) {
    io.writeOut(NO_ENTRIES);
    return { exit: 1, final: true };
  }
  const baseText = gitText(root, ["show", `${mergeBase.sha}:${CHANGELOG_FILE_REL}`]);
  const baseSet = new Set(baseText === null ? [] : extractUnreleasedDashEntries(baseText));
  const addedInline = entries.filter((entry) => !baseSet.has(entry)).length;
  const changelogChanged =
    rows.some((row) => isChangelogEntryPath(row.path) && !isChangelogFragmentPath(row.path)) ||
    baseText === null ||
    normalizeEol(baseText) !== normalizeEol(text);
  const verdict = evaluateChangelogGate({
    mode,
    changeSet: rows,
    changelogChanged,
    addedInlineEntries: addedInline,
    readFragment,
  });
  if (!verdict.ok) {
    for (const problem of verdict.problems) io.writeOut(`FAIL: ${problem}\n`);
    if (mode !== "inline") io.writeOut(`  changelog mode: ${mode} (plan.policy.changelog.mode)\n`);
    return { exit: 1, final: true };
  }
  return { exit: 0, final: false };
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
  // #6314: the presence check reads the effective view: `[Unreleased]` lines plus
  // the entries of valid `changelog.d/` fragments. With no fragment it is unchanged.
  const effective = readEffectiveUnreleased(root, { changelogText: text });
  for (const bad of effective.invalidFragments) {
    io.writeOut(
      `WARN: ignoring invalid changelog fragment ${bad.path} (${bad.reason}: ${bad.detail})\n`,
    );
  }
  const fragmentEntryCount = effective.entries.length - effective.changelogEntries.length;
  const total = entries.length + fragmentEntryCount;
  if (options.againstMergeBase === true) {
    // #6315: the merge-base gate reads plan.policy.changelog.mode and the change set.
    const verdict = checkAgainstMergeBase(root, text, entries, total, io);
    if (verdict.final || verdict.exit !== 0) {
      return verdict.exit;
    }
  } else if (total === 0) {
    io.writeOut(NO_ENTRIES);
    return 1;
  }
  if (fragmentEntryCount > 0) {
    io.writeOut(
      `OK: [Unreleased] has ${total} entries (${entries.length} in CHANGELOG.md, ${fragmentEntryCount} in changelog.d/)\n`,
    );
    return 0;
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
