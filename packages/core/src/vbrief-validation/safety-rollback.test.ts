import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSafetyManifest,
  manifestPath,
  rollback,
  SafetyManifest,
  sha256Of,
  writeBackups,
} from "./safety.js";

function writeManifest(root: string, manifest: SafetyManifest): void {
  mkdirSync(join(root, "vbrief", "migration"), { recursive: true });
  writeFileSync(manifestPath(root), manifest.toJson(), "utf8");
}

describe("safety rollback branches", () => {
  it("refuses when redirect stubs were edited", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-rb-stub-"));
    writeFileSync(join(root, "SPECIFICATION.md"), "edited", "utf8");
    const hash = sha256Of(join(root, "SPECIFICATION.md"));
    writeManifest(
      root,
      new SafetyManifest({
        post_migration_stub_hashes: { "SPECIFICATION.md": "deadbeef" },
        backups: [],
      }),
    );
    const [ok, lines] = rollback(root);
    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("Redirect stubs have been edited"))).toBe(true);
    expect(hash.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses when migrator-modified files were edited", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-rb-mod-"));
    writeFileSync(join(root, ".gitignore"), "user-edited\n", "utf8");
    writeManifest(
      root,
      new SafetyManifest({
        file_modifications: [
          {
            path: ".gitignore",
            operation: "append",
            pre_hash: "0000000000000000000000000000000000000000000000000000000000000000",
            post_hash: "1111111111111111111111111111111111111111111111111111111111111111",
            appended_content: "appended\n",
          },
        ],
        backups: [],
      }),
    );
    const [ok, lines] = rollback(root);
    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("Migrator-modified file(s)"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("aborts when operator declines confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-rb-abort-"));
    writeManifest(root, new SafetyManifest({ backups: [], created_files: [] }));
    const [ok, lines] = rollback(root, { confirmFn: () => false });
    expect(ok).toBe(false);
    expect(lines).toEqual(["Rollback aborted by operator."]);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses when backup files are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-rb-missing-"));
    writeManifest(
      root,
      new SafetyManifest({
        backups: [
          {
            source: "SPECIFICATION.md",
            backup: "SPECIFICATION.premigrate.md",
            source_sha256: "abc",
            size_bytes: 1,
          },
        ],
      }),
    );
    const [ok, lines] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("Backup file(s) missing"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a full successful rollback with renames and modifications", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-rb-full-"));
    const src = join(root, "SPECIFICATION.md");
    const backup = join(root, "SPECIFICATION.premigrate.md");
    writeFileSync(src, "stub", "utf8");
    writeFileSync(backup, "original", "utf8");
    const created = join(root, "vbrief", "migration", "LEGACY-REPORT.md");
    mkdirSync(join(root, "vbrief", "migration"), { recursive: true });
    writeFileSync(created, "legacy", "utf8");
    const renamed = join(root, "vbrief", "migration", "LEGACY-REPORT.reviewed.md");
    writeFileSync(renamed, "legacy", "utf8");
    const gitignore = join(root, ".gitignore");
    writeFileSync(gitignore, "base\nappended\n", "utf8");
    const postHash = sha256Of(gitignore);
    writeFileSync(join(root, "NEW.txt"), "new", "utf8");
    const newHash = sha256Of(join(root, "NEW.txt"));
    writeManifest(
      root,
      new SafetyManifest({
        backups: [
          {
            source: "SPECIFICATION.md",
            backup: "SPECIFICATION.premigrate.md",
            source_sha256: sha256Of(backup),
            size_bytes: 8,
          },
        ],
        created_files: ["vbrief/migration/LEGACY-REPORT.md"],
        created_dirs: ["vbrief/migration"],
        renames: [
          {
            original: "vbrief/migration/LEGACY-REPORT.md",
            current: "vbrief/migration/LEGACY-REPORT.reviewed.md",
            renamed_by: "sync",
            renamed_at: "2026-04-22T00:00:00Z",
          },
        ],
        file_modifications: [
          {
            path: ".gitignore",
            operation: "append",
            pre_hash: sha256Of("base\n"),
            post_hash: postHash,
            appended_content: "appended\n",
          },
          {
            path: "NEW.txt",
            operation: "create",
            pre_hash: "",
            post_hash: newHash,
            appended_content: "new",
          },
          {
            path: "WEIRD.txt",
            operation: "noop",
            pre_hash: "",
            post_hash: "",
            appended_content: "",
          },
        ],
      }),
    );
    const [ok, actions] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    expect(readFileSync(src, "utf8")).toBe("original");
    expect(actions.some((a) => a.includes("RESTORE"))).toBe(true);
    expect(actions.some((a) => a.includes("REMOVE"))).toBe(true);
    expect(actions.some((a) => a.includes("REVERT .gitignore"))).toBe(true);
    expect(loadSafetyManifest(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("writeBackups copies bytes when not dry-run", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-backup-real-"));
    const src = join(root, "SPECIFICATION.md");
    writeFileSync(src, "payload", "utf8");
    const dst = join(root, "SPECIFICATION.premigrate.md");
    const [records, actions] = writeBackups(root, [[src, dst]], { dryRun: false });
    expect(records[0]?.size_bytes).toBe(7);
    expect(readFileSync(dst, "utf8")).toBe("payload");
    expect(actions[0]).toContain("BACKUP");
    rmSync(root, { recursive: true, force: true });
  });
});
