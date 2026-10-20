import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as containedWriteMod from "../fs/contained-write.js";
import { isAtomicWriteTemp } from "../fs/mutation-ledger.js";
import {
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
  VBRIEF_DEPRECATION_MARKER_FILENAME,
  VBRIEF_DEPRECATION_MARKER_SENTINEL,
} from "./constants.js";
import { detectXbriefConvergence } from "./detect.js";
import { evaluateXbriefDrift } from "./drift-gate.js";
import {
  convergeLegacyVbriefRoot,
  emitXbriefMigration,
  legacyInfoIsRedundantWithCanonical,
  planRedundantLegacyEnvelopeStrips,
  removeStaleMigratedFrameworkNarrative,
  runXbriefMigration,
  runXbriefMigrationCli,
  shouldOmitLegacyMigrationFile,
} from "./migrate-project.js";

const itSymlink = it.skipIf(process.platform === "win32");

const SAMPLE_V06 = {
  xBRIEFInfo: {
    version: "0.8",
    description: "fixture",
    created: "2026-06-30T00:00:00Z",
    updated: "2026-06-30T00:00:00Z",
  },
  plan: {
    title: "Legacy story",
    status: "running",
    items: [],
    references: [
      {
        uri: "xbrief/active/child.xbrief.json",
        type: "x-vbrief/plan",
        title: "Child",
      },
    ],
  },
} as const;

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scaffoldLegacyProject(base: string): string {
  const project = join(base, "consumer");
  mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
  writeFileSync(
    join(project, LEGACY_ARTIFACT_DIR, "active", "story.xbrief.json"),
    JSON.stringify(SAMPLE_V06),
    "utf8",
  );
  mkdirSync(join(project, ".deft", "core", "templates"), { recursive: true });
  writeFileSync(
    join(project, ".deft", "core", "templates", "agents-entry.md"),
    "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: project });
  return project;
}

describe("runXbriefMigration", () => {
  it("migrates a legacy vbrief tree to xbrief with semantic transforms", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);

    const lines: string[] = [];
    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      {
        writeOut: (t) => lines.push(t),
        writeErr: (t) => lines.push(t),
      },
    );
    expect(outcome.kind).toBe("migrated");
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
    const migrated = JSON.parse(
      readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"), "utf8"),
    );
    expect(migrated.xBRIEFInfo.version).toBe("0.8");
    expect(migrated.plan.references[0].uri).toBe("xbrief/active/child.xbrief.json");
  });

  it("F-017: migrates vBRIEFInfo@0.5 (+ optional 0.6) to xBRIEFInfo@0.8 under xbrief/", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-05-"));
    temps.push(base);
    const project = join(base, "consumer");
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "completed"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "story.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.5", description: "from-05", created: "2026-06-01T00:00:00Z" },
        plan: {
          title: "0.5 story",
          status: "running",
          items: [
            {
              id: "p1",
              title: "Phase",
              status: "running",
              subItems: [{ id: "p1.t1", title: "T", status: "pending" }],
            },
          ],
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "completed", "done.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.6", description: "from-06", created: "2026-06-02T00:00:00Z" },
        plan: { title: "0.6 story", status: "completed", items: [] },
      })}\n`,
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: project });

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;
    expect(outcome.archivedPaths).toEqual([]);
    expect(outcome.migratedPaths.length).toBe(2);
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);

    const from05 = JSON.parse(
      readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"), "utf8"),
    );
    expect(from05.xBRIEFInfo.version).toBe("0.8");
    expect(from05.plan.items[0].items[0].id).toBe("p1.t1");
    expect(from05.plan.items[0]).not.toHaveProperty("subItems");

    const from06 = JSON.parse(
      readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "completed", "done.xbrief.json"), "utf8"),
    );
    expect(from06.xBRIEFInfo.version).toBe("0.8");
    // #5540: completed migrate gets complete+migration stamp; completedAt left alone.
    expect(from06.plan.metadata?.lifecycleWrite).toEqual({
      action: "complete",
      writtenAt: expect.any(String),
      migration: true,
    });
    expect(from06.plan.metadata?.completedAt).toBeUndefined();
    expect(from05.plan.metadata?.lifecycleWrite).toBeUndefined();
  });

  it("#5540: does not overwrite an existing complete stamp on completed migrate", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-5540-keep-"));
    temps.push(base);
    const project = join(base, "consumer");
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "completed"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "completed", "done.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.6", description: "stamped", created: "2026-06-02T00:00:00Z" },
        plan: {
          title: "Already stamped",
          status: "completed",
          items: [],
          metadata: {
            completedAt: "2026-06-02T12:00:00Z",
            lifecycleWrite: { action: "complete", writtenAt: "2026-06-02T12:00:00Z" },
          },
        },
      })}\n`,
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: project });
    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("migrated");
    const done = JSON.parse(
      readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "completed", "done.xbrief.json"), "utf8"),
    );
    expect(done.plan.metadata.lifecycleWrite).toEqual({
      action: "complete",
      writtenAt: "2026-06-02T12:00:00Z",
    });
    expect(done.plan.metadata.completedAt).toBe("2026-06-02T12:00:00Z");
  });

  it("F-017: archives unparseable / no-info JSON under xbrief/archive/ without hard-fail", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-archive-"));
    temps.push(base);
    const project = join(base, "consumer");
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "good.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.5", description: "ok", created: "2026-06-01T00:00:00Z" },
        plan: { title: "Good", status: "running", items: [] },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "corrupt.vbrief.json"),
      "{ not json !!!\n",
      "utf8",
    );
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "noinfo.vbrief.json"),
      `${JSON.stringify({ plan: { title: "No info", status: "running", items: [] } })}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "ancient.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.3", description: "pre-0.5" },
        plan: { title: "Ancient", status: "running", items: [] },
      })}\n`,
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: project });

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;
    expect(outcome.migratedPaths).toContain(`${MIGRATED_ARTIFACT_DIR}/active/good.xbrief.json`);
    expect(outcome.archivedPaths.length).toBe(3);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "archive", "README.md"))).toBe(true);
    expect(
      readFileSync(
        join(project, MIGRATED_ARTIFACT_DIR, "archive", "active", "corrupt.xbrief.json"),
        "utf8",
      ),
    ).toBe("{ not json !!!\n");
    expect(
      existsSync(join(project, MIGRATED_ARTIFACT_DIR, "archive", "active", "noinfo.xbrief.json")),
    ).toBe(true);
    expect(
      existsSync(join(project, MIGRATED_ARTIFACT_DIR, "archive", "active", "ancient.xbrief.json")),
    ).toBe(true);
    const good = JSON.parse(
      readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "good.xbrief.json"), "utf8"),
    );
    expect(good.xBRIEFInfo.version).toBe("0.8");
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
  });

  it("preserves legacy vbrief/archive/ into the migrated tree (Greptile P1)", () => {
    const project = mkdtempSync(join(tmpdir(), "xbrief-migrate-src-archive-"));
    temps.push(project);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "archive", "active"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "good.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.6", description: "ok" },
        plan: { title: "Good", status: "running", items: [] },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "archive", "active", "kept-note.txt"),
      "operator archive note\n",
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: project });

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("migrated");
    expect(
      existsSync(
        join(project, MIGRATED_ARTIFACT_DIR, "archive", "from-vbrief", "active", "kept-note.txt"),
      ),
    ).toBe(true);
    expect(
      readFileSync(
        join(project, MIGRATED_ARTIFACT_DIR, "archive", "from-vbrief", "active", "kept-note.txt"),
        "utf8",
      ),
    ).toBe("operator archive note\n");
  });

  it("keeps newly archived actives and legacy archive sources on distinct paths", () => {
    const project = mkdtempSync(join(tmpdir(), "xbrief-migrate-archive-collision-"));
    temps.push(project);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "archive", "active"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "foo.vbrief.json"),
      "{ not json !!!\n",
      "utf8",
    );
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "archive", "active", "foo.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.6", description: "legacy archive" },
        plan: { title: "Archived", status: "running", items: [] },
      })}\n`,
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: project });

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("migrated");
    expect(
      readFileSync(
        join(project, MIGRATED_ARTIFACT_DIR, "archive", "active", "foo.xbrief.json"),
        "utf8",
      ),
    ).toBe("{ not json !!!\n");
    const preserved = JSON.parse(
      readFileSync(
        join(project, MIGRATED_ARTIFACT_DIR, "archive", "from-vbrief", "active", "foo.xbrief.json"),
        "utf8",
      ),
    );
    expect(preserved.xBRIEFInfo.version).toBe("0.8");
    expect(preserved.plan.title).toBe("Archived");
  });

  itSymlink("refuses migration when vbrief/ is a symlink outside the project (#2601)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-symlink-"));
    temps.push(base);
    const escapeDir = mkdtempSync(join(tmpdir(), "xbrief-migrate-escape-"));
    temps.push(escapeDir);
    writeFileSync(join(escapeDir, "secret.txt"), "ssh-rsa TOPSECRET\n", "utf8");
    const project = scaffoldLegacyProject(base);
    rmSync(join(project, LEGACY_ARTIFACT_DIR), { recursive: true, force: true });
    symlinkSync(escapeDir, join(project, LEGACY_ARTIFACT_DIR), "dir");

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.message).toMatch(/symlink escaping|symlink on migration path/);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "secret.txt"))).toBe(false);
  });

  it("refuses a dirty tree unless force is passed", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-dirty-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    writeFileSync(join(project, "dirty.txt"), "change\n", "utf8");

    const outcome = runXbriefMigration(
      { projectRoot: project },
      {
        writeOut: () => {},
        writeErr: () => {},
      },
    );
    expect(outcome.kind).toBe("refused");
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(true);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR))).toBe(false);
  });

  it("is a no-op on an already-migrated tree", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-noop-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    runXbriefMigration(
      { projectRoot: project, force: true },
      {
        writeOut: () => {},
        writeErr: () => {},
      },
    );

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      {
        writeOut: () => {},
        writeErr: () => {},
      },
    );
    expect(outcome.kind).toBe("noop");
  });

  it("returns config when xbrief/ already exists alongside vbrief/", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-split-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR), { recursive: true });

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("config");
  });

  it("migrates through a cache-only xbrief tree and preserves both cache sources (#2595)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-cache-only-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    const legacyCache = join(project, LEGACY_ARTIFACT_DIR, ".triage-cache", "issues");
    const canonicalCache = join(project, MIGRATED_ARTIFACT_DIR, ".triage-cache", "issues");
    mkdirSync(legacyCache, { recursive: true });
    mkdirSync(canonicalCache, { recursive: true });
    writeFileSync(join(legacyCache, "legacy-only.json"), "legacy-only\n", "utf8");
    writeFileSync(join(legacyCache, "collision.json"), "legacy\n", "utf8");
    writeFileSync(join(canonicalCache, "canonical-only.json"), "canonical-only\n", "utf8");
    writeFileSync(join(canonicalCache, "collision.json"), "canonical\n", "utf8");

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;

    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
    expect(readFileSync(join(canonicalCache, "legacy-only.json"), "utf8")).toBe("legacy-only\n");
    expect(readFileSync(join(canonicalCache, "canonical-only.json"), "utf8")).toBe(
      "canonical-only\n",
    );
    expect(readFileSync(join(canonicalCache, "collision.json"), "utf8")).toBe("canonical\n");
    expect(existsSync(join(outcome.backupDir, LEGACY_ARTIFACT_DIR))).toBe(true);
    expect(
      existsSync(join(outcome.backupDir, MIGRATED_ARTIFACT_DIR, ".triage-cache", "issues")),
    ).toBe(true);
    expect(runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO).kind).toBe("noop");
  });

  it("F-017: archives lifecycle JSON missing info block instead of hard-failing", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-bad-json-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "bad.vbrief.json"),
      JSON.stringify({ plan: { title: "missing info block", status: "running", items: [] } }),
      "utf8",
    );

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;
    expect(outcome.archivedPaths.some((p) => p.includes("bad"))).toBe(true);
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
    expect(
      existsSync(join(project, MIGRATED_ARTIFACT_DIR, "archive", "active", "bad.xbrief.json")),
    ).toBe(true);
  });

  it("omits framework vbrief.md during migrate:xbrief (#2806) [2806-a1]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-omit-vbrief-md-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "vbrief.md"),
      "# Framework narrative\nsee ../context/working-memory.md\n",
      "utf8",
    );

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("migrated");
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "vbrief.md"))).toBe(false);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
  });

  it("still migrates project JSON and schemas when no framework narrative is present (#2806) [2806-a3]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-schemas-only-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "schemas"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "schemas", "scope.schema.json"),
      '{"title":"scope"}\n',
      "utf8",
    );

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("migrated");
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
    expect(
      readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "schemas", "scope.schema.json"), "utf8"),
    ).toBe('{"title":"scope"}\n');
  });

  it("rewrites non-json text files during migration", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-text-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "notes.txt"),
      "see vbrief/active/story.xbrief.json\n",
      "utf8",
    );

    runXbriefMigration(
      { projectRoot: project, force: true },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "notes.txt"), "utf8")).toBe(
      "see xbrief/active/story.xbrief.json\n",
    );
  });
});

describe("emitXbriefMigration", () => {
  it("supports signpost-only emission", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-emit-signpost-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    const lines: string[] = [];
    expect(
      emitXbriefMigration(
        { kind: "noop", message: "unused" },
        { writeOut: (t) => lines.push(t), writeErr: () => {} },
        { signpostOnly: true, projectRoot: project },
      ),
    ).toBe(0);
    expect(lines.join("")).toContain("directive upgrade");
    expect(lines.join("")).not.toContain("migrate:xbrief");
  });

  it("uses process.cwd() when signpostOnly=true and projectRoot is omitted", () => {
    const outs: string[] = [];
    const code = emitXbriefMigration(
      { kind: "noop", message: "unused" },
      { writeOut: (t) => outs.push(t), writeErr: () => {} },
      { signpostOnly: true },
    );
    expect(code).toBe(0);
    expect(outs.length).toBeGreaterThan(0);
  });

  it("returns exit code 2 and writes to stderr for config outcome (line 231-232)", () => {
    const errs: string[] = [];
    const code = emitXbriefMigration(
      { kind: "config", message: "xbrief/ already exists alongside vbrief/" },
      { writeOut: () => {}, writeErr: (t) => errs.push(t) },
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("xbrief/ already exists alongside vbrief/");
  });

  it("returns exit code 1 and writes to stderr for refused outcome", () => {
    const errs: string[] = [];
    const code = emitXbriefMigration(
      { kind: "refused", message: "working tree is dirty" },
      { writeOut: () => {}, writeErr: (t) => errs.push(t) },
    );
    expect(code).toBe(1);
    expect(errs.join("")).toContain("working tree is dirty");
  });

  it("returns exit code 0 and writes to stdout for migrated outcome", () => {
    const outs: string[] = [];
    const code = emitXbriefMigration(
      {
        kind: "migrated",
        backupDir: "/tmp/backup-xyz",
        files: 5,
        migratedPaths: [
          "xbrief/a.xbrief.json",
          "xbrief/b.xbrief.json",
          "xbrief/c.xbrief.json",
          "xbrief/d.xbrief.json",
          "xbrief/e.xbrief.json",
        ],
        archivedPaths: [],
      },
      { writeOut: (t) => outs.push(t), writeErr: () => {} },
    );
    expect(code).toBe(0);
    expect(outs.join("")).toContain("5 file(s)");
    expect(outs.join("")).toContain("/tmp/backup-xyz");
  });
});

describe("runXbriefMigrationCli", () => {
  it("returns non-zero when migration is refused on a dirty tree", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-cli-dirty-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    writeFileSync(join(project, "dirty.txt"), "change\n", "utf8");

    const code = runXbriefMigrationCli(
      { projectRoot: project },
      {
        writeOut: () => {},
        writeErr: () => {},
      },
    );
    expect(code).toBe(1);
  });

  it("runs agents:refresh after a successful migration", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-cli-ok-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    const lines: string[] = [];
    const code = runXbriefMigrationCli(
      { projectRoot: project, frameworkRoot: join(project, ".deft", "core"), force: true },
      {
        writeOut: (t) => lines.push(t),
        writeErr: (t) => lines.push(t),
      },
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("Migrated 1 file(s)");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
  });

  it("patches stale vbrief tokens in the pre-existing AGENTS.md unmanaged header (#2154)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-cli-header-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    // A consumer AGENTS.md whose unmanaged header still points at the legacy
    // layout, wrapped around a managed section (which must survive untouched).
    const staleAgents = [
      "# Consumer",
      "",
      "## Lifecycle",
      "- `task vbrief:preflight -- vbrief/active/foo.vbrief.json`",
      "- Scoped work lives in `xbrief/`.",
      "",
      "<!-- deft:managed-section v3 -->",
      "body mentions vbrief/active/x.xbrief.json",
      "<!-- /deft:managed-section -->",
      "",
    ].join("\n");
    writeFileSync(join(project, "AGENTS.md"), staleAgents, "utf8");

    const lines: string[] = [];
    const code = runXbriefMigrationCli(
      { projectRoot: project, frameworkRoot: join(project, ".deft", "core"), force: true },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("rewrote");

    const written = readFileSync(join(project, "AGENTS.md"), "utf8");
    // Unmanaged header lifecycle examples now reference xbrief.
    expect(written).toContain("xbrief:preflight -- xbrief/active/foo.xbrief.json");
    expect(written).toContain("Scoped work lives in `xbrief/`.");
    expect(written).not.toContain("vbrief/active/foo.vbrief.json");
    // Managed section markers are still present.
    expect(written).toContain("<!-- /deft:managed-section -->");
  });

  it("returns exit code 2 when agents:refresh cannot find the framework template (template-missing)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-cli-tmpl-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);
    // An empty frameworkRoot has no templates/agents-entry.md so agentsRefreshPlan
    // returns state="template-missing", causing runAgentsRefresh to return 2.
    const emptyFwRoot = mkdtempSync(join(tmpdir(), "empty-fw-"));
    temps.push(emptyFwRoot);

    const errs: string[] = [];
    const code = runXbriefMigrationCli(
      { projectRoot: project, frameworkRoot: emptyFwRoot, force: true },
      { writeOut: () => {}, writeErr: (t) => errs.push(t) },
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("agents:refresh failed");
  });

  itSymlink(
    "refuses agents:refresh when AGENTS.md is a symlink outside the project (#2847)",
    () => {
      const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-cli-agents-symlink-"));
      temps.push(base);
      const escapeDir = mkdtempSync(join(tmpdir(), "xbrief-migrate-cli-agents-victim-"));
      temps.push(escapeDir);
      const project = scaffoldLegacyProject(base);
      const victim = join(escapeDir, "AGENTS.md");
      writeFileSync(victim, "# victim\nKeep me\n", "utf8");
      symlinkSync(victim, join(project, "AGENTS.md"));

      const errs: string[] = [];
      const code = runXbriefMigrationCli(
        { projectRoot: project, frameworkRoot: join(project, ".deft", "core"), force: true },
        { writeOut: () => {}, writeErr: (t) => errs.push(t) },
      );
      expect(code).toBe(2);
      expect(errs.join("")).toMatch(/agents:refresh failed.*symlink/);
      expect(readFileSync(victim, "utf8")).toBe("# victim\nKeep me\n");
    },
  );
});

const SILENT_IO = { writeOut: () => {}, writeErr: () => {} };

function scaffoldCanonicalXbrief(base: string): string {
  const project = join(base, "consumer");
  mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "active"), { recursive: true });
  writeFileSync(
    join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "fixture" },
      plan: { title: "Migrated", status: "running", items: [] },
    }),
    "utf8",
  );
  return project;
}

function countMarkers(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }
  return readdirSync(dir).filter((name) => name === VBRIEF_DEPRECATION_MARKER_FILENAME).length;
}

describe("runXbriefMigration convergence (#2270)", () => {
  it("removes a fully-migrated empty vbrief/ alongside a canonical xbrief/ (no dual empty roots) [a1]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-empty-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    // The stuck dual-empty-root state: canonical xbrief/ + a stray empty vbrief/.
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "pending"), { recursive: true });

    const outcome = runXbriefMigration({ projectRoot: project }, SILENT_IO);
    expect(outcome.kind).toBe("converged");
    if (outcome.kind === "converged") {
      expect(outcome.action).toBe("removed");
      expect(outcome.already).toBe(false);
    }
    // Single unambiguous root remains.
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
  });

  it("retains an empty vbrief/ behind a deprecation marker when --keep-legacy is set [a4]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-keep-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });

    const outcome = runXbriefMigration({ projectRoot: project, keepLegacy: true }, SILENT_IO);
    expect(outcome.kind).toBe("converged");
    if (outcome.kind === "converged") {
      expect(outcome.action).toBe("marker");
    }
    const marker = readFileSync(
      join(project, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME),
      "utf8",
    );
    expect(marker).toContain(VBRIEF_DEPRECATION_MARKER_SENTINEL);
    // The retained folder no longer looks like an active source of truth.
    expect(detectXbriefConvergence(project).state).toBe("xbrief-marker");
  });

  it("marks a populated legacy vbrief/ deprecated when a canonical xbrief/ already has content [a4]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-dual-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    writeFileSync(
      join(project, LEGACY_ARTIFACT_DIR, "active", "old.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "old", items: [] } }),
      "utf8",
    );

    const outcome = runXbriefMigration({ projectRoot: project }, SILENT_IO);
    expect(outcome.kind).toBe("converged");
    if (outcome.kind === "converged") {
      expect(outcome.action).toBe("marker");
    }
    // Legacy content is never destructively deleted; the marker rides alongside it.
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR, "active", "old.xbrief.json"))).toBe(true);
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME))).toBe(
      true,
    );
  });

  it("never marks an empty legacy root when no canonical xbrief/ exists, even with keepLegacy (no dead end)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-nocanon-"));
    temps.push(base);
    const project = join(base, "consumer");
    // Empty legacy root, and no canonical xbrief/ content to migrate to.
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });

    const outcome = runXbriefMigration({ projectRoot: project, keepLegacy: true }, SILENT_IO);
    expect(outcome.kind).toBe("converged");
    if (outcome.kind === "converged") {
      // The stray empty root is removed, not marked — a marker without a
      // canonical replacement would permanently strand the project.
      expect(outcome.action).toBe("removed");
      expect(outcome.message).toContain("no canonical");
    }
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
    // Rerun is a clean no-op, not a stuck "already converged behind a marker".
    expect(runXbriefMigration({ projectRoot: project, keepLegacy: true }, SILENT_IO).kind).toBe(
      "noop",
    );
  });

  it("is idempotent: rerun after a removed converge is a clean no-op [a3]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-idem-rm-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });

    expect(runXbriefMigration({ projectRoot: project }, SILENT_IO).kind).toBe("converged");
    const second = runXbriefMigration({ projectRoot: project }, SILENT_IO);
    expect(second.kind).toBe("noop");
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
  });

  it("is idempotent: rerun after a marker converge does not duplicate the marker [a3]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-idem-mark-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    mkdirSync(join(project, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });

    expect(runXbriefMigration({ projectRoot: project, keepLegacy: true }, SILENT_IO).action).toBe(
      "marker",
    );
    const before = readFileSync(
      join(project, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME),
      "utf8",
    );

    const second = runXbriefMigration({ projectRoot: project, keepLegacy: true }, SILENT_IO);
    expect(second.kind).toBe("converged");
    if (second.kind === "converged") {
      expect(second.already).toBe(true);
    }
    expect(countMarkers(join(project, LEGACY_ARTIFACT_DIR))).toBe(1);
    expect(
      readFileSync(join(project, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME), "utf8"),
    ).toBe(before);
  });

  it("retains vbrief/ behind a marker on a full migration when keepLegacy is set", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-migrate-keep-"));
    temps.push(base);
    const project = scaffoldLegacyProject(base);

    const outcome = runXbriefMigration(
      { projectRoot: project, force: true, keepLegacy: true },
      SILENT_IO,
    );
    expect(outcome.kind).toBe("migrated");
    // The migrated content is canonical in xbrief/, and vbrief/ survives with a marker.
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME))).toBe(
      true,
    );
    // Rerun converges to the idempotent already-marked no-op.
    const rerun = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(rerun.kind).toBe("converged");
  });

  it("returns a noop (not exit 2) when only a stale deposited schema remains (#2368)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-stale-schema-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "schemas"), { recursive: true });
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "schemas", "vbrief-core.schema.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6", description: "stale deposit" } }),
      "utf8",
    );

    const outcome = runXbriefMigration({ projectRoot: project }, SILENT_IO);
    expect(outcome.kind).toBe("noop");
    if (outcome.kind === "noop") {
      expect(outcome.message).toContain("directive update");
      expect(outcome.message).not.toContain("Legacy markers detected");
    }
  });
});

const SAMPLE_HYBRID_V06 = {
  xBRIEFInfo: {
    version: "0.6",
    description: "hybrid residual",
    created: "2026-06-30T00:00:00Z",
    updated: "2026-06-30T00:00:00Z",
  },
  plan: {
    title: "Hybrid residual",
    status: "running",
    items: [],
    references: [
      {
        uri: "https://github.com/deftai/directive/issues/3236",
        type: "x-vbrief/github-issue",
        title: "Issue #3236",
      },
      {
        uri: "xbrief/active/child.xbrief.json",
        type: "x-vbrief/plan",
        title: "Child",
      },
    ],
  },
} as const;

function scaffoldHybridXbriefOnly(base: string): string {
  const project = join(base, "consumer");
  mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "active"), { recursive: true });
  writeFileSync(
    join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"),
    `${JSON.stringify(SAMPLE_HYBRID_V06, null, 2)}\n`,
    "utf8",
  );
  execFileSync("git", ["init"], { cwd: project });
  return project;
}

describe("runXbriefMigration hybrid in-place rewrite (#3236)", () => {
  it("rewrites hybrid xBRIEFInfo@0.6 envelopes on an xbrief-only tree", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-hybrid-rewrite-"));
    temps.push(base);
    const project = scaffoldHybridXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json");

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("rewritten");
    if (outcome.kind === "rewritten") {
      expect(outcome.files).toBe(1);
      expect(outcome.message).toMatch(/Rewrote 1 /);
      expect(outcome.message).toMatch(/xBRIEFInfo@0\.8/);
    }

    const rewritten = JSON.parse(readFileSync(artifact, "utf8"));
    expect(rewritten.xBRIEFInfo.version).toBe("0.8");
    expect(rewritten).not.toHaveProperty("vBRIEFInfo");
    expect(rewritten.plan.references[0].type).toBe("x-xbrief/github-issue");
    expect(rewritten.plan.references[1].type).toBe("x-xbrief/plan");
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);
  });

  it("thin-rewrites orphan xBRIEFInfo@0.7 envelopes on an xbrief-only tree", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-orphan-07-"));
    temps.push(base);
    const project = join(base, "consumer");
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "active"), { recursive: true });
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json");
    writeFileSync(
      artifact,
      `${JSON.stringify(
        {
          xBRIEFInfo: {
            version: "0.7",
            description: "orphan 0.7 residual",
            created: "2026-06-26T00:00:00Z",
            updated: "2026-06-26T00:00:00Z",
          },
          plan: {
            title: "Orphan 0.7",
            status: "running",
            items: [],
            references: [
              {
                uri: "xbrief/active/child.xbrief.json",
                type: "x-vbrief/plan",
                title: "Child",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: project });

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("rewritten");
    if (outcome.kind === "rewritten") {
      expect(outcome.files).toBe(1);
    }

    const rewritten = JSON.parse(readFileSync(artifact, "utf8"));
    expect(rewritten.xBRIEFInfo.version).toBe("0.8");
    expect(rewritten.plan.references[0].type).toBe("x-xbrief/plan");
    expect(existsSync(join(project, LEGACY_ARTIFACT_DIR))).toBe(false);

    const second = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(second.kind).toBe("noop");
  });

  it("is idempotent: second pass on already-0.8 hybrid trees is a clean noop", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-hybrid-idem-"));
    temps.push(base);
    const project = scaffoldHybridXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json");

    expect(runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO).kind).toBe(
      "rewritten",
    );
    const afterFirst = readFileSync(artifact, "utf8");

    const second = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(second.kind).toBe("noop");
    expect(readFileSync(artifact, "utf8")).toBe(afterFirst);
    expect(JSON.parse(afterFirst).xBRIEFInfo.version).toBe("0.8");
  });

  it("emits the rewrite report on stdout with exit 0", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-hybrid-emit-"));
    temps.push(base);
    const project = scaffoldHybridXbriefOnly(base);
    const outs: string[] = [];
    const code = emitXbriefMigration(
      runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO),
      { writeOut: (t) => outs.push(t), writeErr: () => {} },
    );
    expect(code).toBe(0);
    expect(outs.join("")).toMatch(
      /Rewrote 1 residual envelope\(s\) \(0\.5\/0\.6\/0\.7\).*xBRIEFInfo@0\.8/,
    );
  });

  it("does not rewrite schema deposits; hybrid envelopes still rewrite beside them (#3236 / #2368)", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-hybrid-schema-"));
    temps.push(base);
    const project = scaffoldHybridXbriefOnly(base);
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "schemas"), { recursive: true });
    const schemaPath = join(project, MIGRATED_ARTIFACT_DIR, "schemas", "vbrief-core.schema.json");
    const schemaBody = JSON.stringify({
      vBRIEFInfo: { version: "0.6", description: "stale deposit" },
    });
    writeFileSync(schemaPath, schemaBody, "utf8");

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("rewritten");
    expect(
      JSON.parse(
        readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"), "utf8"),
      ).xBRIEFInfo.version,
    ).toBe("0.8");
    // Schema deposit is not a lifecycle artifact — left for directive update.
    expect(readFileSync(schemaPath, "utf8")).toBe(schemaBody);
  });

  it("refuses a dirty hybrid-only tree unless force is passed", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-hybrid-dirty-"));
    temps.push(base);
    const project = scaffoldHybridXbriefOnly(base);
    writeFileSync(join(project, "dirty.txt"), "change\n", "utf8");

    const outcome = runXbriefMigration({ projectRoot: project }, SILENT_IO);
    expect(outcome.kind).toBe("refused");
    expect(
      JSON.parse(
        readFileSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"), "utf8"),
      ).xBRIEFInfo.version,
    ).toBe("0.6");
  });
});

