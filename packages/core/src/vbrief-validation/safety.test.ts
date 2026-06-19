import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dirtyTreeRefusalMessage,
  planBackups,
  premigrateSibling,
  rollback,
  SafetyManifest,
  writeBackups,
} from "./safety.js";

describe("safety", () => {
  it("premigrateSibling preserves suffix chain", () => {
    expect(premigrateSibling("/tmp/specification.vbrief.json")).toBe(
      "/tmp/specification.premigrate.vbrief.json",
    );
  });

  it("SafetyManifest roundtrips JSON", () => {
    const manifest = new SafetyManifest({
      migration_timestamp: "2026-04-22T00:00:00Z",
      renames: [
        {
          original: "a.md",
          current: "b.md",
          renamed_by: "sync",
          renamed_at: "2026-04-22T00:00:00Z",
        },
      ],
    });
    const clone = SafetyManifest.fromJson(manifest.toJson());
    expect(clone.currentPathFor("a.md")).toBe("b.md");
  });

  it("planBackups skips deprecation stubs", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-safety-"));
    writeFileSync(join(root, "SPECIFICATION.md"), "real", "utf8");
    writeFileSync(join(root, "PROJECT.md"), "<!-- deft:deprecated-redirect -->", "utf8");
    const pairs = planBackups(root);
    expect(pairs.some(([src]) => src.endsWith("SPECIFICATION.md"))).toBe(true);
    expect(pairs.some(([src]) => src.endsWith("PROJECT.md"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("rollback refuses without manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-rollback-"));
    const [ok, messages] = rollback(root);
    expect(ok).toBe(false);
    expect(messages[0]).toContain("No safety manifest found");
    rmSync(root, { recursive: true, force: true });
  });

  it("writeBackups dry-run logs actions", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-backup-"));
    const src = join(root, "SPECIFICATION.md");
    writeFileSync(src, "hello", "utf8");
    const dst = premigrateSibling(src);
    const [, actions] = writeBackups(root, [[src, dst]], { dryRun: true });
    expect(actions[0]).toContain("DRYRUN BACKUP");
    rmSync(root, { recursive: true, force: true });
  });

  it("dirtyTreeRefusalMessage is stable", () => {
    expect(dirtyTreeRefusalMessage()).toContain("Working tree is not clean");
  });
});
