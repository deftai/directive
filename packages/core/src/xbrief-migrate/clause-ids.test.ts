import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clauseKeyedItemId,
  rewriteLegacyClauseKeyedItemIds,
} from "../scope/acceptance-evidence.js";
import { validateVbriefSchema } from "../vbrief-validate/schema.js";
import {
  CLAUSE_ID_MIGRATE_COMMAND,
  mainEntry,
  migrateLegacyClauseKeyedItemIdsCorpus,
  parseArgs,
  printLegacyClauseIdNudgeIfNeeded,
  renderLegacyClauseIdLine,
  run,
  scanLegacyClauseKeyedItemIds,
} from "./clause-ids.js";
import { renderXbriefMigrationLine } from "./signpost.js";

const itSymlink = it.skipIf(process.platform === "win32");

const MINIMAL_V08 = {
  xBRIEFInfo: { version: "0.8", description: "fixture" },
  plan: {
    title: "fixture",
    status: "completed",
    items: [] as unknown[],
  },
};

describe("rewriteLegacyClauseKeyedItemIds (#5011)", () => {
  it("rewrites nested leftover clause:N ids and title-syncs when title === id", () => {
    const nested = {
      id: "clause:2",
      title: "clause:2",
      status: "pending",
      items: [{ id: "clause:3", title: "Keep prose", status: "pending" }],
    };
    const items = [
      { id: "clause:1", title: "clause:1", status: "pending", subItems: [nested] },
      { id: "keep", title: "keep", status: "pending" },
    ];
    expect(rewriteLegacyClauseKeyedItemIds(items)).toEqual([
      clauseKeyedItemId(1),
      clauseKeyedItemId(2),
      clauseKeyedItemId(3),
    ]);
    expect(items[0]).toMatchObject({ id: clauseKeyedItemId(1), title: clauseKeyedItemId(1) });
    expect(nested).toMatchObject({ id: clauseKeyedItemId(2), title: clauseKeyedItemId(2) });
    expect(nested.items[0]).toMatchObject({ id: clauseKeyedItemId(3), title: "Keep prose" });
  });

  it("is idempotent on already-migrated clause.N ids", () => {
    const items = [{ id: clauseKeyedItemId(1), title: clauseKeyedItemId(1), status: "pending" }];
    expect(rewriteLegacyClauseKeyedItemIds(items)).toEqual([]);
    expect(items[0]?.id).toBe(clauseKeyedItemId(1));
  });
});