describe("convergeLegacyVbriefRoot (#2270)", () => {
  it("returns removed when the legacy dir is already absent", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-absent-"));
    temps.push(base);
    expect(convergeLegacyVbriefRoot(base, { retain: false })).toBe("removed");
  });

  it("marks an empty dir when retain is requested instead of removing it", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-converge-retain-"));
    temps.push(base);
    mkdirSync(join(base, LEGACY_ARTIFACT_DIR), { recursive: true });
    expect(convergeLegacyVbriefRoot(base, { retain: true })).toBe("marker");
    expect(existsSync(join(base, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME))).toBe(
      true,
    );
  });
});

describe("framework narrative hygiene (#2806)", () => {
  it("shouldOmitLegacyMigrationFile matches only the lifecycle-root narrative", () => {
    expect(shouldOmitLegacyMigrationFile("vbrief.md")).toBe(true);
    expect(shouldOmitLegacyMigrationFile("active/story.xbrief.json")).toBe(false);
    expect(shouldOmitLegacyMigrationFile("schemas/scope.schema.json")).toBe(false);
    expect(shouldOmitLegacyMigrationFile("notes.txt")).toBe(false);
  });

  it("removeStaleMigratedFrameworkNarrative drops xbrief/vbrief.md but keeps records (#2806) [2806-a2]", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-remove-stale-vbrief-md-"));
    temps.push(base);
    const project = join(base, "consumer");
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "active"), { recursive: true });
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "schemas"), { recursive: true });
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "schemas", "xbrief-core-0.8.schema.json"),
      "{}\n",
      "utf8",
    );
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "vbrief.md"),
      "# stale migrated framework narrative\n",
      "utf8",
    );

    expect(removeStaleMigratedFrameworkNarrative(project)).toBe(true);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "vbrief.md"))).toBe(false);
    expect(existsSync(join(project, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"))).toBe(
      true,
    );
    expect(
      existsSync(join(project, MIGRATED_ARTIFACT_DIR, "schemas", "xbrief-core-0.8.schema.json")),
    ).toBe(true);
    expect(removeStaleMigratedFrameworkNarrative(project)).toBe(false);
  });
});

