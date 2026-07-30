import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  batchApproveEscalations,
  fileEscalation,
  listEscalationsFiltered,
  resolveEscalation,
} from "./actions.js";
import { loadEscalation } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "esc-actions-"));
  roots.push(root);
  return root;
}

describe("escalation actions (#518)", () => {
  it("fileEscalation rejects empty title", () => {
    const root = tempRoot();
    expect(() => fileEscalation({ projectRoot: root, type: "question", title: "   " })).toThrow(
      /title/,
    );
  });

  it("resolveEscalation rejects invalid decision and double resolve", () => {
    const root = tempRoot();
    const e = fileEscalation({
      projectRoot: root,
      type: "approval",
      title: "merge?",
      id: "esc-a1",
    });
    expect(resolveEscalation({ projectRoot: root, id: e.id, decision: "nope" }).ok).toBe(false);
    expect(resolveEscalation({ projectRoot: root, id: e.id, decision: "approved" }).ok).toBe(true);
    const again = resolveEscalation({
      projectRoot: root,
      id: e.id,
      decision: "denied",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("already-resolved");
  });

  it("batchApprove respects id filter", () => {
    const root = tempRoot();
    fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "a",
      id: "esc-1",
    });
    fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "b",
      id: "esc-2",
    });
    const batch = batchApproveEscalations({
      projectRoot: root,
      ids: ["esc-1"],
    });
    expect(batch.approved.map((x) => x.id)).toEqual(["esc-1"]);
    expect(loadEscalation(root, "esc-2")?.status).toBe("open");
  });

  it("listEscalationsFiltered openOnly", () => {
    const root = tempRoot();
    fileEscalation({ projectRoot: root, type: "resource", title: "need key", id: "r1" });
    resolveEscalation({ projectRoot: root, id: "r1", decision: "dismissed" });
    expect(listEscalationsFiltered(root, { openOnly: true })).toHaveLength(0);
    expect(listEscalationsFiltered(root)).toHaveLength(1);
  });
});
