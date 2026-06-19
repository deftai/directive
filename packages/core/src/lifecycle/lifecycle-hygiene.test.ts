import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPACITY_COLDSTART_NUDGE_ID,
  DEFAULT_ACTOR,
  detectCapacityColdstartNudge,
  detectLifecycleNudges,
  EPIC_STALENESS_DAYS_DEFAULT,
  EPIC_STRANDED_DAYS_DEFAULT,
  loadAcceptedDebtKeys,
  recordTechDebtAcceptance,
  resolveEpicThresholds,
  TIER_STALE_EPIC,
  TIER_STRANDED,
} from "./lifecycle-hygiene.js";

const NOW = new Date("2026-06-05T12:00:00.000Z");

function isoBefore(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.toISOString().slice(0, 19)}Z`;
}

function seedEpic(
  root: string,
  folder: string,
  slug: string,
  options: {
    updated: string;
    status?: string;
    kind?: string;
    children?: string[];
  },
): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  const refs = (options.children ?? []).map((uri) => ({
    type: "x-vbrief/plan",
    uri,
    TrustLevel: "internal",
  }));
  writeFileSync(
    join(dir, `${slug}.vbrief.json`),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: slug,
        status: options.status ?? "running",
        updated: options.updated,
        metadata: { kind: options.kind ?? "epic" },
        references: refs,
      },
    }),
    "utf8",
  );
}

function seedChild(
  root: string,
  folder: string,
  slug: string,
  status: string,
  updated: string,
): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.vbrief.json`),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: slug, status, updated },
    }),
    "utf8",
  );
}

function seedStrandedEpic(root: string, ageDays = 60): void {
  const stamp = isoBefore(ageDays);
  seedChild(root, "completed", "2026-01-01-slice-done", "completed", stamp);
  seedChild(root, "active", "2026-01-01-slice-todo", "running", stamp);
  seedEpic(root, "active", "2026-01-01-epic-stranded", {
    updated: stamp,
    children: [
      "completed/2026-01-01-slice-done.vbrief.json",
      "active/2026-01-01-slice-todo.vbrief.json",
    ],
  });
}

function capacityPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unit: "vbrief-count",
    window: 30,
    enforcement: "advise",
    minSampleSize: 5,
    defaultBucket: "feature",
    buckets: [
      { id: "debt", target: 0.4 },
      { id: "feature", target: 0.6 },
    ],
    ...overrides,
  };
}

function seedCapacityProject(root: string, capacity: Record<string, unknown> | null): void {
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
  const plan: Record<string, unknown> = {
    title: "Capacity test",
    status: "running",
    items: [],
  };
  if (capacity !== null) {
    plan.policy = { capacityAllocation: capacity };
  }
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }),
    "utf8",
  );
}

function writeCompleted(root: string, name: string, metadata: Record<string, unknown>): void {
  writeFileSync(
    join(root, "vbrief", "completed", `${name}.vbrief.json`),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: name, status: "completed", items: [], metadata },
    }),
    "utf8",
  );
}