describe("emitXbriefMigration converged (#2270)", () => {
  it("returns exit code 0 and writes the converge message to stdout", () => {
    const outs: string[] = [];
    const code = emitXbriefMigration(
      {
        kind: "converged",
        action: "removed",
        already: false,
        message: "Converged layout: removed",
      },
      { writeOut: (t) => outs.push(t), writeErr: () => {} },
    );
    expect(code).toBe(0);
    expect(outs.join("")).toContain("Converged layout: removed");
  });
});

const CANONICAL_08_INFO = {
  version: "0.8",
  description: "fixture",
  created: "2026-06-30T00:00:00Z",
  updated: "2026-06-30T00:00:00Z",
  metadata: { deft_version: "0.109.1" },
} as const;

const DUAL_PLAN = {
  title: "Dual envelope spec",
  status: "running",
  items: [],
} as const;

function dualEnvelopeDoc(
  legacy: Record<string, unknown> = { version: "0.6" },
): Record<string, unknown> {
  return {
    vBRIEFInfo: legacy,
    plan: { ...DUAL_PLAN },
    xBRIEFInfo: {
      ...CANONICAL_08_INFO,
      metadata: { ...CANONICAL_08_INFO.metadata },
    },
  };
}

function gitQuiet(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
}

function scaffoldDualEnvelopeXbriefOnly(
  base: string,
  options: {
    specLegacy?: Record<string, unknown>;
    alsoPlan?: boolean;
    alsoCompleted?: boolean;
    track?: boolean;
  } = {},
): string {
  const project = join(base, "consumer");
  mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "completed"), { recursive: true });
  writeFileSync(
    join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json"),
    `${JSON.stringify(dualEnvelopeDoc(options.specLegacy), null, 2)}\n`,
    "utf8",
  );
  if (options.alsoPlan === true) {
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "plan.xbrief.json"),
      `${JSON.stringify(dualEnvelopeDoc({ version: "0.6" }), null, 2)}\n`,
      "utf8",
    );
  }
  if (options.alsoCompleted === true) {
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "completed", "2026-01-01-old.xbrief.json"),
      `${JSON.stringify(dualEnvelopeDoc({ version: "0.6" }), null, 2)}\n`,
      "utf8",
    );
  }
  gitQuiet(project, ["init", "-q"]);
  if (options.track === true) {
    gitQuiet(project, ["add", "--", "xbrief"]);
  }
  return project;
}

