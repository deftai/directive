import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
import {
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("scope coverage boost", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("rewrites file:// prefixed refs on decomposed moves", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    const vbrief = join(root, "vbrief");
    for (const f of ["pending", "active"]) {
      mkdirSync(join(vbrief, f), { recursive: true });
    }
    const parent = join(vbrief, "pending", "p.vbrief.json");
    const child = join(vbrief, "pending", "c.vbrief.json");
    writeFileSync(
      parent,
      formatVbriefJson({
        plan: {
          title: "P",
          status: "pending",
          items: [],
          references: [{ type: "x-vbrief/plan", uri: "file://pending/c.vbrief.json" }],
        },
      }),
    );
    writeFileSync(
      child,
      formatVbriefJson({
        plan: {
          title: "C",
          status: "pending",
          items: [],
          planRef: "file://pending/p.vbrief.json",
        },
      }),
    );
    const childData = JSON.parse(readFileSync(child, "utf8"));
    const newChild = join(vbrief, "active", "c.vbrief.json");
    writeFileSync(newChild, readFileSync(child));
    rmSync(child);
    updateDecomposedParentBackReferences(childData, child, newChild, vbrief);
    const parentData = JSON.parse(readFileSync(parent, "utf8"));
    expect(parentData.plan.references[0].uri).toContain("active/");
    updateDecomposedChildBackReferences(
      parentData,
      parent,
      join(vbrief, "active", "p.vbrief.json"),
      vbrief,
    );
    const childAfter = JSON.parse(readFileSync(newChild, "utf8"));
    expect(String(childAfter.plan.planRef)).toContain("active/");
  });

  it("project definition sync rewrites references and metadata refs", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
      formatVbriefJson({
        plan: {
          title: "P",
          status: "running",
          items: [
            {
              id: "2026-01-01-x",
              title: "Other",
              status: "running",
              metadata: {
                references: [{ type: "x-vbrief/plan", uri: "active/move.vbrief.json" }],
              },
            },
          ],
          references: [{ type: "x-vbrief/plan", uri: "active/move.vbrief.json" }],
        },
      }),
    );
    const active = join(vbrief, "active", "move.vbrief.json");
    writeFileSync(
      active,
      formatVbriefJson({ plan: { title: "Other", status: "running", items: [] } }),
    );
    const data = JSON.parse(readFileSync(active, "utf8"));
    syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "move.vbrief.json"),
      vbrief,
      "completed",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"));
    expect(pd.plan.references[0].uri).toContain("completed/");
  });

  it("undo cancel with legacy cancelled_from top-level field", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    writeFileSync(
      join(root, "vbrief", "cancelled", "x.vbrief.json"),
      formatVbriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
    );
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "cancel",
      vbrief_path: "vbrief/cancelled/x.vbrief.json",
      from_status: "pending",
      to_status: "cancelled",
      actor: "operator",
      cancelled_from: "pending",
    };
    append(entry, logPath);
    expect(undoOne(entry, root, { logPath }).ok).toBe(true);
    expect(existsSync(join(root, "vbrief", "pending", "x.vbrief.json"))).toBe(true);
  });

  it("undo rejects unknown action", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "promote",
      vbrief_path: "vbrief/pending/x.vbrief.json",
      from_status: "proposed",
      to_status: "pending",
      actor: "operator",
    };
    append(entry, logPath);
    expect(undoOne(entry, root, { logPath }).ok).toBe(false);
  });
});
