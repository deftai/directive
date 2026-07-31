import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLifecycleStats,
  formatLifecycleStatsText,
  LIFECYCLE_STATS_SEMANTICS,
  parseDurationMs,
} from "./stats.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-stats-"));
  roots.push(root);
  return root;
}

function writeBrief(
  root: string,
  folder: string,
  name: string,
  opts: {
    status?: string;
    updated?: string;
    completedAt?: string;
  } = {},
): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const updated = opts.updated ?? "2026-07-30T12:00:00Z";
  const plan: Record<string, unknown> = {
    id: name.replace(/\.xbrief\.json$/, ""),
    title: name,
    status: opts.status ?? folder,
    updated,
    metadata: {},
  };
  if (opts.completedAt !== undefined) {
    (plan.metadata as Record<string, unknown>).completedAt = opts.completedAt;
  }
  if (folder === "active" && opts.status === undefined) {
    plan.status = "running";
  }
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "t", created: updated, updated },
      plan,
    }),
    "utf8",
  );
}

const NOW = new Date("2026-07-31T12:00:00Z");

describe("parseDurationMs (via stats)", () => {
  it("parses simple durations", () => {
    expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDurationMs("24h")).toBe(24 * 60 * 60 * 1000);
  });
});

describe("collectLifecycleStats", () => {
  it("returns zeros on empty project without xbrief tree", () => {
    const root = fixtureRoot();
    const stats = collectLifecycleStats({ projectRoot: root, since: "7d", now: NOW });
    expect(stats.promoted).toBe(0);
    expect(stats.activated).toBe(0);
    expect(stats.completed).toBe(0);
    expect(stats.cancelled_or_failed).toBe(0);
    expect(stats.still_active).toBe(0);
    expect(stats.folder_totals).toEqual({
      proposed: 0,
      pending: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
    });
    expect(stats.since).toBe("7d");
    expect(stats.semantics).toBe(LIFECYCLE_STATS_SEMANTICS);
  });

  it("counts WWYSYDH metrics with folder semantics and window", () => {
    const root = fixtureRoot();
    // In window (last 7d from 2026-07-31)
    writeBrief(root, "pending", "p-in.xbrief.json", {
      status: "pending",
      updated: "2026-07-28T10:00:00Z",
    });
    writeBrief(root, "active", "a-in.xbrief.json", {
      status: "running",
      updated: "2026-07-29T10:00:00Z",
    });
    writeBrief(root, "active", "a-old.xbrief.json", {
      status: "running",
      updated: "2026-07-01T10:00:00Z",
    });
    writeBrief(root, "completed", "c-in.xbrief.json", {
      status: "completed",
      updated: "2026-07-30T10:00:00Z",
      completedAt: "2026-07-30T11:00:00Z",
    });
    writeBrief(root, "completed", "f-in.xbrief.json", {
      status: "failed",
      updated: "2026-07-30T12:00:00Z",
      completedAt: "2026-07-30T12:00:00Z",
    });
    writeBrief(root, "cancelled", "x-in.xbrief.json", {
      status: "cancelled",
      updated: "2026-07-27T10:00:00Z",
    });
    // Outside window
    writeBrief(root, "pending", "p-old.xbrief.json", {
      status: "pending",
      updated: "2026-06-01T10:00:00Z",
    });
    writeBrief(root, "completed", "c-old.xbrief.json", {
      status: "completed",
      updated: "2026-06-15T10:00:00Z",
      completedAt: "2026-06-15T10:00:00Z",
    });
    writeBrief(root, "proposed", "prop.xbrief.json", {
      status: "proposed",
      updated: "2026-07-30T10:00:00Z",
    });

    const stats = collectLifecycleStats({ projectRoot: root, since: "7d", now: NOW });
    expect(stats.promoted).toBe(1); // p-in only
    expect(stats.activated).toBe(1); // a-in only
    expect(stats.completed).toBe(1); // c-in
    expect(stats.cancelled_or_failed).toBe(2); // f-in + x-in
    expect(stats.still_active).toBe(2); // a-in + a-old (snapshot)
    expect(stats.folder_totals).toEqual({
      proposed: 1,
      pending: 2,
      active: 2,
      completed: 3,
      cancelled: 1,
    });
    expect(stats.window_start).toBe("2026-07-24T12:00:00Z");
    expect(stats.as_of).toBe("2026-07-31T12:00:00Z");
  });

  it("prefers completedAt over plan.updated for terminal briefs", () => {
    const root = fixtureRoot();
    writeBrief(root, "completed", "stale-plan.xbrief.json", {
      status: "completed",
      updated: "2026-01-01T00:00:00Z",
      completedAt: "2026-07-30T00:00:00Z",
    });
    const stats = collectLifecycleStats({ projectRoot: root, since: "7d", now: NOW });
    expect(stats.completed).toBe(1);
  });

  it("skips unreadable / non-plan artifacts", () => {
    const root = fixtureRoot();
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.xbrief.json"), "{not-json", "utf8");
    writeFileSync(join(dir, "noplan.xbrief.json"), JSON.stringify({ xBRIEFInfo: {} }), "utf8");
    writeFileSync(join(dir, "readme.md"), "ignore", "utf8");
    writeBrief(root, "active", "ok.xbrief.json", {
      status: "running",
      updated: "2026-07-30T00:00:00Z",
    });
    const stats = collectLifecycleStats({ projectRoot: root, since: "7d", now: NOW });
    expect(stats.still_active).toBe(1);
    expect(stats.activated).toBe(1);
  });

  it("rejects invalid --since via parseDurationMs", () => {
    expect(() => parseDurationMs("not-a-duration")).toThrow(/invalid duration/);
  });
});

describe("formatLifecycleStatsText", () => {
  it("renders key metrics", () => {
    const root = fixtureRoot();
    writeBrief(root, "active", "a.xbrief.json", {
      status: "running",
      updated: "2026-07-30T00:00:00Z",
    });
    const stats = collectLifecycleStats({ projectRoot: root, since: "7d", now: NOW });
    const text = formatLifecycleStatsText(stats);
    expect(text).toContain("lifecycle:stats (since 7d");
    expect(text).toContain("activated: 1");
    expect(text).toContain("still_active: 1");
  });
});
