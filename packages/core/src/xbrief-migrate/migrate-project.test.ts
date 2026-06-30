import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_ARTIFACT_DIR, MIGRATED_ARTIFACT_DIR } from "./constants.js";
import { runXbriefMigration, runXbriefMigrationCli } from "./migrate-project.js";

const SAMPLE_V06 = {
  vBRIEFInfo: {
    version: "0.6",
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
        uri: "vbrief/active/child.vbrief.json",
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
    join(project, LEGACY_ARTIFACT_DIR, "active", "story.vbrief.json"),
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
});
