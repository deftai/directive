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
import { detectLifecycleFolder, runTransition } from "./transition.js";
import { formatVbriefJson } from "./vbrief-json.js";

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
    vBRIEFInfo: { version: "0.5" },
    plan: { title: "T", status, items: [] },
  });
  return path;
}

function writeFile(path: string, data: unknown): void {
  writeFileSync(path, formatVbriefJson(data), "utf8");
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

  it("completes active to completed with stamp", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running");
    const result = runTransition("complete", file);
    expect(result.ok).toBe(true);
    const dest = join(root, "xbrief", "completed", "story.xbrief.json");
    const data = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { metadata: { completedAt: string } };
    };
    expect(data.plan.metadata.completedAt).toMatch(/Z$/);
  });

  it("fails active to completed with failed status", () => {
    root = makeRepo();
    const file = writeVbrief(root, "active", "running");
    const result = runTransition("fail", file);
    expect(result.ok).toBe(true);
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

  it("detects lifecycle folder", () => {
    expect(detectLifecycleFolder("/tmp/xbrief/pending/foo.xbrief.json")).toBe("pending");
    expect(detectLifecycleFolder("/tmp/other/foo.xbrief.json")).toBeNull();
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
