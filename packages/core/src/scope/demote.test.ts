import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { batchDemote, demoteOne, resolveFilePath } from "./demote.js";
import { runTransition } from "./transition.js";
import { formatVbriefJson } from "./vbrief-json.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "demote-test-"));
  mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
  mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
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
    const path = join(root, "xbrief", "pending", "x.xbrief.json");
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
    expect(existsSync(join(root, "xbrief", "proposed", "x.xbrief.json"))).toBe(true);
  });

  it("batch demotes older pending files", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "pending", "old.xbrief.json");
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
    const [resolved] = resolveFilePath("xbrief/pending/x.xbrief.json", root);
    expect(resolved).toContain("xbrief/pending/x.xbrief.json");
  });
});

describe("promote then demote undo path", () => {
  it("round trip via filesystem", () => {
    const root = makeRepo();
    const proposed = join(root, "xbrief", "proposed", "y.xbrief.json");
    writeFileSync(
      proposed,
      formatVbriefJson({ plan: { title: "T", status: "proposed", items: [] } }),
      "utf8",
    );
    expect(runTransition("promote", proposed).ok).toBe(true);
    const pending = join(root, "xbrief", "pending", "y.xbrief.json");
    expect(demoteOne(pending, root, "test").ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
