import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCompletedWriteGuard, scanCompletedWriteCorpus } from "./completed-write-guard.js";

function isolatedGitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.DEFT_BASE_REF;
  delete env.GITHUB_BASE_REF;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  return env;
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