describe("legacyInfoIsRedundantWithCanonical (#4163)", () => {
  it("treats version-only leftover {version: 0.6} as redundant", () => {
    expect(legacyInfoIsRedundantWithCanonical({ version: "0.6" }, { ...CANONICAL_08_INFO })).toBe(
      true,
    );
  });

  it("strips when leftover updated equals the canonical stamp", () => {
    expect(
      legacyInfoIsRedundantWithCanonical(
        { version: "0.6", updated: CANONICAL_08_INFO.updated },
        { ...CANONICAL_08_INFO },
      ),
    ).toBe(true);
  });

  it("fails closed on a unique leftover description", () => {
    expect(
      legacyInfoIsRedundantWithCanonical(
        { version: "0.6", description: "only on leftover" },
        { version: "0.8" },
      ),
    ).toBe(false);
  });

  it("fails closed when leftover description disagrees with canonical", () => {
    expect(
      legacyInfoIsRedundantWithCanonical(
        { version: "0.6", description: "other" },
        { ...CANONICAL_08_INFO },
      ),
    ).toBe(false);
  });
});

describe("planRedundantLegacyEnvelopeStrips (#4163)", () => {
  it("plans a strip for root specification.xbrief.json and plan.xbrief.json", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-plan-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, { alsoPlan: true });
    const plan = planRedundantLegacyEnvelopeStrips(project);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const rels = plan.pending.map((entry) => entry.path.replace(/\\/g, "/"));
    expect(rels.some((p) => p.endsWith("xbrief/specification.xbrief.json"))).toBe(true);
    expect(rels.some((p) => p.endsWith("xbrief/plan.xbrief.json"))).toBe(true);
    for (const entry of plan.pending) {
      const body = JSON.parse(entry.body) as Record<string, unknown>;
      expect(body).not.toHaveProperty("vBRIEFInfo");
      expect(body.xBRIEFInfo).toEqual({
        ...CANONICAL_08_INFO,
        metadata: { ...CANONICAL_08_INFO.metadata },
      });
      expect(body.plan).toEqual(DUAL_PLAN);
    }
  });

  it("does not plan a strip for xbrief/completed historical records", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-completed-"));
    temps.push(base);
    const project = scaffoldCanonicalXbrief(base);
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR, "completed"), { recursive: true });
    writeFileSync(
      join(project, MIGRATED_ARTIFACT_DIR, "completed", "2026-01-01-old.xbrief.json"),
      `${JSON.stringify(dualEnvelopeDoc({ version: "0.6" }), null, 2)}\n`,
      "utf8",
    );
    const plan = planRedundantLegacyEnvelopeStrips(project);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.pending).toHaveLength(0);
  });

  it("fails closed when leftover key cannot be deleted from original bytes", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-dup-key-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const compact = JSON.stringify(dualEnvelopeDoc());
    const duplicated = `${compact.slice(0, -1)},"vBRIEFInfo":{"version":"0.6"}}`;
    writeFileSync(artifact, duplicated, "utf8");
    const plan = planRedundantLegacyEnvelopeStrips(project);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/failed to delete leftover vBRIEFInfo/);
    expect(readFileSync(artifact, "utf8")).toBe(duplicated);
  });

  it("fails closed on a non-redundant dual envelope in the drift-gate set", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-disagree-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, {
      specLegacy: { version: "0.6", description: "only on leftover" },
    });
    const plan = planRedundantLegacyEnvelopeStrips(project);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/non-redundant dual envelope/);
    expect(plan.error).toMatch(/specification\.xbrief\.json/);
  });
});

