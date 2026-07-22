import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLifecycleFolder,
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import { formatBriefJson } from "./vbrief-json.js";

describe("decomposed-refs branches", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("skips invalid parents, missing files, and unchanged uris", () => {
    root = mkdtempSync(join(tmpdir(), "decomp-br-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const parent = join(vbrief, "active", "p.xbrief.json");
    writeFileSync(
      parent,
      formatBriefJson({
        plan: {
          references: [
            { type: "x-vbrief/plan", uri: "active/child.xbrief.json" },
            { type: "x-vbrief/plan", uri: "active/child.xbrief.json" },
            null,
            { type: "other", uri: "x" },
          ],
        },
      }),
    );
    const childData = {
      plan: { planRef: "active/p.xbrief.json", items: [{ planRef: 123 }] },
    };
    expect(
      updateDecomposedParentBackReferences(
        childData,
        join(vbrief, "pending", "child.xbrief.json"),
        join(vbrief, "active", "child.xbrief.json"),
        vbrief,
      ),
    ).toEqual([]);

    writeFileSync(
      parent,
      formatBriefJson({
        plan: {
          references: [{ type: "x-vbrief/plan", uri: "active/child.xbrief.json" }],
        },
      }),
    );
    writeFileSync(
      join(vbrief, "active", "child.xbrief.json"),
      formatBriefJson({ plan: { planRef: "active/p.xbrief.json", items: [] } }),
    );
    updateDecomposedParentBackReferences(
      childData,
      join(vbrief, "active", "child.xbrief.json"),
      join(vbrief, "active", "child.xbrief.json"),
      vbrief,
    );
    expect(JSON.parse(readFileSync(parent, "utf8")).plan.references[0].uri).toContain("active/");
  });

  it("updates child planRefs when parent moves", () => {
    root = mkdtempSync(join(tmpdir(), "decomp-child-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const parent = join(vbrief, "pending", "p.xbrief.json");
    const child = join(vbrief, "pending", "c.xbrief.json");
    writeFileSync(
      parent,
      formatBriefJson({
        plan: {
          references: [{ type: "x-vbrief/plan", uri: "pending/c.xbrief.json" }],
          items: [],
        },
      }),
    );
    writeFileSync(
      child,
      formatBriefJson({
        plan: { planRef: "pending/p.xbrief.json", items: [{ planRef: "pending/p.xbrief.json" }] },
      }),
    );
    const parentData = JSON.parse(readFileSync(parent, "utf8"));
    const newParent = join(vbrief, "active", "p.xbrief.json");
    writeFileSync(newParent, readFileSync(parent));
    rmSync(parent);
    const updated = updateDecomposedChildBackReferences(parentData, parent, newParent, vbrief);
    expect(updated).toContain(child);
    expect(JSON.parse(readFileSync(child, "utf8")).plan.planRef).toContain("active/");
  });

  it("detectLifecycleFolder returns null outside lifecycle dirs", () => {
    expect(detectLifecycleFolder("/tmp/vbrief.json")).toBeNull();
    expect(detectLifecycleFolder("/tmp/proposed/x.xbrief.json")).toBe("proposed");
  });
});
