import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPLETED_WRITE_GUARD_MAX_BYTES,
  evaluateCompletedWriteGuard,
  scanCompletedWriteCorpus,
  UNPAIRED_ACTIVE_DELETE_REMEDIATION,
} from "./completed-write-guard.js";

function isolatedGitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.DEFT_BASE_REF;
  delete env.GITHUB_BASE_REF;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  env.GIT_AUTHOR_NAME = "t";
  env.GIT_AUTHOR_EMAIL = "t@t.test";
  env.GIT_COMMITTER_NAME = "t";
  env.GIT_COMMITTER_EMAIL = "t@t.test";
  return env;
}

function gitOk(args: string[], cwd: string): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnv(cwd),
  });
  expect(r.status, `${args.join(" ")}\n${r.stderr ?? ""}${r.stdout ?? ""}`).toBe(0);
}

function husk(status = "completed"): string {
  return JSON.stringify({
    xBRIEFInfo: { version: "0.8" },
    plan: {
      title: "husk",
      status,
      metadata: { kind: "fix" },
    },
  });
}

function stamped(status = "completed"): string {
  return JSON.stringify({
    xBRIEFInfo: { version: "0.8" },
    plan: {
      title: "stamped",
      status,
      metadata: {
        lifecycleWrite: {
          action: status === "failed" ? "fail" : "complete",
          writtenAt: "2026-08-25T00:00:00Z",
        },
      },
    },
  });
}

