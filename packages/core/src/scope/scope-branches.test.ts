import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { append, canonicalLogPath, newDecisionId, ScopeAuditLogError } from "./audit-log.js";
import { demoteOne } from "./demote.js";
import { demoteMain, lifecycleMain, undoMain } from "./main.js";
import { resolveProjectRoot } from "./project-context.js";
import { runTransition } from "./transition.js";
import { undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("scope branch coverage", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("main undo mutex and batch paths", () => {
    expect(undoMain(["id1", "--batch-id", "b", "--project-root", "/tmp"])).toBe(2);
    expect(undoMain(["--latest", "--decision-id", "x", "--project-root", "/tmp"])).toBe(2);
    expect(undoMain(["a", "--decision-id", "b", "--project-root", "/tmp"])).toBe(2);
    root = mkdtempSync(join(tmpdir(), "scope-br-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(canonicalLogPath(root), "{}\n", "utf8");
    expect(undoMain(["--batch-id", newDecisionId(), "--project-root", root])).toBe(1);
  });

  it("lifecycle promote with force over cap", () => {
    root = mkdtempSync(join(tmpdir(), "scope-br-"));
    for (const f of ["proposed", "pending", "active"]) {
      mkdirSync(join(root, "vbrief", f), { recursive: true });
    }
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(
        join(root, "vbrief", "pending", `p${i}.vbrief.json`),
        formatVbriefJson({ plan: { title: "T", status: "pending", items: [] } }),
      );
    }
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      formatVbriefJson({
        plan: { title: "P", status: "running", items: [], policy: { wipCap: 10 } },
      }),
    );
    const file = join(root, "vbrief", "proposed", "new.vbrief.json");
    writeFileSync(file, formatVbriefJson({ plan: { title: "T", status: "proposed", items: [] } }));
    expect(lifecycleMain(["promote", file, "--project-root", root, "--force"])).toBe(0);
  });

  it("undo restore and nested undo branches", () => {
    root = mkdtempSync(join(tmpdir(), "scope-br-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const proposed = join(root, "vbrief", "proposed", "r.vbrief.json");
    writeFileSync(
      proposed,
      formatVbriefJson({ plan: { title: "T", status: "proposed", items: [] } }),
    );
    const restoreEntry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "restore",
      vbrief_path: "vbrief/proposed/r.vbrief.json",
      from_status: "cancelled",
      to_status: "proposed",
      actor: "operator",
    };
    append(restoreEntry, logPath);
    expect(undoOne(restoreEntry, root, { logPath }).ok).toBe(true);
    expect(existsSync(join(root, "vbrief", "cancelled", "r.vbrief.json"))).toBe(true);

    const pending = join(root, "vbrief", "pending", "d.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      pending,
      formatVbriefJson({ plan: { title: "T", status: "pending", items: [] } }),
    );
    const demoted = demoteOne(pending, root, "x");
    const undoResult = undoOne(demoted.auditEntry as Record<string, unknown>, root, { logPath });
    expect(undoResult.ok).toBe(true);
    const undoUndo = undoOne(undoResult.auditEntry as Record<string, unknown>, root, { logPath });
    expect(undoUndo.ok).toBe(true);
  });

  it("audit log validation branches", () => {
    root = mkdtempSync(join(tmpdir(), "scope-br-"));
    const logPath = canonicalLogPath(root);
    expect(() => append({}, logPath)).toThrow(ScopeAuditLogError);
    expect(() =>
      append(
        {
          decision_id: "bad",
          timestamp: "2026-05-17T21:05:00Z",
          action: "demote",
          vbrief_path: "x",
          from_status: "p",
          to_status: "p",
          actor: "op",
          demote_meta: {
            was_promoted: true,
            original_promotion_decision_id: "bad-id",
            days_in_pending: 1,
            demote_reason: "r",
            demoted_from: "pending",
          },
        },
        logPath,
      ),
    ).toThrow(ScopeAuditLogError);
  });

  it("project context invalid roots", () => {
    expect(resolveProjectRoot("/does-not-exist-xyz-abc")).toBeNull();
  });

  it("fail unblock from blocked and same-folder cancel no-op", () => {
    root = mkdtempSync(join(tmpdir(), "scope-br-"));
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
    const active = join(root, "vbrief", "active", "f.vbrief.json");
    writeFileSync(active, formatVbriefJson({ plan: { title: "T", status: "running", items: [] } }));
    runTransition("block", active);
    expect(runTransition("unblock", active).ok).toBe(true);
    const cancelled = join(root, "vbrief", "cancelled", "c.vbrief.json");
    writeFileSync(
      cancelled,
      formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
    );
    expect(runTransition("cancel", cancelled).message).toContain("No-op");
  });

  it("demoteMain usage without file", () => {
    expect(demoteMain([])).toBe(2);
  });
});
