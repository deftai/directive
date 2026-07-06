import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeState } from "../doctor/doctor-state.js";
import { append } from "../intake/candidates-log.js";
import { resolveEvalDir } from "../layout/resolve.js";
import {
  migrateLegacyTriageCacheFromEval,
  resolveCandidatesLogPath,
  resolveTriageCacheDir,
  resolveTriageCachePath,
  TRIAGE_CACHE_DIR_NAME,
  triageCacheRelPath,
} from "./cache-path.js";

describe("triage cache-path (#1703)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "triage-cache-path-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedVbrief(): void {
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "s.vbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  }

  function seedXbrief(): void {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "s.xbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  }

  it("resolves the dedicated triage-cache directory under the active lifecycle root", () => {
    seedVbrief();
    expect(resolveTriageCacheDir(root)).toBe(join(root, "vbrief", TRIAGE_CACHE_DIR_NAME));
    expect(resolveTriageCachePath(root, "candidates.jsonl")).toBe(
      join(root, "vbrief", TRIAGE_CACHE_DIR_NAME, "candidates.jsonl"),
    );
    expect(triageCacheRelPath(root, "candidates.jsonl")).toBe(
      "vbrief/.triage-cache/candidates.jsonl",
    );
  });

  it("resolves under xbrief when the migrated tree exists", () => {
    seedXbrief();
    expect(resolveTriageCacheDir(root)).toBe(join(root, "xbrief", TRIAGE_CACHE_DIR_NAME));
    expect(triageCacheRelPath(root, "summary-history.jsonl")).toBe(
      "xbrief/.triage-cache/summary-history.jsonl",
    );
  });

  it("migrates legacy candidates.jsonl from .eval into .triage-cache on resolve", () => {
    seedVbrief();
    const legacyDir = resolveEvalDir(root);
    mkdirSync(legacyDir, { recursive: true });
    const legacyBody = '{"decision_id":"00000000-0000-4000-8000-000000000001"}\n';
    writeFileSync(join(legacyDir, "candidates.jsonl"), legacyBody, "utf8");

    const resolved = resolveCandidatesLogPath(root);
    expect(resolved).toBe(join(root, "vbrief", TRIAGE_CACHE_DIR_NAME, "candidates.jsonl"));
    expect(existsSync(resolved)).toBe(true);
    expect(readFileSync(resolved, "utf8")).toBe(legacyBody);
    expect(existsSync(join(legacyDir, "candidates.jsonl"))).toBe(false);
  });

  it("migrateLegacyTriageCacheFromEval is idempotent and removes orphaned legacy copies when target already exists", () => {
    seedVbrief();
    const legacyDir = resolveEvalDir(root);
    const targetDir = resolveTriageCacheDir(root);
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(legacyDir, "candidates.jsonl"), "legacy\n", "utf8");
    writeFileSync(join(targetDir, "candidates.jsonl"), "canonical\n", "utf8");

    const first = migrateLegacyTriageCacheFromEval(root);
    expect(first.removedLegacyFiles).toContain("candidates.jsonl");
    expect(readFileSync(join(targetDir, "candidates.jsonl"), "utf8")).toBe("canonical\n");
    expect(existsSync(join(legacyDir, "candidates.jsonl"))).toBe(false);

    writeFileSync(join(legacyDir, "summary-history.jsonl"), "history\n", "utf8");
    const second = migrateLegacyTriageCacheFromEval(root);
    expect(second.migratedFiles).toContain("summary-history.jsonl");
    expect(existsSync(join(targetDir, "summary-history.jsonl"))).toBe(true);
  });

  it("migrates the decompositions directory from legacy .eval", () => {
    seedVbrief();
    const legacyDir = resolveEvalDir(root);
    const decompDir = join(legacyDir, "decompositions");
    mkdirSync(decompDir, { recursive: true });
    writeFileSync(join(decompDir, "draft.json"), "{}", "utf8");

    const result = migrateLegacyTriageCacheFromEval(root);
    expect(result.migratedDirs).toContain("decompositions");
    expect(existsSync(join(resolveTriageCacheDir(root), "decompositions", "draft.json"))).toBe(
      true,
    );
    expect(existsSync(decompDir)).toBe(false);
  });

  it("leaves .eval free for version-eval results after triage migration", () => {
    seedVbrief();
    const legacyDir = resolveEvalDir(root);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "candidates.jsonl"), "triage\n", "utf8");
    mkdirSync(join(legacyDir, "results"), { recursive: true });
    writeFileSync(join(legacyDir, "results", "v0.1.json"), "{}", "utf8");

    resolveTriageCachePath(root, "candidates.jsonl");

    expect(existsSync(join(legacyDir, "candidates.jsonl"))).toBe(false);
    expect(existsSync(join(legacyDir, "results", "v0.1.json"))).toBe(true);
    expect(existsSync(join(resolveTriageCacheDir(root), "candidates.jsonl"))).toBe(true);
  });

  it("regenerates README.md with layout-aware .triage-cache paths instead of renaming stale .eval content", () => {
    seedXbrief();
    const legacyDir = resolveEvalDir(root);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "README.md"),
      "# legacy `.eval/` readme -- do not keep\n",
      "utf8",
    );

    const result = migrateLegacyTriageCacheFromEval(root);
    expect(result.regeneratedFiles).toContain("README.md");
    expect(existsSync(join(legacyDir, "README.md"))).toBe(false);

    const readme = readFileSync(join(resolveTriageCacheDir(root), "README.md"), "utf8");
    expect(readme).toContain("xbrief/.triage-cache/");
    expect(readme).not.toContain("`.eval/`");
    expect(readme).not.toContain("legacy `.eval/` readme");
  });

  it("preserves an existing canonical README and only removes the legacy copy", () => {
    seedXbrief();
    const legacyDir = resolveEvalDir(root);
    const targetDir = resolveTriageCacheDir(root);
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(legacyDir, "README.md"), "# stale legacy\n", "utf8");
    writeFileSync(join(targetDir, "README.md"), "# canonical custom\n", "utf8");

    const result = migrateLegacyTriageCacheFromEval(root);
    expect(result.removedLegacyFiles).toContain("README.md");
    expect(result.regeneratedFiles).not.toContain("README.md");
    expect(readFileSync(join(targetDir, "README.md"), "utf8")).toBe("# canonical custom\n");
    expect(existsSync(join(legacyDir, "README.md"))).toBe(false);
  });

  it("removes orphaned legacy triage-cache files when the canonical .triage-cache copy already exists", () => {
    seedXbrief();
    const legacyDir = resolveEvalDir(root);
    const targetDir = resolveTriageCacheDir(root);
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(legacyDir, "doctor-state.json"), '{"stale":true}\n', "utf8");
    writeFileSync(join(targetDir, "doctor-state.json"), '{"canonical":true}\n', "utf8");

    const result = migrateLegacyTriageCacheFromEval(root);
    expect(result.removedLegacyFiles).toContain("doctor-state.json");
    expect(existsSync(join(legacyDir, "doctor-state.json"))).toBe(false);
    expect(readFileSync(join(targetDir, "doctor-state.json"), "utf8")).toContain("canonical");
  });

  it("writeState persists under .triage-cache on migrated xbrief trees, not legacy .eval", () => {
    seedXbrief();
    const legacyDir = resolveEvalDir(root);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "doctor-state.json"), '{"legacy":true}\n', "utf8");

    const path = writeState(root, {
      exitCode: 0,
      findingCount: 0,
      errorCount: 0,
      now: new Date("2026-07-06T00:00:00Z"),
    });

    expect(path).not.toBeNull();
    if (path === null) {
      throw new Error("expected writeState to return a path");
    }
    expect(path).toBe(join(root, "xbrief", TRIAGE_CACHE_DIR_NAME, "doctor-state.json"));
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(legacyDir, "doctor-state.json"))).toBe(false);
  });

  it("intake candidates-log append defaults to .triage-cache, not legacy .eval", () => {
    seedXbrief();
    const legacyDir = resolveEvalDir(root);
    mkdirSync(legacyDir, { recursive: true });

    const prev = process.cwd();
    try {
      process.chdir(root);
      append({
        decision_id: "00000000-0000-4000-8000-000000000001",
        timestamp: "2026-07-06T00:00:00Z",
        repo: "deftai/directive",
        issue_number: 2344,
        decision: "accept",
        actor: "agent:test",
      });
    } finally {
      process.chdir(prev);
    }

    const canonical = join(root, "xbrief", TRIAGE_CACHE_DIR_NAME, "candidates.jsonl");
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(join(legacyDir, "candidates.jsonl"))).toBe(false);
  });
});
