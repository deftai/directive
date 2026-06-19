import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLifecycleFolder,
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import { formatVbriefJson } from "./vbrief-json.js";

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
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const parent = join(vbrief, "active", "p.vbrief.json");
    writeFileSync(
      parent,
      formatVbriefJson({
        plan: {
          references: [
            { type: "x-vbrief/plan", uri: "active/child.vbrief.json" },
            { type: "x-vbrief/plan", uri: "active/child.vbrief.json" },
            null,
            { type: "other", uri: "x" },
          ],
        },
      }),
    );
    const childData = {
      plan: { planRef: "active/p.vbrief.json", items: [{ planRef: 123 }] },
    };
    expect(
      updateDecomposedParentBackReferences(
        childData,
        join(vbrief, "pending", "child.vbrief.json"),
        join(vbrief, "active", "child.vbrief.json"),
        vbrief,
      ),
    ).toEqual([]);

    writeFileSync(
      parent,
      formatVbriefJson({
        plan: {
          references: [{ type: "x-vbrief/plan", uri: "active/child.vbrief.json" }],
        },
      }),
    );
    writeFileSync(
      join(vbrief, "active", "child.vbrief.json"),
      formatVbriefJson({ plan: { planRef: "active/p.vbrief.json", items: [] } }),
    );
    updateDecomposedParentBackReferences(
      childData,
      join(vbrief, "active", "child.vbrief.json"),
      join(vbrief, "active", "child.vbrief.json"),
      vbrief,
    );
    expect(JSON.parse(readFileSync(parent, "utf8")).plan.references[0].uri).toContain("active/");
  });

  it("updates child planRefs when parent moves", () => {
    root = mkdtempSync(join(tmpdir(), "decomp-child-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const parent = join(vbrief, "pending", "p.vbrief.json");
    const child = join(vbrief, "pending", "c.vbrief.json");
    writeFileSync(
      parent,
      formatVbriefJson({
        plan: {
          references: [{ type: "x-vbrief/plan", uri: "pending/c.vbrief.json" }],
          items: [],
        },
      }),
    );
    writeFileSync(
      child,
      formatVbriefJson({
        plan: { planRef: "pending/p.vbrief.json", items: [{ planRef: "pending/p.vbrief.json" }] },
      }),
    );
    const parentData = JSON.parse(readFileSync(parent, "utf8"));
    const newParent = join(vbrief, "active", "p.vbrief.json");
    writeFileSync(newParent, readFileSync(parent));
    rmSync(parent);
    const updated = updateDecomposedChildBackReferences(parentData, parent, newParent, vbrief);
    expect(updated).toContain(child);
    expect(JSON.parse(readFileSync(child, "utf8")).plan.planRef).toContain("active/");
  });

  it("detectLifecycleFolder returns null outside lifecycle dirs", () => {
    expect(detectLifecycleFolder("/tmp/vbrief.json")).toBeNull();
    expect(detectLifecycleFolder("/tmp/proposed/x.vbrief.json")).toBe("proposed");
  });
});
