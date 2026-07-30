import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEGACY_VBRIEF_VERSION } from "@deftai/directive-types";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";

export interface TaskSurfaceIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

const UNRELEASED_RE = /## \[Unreleased\][ \t]*\n([\s\S]*?)(?=\n## \[|$)/;
const CHANGE_NAME_RE = /^[\w][\w-]*$/;
const COMMIT_TYPES = "feat|fix|docs|chore|refactor|test|style|perf|ci|build|revert";
const COMMIT_SUBJECT_RE = new RegExp(`^(${COMMIT_TYPES})(\\(.+\\))?!?: .+`);

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

/** Port of ``task change:changelog:check`` inline Python (#2022 Phase 2). */
export function runChangelogCheck(projectRoot: string, io: TaskSurfaceIo): number {
  const path = join(resolve(projectRoot), "CHANGELOG.md");
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
  const body = match[1] ?? "";
  const entries = body.split("\n").filter((line) => line.trimStart().startsWith("- "));
  if (entries.length === 0) {
    io.writeOut('FAIL: [Unreleased] section has no entries (no lines starting with "- ")\n');
    return 1;
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
