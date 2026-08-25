import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCompletedWriteGuard, scanCompletedWriteCorpus } from "./completed-write-guard.js";

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

  it("skips when the project root has no merge-base or is not a git working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-nongit-"));
    try {
      const result = evaluateCompletedWriteGuard(root);
      expect(result.code).toBe(0);
      expect(result.message).toMatch(/skipped -- not a git working tree/);
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
      const result = scanCompletedWriteCorpus(root);
      expect(result.scanned).toBe(1);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