describe("migrateLegacyClauseKeyedItemIdsCorpus (#5011)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clause-ids-corpus-"));
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, items: unknown[]): string {
    const path = join(root, rel);
    writeFileSync(
      path,
      `${JSON.stringify({ ...MINIMAL_V08, plan: { ...MINIMAL_V08.plan, items } }, null, 2)}\n`,
      "utf8",
    );
    return path;
  }

  it("rewrites cancelled and completed leftovers and no-ops on clause.N", () => {
    const cancelled = write("xbrief/cancelled/old.xbrief.json", [
      { id: "clause:1", title: "clause:1", status: "cancelled" },
    ]);
    const completed = write("xbrief/completed/done.xbrief.json", [
      {
        id: "parent",
        title: "parent",
        status: "completed",
        subItems: [{ id: "clause:4", title: "Keep complete a check", status: "completed" }],
      },
    ]);
    write("xbrief/active/clean.xbrief.json", [
      { id: clauseKeyedItemId(1), title: clauseKeyedItemId(1), status: "pending" },
    ]);

    const first = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(first.changed).toEqual([
      "xbrief/cancelled/old.xbrief.json",
      "xbrief/completed/done.xbrief.json",
    ]);
    expect(first.conflicts).toEqual([]);

    const cancelledDoc = JSON.parse(readFileSync(cancelled, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(cancelledDoc.plan.items[0]).toMatchObject({
      id: clauseKeyedItemId(1),
      title: clauseKeyedItemId(1),
    });
    const completedDoc = JSON.parse(readFileSync(completed, "utf8")) as {
      plan: { items: Array<{ subItems: Array<Record<string, unknown>> }> };
    };
    expect(completedDoc.plan.items[0]?.subItems[0]).toMatchObject({
      id: clauseKeyedItemId(4),
      title: "Keep complete a check",
    });

    expect(migrateLegacyClauseKeyedItemIdsCorpus(root).changed).toEqual([]);
    expect(scanLegacyClauseKeyedItemIds(root).hits).toEqual([]);
  });

  it("scan names leftover cancelled/completed ids without writing", () => {
    write("xbrief/cancelled/old.xbrief.json", [
      { id: "clause:8", title: "clause:8", status: "cancelled" },
    ]);
    const before = readFileSync(join(root, "xbrief/cancelled/old.xbrief.json"), "utf8");
    const scan = scanLegacyClauseKeyedItemIds(root);
    expect(scan.hits).toEqual([
      { path: "xbrief/cancelled/old.xbrief.json", rewrittenIds: [clauseKeyedItemId(8)] },
    ]);
    expect(readFileSync(join(root, "xbrief/cancelled/old.xbrief.json"), "utf8")).toBe(before);
    expect(renderLegacyClauseIdLine(root)).toContain(CLAUSE_ID_MIGRATE_COMMAND);
    expect(renderXbriefMigrationLine(root)).toContain(CLAUSE_ID_MIGRATE_COMMAND);
  });

  it("skips invalid JSON and plan-less artifacts; empty trees scan nothing", () => {
    writeFileSync(join(root, "xbrief", "completed", "bad.xbrief.json"), "{not-json", "utf8");
    writeFileSync(
      join(root, "xbrief", "completed", "noplan.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" } })}\n`,
      "utf8",
    );
    expect(migrateLegacyClauseKeyedItemIdsCorpus(root).changed).toEqual([]);
    expect(renderLegacyClauseIdLine(root)).toContain("none --");
    const empty = mkdtempSync(join(tmpdir(), "clause-ids-empty-"));
    expect(migrateLegacyClauseKeyedItemIdsCorpus(empty)).toEqual({
      scanned: 0,
      changed: [],
      conflicts: [],
    });
    expect(scanLegacyClauseKeyedItemIds(empty).hits).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  itSymlink("reports a nested file symlink as a conflict instead of success", () => {
    const escapeDir = mkdtempSync(join(tmpdir(), "clause-ids-nested-escape-"));
    const target = join(escapeDir, "linked.xbrief.json");
    writeFileSync(
      target,
      `${JSON.stringify({ plan: { items: [{ id: "clause:1", title: "clause:1" }] } }, null, 2)}\n`,
      "utf8",
    );
    symlinkSync(target, join(root, "xbrief", "completed", "linked.xbrief.json"), "file");
    const result = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(result.changed).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        path: "xbrief/completed/linked.xbrief.json",
        message: "skipped symlink; vbrief:validate may still reject leftover clause:N inside",
      },
    ]);
    expect(run(["--project-root", root])).toBe(1);
    const linkedDoc = JSON.parse(readFileSync(target, "utf8")) as {
      plan: { items: Array<{ id: string }> };
    };
    expect(linkedDoc.plan.items[0]?.id).toBe("clause:1");
    rmSync(escapeDir, { recursive: true, force: true });
  });

  it("conflicts when clause:N rewrite would duplicate an existing clause.N", () => {
    const path = write("xbrief/completed/both.xbrief.json", [
      { id: "clause:1", title: "clause:1", status: "completed" },
      { id: clauseKeyedItemId(1), title: "already dotted", status: "completed" },
    ]);
    const before = readFileSync(path, "utf8");
    const result = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(result.changed).toEqual([]);
    expect(result.conflicts[0]?.path).toBe("xbrief/completed/both.xbrief.json");
    expect(result.conflicts[0]?.message).toMatch(/duplicate PlanItem ids/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(run(["--project-root", root])).toBe(1);
  });

  it("rewrites leftover vbrief/ when xbrief/ exists but holds no briefs", () => {
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    const path = join(root, "vbrief", "completed", "old.vbrief.json");
    writeFileSync(
      path,
      `${JSON.stringify({ plan: { items: [{ id: "clause:6", title: "clause:6" }] } }, null, 2)}\n`,
      "utf8",
    );
    const result = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(result.conflicts).toEqual([]);
    expect(result.changed).toEqual(["vbrief/completed/old.vbrief.json"]);
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      plan: { items: Array<{ id: string }> };
    };
    expect(doc.plan.items[0]?.id).toBe(clauseKeyedItemId(6));
  });

  it("rewrites clause:N when unrelated duplicate ids already exist", () => {
    const path = write("xbrief/completed/unrelated-dup.xbrief.json", [
      { id: "keep", title: "keep", status: "completed" },
      { id: "keep", title: "keep-copy", status: "completed" },
      { id: "clause:2", title: "clause:2", status: "completed" },
    ]);
    const result = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(result.conflicts).toEqual([]);
    expect(result.changed).toEqual(["xbrief/completed/unrelated-dup.xbrief.json"]);
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      plan: { items: Array<{ id: string }> };
    };
    expect(doc.plan.items.map((item) => item.id)).toEqual(["keep", "keep", clauseKeyedItemId(2)]);
  });

  itSymlink("ignores an unrelated non-brief symlink and still rewrites leftovers", () => {
    const escapeDir = mkdtempSync(join(tmpdir(), "clause-ids-unrelated-link-"));
    writeFileSync(join(escapeDir, "notes.txt"), "not a brief\n", "utf8");
    mkdirSync(join(escapeDir, "docs"), { recursive: true });
    symlinkSync(join(escapeDir, "notes.txt"), join(root, "xbrief", "completed", "notes.txt"));
    symlinkSync(join(escapeDir, "docs"), join(root, "xbrief", "docs"), "dir");
    const path = write("xbrief/completed/done.xbrief.json", [
      { id: "clause:7", title: "clause:7", status: "completed" },
    ]);
    const result = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(result.conflicts).toEqual([]);
    expect(result.changed).toEqual(["xbrief/completed/done.xbrief.json"]);
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      plan: { items: Array<{ id: string }> };
    };
    expect(doc.plan.items[0]?.id).toBe(clauseKeyedItemId(7));
    rmSync(escapeDir, { recursive: true, force: true });
  });

  itSymlink("conflicts when a lifecycle folder is a symlink", () => {
    const escapeDir = mkdtempSync(join(tmpdir(), "clause-ids-folder-link-"));
    mkdirSync(join(escapeDir, "completed"), { recursive: true });
    writeFileSync(
      join(escapeDir, "completed", "out.xbrief.json"),
      `${JSON.stringify({ plan: { items: [{ id: "clause:1", title: "clause:1" }] } }, null, 2)}\n`,
      "utf8",
    );
    rmSync(join(root, "xbrief", "completed"), { recursive: true, force: true });
    symlinkSync(join(escapeDir, "completed"), join(root, "xbrief", "completed"), "dir");
    const leftover = write("xbrief/cancelled/old.xbrief.json", [
      { id: "clause:8", title: "clause:8", status: "cancelled" },
    ]);
    const result = migrateLegacyClauseKeyedItemIdsCorpus(root);
    expect(result.conflicts).toEqual([
      {
        path: "xbrief/completed",
        message: "skipped symlink; vbrief:validate may still reject leftover clause:N inside",
      },
    ]);
    expect(result.changed).toEqual(["xbrief/cancelled/old.xbrief.json"]);
    const doc = JSON.parse(readFileSync(leftover, "utf8")) as {
      plan: { items: Array<{ id: string }> };
    };
    expect(doc.plan.items[0]?.id).toBe(clauseKeyedItemId(8));
    rmSync(escapeDir, { recursive: true, force: true });
  });
});

describe("migrate:clause-ids CLI (#5011)", () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("parses --project-root", () => {
    expect(parseArgs(["--project-root", "/tmp/project"]).projectRoot).toBe("/tmp/project");
    expect(parseArgs(["--project-root=/tmp/p"]).projectRoot).toBe("/tmp/p");
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
  });

  it("returns 2 for unknown flags and 0 for --help", () => {
    expect(run(["--not-real"])).toBe(2);
    expect(mainEntry(["--not-real"])).toBe(2);
    expect(run(["--help"])).toBe(0);
    expect(mainEntry(["-h"])).toBe(0);
  });

  it("migrates a corpus then no-ops", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-ids-cli-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    const file = join(root, "xbrief", "completed", "done.xbrief.json");
    writeFileSync(
      file,
      `${JSON.stringify({ plan: { items: [{ id: "clause:9", title: "clause:9" }] } }, null, 2)}\n`,
      "utf8",
    );
    expect(run(["--project-root", root])).toBe(0);
    const plan = (
      JSON.parse(readFileSync(file, "utf8")) as { plan: { items: Array<{ id: string }> } }
    ).plan;
    expect(plan.items[0]?.id).toBe(clauseKeyedItemId(9));
    expect(run(["--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  itSymlink("returns 1 when the lifecycle root is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-ids-cli-link-"));
    const escapeDir = mkdtempSync(join(tmpdir(), "clause-ids-cli-escape-"));
    writeFileSync(
      join(escapeDir, "outside.xbrief.json"),
      `${JSON.stringify({ plan: { items: [{ id: "clause:1", title: "clause:1" }] } }, null, 2)}\n`,
      "utf8",
    );
    symlinkSync(escapeDir, join(root, "xbrief"), "dir");
    expect(run(["--project-root", root])).toBe(1);
    rmSync(root, { recursive: true, force: true });
    rmSync(escapeDir, { recursive: true, force: true });
  });

  it("printLegacyClauseIdNudgeIfNeeded is silent when there are no leftovers", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-ids-nudge-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "clean.xbrief.json"),
      `${JSON.stringify({ plan: { items: [{ id: clauseKeyedItemId(1) }] } }, null, 2)}\n`,
      "utf8",
    );
    const lines: string[] = [];
    printLegacyClauseIdNudgeIfNeeded(root, { printf: (text) => lines.push(text) });
    expect(lines).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("vbrief:validate stays hard on clause:N (#5011)", () => {
  it("warn-accepts leftover colon ids on draft under 0.8 VALID_PLAN_STATUSES (#5467)", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      {
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          // Prefer-A (#5467): 0.8 demotes clause:N on every VALID_PLAN_STATUSES member.
          status: "draft",
          items: [{ id: "clause:1", title: "colon", status: "pending" }],
        },
      },
      "id-colon.json",
      warnings,
    );
    expect(errors.some((e) => e.includes("invalid id"))).toBe(false);
    expect(
      warnings.some((w) => w.includes("legacy clause-colon id") && w.includes("clause:1")),
    ).toBe(true);
  });

  it("still hard-fails non-clause illegal ids on draft under 0.8", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      {
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          status: "draft",
          items: [{ id: "not a legal id", title: "bad", status: "pending" }],
        },
      },
      "id-illegal.json",
      warnings,
    );
    expect(errors.some((e) => e.includes("invalid id"))).toBe(true);
    expect(warnings.some((w) => w.includes("legacy clause-colon id"))).toBe(false);
  });

  it("demotes leftover colon ids to warnings on terminal plans when a collector is passed", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      {
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          status: "completed",
          items: [{ id: "clause:1", title: "colon", status: "pending" }],
        },
      },
      "id-colon-terminal.json",
      warnings,
    );
    expect(errors.some((e) => e.includes("invalid id"))).toBe(false);
    expect(
      warnings.some((w) => w.includes("legacy clause-colon id") && w.includes("clause:1")),
    ).toBe(true);
  });
});
