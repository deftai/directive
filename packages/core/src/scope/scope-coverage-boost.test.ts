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
import { formatBriefJson } from "./vbrief-json.js";

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
    const vbrief = join(root, "xbrief");
    for (const f of ["pending", "active"]) {
      mkdirSync(join(vbrief, f), { recursive: true });
    }
    const parent = join(vbrief, "pending", "p.xbrief.json");
    const child = join(vbrief, "pending", "c.xbrief.json");
    writeFileSync(
      parent,
      formatBriefJson({
        plan: {
          title: "P",
          status: "pending",
          items: [],
          references: [{ type: "x-vbrief/plan", uri: "file://pending/c.xbrief.json" }],
        },
      }),
    );
    writeFileSync(
      child,
      formatBriefJson({
        plan: {
          title: "C",
          status: "pending",
          items: [],
          planRef: "file://pending/p.xbrief.json",
        },
      }),
    );
    const childData = JSON.parse(readFileSync(child, "utf8"));
    const newChild = join(vbrief, "active", "c.xbrief.json");
    writeFileSync(newChild, readFileSync(child));
    rmSync(child);
    updateDecomposedParentBackReferences(childData, child, newChild, vbrief);
    const parentData = JSON.parse(readFileSync(parent, "utf8"));
    expect(parentData.plan.references[0].uri).toContain("active/");
    updateDecomposedChildBackReferences(
      parentData,
      parent,
      join(vbrief, "active", "p.xbrief.json"),
      vbrief,
    );
    const childAfter = JSON.parse(readFileSync(newChild, "utf8"));
    expect(String(childAfter.plan.planRef)).toContain("active/");
  });

  it("project definition sync rewrites references and metadata refs", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
      formatBriefJson({
        plan: {
          title: "P",
          status: "running",
          items: [
            {
              id: "2026-01-01-x",
              title: "Other",
              status: "running",
              metadata: {
                references: [{ type: "x-vbrief/plan", uri: "active/move.xbrief.json" }],
              },
            },
          ],
          references: [{ type: "x-vbrief/plan", uri: "active/move.xbrief.json" }],
        },
      }),
    );
    const active = join(vbrief, "active", "move.xbrief.json");
    writeFileSync(
      active,
      formatBriefJson({ plan: { title: "Other", status: "running", items: [] } }),
    );
    const data = JSON.parse(readFileSync(active, "utf8"));
    syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "move.xbrief.json"),
      vbrief,
      "completed",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"));
    expect(pd.plan.references[0].uri).toContain("completed/");
  });

  it("undo cancel with legacy cancelled_from top-level field", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    writeFileSync(
      join(root, "xbrief", "cancelled", "x.xbrief.json"),
      formatBriefJson({ plan: { title: "T", status: "cancelled", items: [] } }),
    );
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "cancel",
      vbrief_path: "xbrief/cancelled/x.xbrief.json",
      from_status: "pending",
      to_status: "cancelled",
      actor: "operator",
      cancelled_from: "pending",
    };
    append(entry, logPath);
    expect(undoOne(entry, root, { logPath }).ok).toBe(true);
    expect(existsSync(join(root, "xbrief", "pending", "x.xbrief.json"))).toBe(true);
  });

  it("undo rejects unknown action", () => {
    root = mkdtempSync(join(tmpdir(), "boost-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const entry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "promote",
      vbrief_path: "xbrief/pending/x.xbrief.json",
      from_status: "proposed",
      to_status: "pending",
      actor: "operator",
    };
    append(entry, logPath);
    expect(undoOne(entry, root, { logPath }).ok).toBe(false);
  });
});
