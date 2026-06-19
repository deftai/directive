import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { batchDemote, demoteOne, resolveFilePath } from "./demote.js";
import { runTransition } from "./transition.js";
import { formatVbriefJson } from "./vbrief-json.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "demote-test-"));
  mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
  mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
  return root;
}

describe("demote", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("demotes pending to proposed with audit entry", () => {
    root = makeRepo();
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    writeFileSync(
      path,
      formatVbriefJson({
        plan: { title: "T", status: "pending", updated: "2026-05-01T00:00:00Z", items: [] },
      }),
      "utf8",
    );
    const now = new Date("2026-05-10T00:00:00.000Z");
    const result = demoteOne(path, root, "operator-requested", { now });
    expect(result.ok).toBe(true);
    expect(result.auditEntry?.action).toBe("demote");
    expect(existsSync(join(root, "vbrief", "proposed", "x.vbrief.json"))).toBe(true);
  });

  it("batch demotes older pending files", () => {
    root = makeRepo();
    const path = join(root, "vbrief", "pending", "old.vbrief.json");
    writeFileSync(
      path,
      formatVbriefJson({
        plan: { title: "T", status: "pending", updated: "2026-01-01T00:00:00Z", items: [] },
      }),
      "utf8",
    );
    const now = new Date("2026-06-01T00:00:00.000Z");
    const [count] = batchDemote(root, 30, { now });
    expect(count).toBe(1);
  });

  it("resolveFilePath handles relative paths", () => {
    root = makeRepo();
    const [resolved] = resolveFilePath("vbrief/pending/x.vbrief.json", root);
    expect(resolved).toContain("vbrief/pending/x.vbrief.json");
  });
});

describe("promote then demote undo path", () => {
  it("round trip via filesystem", () => {
    const root = makeRepo();
    const proposed = join(root, "vbrief", "proposed", "y.vbrief.json");
    writeFileSync(
      proposed,
      formatVbriefJson({ plan: { title: "T", status: "proposed", items: [] } }),
      "utf8",
    );
    expect(runTransition("promote", proposed).ok).toBe(true);
    const pending = join(root, "vbrief", "pending", "y.vbrief.json");
    expect(demoteOne(pending, root, "test").ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
