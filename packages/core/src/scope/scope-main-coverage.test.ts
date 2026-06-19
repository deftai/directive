import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalLogPath, newDecisionId } from "./audit-log.js";
import {
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import { demoteOne } from "./demote.js";
import { undoMain } from "./main.js";
import { resolveProjectRoot } from "./project-context.js";
import { undoBatch } from "./undo.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("scope main and context branches", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    delete process.env.DEFT_PROJECT_ROOT;
  });

  it("resolveProjectRoot walks from nested directory", () => {
    root = mkdtempSync(join(tmpdir(), "ctx-walk-"));
    mkdirSync(join(root, "vbrief"));
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    expect(resolveProjectRoot(null, join(root, "sub", "deep"))).toBe(root);
  });

  it("resolveProjectRoot rejects invalid env", () => {
    process.env.DEFT_PROJECT_ROOT = "/nonexistent-path-xyz-123";
    expect(resolveProjectRoot(null)).toBeNull();
  });

  it("decomposed helpers skip bad files gracefully", () => {
    root = mkdtempSync(join(tmpdir(), "decomp-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const badParent = join(vbrief, "active", "bad.vbrief.json");
    writeFileSync(badParent, "{", "utf8");
    const childData = {
      plan: { planRef: "active/bad.vbrief.json", items: [] },
    };
    expect(
      updateDecomposedParentBackReferences(
        childData,
        join(vbrief, "pending", "c.json"),
        join(vbrief, "active", "c.json"),
        vbrief,
      ),
    ).toEqual([]);
    const parentData = {
      plan: {
        references: [{ type: "x-vbrief/plan", uri: "active/missing.vbrief.json" }],
        items: [],
      },
    };
    expect(
      updateDecomposedChildBackReferences(
        parentData,
        join(vbrief, "active", "p.json"),
        join(vbrief, "completed", "p.json"),
        vbrief,
      ),
    ).toEqual([]);
  });

  it("undoMain batch success and dry-run", () => {
    root = mkdtempSync(join(tmpdir(), "undo-cli-"));
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    const batchId = newDecisionId();
    for (const name of ["one.vbrief.json", "two.vbrief.json"]) {
      const pending = join(root, "vbrief", "pending", name);
      writeFileSync(
        pending,
        formatVbriefJson({ plan: { title: name, status: "pending", items: [] } }),
      );
      demoteOne(pending, root, "batch", { batchId });
    }
    expect(undoMain(["--batch-id", batchId, "--project-root", root])).toBe(0);
    for (const name of ["one.vbrief.json", "two.vbrief.json"]) {
      demoteOne(join(root, "vbrief", "pending", name), root, "batch", { batchId });
    }
    expect(undoMain(["--batch-id", batchId, "--dry-run", "--project-root", root])).toBe(0);
  });

  it("undoBatch returns empty message when no members", () => {
    root = mkdtempSync(join(tmpdir(), "undo-batch-"));
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(canonicalLogPath(root), "", "utf8");
    const [count, , skipped] = undoBatch(newDecisionId(), root);
    expect(count).toBe(0);
    expect(skipped[0]).toContain("No audit entries");
  });
});
