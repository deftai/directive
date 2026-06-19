import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { append, canonicalLogPath, newDecisionId, readAll } from "./audit-log.js";
import { demoteOne } from "./demote.js";
import { findByBatchId, undoBatch, undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("undo", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("undoes demote back to pending", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    const pending = join(root, "vbrief", "pending", "z.vbrief.json");
    writeFileSync(
      pending,
      formatVbriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      "utf8",
    );
    const demote = demoteOne(pending, root, "test");
    expect(demote.ok).toBe(true);
    const entry = demote.auditEntry as Record<string, unknown>;
    const undo = undoOne(entry, root);
    expect(undo.ok).toBe(true);
    expect(existsSync(join(root, "vbrief", "pending", "z.vbrief.json"))).toBe(true);
  });

  it("refuses terminal actions", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T19:00:00Z",
      action: "complete",
      vbrief_path: "vbrief/completed/x.vbrief.json",
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
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    const batchId = newDecisionId();
    for (const name of ["a.vbrief.json", "b.vbrief.json"]) {
      const pending = join(root, "vbrief", "pending", name);
      writeFileSync(
        pending,
        formatVbriefJson({ plan: { title: name, status: "pending", items: [] } }),
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
    mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    writeFileSync(
      join(root, "vbrief", "cancelled", "c.vbrief.json"),
      formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      "utf8",
    );
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "cancel",
      vbrief_path: "vbrief/cancelled/c.vbrief.json",
      from_status: "pending",
      to_status: "cancelled",
      actor: "operator",
    };
    append(entry, logPath);
    expect(undoOne(entry, root, { logPath }).ok).toBe(true);
    expect(existsSync(join(root, "vbrief", "pending", "c.vbrief.json"))).toBe(true);
  });

  it("undoes undo-of-restore back to cancelled", () => {
    root = mkdtempSync(join(tmpdir(), "undo-chain-"));
    mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const restoreId = newDecisionId();
    append(
      {
        decision_id: restoreId,
        timestamp: "2026-05-18T19:00:00Z",
        action: "restore",
        vbrief_path: "vbrief/cancelled/x.vbrief.json",
        from_status: "cancelled",
        to_status: "proposed",
        actor: "operator",
      },
      logPath,
    );
    writeFileSync(
      join(root, "vbrief", "cancelled", "x.vbrief.json"),
      formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
      "utf8",
    );
    const restoreEntry = readAll(logPath)[0] as Record<string, unknown>;
    expect(undoOne(restoreEntry, root, { logPath }).ok).toBe(true);
    const undoEntry = readAll(logPath).find((e) => e.action === "undo") as Record<string, unknown>;
    expect(undoOne(undoEntry, root, { logPath, logEntries: readAll(logPath) }).ok).toBe(true);
  });

  it("idempotent re-run is no-op", () => {
    root = mkdtempSync(join(tmpdir(), "undo-test-"));
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    const pending = join(root, "vbrief", "pending", "i.vbrief.json");
    writeFileSync(
      pending,
      formatVbriefJson({ plan: { title: "T", status: "pending", items: [] } }),
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
});
