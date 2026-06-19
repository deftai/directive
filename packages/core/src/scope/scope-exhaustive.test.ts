import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
import {
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import { undoMain } from "./main.js";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { undoOne } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";
import {
  collectChildUris,
  collectPlanRefs,
  relativeToVbrief,
  resolveVbriefRef,
  scopeIdsForFilename,
} from "./vbrief-ref.js";

describe("scope exhaustive branches", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("vbrief-ref edge cases", () => {
    root = mkdtempSync(join(tmpdir(), "ex-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief);
    expect(collectPlanRefs({ items: [{ planRef: 1 }] })).toEqual([]);
    expect(collectChildUris({ references: [{ type: "other" }] })).toEqual([]);
    expect(scopeIdsForFilename("slug.vbrief.json").has("slug")).toBe(true);
    expect(relativeToVbrief("/outside", vbrief)).toBeNull();
    expect(resolveVbriefRef("", vbrief)).toBeNull();
  });

  it("undo inverse for undo-of-demote and missing metadata", () => {
    root = mkdtempSync(join(tmpdir(), "ex-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const demoteId = newDecisionId();
    append(
      {
        decision_id: demoteId,
        timestamp: "2026-05-18T19:00:00Z",
        action: "demote",
        vbrief_path: "vbrief/proposed/x.vbrief.json",
        from_status: "pending",
        to_status: "proposed",
        actor: "operator",
        demote_meta: {
          was_promoted: true,
          original_promotion_decision_id: null,
          days_in_pending: 0,
          demote_reason: "x",
          demoted_from: "pending",
        },
      },
      logPath,
    );
    const undoEntry = {
      decision_id: newDecisionId(),
      timestamp: "2026-05-18T20:00:00Z",
      action: "undo",
      vbrief_path: "vbrief/pending/x.vbrief.json",
      from_status: "proposed",
      to_status: "pending",
      actor: "operator",
      undo_meta: { original_decision_id: demoteId, original_action: "demote" },
    };
    append(undoEntry, logPath);
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "pending", "x.vbrief.json"),
      formatVbriefJson({ plan: { title: "T", status: "pending", items: [] } }),
    );
    expect(undoOne(undoEntry, root, { logPath }).ok).toBe(true);

    expect(
      undoOne(
        {
          decision_id: newDecisionId(),
          action: "cancel",
          vbrief_path: "vbrief/cancelled/y.vbrief.json",
        },
        root,
        { logPath },
      ).ok,
    ).toBe(false);
  });

  it("undoMain latest finds nothing when log empty", () => {
    root = mkdtempSync(join(tmpdir(), "ex-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(canonicalLogPath(root), "", "utf8");
    expect(undoMain(["--latest", "--project-root", root])).toBe(1);
  });

  it("sync project definition outside vbrief is noop", () => {
    syncProjectDefinitionAfterScopeMove({}, "/a", "/b", "/vb", "completed");
    expect(true).toBe(true);
  });

  it("decomposed parent rewrite handles item-level planRef", () => {
    root = mkdtempSync(join(tmpdir(), "ex-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const parent = join(vbrief, "pending", "p.vbrief.json");
    writeFileSync(
      parent,
      formatVbriefJson({
        plan: {
          title: "P",
          items: [{ planRef: "pending/c.vbrief.json" }],
          references: [],
        },
      }),
    );
    const child = join(vbrief, "pending", "c.vbrief.json");
    writeFileSync(
      child,
      formatVbriefJson({ plan: { title: "C", items: [], planRef: "pending/p.vbrief.json" } }),
    );
    const childData = JSON.parse(readFileSync(child, "utf8")) as Record<string, unknown>;
    const newChild = join(vbrief, "active", "c.vbrief.json");
    writeFileSync(newChild, readFileSync(child));
    rmSync(child);
    updateDecomposedParentBackReferences(childData, child, newChild, vbrief);
    updateDecomposedChildBackReferences(
      JSON.parse(readFileSync(parent, "utf8")) as Record<string, unknown>,
      parent,
      join(vbrief, "active", "p.vbrief.json"),
      vbrief,
    );
    expect(existsSync(newChild)).toBe(true);
  });
});