describe("runXbriefMigration redundant leftover strip (#4163)", () => {
  it("strips leftover vBRIEFInfo on an already-xbrief specification and returns rewritten", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-rewrite-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const before = JSON.parse(readFileSync(artifact, "utf8")) as Record<string, unknown>;
    const planBefore = JSON.stringify(before.plan);
    const infoBefore = JSON.stringify(before.xBRIEFInfo);

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("rewritten");
    if (outcome.kind === "rewritten") {
      expect(outcome.files).toBe(1);
      expect(outcome.message).toMatch(/Stripped 1 redundant leftover vBRIEFInfo/);
    }

    const after = JSON.parse(readFileSync(artifact, "utf8")) as Record<string, unknown>;
    expect(after).not.toHaveProperty("vBRIEFInfo");
    expect(JSON.stringify(after.plan)).toBe(planBefore);
    expect(JSON.stringify(after.xBRIEFInfo)).toBe(infoBefore);
  });

  it("does not fire the residual-schema noop when a strip is pending", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-no-noop-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).not.toBe("noop");
    expect(outcome.kind).toBe("rewritten");
  });

  it("leaves xbrief/completed dual envelopes historical", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-hist-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, { alsoCompleted: true });
    const completed = join(
      project,
      MIGRATED_ARTIFACT_DIR,
      "completed",
      "2026-01-01-old.xbrief.json",
    );
    const before = readFileSync(completed, "utf8");
    expect(runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO).kind).toBe(
      "rewritten",
    );
    expect(readFileSync(completed, "utf8")).toBe(before);
    expect(JSON.parse(before)).toHaveProperty("vBRIEFInfo");
  });

  it("refuses the whole migrate on a non-redundant dual envelope and does not write", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-refuse-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, {
      specLegacy: { version: "0.6", description: "only on leftover" },
    });
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const before = readFileSync(artifact, "utf8");
    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("config");
    if (outcome.kind === "config") {
      expect(outcome.message).toMatch(/non-redundant dual envelope/);
    }
    expect(readFileSync(artifact, "utf8")).toBe(before);
    const code = emitXbriefMigration(outcome, SILENT_IO);
    expect(code).toBe(2);
  });

  it("refuses a dirty tree unless force is passed", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-dirty-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    writeFileSync(join(project, "dirty.txt"), "change\n", "utf8");
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const outcome = runXbriefMigration({ projectRoot: project }, SILENT_IO);
    expect(outcome.kind).toBe("refused");
    expect(JSON.parse(readFileSync(artifact, "utf8"))).toHaveProperty("vBRIEFInfo");
  });

  it("evaluateXbriefDrift on the stripped tracked set is the success-then-reject postcondition", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-drift-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, { track: true });
    expect(evaluateXbriefDrift(project).code).toBe(1);
    expect(evaluateXbriefDrift(project).findings[0]?.kind).toBe("legacy-envelope-key");

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("rewritten");
    const drift = evaluateXbriefDrift(project);
    expect(drift.code).toBe(0);
    expect(drift.findings).toHaveLength(0);
  });

  it("does not write when evaluateXbriefDrift cannot run on a non-git tree", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-nogit-"));
    temps.push(base);
    const project = join(base, "consumer");
    mkdirSync(join(project, MIGRATED_ARTIFACT_DIR), { recursive: true });
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    writeFileSync(artifact, `${JSON.stringify(dualEnvelopeDoc(), null, 2)}\n`, "utf8");
    const before = readFileSync(artifact, "utf8");
    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("config");
    expect(readFileSync(artifact, "utf8")).toBe(before);
    expect(JSON.parse(before)).toHaveProperty("vBRIEFInfo");
  });

  it("does not write when another tracked drift finding would keep evaluateXbriefDrift red", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-partial-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, { track: true });
    writeFileSync(join(project, "stale.vbrief.json"), "{}\n", "utf8");
    gitQuiet(project, ["add", "--", "stale.vbrief.json"]);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const before = readFileSync(artifact, "utf8");
    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("config");
    expect(readFileSync(artifact, "utf8")).toBe(before);
    expect(JSON.parse(before)).toHaveProperty("vBRIEFInfo");
  });

  it("compact dual-envelope input stays byte-identical except the deleted key", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-compact-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const compact = JSON.stringify(dualEnvelopeDoc());
    writeFileSync(artifact, compact, "utf8");
    const expected = JSON.stringify({
      plan: dualEnvelopeDoc().plan,
      xBRIEFInfo: dualEnvelopeDoc().xBRIEFInfo,
    });
    expect(runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO).kind).toBe(
      "rewritten",
    );
    expect(readFileSync(artifact, "utf8")).toBe(expected);
  });

  it("tab-indented dual-envelope input stays byte-identical except the deleted key", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-tab-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const tabbed = `${JSON.stringify(dualEnvelopeDoc(), null, "\t")}\n`;
    writeFileSync(artifact, tabbed, "utf8");
    const expected = `${JSON.stringify(
      {
        plan: dualEnvelopeDoc().plan,
        xBRIEFInfo: dualEnvelopeDoc().xBRIEFInfo,
      },
      null,
      "\t",
    )}\n`;
    expect(runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO).kind).toBe(
      "rewritten",
    );
    expect(readFileSync(artifact, "utf8")).toBe(expected);
  });

  it("is idempotent: second pass after a strip is a clean noop", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-idem-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const artifact = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    expect(runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO).kind).toBe(
      "rewritten",
    );
    const afterFirst = readFileSync(artifact, "utf8");
    const second = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(second.kind).toBe("noop");
    expect(readFileSync(artifact, "utf8")).toBe(afterFirst);
  });

  it("restores both originals when the second of two writes throws", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-second-throw-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base, { alsoPlan: true });
    const spec = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const planPath = join(project, MIGRATED_ARTIFACT_DIR, "plan.xbrief.json");
    const specBefore = readFileSync(spec, "utf8");
    const planBefore = readFileSync(planPath, "utf8");
    const live = new Set([resolve(spec), resolve(planPath)]);
    const realWrite = containedWriteMod.containedWrite;
    const realRename = containedWriteMod.containedRename;
    let committed = 0;
    let induced = false;
    vi.spyOn(containedWriteMod, "containedRename").mockImplementation((input) => {
      const result = realRename(input);
      if (live.has(resolve(String(input.to)))) committed += 1;
      return result;
    });
    vi.spyOn(containedWriteMod, "containedWrite").mockImplementation((input) => {
      const target = resolve(String(input.target));
      if (!induced && committed >= 1 && isAtomicWriteTemp(target)) {
        induced = true;
        throw Object.assign(new Error("EIO: input/output error"), { code: "EIO" });
      }
      return realWrite(input);
    });

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("config");
    if (outcome.kind === "config") {
      expect(outcome.message).toMatch(/leftover-envelope strip write failed/);
      expect(outcome.message).toMatch(/EIO/);
    }
    expect(readFileSync(spec, "utf8")).toBe(specBefore);
    expect(readFileSync(planPath, "utf8")).toBe(planBefore);
    expect(JSON.parse(specBefore)).toHaveProperty("vBRIEFInfo");
    expect(JSON.parse(planBefore)).toHaveProperty("vBRIEFInfo");
  });

  it("restores the original when the first replace throws mid-write", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-mid-replace-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const spec = join(project, MIGRATED_ARTIFACT_DIR, "specification.xbrief.json");
    const before = readFileSync(spec, "utf8");
    const realWrite = containedWriteMod.containedWrite;
    let induced = false;
    vi.spyOn(containedWriteMod, "containedWrite").mockImplementation((input) => {
      const target = resolve(String(input.target));
      if (!induced && isAtomicWriteTemp(target)) {
        induced = true;
        const live = target.replace(/\.deft-\d+\.tmp$/u, "");
        writeFileSync(live, "truncated-partial\n", "utf8");
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realWrite(input);
    });

    const outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    expect(outcome.kind).toBe("config");
    if (outcome.kind === "config") {
      expect(outcome.message).toMatch(/leftover-envelope strip write failed/);
      expect(outcome.message).toMatch(/ENOSPC/);
    }
    expect(readFileSync(spec, "utf8")).toBe(before);
    expect(JSON.parse(before)).toHaveProperty("vBRIEFInfo");
  });

  it("returns restore failures instead of throwing when rollback writes fail", () => {
    const base = mkdtempSync(join(tmpdir(), "xbrief-strip-restore-fail-"));
    temps.push(base);
    const project = scaffoldDualEnvelopeXbriefOnly(base);
    const realWrite = containedWriteMod.containedWrite;
    let induced = false;
    vi.spyOn(containedWriteMod, "containedWrite").mockImplementation((input) => {
      const target = resolve(String(input.target));
      if (!induced && isAtomicWriteTemp(target)) {
        induced = true;
        const live = target.replace(/\.deft-\d+\.tmp$/u, "");
        writeFileSync(live, "truncated-partial\n", "utf8");
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      if (induced && isAtomicWriteTemp(target)) {
        throw Object.assign(new Error("ENOSPC during restore"), { code: "ENOSPC" });
      }
      return realWrite(input);
    });

    let outcome: ReturnType<typeof runXbriefMigration> | undefined;
    expect(() => {
      outcome = runXbriefMigration({ projectRoot: project, force: true }, SILENT_IO);
    }).not.toThrow();
    expect(outcome?.kind).toBe("config");
    if (outcome?.kind === "config") {
      expect(outcome.message).toMatch(/leftover-envelope strip write failed/);
      expect(outcome.message).toMatch(/restore also failed/);
      expect(outcome.message).toMatch(/ENOSPC during restore/);
    }
  });
});