describe("lifecycle hygiene", () => {
  it("fires stranded trichotomy for dormant partial epic", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-stranded-"));
    seedStrandedEpic(root, 45);
    const nudges = detectLifecycleNudges(root, { now: NOW });
    expect(nudges).toHaveLength(1);
    const nudge = nudges[0] as NonNullable<(typeof nudges)[0]>;
    expect(nudge.kind).toBe("stranded");
    expect(nudge.tier).toBe(TIER_STRANDED);
    expect(nudge.completedChildren).toBe(1);
    expect(nudge.totalChildren).toBe(2);
    expect(nudge.message).toBe(
      '[TIER-1] stranded slice: epic "2026-01-01-epic-stranded" dormant 45d (> epicStrandedDays 30) with 1/2 children completed -- finish | cancel-and-remove | accept-as-tech-debt (see `task capacity:show`)',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fire stranded within threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-no-stranded-"));
    seedStrandedEpic(root, 10);
    expect(detectLifecycleNudges(root, { now: NOW })).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fire stranded without completed child", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-none-done-"));
    const stamp = isoBefore(60);
    seedChild(root, "active", "2026-01-01-a", "running", stamp);
    seedChild(root, "active", "2026-01-01-b", "running", stamp);
    seedEpic(root, "active", "2026-01-01-epic-none-done", {
      updated: stamp,
      children: ["active/2026-01-01-a.vbrief.json", "active/2026-01-01-b.vbrief.json"],
    });
    expect(detectLifecycleNudges(root, { now: NOW })).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("fires stale epic nudge for undecomposed epic", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-stale-"));
    seedEpic(root, "pending", "2026-01-01-epic-undecomposed", {
      updated: isoBefore(30),
      status: "pending",
    });
    const nudges = detectLifecycleNudges(root, { now: NOW });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.kind).toBe("stale-epic");
    expect(nudges[0]?.tier).toBe(TIER_STALE_EPIC);
    expect(nudges[0]?.message).toBe(
      '[TIER-2] stale epic: undecomposed epic "2026-01-01-epic-undecomposed" dormant 30d (> epicStalenessDays 14) -- needs estimation/decomposition',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fire stale epic within threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-fresh-"));
    seedEpic(root, "pending", "2026-01-01-fresh-epic", {
      updated: isoBefore(5),
      status: "pending",
    });
    expect(detectLifecycleNudges(root, { now: NOW })).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("never nudges completed epic", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-done-"));
    const stamp = isoBefore(60);
    seedChild(root, "completed", "2026-01-01-c1", "completed", stamp);
    seedEpic(root, "completed", "2026-01-01-epic-done", {
      updated: stamp,
      status: "completed",
      children: ["completed/2026-01-01-c1.vbrief.json"],
    });
    expect(detectLifecycleNudges(root, { now: NOW })).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("records tech debt acceptance and stops re-nudging", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-debt-"));
    seedStrandedEpic(root, 45);
    const first = detectLifecycleNudges(root, { now: NOW });
    expect(first).toHaveLength(1);
    const epicId = first[0]?.nudgeId as string;
    const followUp = "proposed/2026-06-05-tech-debt-epic-stranded.vbrief.json";
    const ledger = recordTechDebtAcceptance(root, epicId, { followUpRef: followUp });
    const record = JSON.parse(readFileSync(ledger, "utf8").trim()) as Record<string, unknown>;
    expect(record.epic).toBe(epicId);
    expect(record.follow_up_ref).toBe(followUp);
    expect(record.actor).toBe(DEFAULT_ACTOR);
    expect(detectLifecycleNudges(root, { now: NOW })).toEqual([]);
    expect(loadAcceptedDebtKeys(root).has(epicId)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects empty follow-up ref", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-bad-ref-"));
    expect(() =>
      recordTechDebtAcceptance(root, "2026-01-01-epic.vbrief.json", { followUpRef: "  " }),
    ).toThrow("follow_up_ref must be a non-empty reference string");
    rmSync(root, { recursive: true, force: true });
  });

  it("reads thresholds from capacityAllocation", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-thresh-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          policy: {
            capacityAllocation: { epicStrandedDays: 7, epicStalenessDays: 3 },
          },
        },
      }),
      "utf8",
    );
    const thresholds = resolveEpicThresholds(root);
    expect(thresholds.strandedDays).toBe(7);
    expect(thresholds.stalenessDays).toBe(3);
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults thresholds when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-default-thresh-"));
    const thresholds = resolveEpicThresholds(root);
    expect(thresholds.strandedDays).toBe(EPIC_STRANDED_DAYS_DEFAULT);
    expect(thresholds.stalenessDays).toBe(EPIC_STALENESS_DAYS_DEFAULT);
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores non-positive threshold overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-bad-thresh-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          policy: {
            capacityAllocation: { epicStrandedDays: true, epicStalenessDays: -1 },
          },
        },
      }),
      "utf8",
    );
    const thresholds = resolveEpicThresholds(root);
    expect(thresholds.strandedDays).toBe(EPIC_STRANDED_DAYS_DEFAULT);
    expect(thresholds.stalenessDays).toBe(EPIC_STALENESS_DAYS_DEFAULT);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects empty epic name for tech debt", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-empty-epic-"));
    expect(() => recordTechDebtAcceptance(root, "  ", { followUpRef: "issue-1" })).toThrow(
      /non-empty/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to stale epic when all child refs missing", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-ghost-"));
    seedEpic(root, "active", "2026-01-01-epic-orphan-refs", {
      updated: isoBefore(40),
      children: [
        "completed/2026-01-01-ghost-a.vbrief.json",
        "active/2026-01-01-ghost-b.vbrief.json",
      ],
    });
    const nudges = detectLifecycleNudges(root, { now: NOW });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.kind).toBe("stale-epic");
    rmSync(root, { recursive: true, force: true });
  });

  it("fires capacity coldstart nudge when configured and unclassified", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-cold-"));
    seedCapacityProject(root, capacityPolicy({ minSampleSize: 5 }));
    for (let i = 0; i < 3; i += 1) {
      writeCompleted(root, `c${i}`, { completedAt: isoBefore(3) });
    }
    const nudge = detectCapacityColdstartNudge(root, { now: NOW });
    expect(nudge).not.toBeNull();
    expect(nudge?.nudgeId).toBe(CAPACITY_COLDSTART_NUDGE_ID);
    expect(nudge?.message).toBe(
      "[TIER-3] capacity cold-start: 3 completed vBRIEF(s) unclassified (classified 0/5 in window) -- run `task capacity:backfill --apply` to classify history and activate capacity accounting (#1606)",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("suppresses capacity coldstart when unconfigured", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-no-cap-"));
    seedCapacityProject(root, null);
    writeCompleted(root, "c", { completedAt: isoBefore(3) });
    expect(detectCapacityColdstartNudge(root, { now: NOW })).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("suppresses capacity coldstart when already classified", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-classified-"));
    seedCapacityProject(root, capacityPolicy({ minSampleSize: 2 }));
    for (let i = 0; i < 3; i += 1) {
      writeCompleted(root, `c${i}`, {
        completedAt: isoBefore(3),
        capacityBucket: "feature",
      });
    }
    expect(detectCapacityColdstartNudge(root, { now: NOW })).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("includes capacity coldstart in detectLifecycleNudges ranking", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-mixed-"));
    seedCapacityProject(root, capacityPolicy({ minSampleSize: 5 }));
    writeCompleted(root, "cold", { completedAt: isoBefore(3) });
    seedEpic(root, "pending", "2026-01-01-epic-stale", {
      updated: isoBefore(40),
      status: "pending",
    });
    const nudges = detectLifecycleNudges(root, { now: NOW });
    expect(nudges.some((n) => n.kind === "capacity-coldstart")).toBe(true);
    expect(nudges.some((n) => n.kind === "stale-epic")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects empty epic key for tech debt acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-empty-epic-"));
    expect(() =>
      recordTechDebtAcceptance(root, "  ", { followUpRef: "proposed/foo.vbrief.json" }),
    ).toThrow("epic must be a non-empty basename or path");
    rmSync(root, { recursive: true, force: true });
  });

  it("uses folder fallback status for completed child", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-folder-status-"));
    const stamp = isoBefore(45);
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "completed", "2026-01-01-slice-done.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "done", updated: stamp },
      }),
      "utf8",
    );
    seedChild(root, "active", "2026-01-01-slice-todo", "running", stamp);
    seedEpic(root, "active", "2026-01-01-epic-stranded", {
      updated: stamp,
      children: [
        "completed/2026-01-01-slice-done.vbrief.json",
        "active/2026-01-01-slice-todo.vbrief.json",
      ],
    });
    expect(detectLifecycleNudges(root, { now: NOW })).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips malformed vbrief files", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-malformed-"));
    const dir = join(root, "vbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.vbrief.json"), "{not json", "utf8");
    writeFileSync(join(dir, "no-plan.vbrief.json"), JSON.stringify({ vBRIEFInfo: {} }), "utf8");
    expect(detectLifecycleNudges(root, { now: NOW })).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("loadAcceptedDebtKeys skips corrupt ledger lines", () => {
    const root = mkdtempSync(join(tmpdir(), "lh-ledger-"));
    const ledger = join(root, "vbrief", ".audit", "epic-tech-debt-accepted.jsonl");
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      '{"epic":"good.vbrief.json","follow_up_ref":"issue-1","accepted_at":"2026-01-01T00:00:00Z","actor":"test"}\n{bad json\n',
      "utf8",
    );
    expect(loadAcceptedDebtKeys(root)).toEqual(new Set(["good.vbrief.json"]));
    rmSync(root, { recursive: true, force: true });
  });
});
