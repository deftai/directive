/**
 * Red-green tests for GENERATION.json ownership/removal record (AC11.10 / AC13.2).
 *
 * Slice 1b: schema + pure read/write helpers. Fixtures only — do not touch the
 * live checkout's .deft/GENERATION.json.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATION_REL,
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_MARKER_ID,
  MANAGED_SECTION_OPEN_PREFIX,
  OWNERSHIP_SCHEMA_VERSION,
  buildOwnershipRecord,
  fingerprintContent,
  generationPath,
  inspectOwnershipRecord,
  normalizeRelativePath,
  ownershipRecordsEqual,
  parseOwnershipRecord,
  readOwnershipRecord,
  stableOwnershipFingerprint,
  writeOwnershipRecord,
  type OwnedArtifact,
  type SetupOwnershipRecord,
} from "./ownership.js";

const temps: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-ownership-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "ownership-fixture" })}\n`);
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

function sampleArtifacts(): OwnedArtifact[] {
  return [
    {
      path: ".githooks/pre-commit",
      kind: "whole-file",
      fingerprint: fingerprintContent("#!/bin/sh\necho hook\n"),
    },
    {
      path: "AGENTS.md",
      kind: "marked-section",
      fingerprint: fingerprintContent("managed body"),
      markerId: MANAGED_SECTION_MARKER_ID,
    },
    {
      path: ".claude/settings.json",
      kind: "structured-entry",
      fingerprint: fingerprintContent('{"hooks":{}}'),
      entryKey: "/hooks",
    },
    {
      path: "xbrief",
      kind: "retained",
      fingerprint: fingerprintContent("xbrief-retain"),
    },
  ];
}

function sampleRecord(
  overrides: Partial<SetupOwnershipRecord> = {},
): SetupOwnershipRecord {
  return buildOwnershipRecord({
    runtimeVersion: "1.2.3",
    packageManager: "pnpm",
    ownership: sampleArtifacts(),
    ...overrides,
  });
}

describe("marker constants (AC11.10 reuse existing markers)", () => {
  it("documents deft:managed-section open/close ids as constants", () => {
    expect(MANAGED_SECTION_MARKER_ID).toBe("deft:managed-section");
    expect(MANAGED_SECTION_OPEN_PREFIX).toBe("<!-- deft:managed-section");
    expect(MANAGED_SECTION_CLOSE).toBe("<!-- /deft:managed-section -->");
  });
});

describe("path + fingerprint helpers (AC13.2)", () => {
  it("keeps GENERATION.json under .deft/ with a relative path constant", () => {
    expect(GENERATION_REL).toBe(".deft/GENERATION.json");
    const root = tempProject();
    expect(generationPath(root)).toBe(join(root, ".deft", "GENERATION.json"));
  });

  it("normalizes relative paths to POSIX and rejects absolute paths", () => {
    expect(normalizeRelativePath("AGENTS.md")).toBe("AGENTS.md");
    expect(normalizeRelativePath(".githooks\\pre-commit")).toBe(".githooks/pre-commit");
    expect(normalizeRelativePath("./.claude/settings.json")).toBe(".claude/settings.json");
    expect(() => normalizeRelativePath("/abs/path")).toThrow(/absolute/i);
    expect(() => normalizeRelativePath("C:\\Windows\\path")).toThrow(/absolute/i);
  });

  it("fingerprints content stably with sha256 hex", () => {
    const a = fingerprintContent("same");
    const b = fingerprintContent("same");
    const c = fingerprintContent("different");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(createHash("sha256").update("same", "utf8").digest("hex"));
  });
});

describe("parseOwnershipRecord — ownership kinds + legacy tolerance", () => {
  it("parses wholly owned, marked-section, structured-entry, and retained kinds", () => {
    const raw = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      runtimeVersion: "9.9.9",
      packageManager: "npm",
      ownership: [
        { path: "a", kind: "whole-file", fingerprint: "f1" },
        {
          path: "AGENTS.md",
          kind: "marked-section",
          fingerprint: "f2",
          markerId: MANAGED_SECTION_MARKER_ID,
        },
        {
          path: ".cursor/hooks.json",
          kind: "structured-entry",
          fingerprint: "f3",
          entryKey: "/hooks",
        },
        { path: "xbrief", kind: "retained", fingerprint: "f4" },
      ],
    };
    const parsed = parseOwnershipRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.runtimeVersion).toBe("9.9.9");
    expect(parsed?.packageManager).toBe("npm");
    expect(parsed?.ownership.map((o) => o.kind)).toEqual([
      "whole-file",
      "marked-section",
      "structured-entry",
      "retained",
    ]);
    expect(parsed?.ownership[1]?.markerId).toBe(MANAGED_SECTION_MARKER_ID);
    expect(parsed?.ownership[2]?.entryKey).toBe("/hooks");
  });

  it("tolerates legacy freshness fields without requiring them (AC13.2 migration reader)", () => {
    const raw = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      runtimeVersion: "1.0.0",
      packageManager: "pnpm",
      ownership: [{ path: "hook", kind: "whole-file", fingerprint: "abc" }],
      // Legacy #3117 freshness fields — tolerated, not required for ownership.
      generation: 7,
      contentVersion: "1.0.0",
      stampedAt: "2026-10-10T12:00:00Z",
      stampedBy: "directive-init",
      surfaces: { payload: "1.0.0" },
    };
    const parsed = parseOwnershipRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.runtimeVersion).toBe("1.0.0");
    expect(parsed?.ownership).toHaveLength(1);
    // Stable view must not surface stampedAt as a required ownership field.
    expect("stampedAt" in (parsed as object)).toBe(false);
  });

  it("rejects absolute paths and unknown kinds", () => {
    expect(
      parseOwnershipRecord({
        schemaVersion: OWNERSHIP_SCHEMA_VERSION,
        runtimeVersion: "1",
        packageManager: "npm",
        ownership: [{ path: "/etc/passwd", kind: "whole-file", fingerprint: "x" }],
      }),
    ).toBeNull();
    expect(
      parseOwnershipRecord({
        schemaVersion: OWNERSHIP_SCHEMA_VERSION,
        runtimeVersion: "1",
        packageManager: "npm",
        ownership: [{ path: "a", kind: "mystery", fingerprint: "x" }],
      }),
    ).toBeNull();
  });

  it("returns null for missing/invalid documents", () => {
    expect(parseOwnershipRecord(null)).toBeNull();
    expect(parseOwnershipRecord({})).toBeNull();
    expect(parseOwnershipRecord({ runtimeVersion: "1" })).toBeNull();
  });
});

describe("AC13.2 stable equality — no timestamps / absolute paths", () => {
  it("stableOwnershipFingerprint ignores legacy stampedAt/stampedBy/generation", () => {
    const base = sampleRecord();
    const withLegacy = {
      ...base,
      stampedAt: "2026-01-01T00:00:00Z",
      stampedBy: "someone",
      generation: 99,
    } as SetupOwnershipRecord & {
      stampedAt: string;
      stampedBy: string;
      generation: number;
    };
    expect(stableOwnershipFingerprint(base)).toBe(stableOwnershipFingerprint(withLegacy));
    expect(ownershipRecordsEqual(base, withLegacy)).toBe(true);
  });

  it("equality changes only when version, PM, or owned fingerprints change", () => {
    const a = sampleRecord();
    const same = sampleRecord();
    expect(ownershipRecordsEqual(a, same)).toBe(true);

    const versionChanged = sampleRecord({ runtimeVersion: "9.0.0" });
    expect(ownershipRecordsEqual(a, versionChanged)).toBe(false);

    const pmChanged = sampleRecord({ packageManager: "npm" });
    expect(ownershipRecordsEqual(a, pmChanged)).toBe(false);

    const ownershipChanged = sampleRecord({
      ownership: [
        {
          path: ".githooks/pre-commit",
          kind: "whole-file",
          fingerprint: fingerprintContent("changed"),
        },
      ],
    });
    expect(ownershipRecordsEqual(a, ownershipChanged)).toBe(false);
  });

  it("written document contains no absolute paths and no per-run timestamps", () => {
    const root = tempProject();
    const record = sampleRecord();
    writeOwnershipRecord(root, record);
    const rawText = readFileSync(generationPath(root), "utf8");
    const written = JSON.parse(rawText) as Record<string, unknown>;

    expect(written.stampedAt).toBeUndefined();
    expect(written.stampedBy).toBeUndefined();
    expect(rawText).not.toMatch(/stampedAt/);
    expect(rawText).not.toMatch(root.replace(/\\/g, "\\\\"));

    for (const entry of written.ownership as OwnedArtifact[]) {
      expect(entry.path.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:[\\/]/.test(entry.path)).toBe(false);
    }
  });
});

describe("read/write helpers pure over project root", () => {
  it("writes and reads a round-trip ownership record", () => {
    const root = tempProject();
    const record = sampleRecord();
    const target = writeOwnershipRecord(root, record);
    expect(target).toBe(generationPath(root));
    expect(existsSync(target)).toBe(true);

    const read = readOwnershipRecord(root);
    expect(read).not.toBeNull();
    expect(ownershipRecordsEqual(read!, record)).toBe(true);
    expect(inspectOwnershipRecord(root)).toMatchObject({ kind: "valid" });
  });

  it("is readable when runtime package is missing/damaged (committed .deft only)", () => {
    const root = tempProject();
    // No node_modules / no runtime package — only committed GENERATION.json.
    writeOwnershipRecord(root, sampleRecord({ runtimeVersion: "0.0.0-yolo.3" }));
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    const read = readOwnershipRecord(root);
    expect(read?.runtimeVersion).toBe("0.0.0-yolo.3");
    expect(read?.packageManager).toBe("pnpm");
    expect(read?.ownership.some((o) => o.kind === "retained")).toBe(true);
  });

  it("inspect distinguishes absent vs invalid vs valid", () => {
    const root = tempProject();
    expect(inspectOwnershipRecord(root)).toEqual({ kind: "absent" });

    writeFileSync(generationPath(root), "{not json\n", "utf8");
    expect(inspectOwnershipRecord(root)).toEqual({
      kind: "unreadable",
      reason: "invalid-json",
    });

    writeFileSync(
      generationPath(root),
      `${JSON.stringify({ schemaVersion: 1, runtimeVersion: "1" })}\n`,
      "utf8",
    );
    expect(inspectOwnershipRecord(root)).toEqual({
      kind: "unreadable",
      reason: "invalid-record",
    });
  });

  it("idempotent rewrite leaves bytes unchanged when ownership is unchanged (AC13.2)", () => {
    const root = tempProject();
    const record = sampleRecord();
    writeOwnershipRecord(root, record);
    const before = readFileSync(generationPath(root), "utf8");
    writeOwnershipRecord(root, sampleRecord());
    const after = readFileSync(generationPath(root), "utf8");
    expect(after).toBe(before);
  });
});