describe("evaluateCompletedWriteGuard (#3679)", () => {
  it("refuses a newly added completed/ husk", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-husk.xbrief.json", "src/app.ts"],
      payloads: new Map([["xbrief/completed/2026-08-25-husk.xbrief.json", husk()]]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/unguarded completed\/ add/);
    expect(result.message).toMatch(/leftover land PR \(#3476\)/);
    expect(result.findings).toHaveLength(1);
  });

  it("accepts a newly added completed/ blob with a transition write", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-ok.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-ok.xbrief.json", stamped()]]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("accepts a failed completion without provenance", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-fail.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-fail.xbrief.json", husk("failed")]]),
    });
    expect(result.code).toBe(0);
  });

  it("ignores added files outside completed/", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/active/story.xbrief.json", "CHANGELOG.md"],
      payloads: new Map([["xbrief/active/story.xbrief.json", husk()]]),
    });
    expect(result.code).toBe(0);
  });

  it("refuses an added completed/ blob with unreadable plan JSON", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-bad.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-bad.xbrief.json", "{not json"]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/unreadable plan/);
  });

  it("refuses an added completed/ blob that is missing on disk", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-missing.xbrief.json"],
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/unreadable$/);
  });

  it("accepts a vbrief/completed stamp the same as xbrief/", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["vbrief/completed/2026-08-25-ok.xbrief.json"],
      payloads: new Map([["vbrief/completed/2026-08-25-ok.xbrief.json", stamped()]]),
    });
    expect(result.code).toBe(0);
  });

  it("skips when the project root is not a git working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-nongit-"));
    try {
      const result = evaluateCompletedWriteGuard(root);
      expect(result.code).toBe(0);
      expect(result.message).toMatch(/skipped -- not a git working tree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an over-limit completed/ artifact through the controlled path", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-oversize-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      const rel = "xbrief/completed/2026-08-25-huge.xbrief.json";
      writeFileSync(join(root, rel), "x".repeat(COMPLETED_WRITE_GUARD_MAX_BYTES + 1), "utf8");
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.detail).toContain(rel);
      expect(result.findings[0]?.detail).toContain(
        `${String(COMPLETED_WRITE_GUARD_MAX_BYTES)}-byte read limit`,
      );
      expect(result.message).toMatch(/unguarded completed\/ add/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a stamped completed/ artifact under the read limit from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-undersize-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      const rel = "xbrief/completed/2026-08-25-ok.xbrief.json";
      writeFileSync(join(root, rel), stamped(), "utf8");
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a newly added completed/ path that is not a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-dir-"));
    try {
      const rel = "xbrief/completed/2026-08-25-dir.xbrief.json";
      mkdirSync(join(root, rel), { recursive: true });
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings[0]?.detail).toMatch(/not a regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a newly added completed/ symlink without following it", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-link-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      const target = join(root, "target.json");
      writeFileSync(target, husk(), "utf8");
      const rel = "xbrief/completed/2026-08-25-link.xbrief.json";
      try {
        symlinkSync(target, join(root, rel));
      } catch {
        return;
      }
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings[0]?.detail).toMatch(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a completed/ path whose parent directory is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-parent-link-"));
    try {
      const realDir = join(root, "real-completed");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "2026-08-25-link.xbrief.json"), husk(), "utf8");
      mkdirSync(join(root, "xbrief"), { recursive: true });
      const rel = "xbrief/completed/2026-08-25-link.xbrief.json";
      try {
        symlinkSync(realDir, join(root, "xbrief", "completed"), "dir");
      } catch {
        return;
      }
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings[0]?.detail).toMatch(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a git tree has no merge-base ref", { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-nobase-"));
    try {
      const init = spawnSync("git", ["init", "-q", "-b", "deft-no-base"], {
        cwd: root,
        encoding: "utf8",
        env: isolatedGitEnv(root),
      });
      expect(init.status, String(init.stderr ?? "")).toBe(0);
      const result = evaluateCompletedWriteGuard(root);
      expect(result.code).toBe(2);
      expect(result.message).toMatch(
        /no merge-base ref found|base ref .* not found|Pass --base-ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the base ref has no merge-base with HEAD", { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-unrelated-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      gitOk(["checkout", "--orphan", "other"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "other"], root);
      const result = evaluateCompletedWriteGuard(root, { baseRef: "master" });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(
        /committed change-set unavailable|no merge base|Pass --base-ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scanCompletedWriteCorpus (#3679)", () => {
  it("reports historical husks as findings and ignores stamped files", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-corpus-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "husk.xbrief.json"), husk(), "utf8");
      writeFileSync(join(dir, "ok.xbrief.json"), stamped(), "utf8");
      const result = scanCompletedWriteCorpus(root);
      expect(result.scanned).toBe(2);
      expect(result.findings.map((f) => f.relPath)).toEqual(["xbrief/completed/husk.xbrief.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips unreadable and invalid corpus blobs without counting them as husks", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-corpus-bad-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "empty-dir-placeholder.xbrief.json"), "[", "utf8");
      mkdirSync(join(dir, "dir-not-file.xbrief.json"));
      const result = scanCompletedWriteCorpus(root);
      expect(result.scanned).toBe(2);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluateCompletedWriteGuard (#3766 active deletion)", () => {
  const active = "xbrief/active/2026-08-25-story.xbrief.json";
  const completed = "xbrief/completed/2026-08-25-story.xbrief.json";

  it("rejects an unaccompanied delete of an active brief", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}`,
    });
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.relPath).toBe(active);
    expect(result.message).toMatch(/no paired stamped destination/);
  });

  it("accepts a rename from active/ to a stamped completed/ destination", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${completed}`,
      payloads: new Map([[completed, stamped()]]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("accepts a delete of active/ paired with a stamped completed/ add", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${completed}`,
      payloads: new Map([[completed, stamped()]]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("halts lone-D cleanup naming scope:complete or leave untracked", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}`,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("scope:complete");
    expect(result.message).toMatch(/untracked/);
    expect(result.message).toContain(UNPAIRED_ACTIVE_DELETE_REMEDIATION);
  });

  it("rejects an unaccompanied active delete discovered from git", { timeout: 20_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-active-del-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      const dir = join(root, "xbrief", "active");
      mkdirSync(dir, { recursive: true });
      const rel = "xbrief/active/2026-08-25-other.xbrief.json";
      writeFileSync(join(root, rel), husk("running"), "utf8");
      gitOk(["add", rel], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "track active"], root);
      gitOk(["rm", "-f", rel], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "delete active"], root);
      const result = evaluateCompletedWriteGuard(root, { baseRef: "HEAD~1" });
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.relPath === rel)).toBe(true);
      expect(result.message).toMatch(/no paired stamped destination/);
      expect(result.message).toContain("scope:complete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
