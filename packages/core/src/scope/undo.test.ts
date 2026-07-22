import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projectionContainment from "../fs/projection-containment.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { append, canonicalLogPath, newDecisionId, readAll } from "./audit-log.js";
import { demoteOne } from "./demote.js";
import { findByBatchId, undoBatch, undoOne } from "./undo.js";
import { formatBriefJson } from "./vbrief-json.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("undo", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("undoes demote back to pending", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pending = join(root, "xbrief", "pending", "z.xbrief.json");
    writeFileSync(
      pending,
      formatBriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      "utf8",
    );
    const demote = demoteOne(pending, root, "test");
    expect(demote.ok).toBe(true);
    const entry = demote.auditEntry as Record<string, unknown>;
    const undo = undoOne(entry, root);
    expect(undo.ok).toBe(true);
    expect(existsSync(join(root, "xbrief", "pending", "z.xbrief.json"))).toBe(true);
  });

  it("refuses terminal actions", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T19:00:00Z",
      action: "complete",
      vbrief_path: "xbrief/completed/x.xbrief.json",
      from_status: "active",
      to_status: "completed",
      actor: "operator",
    };
    append(entry, logPath);
    const result = undoOne(entry, root, { logPath });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("terminal");
  });

  it("batch undo reverses cohort", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const batchId = newDecisionId();
    for (const name of ["a.xbrief.json", "b.xbrief.json"]) {
      const pending = join(root, "xbrief", "pending", name);
      writeFileSync(
        pending,
        formatBriefJson({ plan: { title: name, status: "pending", items: [] } }),
        "utf8",
      );
      const demoted = demoteOne(pending, root, "batch", { batchId });
      expect(demoted.ok).toBe(true);
    }
    const logPath = canonicalLogPath(root);
    expect(findByBatchId(batchId, readAll(logPath))).toHaveLength(2);
    const [undone] = undoBatch(batchId, root);
    expect(undone).toBe(2);
  });

  it("undoes cancel back to pending using from_status", () => {
    root = mkdtempSync(join(tmpdir(), "undo-cancel-"));
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    writeFileSync(
      join(root, "xbrief", "cancelled", "c.xbrief.json"),
      formatBriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      "utf8",
    );
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "cancel",
      vbrief_path: "xbrief/cancelled/c.xbrief.json",
      from_status: "pending",
      to_status: "cancelled",
      actor: "operator",
    };
    append(entry, logPath);
    expect(undoOne(entry, root, { logPath }).ok).toBe(true);
    expect(existsSync(join(root, "xbrief", "pending", "c.xbrief.json"))).toBe(true);
  });

  it("undoes undo-of-restore back to cancelled", () => {
    root = mkdtempSync(join(tmpdir(), "undo-chain-"));
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const restoreId = newDecisionId();
    append(
      {
        decision_id: restoreId,
        timestamp: "2026-05-18T19:00:00Z",
        action: "restore",
        vbrief_path: "xbrief/cancelled/x.xbrief.json",
        from_status: "cancelled",
        to_status: "proposed",
        actor: "operator",
      },
      logPath,
    );
    writeFileSync(
      join(root, "xbrief", "cancelled", "x.xbrief.json"),
      formatBriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      "utf8",
    );
    const restoreEntry = readAll(logPath)[0] as Record<string, unknown>;
    expect(undoOne(restoreEntry, root, { logPath }).ok).toBe(true);
    const undoEntry = readAll(logPath).find((e) => e.action === "undo") as Record<string, unknown>;
    expect(undoOne(undoEntry, root, { logPath, logEntries: readAll(logPath) }).ok).toBe(true);
  });

  it("idempotent re-run is no-op", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pending = join(root, "xbrief", "pending", "i.xbrief.json");
    writeFileSync(
      pending,
      formatBriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      "utf8",
    );
    const demote = demoteOne(pending, root, "test");
    const entry = demote.auditEntry as Record<string, unknown>;
    const logPath = canonicalLogPath(root);
    expect(undoOne(entry, root, { logPath }).ok).toBe(true);
    const logAfter = readAll(logPath);
    expect(logAfter.some((e) => e.action === "undo")).toBe(true);
    const second = undoOne(entry, root, { logPath, logEntries: logAfter });
    expect(second.ok).toBe(true);
    expect(second.message).toContain("already undone");
  });

  itSymlink("refuses undo when proposed xBRIEF is a symlink outside the project (#2668)", () => {
    root = mkdtempSync(join(tmpdir(), "undo-symlink-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "pending", "seed.xbrief.json"),
      formatBriefJson({ plan: { title: "seed", status: "pending", items: [] } }),
      "utf8",
    );
    const escapeDir = mkdtempSync(join(tmpdir(), "undo-symlink-escape-"));
    const victim = join(escapeDir, "victim.xbrief.json");
    writeFileSync(
      victim,
      formatBriefJson({
        plan: { title: "T", status: "proposed", updated: "2026-05-01T00:00:00Z", items: [] },
      }),
      "utf8",
    );
    symlinkSync(victim, join(root, "xbrief", "proposed", "x.xbrief.json"));

    const logPath = canonicalLogPath(root);
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T19:00:00Z",
      action: "demote",
      vbrief_path: "xbrief/proposed/x.xbrief.json",
      from_status: "pending",
      to_status: "proposed",
      actor: "operator",
      demote_meta: {
        was_promoted: true,
        original_promotion_decision_id: null,
        days_in_pending: 0,
        demote_reason: "operator-requested",
        demoted_from: "pending",
      },
    };
    append(entry, logPath);

    const undo = undoOne(entry, root, { logPath });
    expect(undo.ok).toBe(false);
    expect(undo.message).toMatch(/projection write refused|symlink/);
    expect(JSON.parse(readFileSync(victim, "utf8"))).toMatchObject({
      plan: { status: "proposed" },
    });
    rmSync(escapeDir, { recursive: true, force: true });
  });

  it("refuses undo when write target fails containment check (#2668)", () => {
    root = mkdtempSync(join(tmpdir(), "undo-contain-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pending = join(root, "xbrief", "pending", "x.xbrief.json");
    writeFileSync(
      pending,
      formatBriefJson({
        plan: { title: "T", status: "pending", updated: "2026-05-01T00:00:00Z", items: [] },
      }),
      "utf8",
    );
    const demote = demoteOne(pending, root, "test");
    expect(demote.ok).toBe(true);
    const entry = demote.auditEntry as Record<string, unknown>;
    const spy = vi.spyOn(projectionContainment, "assertWriteTargetSafe").mockImplementation(() => {
      throw new ProjectionContainmentError("projection write refused: mock symlink escape", {
        projectDir: root,
        targetPath: join(root, "xbrief", "proposed", "x.xbrief.json"),
        offendingPath: join(tmpdir(), "escape"),
      });
    });
    try {
      const undo = undoOne(entry, root);
      expect(undo.ok).toBe(false);
      expect(undo.message).toMatch(/projection write refused/);
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows unexpected containment helper failures (#2668)", () => {
    root = mkdtempSync(join(tmpdir(), "undo-contain-throw-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pending = join(root, "xbrief", "pending", "x.xbrief.json");
    writeFileSync(
      pending,
      formatBriefJson({
        plan: { title: "T", status: "pending", updated: "2026-05-01T00:00:00Z", items: [] },
      }),
      "utf8",
    );
    const demote = demoteOne(pending, root, "test");
    const entry = demote.auditEntry as Record<string, unknown>;
    const spy = vi.spyOn(projectionContainment, "assertWriteTargetSafe").mockImplementation(() => {
      throw new Error("unexpected containment failure");
    });
    try {
      expect(() => undoOne(entry, root)).toThrow(/unexpected containment failure/);
    } finally {
      spy.mockRestore();
    }
  });
});
