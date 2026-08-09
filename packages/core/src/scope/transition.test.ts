import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteBrief, readBriefForMutation } from "./brief-io.js";
import { detectLifecycleFolder, runTransition } from "./transition.js";
import { formatBriefJson } from "./vbrief-json.js";

const itSymlink = it.skipIf(process.platform === "win32");

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-test-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  return root;
}

function writeVbrief(
  root: string,
  folder: string,
  status: string,
  name = "story.xbrief.json",
): string {
  const path = join(root, "xbrief", folder, name);
  writeFile(path, {
    xBRIEFInfo: { version: "0.8" },
    plan: { title: "T", status, items: [] },
  });
  return path;
}

function writeFile(path: string, data: unknown): void {
  writeFileSync(path, formatBriefJson(data), "utf8");
}

describe("runTransition", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("promotes proposed to pending", () => {
    root = makeRepo();
    const file = writeVbrief(root, "proposed", "proposed");
    const fixed = new Date("2026-06-01T12:00:00.000Z");
    const result = runTransition("promote", file, fixed);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Promoted");
    const dest = join(root, "xbrief", "pending", "story.xbrief.json");
    expect(existsSync(dest)).toBe(true);
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { status: string; updated: string };
    };
    expect(data.plan.status).toBe("pending");
    expect(data.plan.updated).toBe("2026-06-01T12:00:00Z");
  });

  it("activates pending to active", () => {
    root = makeRepo();
    const file = writeVbrief(root, "pending", "pending");
    const result = runTransition("activate", file);
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(true);
  });

  it("refuses activate when a plan item has effort XL (#1581)", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "pending", "xl-story.xbrief.json");
    writeFile(path, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "pending",
        items: [{ id: "big", title: "Needs breakdown", status: "pending", effort: "XL" }],
      },
    });
    const result = runTransition("activate", path);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/effort=XL|#1581/);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", "xl-story.xbrief.json"))).toBe(false);
  });

  it("activates when plan items use S/M/L effort (#1581)", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "pending", "sized.xbrief.json");
    writeFile(path, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "pending",
        items: [
          { id: "s", title: "Small", status: "pending", effort: "S" },
          { id: "m", title: "Medium", status: "pending", effort: "M" },
        ],
      },
    });
    const result = runTransition("activate", path);
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", "sized.xbrief.json"))).toBe(true);
  });

  it("completes active to completed with stamp", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running");
    const result = runTransition("complete", file);
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    expect(existsSync(file)).toBe(false);
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { status: string; metadata: { completedAt: string } };
    };
    expect(data.plan.status).toBe("completed");
    expect(data.plan.metadata.completedAt).toMatch(/Z$/);
  });

  it("advances non-terminal own plan.items and stamps xBRIEFInfo.updated on complete (#2862)", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "mixed-items.xbrief.json");
    const staleEnvelope = "2026-01-01T00:00:00Z";
    writeFile(path, {
      xBRIEFInfo: { version: "0.8", updated: staleEnvelope },
      plan: {
        title: "mixed",
        status: "running",
        updated: staleEnvelope,
        items: [
          { title: "pending-item", status: "pending" },
          { title: "proposed-item", status: "proposed" },
          { title: "running-item", status: "running" },
          { title: "cancelled-item", status: "cancelled" },
          { title: "failed-item", status: "failed" },
          { title: "already-completed", status: "completed" },
          {
            title: "parent-with-sub",
            status: "pending",
            subItems: [
              { title: "sub-pending", status: "pending" },
              { title: "sub-cancelled", status: "cancelled" },
            ],
          },
        ],
      },
    });
    const fixed = new Date("2026-07-27T15:30:00.000Z");
    const result = runTransition("complete", path, fixed);
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "mixed-items.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      xBRIEFInfo: { updated: string };
      plan: {
        status: string;
        updated: string;
        items: Array<{
          title: string;
          status: string;
          subItems?: Array<{ title: string; status: string }>;
        }>;
      };
    };
    expect(data.plan.status).toBe("completed");
    expect(data.plan.updated).toBe("2026-07-27T15:30:00Z");
    expect(data.xBRIEFInfo.updated).toBe(data.plan.updated);
    expect(data.xBRIEFInfo.updated).not.toBe(staleEnvelope);
    const byTitle = Object.fromEntries(data.plan.items.map((i) => [i.title, i]));
    expect(byTitle["pending-item"].status).toBe("completed");
    expect(byTitle["proposed-item"].status).toBe("completed");
    expect(byTitle["running-item"].status).toBe("completed");
    expect(byTitle["cancelled-item"].status).toBe("cancelled");
    expect(byTitle["failed-item"].status).toBe("failed");
    expect(byTitle["already-completed"].status).toBe("completed");
    expect(byTitle["parent-with-sub"].status).toBe("completed");
    expect(byTitle["parent-with-sub"].subItems?.[0].status).toBe("completed");
    expect(byTitle["parent-with-sub"].subItems?.[1].status).toBe("cancelled");
  });

  it("stamps vBRIEFInfo.updated on terminal transition for v0.6 envelopes (#2862)", () => {
    root = makeRepo();
    const path = join(root, "xbrief", "active", "v06.xbrief.json");
    writeFile(path, {
      vBRIEFInfo: { version: "0.6", updated: "2026-01-01T00:00:00Z" },
      plan: {
        title: "v06",
        status: "running",
        items: [{ title: "a", status: "pending" }],
      },
    });
    const fixed = new Date("2026-07-27T16:00:00.000Z");
    expect(runTransition("complete", path, fixed).ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "v06.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      vBRIEFInfo: { updated: string };
      plan: { updated: string; items: Array<{ status: string }> };
    };
    expect(data.vBRIEFInfo.updated).toBe("2026-07-27T16:00:00Z");
    expect(data.vBRIEFInfo.updated).toBe(data.plan.updated);
    expect(data.plan.items[0].status).toBe("completed");
  });

  it("advances non-terminal own items on fail and cancel (#2862)", () => {
    root = makeRepo();
    const failPath = join(root, "xbrief", "active", "fail-items.xbrief.json");
    writeFile(failPath, {
      xBRIEFInfo: { version: "0.8", updated: "2026-01-01T00:00:00Z" },
      plan: {
        title: "fail",
        status: "running",
        items: [
          { title: "p", status: "pending" },
          { title: "c", status: "cancelled" },
        ],
      },
    });
    expect(runTransition("fail", failPath).ok).toBe(true);
    const failed = JSON.parse(
      readFileSync(join(root, "xbrief", "completed", "fail-items.xbrief.json"), "utf8"),
    ) as { plan: { status: string; items: Array<{ status: string }> } };
    expect(failed.plan.status).toBe("failed");
    expect(failed.plan.items[0].status).toBe("failed");
    expect(failed.plan.items[1].status).toBe("cancelled");

    const cancelPath = join(root, "xbrief", "active", "cancel-items.xbrief.json");
    writeFile(cancelPath, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "cancel",
        status: "running",
        items: [
          { title: "p", status: "proposed" },
          { title: "f", status: "failed" },
        ],
      },
    });
    expect(runTransition("cancel", cancelPath).ok).toBe(true);
    const cancelled = JSON.parse(
      readFileSync(join(root, "xbrief", "cancelled", "cancel-items.xbrief.json"), "utf8"),
    ) as { plan: { status: string; items: Array<{ status: string }> } };
    expect(cancelled.plan.status).toBe("cancelled");
    expect(cancelled.plan.items[0].status).toBe("cancelled");
    expect(cancelled.plan.items[1].status).toBe("failed");
  });

  it("handles empty/nested items and skip-invalid item entries on complete (#2862)", () => {
    root = makeRepo();
    const fixed = new Date("2026-07-27T17:00:00.000Z");

    const emptyPath = join(root, "xbrief", "active", "empty-items.xbrief.json");
    writeFile(emptyPath, {
      xBRIEFInfo: { version: "0.8", updated: "2026-01-01T00:00:00Z" },
      plan: { title: "empty", status: "running", items: [] },
    });
    expect(runTransition("complete", emptyPath, fixed).ok).toBe(true);
    const emptyDest = join(root, "xbrief", "completed", "empty-items.xbrief.json");
    const emptyData = JSON.parse(readFileSync(emptyDest, "utf8")) as {
      xBRIEFInfo: { updated: string };
      plan: { updated: string; items: unknown[] };
    };
    expect(emptyData.xBRIEFInfo.updated).toBe(emptyData.plan.updated);
    expect(emptyData.plan.items).toEqual([]);

    const nestedPath = join(root, "xbrief", "active", "nested-items.xbrief.json");
    writeFile(nestedPath, {
      xBRIEFInfo: { version: "0.8", updated: "2026-01-01T00:00:00Z" },
      plan: {
        title: "nested",
        status: "running",
        items: [
          {
            title: "parent",
            status: "pending",
            // Nested under items[] (not only subItems) advances recursively.
            items: [{ title: "child-pending", status: "pending" }],
          },
          { title: "blocked-item", status: "blocked" },
        ],
      },
    });
    expect(runTransition("complete", nestedPath, fixed).ok).toBe(true);
    const nested = JSON.parse(
      readFileSync(join(root, "xbrief", "completed", "nested-items.xbrief.json"), "utf8"),
    ) as {
      plan: {
        items: Array<{
          title: string;
          status: string;
          items?: Array<{ status: string }>;
        }>;
      };
    };
    expect(nested.plan.items[0].status).toBe("completed");
    expect(nested.plan.items[0].items?.[0].status).toBe("completed");
    expect(nested.plan.items[1].status).toBe("blocked");

    // Exercise skip branches for non-array items / non-object entries (write may fail closed).
    const nonArrayPath = join(root, "xbrief", "active", "non-array-items.xbrief.json");
    writeFile(nonArrayPath, {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "bad-items", status: "running", items: "not-an-array" },
    });
    expect(runTransition("complete", nonArrayPath, fixed).ok).toBe(false);

    const junkPath = join(root, "xbrief", "active", "junk-entries.xbrief.json");
    writeFile(junkPath, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "junk",
        status: "running",
        items: [null, "skip", ["arr"], { title: "ok", status: "pending" }],
      },
    });
    expect(runTransition("complete", junkPath, fixed).ok).toBe(false);
  });

  it("does not leave non-terminal status in active/ during complete (#2578)", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running", "atomic-complete.xbrief.json");
    const result = runTransition("complete", file);
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(root, "xbrief", "active", "atomic-complete.xbrief.json"))).toBe(false);
    const dest = join(root, "xbrief", "completed", "atomic-complete.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as { plan: { status: string } };
    expect(data.plan.status).toBe("completed");
  });

  it("fails active to completed with failed status", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running");
    const result = runTransition("fail", file);
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as { plan: { status: string } };
    expect(data.plan.status).toBe("failed");
  });

  it("blocks and unblocks in place", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running");
    expect(runTransition("block", file).ok).toBe(true);
    expect(runTransition("unblock", file).ok).toBe(true);
  });

  it("rejects invalid transition", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running");
    const result = runTransition("promote", file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Invalid transition");
  });

  it("rejects move when destination already exists (#2578)", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running", "dup.xbrief.json");
    writeVbrief(root, "completed", "completed", "dup.xbrief.json");
    const result = runTransition("complete", file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Target already exists");
    expect(existsSync(file)).toBe(true);
  });

  it("detects lifecycle folder", () => {
    expect(detectLifecycleFolder("/tmp/xbrief/pending/foo.xbrief.json")).toBe("pending");
    expect(detectLifecycleFolder("/tmp/other/foo.xbrief.json")).toBeNull();
  });

  it("rejects persist when post-mutation brief would be folder/status invalid (#2131)", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running", "invalid-persist.xbrief.json");
    const readResult = readBriefForMutation(file);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      return;
    }
    const data = readResult.data;
    const plan = data.plan as Record<string, unknown>;
    plan.status = "pending";
    plan.updated = "2026-06-01T12:00:00Z";
    const before = readFileSync(file, "utf8");
    const writeResult = atomicWriteBrief(file, data, join(root, "xbrief"));
    expect(writeResult.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("scope lifecycle projection containment (#2447)", () => {
  let root = "";
  let escapeDir = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    if (escapeDir.length > 0) {
      rmSync(escapeDir, { recursive: true, force: true });
      escapeDir = "";
    }
  });

  itSymlink(
    "refuses promote when the destination lifecycle folder is a symlink outside the project",
    () => {
      root = mkdtempSync(join(tmpdir(), "scope-symlink-dest-"));
      escapeDir = mkdtempSync(join(tmpdir(), "scope-symlink-escape-"));
      mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
      const escapePending = join(escapeDir, "pending");
      mkdirSync(escapePending, { recursive: true });
      symlinkSync(escapePending, join(root, "xbrief", "pending"));

      const file = writeVbrief(root, "proposed", "proposed");
      const result = runTransition("promote", file);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("projection write refused");
      expect(existsSync(file)).toBe(true);
      expect(existsSync(join(escapeDir, "story.xbrief.json"))).toBe(false);
      const unchanged = JSON.parse(readFileSync(file, "utf8")) as { plan: { status: string } };
      expect(unchanged.plan.status).toBe("proposed");
    },
  );

  itSymlink(
    "refuses complete when the destination lifecycle folder is a symlink outside the project",
    () => {
      root = mkdtempSync(join(tmpdir(), "scope-symlink-complete-"));
      escapeDir = mkdtempSync(join(tmpdir(), "scope-symlink-complete-escape-"));
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      const escapeCompleted = join(escapeDir, "completed");
      mkdirSync(escapeCompleted, { recursive: true });
      symlinkSync(escapeCompleted, join(root, "xbrief", "completed"));

      const file = writeVbrief(root, "active", "running", "complete-story.xbrief.json");
      const result = runTransition("complete", file);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("projection write refused");
      expect(existsSync(file)).toBe(true);
      expect(existsSync(join(escapeDir, "complete-story.xbrief.json"))).toBe(false);
      const unchanged = JSON.parse(readFileSync(file, "utf8")) as { plan: { status: string } };
      expect(unchanged.plan.status).toBe("running");
    },
  );
});
