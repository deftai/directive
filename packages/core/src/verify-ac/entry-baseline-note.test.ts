/**
 * #6374 item 4: context note on verified rows whose file is unchanged since the
 * commit before a committed brief entered its lifecycle folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateVerifyAcFromPath } from "../product-first-done-gate/evaluate.js";
import type { ClauseWalkResult } from "./clauses.js";
import {
  annotateUnchangedSinceEntry,
  ENTRY_BASELINE_NOTE,
  resolveEntryBaselineCommit,
} from "./entry-baseline-note.js";

const roots: string[] = [];
const BRIEF_NAME = "2026-11-17-1-entry-note.xbrief.json";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function plan(): Record<string, unknown> {
  return {
    id: "6374-note",
    title: "entry baseline note",
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      ambiguity_attestation: "none_found",
      clauses: [
        {
          id: 1,
          text: 'The module exports "ENTRY_TOKEN_6374".',
          artifact_path: "src/a.ts",
          ambiguous: false,
        },
      ],
    },
    metadata: { swarm: { file_scope: ["src/a.ts"] } },
    items: [],
  };
}

/** Repo with src/a.ts committed; the brief is written to `folder` but not committed. */
function repo(folder: string): { root: string; brief: string; rel: string } {
  const root = mkdtempSync(join(tmpdir(), "ac-6374-note-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "master");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), 'export const x = "ENTRY_TOKEN_6374";\n');
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed product file");
  mkdirSync(join(root, "xbrief", folder), { recursive: true });
  const rel = `xbrief/${folder}/${BRIEF_NAME}`;
  const brief = join(root, ...rel.split("/"));
  writeFileSync(brief, `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: plan() })}\n`);
  return { root, brief, rel };
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

function verifiedRow(): ClauseWalkResult {
  return {
    id: 1,
    text: "t",
    artifact_path: "src/a.ts",
    outcome: "verified",
    detail: "expected token(s) present",
    adjudicable: true,
  };
}

function report(rows: ClauseWalkResult[]) {
  return {
    clauses: rows,
    failed: rows.filter((r) => r.outcome === "failed"),
    unverifiable: rows.filter((r) => r.outcome === "unverifiable"),
    verified: rows.filter((r) => r.outcome === "verified"),
    ok: true,
  };
}

const evalOptions = {
  captureFromNarratives: false,
  hasSuiteFloor: true,
  bankOnPass: false,
  reuseMode: "never" as const,
  applyOracleIntegrity: false,
  runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

function firstLine(message: string): string {
  return (message.split("\n").find((row) => row.trim().length > 0) ?? "").trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("entry baseline context note (#6374)", () => {
  it("marks a verified row on a committed active brief; the first line and exit code match the uncommitted run", () => {
    const { root, brief } = repo("active");
    // Not committed at its path yet: no note.
    const before = evaluateVerifyAcFromPath(brief, { ...evalOptions, projectRoot: root });
    expect(before.message).not.toContain(ENTRY_BASELINE_NOTE);

    commitAll(root, "brief enters active/");
    const after = evaluateVerifyAcFromPath(brief, { ...evalOptions, projectRoot: root });
    const row = after.message.split("\n").find((line) => line.includes("[verified] clause 1"));
    expect(row).toBeDefined();
    expect(row).toContain(ENTRY_BASELINE_NOTE);

    // The note never changes the first line, the outcome or the exit code.
    expect(firstLine(after.message)).toBe(firstLine(before.message));
    expect(firstLine(after.message)).toMatch(/^verify:ac passed \(#3284\) \(1 verified/);
    expect([before.code, after.code]).toEqual([0, 0]);
    expect(after.clauseOutcomes?.map((r) => r.outcome)).toEqual(["verified"]);
    expect(after.resolution).toBe(before.resolution);
  });

  it("gives no note for an active brief that is not committed at its path", () => {
    const { root, rel } = repo("active");
    expect(resolveEntryBaselineCommit(root, rel)).toBeNull();
    const out = annotateUnchangedSinceEntry(report([verifiedRow()]), {
      projectRoot: root,
      xbriefPath: rel,
    });
    expect(out.clauses[0]?.detail).not.toContain(ENTRY_BASELINE_NOTE);
  });

  it("gives no note when the file changed after the brief entered its folder", () => {
    const { root, rel } = repo("active");
    commitAll(root, "brief enters active/");
    writeFileSync(join(root, "src", "a.ts"), 'export const x = "ENTRY_TOKEN_6374"; // work\n');
    const out = annotateUnchangedSinceEntry(report([verifiedRow()]), {
      projectRoot: root,
      xbriefPath: rel,
    });
    expect(out.clauses[0]?.detail).toBe("expected token(s) present");
  });

  it("uses the parent of the commit that added the brief at its current path (lifecycle move)", () => {
    const { root, rel } = repo("pending");
    commitAll(root, "brief enters pending/");
    const activeRel = rel.replace("/pending/", "/active/");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    git(root, "mv", rel, activeRel);
    commitAll(root, "brief enters active/");
    const moveCommit = git(root, "rev-parse", "HEAD");
    expect(resolveEntryBaselineCommit(root, activeRel)).toBe(
      git(root, "rev-parse", `${moveCommit}^`),
    );
    const out = annotateUnchangedSinceEntry(report([verifiedRow()]), {
      projectRoot: root,
      xbriefPath: activeRel,
    });
    expect(out.verified[0]?.detail).toContain(ENTRY_BASELINE_NOTE);
  });

  it("gives no note for a terminal folder, a missing path, a checkout outside git or non-verified rows", () => {
    const { root, rel } = repo("completed");
    commitAll(root, "brief completed");
    expect(resolveEntryBaselineCommit(root, rel)).toBeNull();
    expect(resolveEntryBaselineCommit(root, "elsewhere/brief.json")).toBeNull();

    const outside = mkdtempSync(join(tmpdir(), "ac-6374-nogit-"));
    roots.push(outside);
    expect(resolveEntryBaselineCommit(outside, `xbrief/active/${BRIEF_NAME}`)).toBeNull();

    const rows: ClauseWalkResult[] = [
      { ...verifiedRow(), outcome: "unverifiable", adjudicable: false },
    ];
    const input = report(rows);
    expect(annotateUnchangedSinceEntry(input, { projectRoot: root, xbriefPath: rel })).toBe(input);
    expect(
      annotateUnchangedSinceEntry(report([verifiedRow()]), { projectRoot: root, xbriefPath: null })
        .clauses[0]?.detail,
    ).toBe("expected token(s) present");
  });

  it("returns the report unchanged when the git runner reports no add commit", () => {
    const input = report([verifiedRow()]);
    // cat-file says the brief is committed; log finds no add commit.
    const git = () => ({ code: 0, stdout: "", stderr: "" });
    expect(
      annotateUnchangedSinceEntry(input, {
        projectRoot: process.cwd(),
        xbriefPath: `xbrief/active/${BRIEF_NAME}`,
        git,
      }),
    ).toBe(input);
  });
});

describe("entry baseline note with a fake git runner (#6374)", () => {
  const ADD = "a".repeat(40);
  const PARENT = "b".repeat(40);
  const BLOB = "c".repeat(40);
  const ACTIVE = `xbrief/active/${BRIEF_NAME}`;

  type Reply = { code: number; stdout: string };
  /** Answers by subcommand; anything not listed exits 0 with the given default. */
  function fakeGit(replies: Record<string, Reply | ((args: readonly string[]) => Reply)>) {
    return (_root: string, args: readonly string[]) => {
      const key = args[0] ?? "";
      const r = replies[key];
      const reply = typeof r === "function" ? r(args) : (r ?? { code: 0, stdout: "" });
      return { ...reply, stderr: "" };
    };
  }

  const happy = {
    "cat-file": { code: 0, stdout: "" },
    log: { code: 0, stdout: `${ADD}\n` },
    "rev-parse": (args: readonly string[]) =>
      String(args[3]).endsWith("^") ? { code: 0, stdout: PARENT } : { code: 0, stdout: BLOB },
    "hash-object": { code: 0, stdout: BLOB },
  };

  it("resolves the parent of the add commit", () => {
    expect(resolveEntryBaselineCommit(process.cwd(), ACTIVE, fakeGit(happy))).toBe(PARENT);
  });

  it("returns null for a path outside the project or an unknown layout", () => {
    expect(resolveEntryBaselineCommit(process.cwd(), "../elsewhere.json", fakeGit(happy))).toBe(
      null,
    );
    expect(
      resolveEntryBaselineCommit(process.cwd(), "notes/active/brief.json", fakeGit(happy)),
    ).toBeNull();
  });

  it("returns null when git log fails, prints no sha, or the add commit is a root commit", () => {
    const cwd = process.cwd();
    expect(
      resolveEntryBaselineCommit(
        cwd,
        ACTIVE,
        fakeGit({ ...happy, log: { code: 128, stdout: "" } }),
      ),
    ).toBeNull();
    expect(
      resolveEntryBaselineCommit(cwd, ACTIVE, fakeGit({ ...happy, log: { code: 0, stdout: "x" } })),
    ).toBeNull();
    expect(
      resolveEntryBaselineCommit(
        cwd,
        ACTIVE,
        fakeGit({ ...happy, "rev-parse": { code: 1, stdout: "" } }),
      ),
    ).toBeNull();
  });

  it("adds the note only when the blob ids match", () => {
    const noted = annotateUnchangedSinceEntry(report([verifiedRow()]), {
      projectRoot: process.cwd(),
      xbriefPath: ACTIVE,
      git: fakeGit(happy),
    });
    expect(noted.verified[0]?.detail).toContain(ENTRY_BASELINE_NOTE);
    expect(noted.clauses).toHaveLength(1);
  });

  it("gives no note when the file is missing at the parent or cannot be hashed", () => {
    const missingBefore = fakeGit({
      ...happy,
      "rev-parse": (args) =>
        String(args[3]).endsWith("^") ? { code: 0, stdout: PARENT } : { code: 1, stdout: "" },
    });
    const noHash = fakeGit({ ...happy, "hash-object": { code: 128, stdout: "" } });
    for (const git of [missingBefore, noHash]) {
      const out = annotateUnchangedSinceEntry(report([verifiedRow()]), {
        projectRoot: process.cwd(),
        xbriefPath: ACTIVE,
        git,
      });
      expect(out.clauses[0]?.detail).toBe("expected token(s) present");
    }
  });

  it("skips verified rows with no path or a path outside the project", () => {
    const rows: ClauseWalkResult[] = [
      { ...verifiedRow(), artifact_path: null },
      { ...verifiedRow(), id: 2, artifact_path: "../outside.ts" },
    ];
    const input = report(rows);
    expect(
      annotateUnchangedSinceEntry(input, {
        projectRoot: process.cwd(),
        xbriefPath: ACTIVE,
        git: fakeGit(happy),
      }),
    ).toBe(input);
  });
});
