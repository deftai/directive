/**
 * Tests for verify:contained-writes skeleton (#2951 Phase 1).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTAINED_WRITES_ALLOWLIST, evaluateContainedWrites } from "./contained-writes.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("evaluateContainedWrites (#2951)", () => {
  it("exits 2 when project root is missing", () => {
    const missing = join(tmpdir(), `cw-verify-missing-${Date.now()}`);
    const result = evaluateContainedWrites({ projectRoot: missing });
    expect(result.code).toBe(2);
    expect(result.findings).toEqual([]);
  });

  it("is fail-open (exit 0) when raw sinks exist without --enforce", () => {
    const root = freshDir("cw-verify-open-");
    const src = join(root, "packages", "core", "src", "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "sink.ts"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/x", "y");\n',
      "utf8",
    );
    const result = evaluateContainedWrites({ projectRoot: root });
    expect(result.code).toBe(0);
    expect(result.failOpen).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/fail-open|ADVISORY/i);
  });

  it("fails closed with exit 1 under --enforce", () => {
    const root = freshDir("cw-verify-enforce-");
    const src = join(root, "packages", "core", "src", "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "sink.ts"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/x", "y");\n',
      "utf8",
    );
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(1);
    expect(result.failOpen).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("skips test files and allowlisted modules", () => {
    const root = freshDir("cw-verify-allow-");
    const fsDir = join(root, "packages", "core", "src", "fs");
    mkdirSync(fsDir, { recursive: true });
    writeFileSync(join(fsDir, "contained-write.ts"), 'writeFileSync("x", "y");\n', "utf8");
    writeFileSync(join(fsDir, "contained-write.test.ts"), 'writeFileSync("x", "y");\n', "utf8");
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("allowlist seed includes contained-write implementation", () => {
    expect(CONTAINED_WRITES_ALLOWLIST).toContain("packages/core/src/fs/contained-write.ts");
  });

  it("does not allowlist a path that merely ends with an allowlisted suffix", () => {
    const root = freshDir("cw-verify-endswith-");
    const spoof = join(root, "packages", "core", "src", "evil", "packages", "core", "src", "fs");
    mkdirSync(spoof, { recursive: true });
    writeFileSync(join(spoof, "contained-write.ts"), "writeFileSync(a, b);\n", "utf8");
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.path.includes("evil"))).toBe(true);
  });

  it("detects low-level openSync/writeSync sinks under --enforce", () => {
    const root = freshDir("cw-verify-opensync-");
    const src = join(root, "packages", "core", "src", "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "low.ts"),
      'import { openSync, writeSync } from "node:fs";\nconst fd = openSync(p, "w");\nwriteSync(fd, buf);\n',
      "utf8",
    );
    const result = evaluateContainedWrites({ projectRoot: root, enforce: true });
    expect(result.code).toBe(1);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});
