/**
 * Prefer-A Bound tip pins for #3729 (lifetime, mutation-surface matrix, two-axis).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_RITUAL_STALENESS_HOURS } from "../policy/index.js";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyWriteGate,
  formatOccupancyRemediation,
  OCCUPANCY_ADVISORY_COORDINATION_PREFACE,
  OCCUPANCY_FREE_TREE_SELECTION,
  OCCUPANCY_MUTATION_SURFACE_MATRIX,
  OCCUPANCY_PINNED_RITUAL_STALENESS_HOURS,
  OCCUPANCY_TTL_MS,
  OCCUPANCY_TWO_AXIS_POLICY_RATIONALE,
  OCCUPANCY_UNKNOWN_IDENTITY_POLICY,
  OCCUPANCY_UNKNOWN_LEASE_POLICY,
  OCCUPANCY_VS_RITUAL_LIFETIME_RATIONALE,
  OCCUPANCY_VS_RITUAL_TTL_RATIO,
  readOccupancy,
} from "./occupancy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../");

function tipSource(relpath: string): string {
  return readFileSync(resolve(REPO_ROOT, relpath), "utf8");
}

describe("occupancy Prefer-A Bound (#3729)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  it("pins lease-versus-ritual lifetime at tip 20m vs 8h (24:1) with rationale", () => {
    expect(OCCUPANCY_TTL_MS).toBe(20 * 60 * 1000);
    expect(OCCUPANCY_PINNED_RITUAL_STALENESS_HOURS).toBe(8);
    expect(DEFAULT_SESSION_RITUAL_STALENESS_HOURS).toBe(OCCUPANCY_PINNED_RITUAL_STALENESS_HOURS);
    expect(OCCUPANCY_VS_RITUAL_TTL_RATIO).toBe(24);
    expect((DEFAULT_SESSION_RITUAL_STALENESS_HOURS * 60 * 60 * 1000) / OCCUPANCY_TTL_MS).toBe(
      OCCUPANCY_VS_RITUAL_TTL_RATIO,
    );
    expect(OCCUPANCY_VS_RITUAL_LIFETIME_RATIONALE).toMatch(/24:1/);
    expect(OCCUPANCY_VS_RITUAL_LIFETIME_RATIONALE).toMatch(/advisory coordination/i);
    // Prefer-A: do not restate Recut body 4h / 12:1 as the tip pin.
    expect(OCCUPANCY_PINNED_RITUAL_STALENESS_HOURS).not.toBe(4);
    expect(OCCUPANCY_VS_RITUAL_TTL_RATIO).not.toBe(12);
  });

  it("asserts the mutation-surface matrix against tip dispatcher call sites", () => {
    expect(OCCUPANCY_MUTATION_SURFACE_MATRIX.map((row) => row.surface)).toEqual([
      "hook-gated-tool-writes",
      "spawn-tools",
      "shell-dest-forms",
      "push-merge-runtime-authority",
    ]);
    for (const row of OCCUPANCY_MUTATION_SURFACE_MATRIX) {
      const source = tipSource(row.tipRelpath);
      for (const marker of row.tipMarkers) {
        expect(source, `${row.surface} missing tip marker ${JSON.stringify(marker)}`).toContain(
          marker,
        );
      }
    }
    const writeGate = OCCUPANCY_MUTATION_SURFACE_MATRIX.find(
      (row) => row.surface === "hook-gated-tool-writes",
    );
    const spawnTools = OCCUPANCY_MUTATION_SURFACE_MATRIX.find(
      (row) => row.surface === "spawn-tools",
    );
    const shellDest = OCCUPANCY_MUTATION_SURFACE_MATRIX.find(
      (row) => row.surface === "shell-dest-forms",
    );
    const pushMerge = OCCUPANCY_MUTATION_SURFACE_MATRIX.find(
      (row) => row.surface === "push-merge-runtime-authority",
    );
    expect(writeGate?.consult).toBe("write-gate");
    expect(spawnTools?.consult).toBe("dest-consult-or-hard-coded-allow");
    expect(shellDest?.consult).toBe("opt-in-shellDestForms-enforce");
    expect(pushMerge?.consult).toBe("not-consulted");
    // Push/merge tipMarkers must resolve to live dispatcher code (not comment-only).
    const dispatcher = tipSource("packages/core/src/hooks/dispatcher.ts");
    for (const marker of pushMerge?.tipMarkers ?? []) {
      const idx = dispatcher.indexOf(marker);
      expect(idx, `missing live marker ${JSON.stringify(marker)}`).toBeGreaterThanOrEqual(0);
      const lineStart = dispatcher.lastIndexOf("\n", idx) + 1;
      const lineEnd = dispatcher.indexOf("\n", idx);
      const line = dispatcher.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trimStart();
      expect(line.startsWith("//") || line.startsWith("*")).toBe(false);
    }
    // A matrix confined to evaluateOccupancyWriteGate alone does not discharge AC2.
    expect(
      OCCUPANCY_MUTATION_SURFACE_MATRIX.some((row) => row.surface !== "hook-gated-tool-writes"),
    ).toBe(true);
  });

  it("states two-axis policy and selects documented fail-open (not auto-claim)", () => {
    expect(OCCUPANCY_UNKNOWN_LEASE_POLICY).toBe("fail-open");
    expect(OCCUPANCY_UNKNOWN_IDENTITY_POLICY).toBe("fail-closed");
    expect(OCCUPANCY_FREE_TREE_SELECTION).toBe("documented-fail-open");
    expect(OCCUPANCY_TWO_AXIS_POLICY_RATIONALE).toMatch(/fails? open/i);
    expect(OCCUPANCY_TWO_AXIS_POLICY_RATIONALE).toMatch(/fails? closed/i);
    expect(OCCUPANCY_FREE_TREE_SELECTION).not.toBe("auto-claim");

    const freeRoot = mkdtempSync(join(tmpdir(), "occ-3729-free-"));
    temps.push(freeRoot);
    const freeTree = evaluateOccupancyWriteGate(freeRoot, {
      sessionId: "stranger-on-free-tree",
      now: new Date("2026-10-04T00:00:00Z"),
    });
    expect(freeTree.allow).toBe(true);
    expect(freeTree.occupant).toBeNull();
    expect(freeTree.admitted).toBeNull();

    const heldRoot = mkdtempSync(join(tmpdir(), "occ-3729-held-"));
    temps.push(heldRoot);
    applyWorktreeOccupancy(heldRoot, {
      sessionId: "owner-a",
      intent: "mutation",
      now: new Date("2026-10-04T00:00:00Z"),
    });
    const stranger = evaluateOccupancyWriteGate(heldRoot, {
      sessionId: "stranger-b",
      now: new Date("2026-10-04T00:01:00Z"),
    });
    expect(stranger.allow).toBe(false);
    expect(stranger.occupant?.sessionId).toBe("owner-a");
  });

  it("keeps advisory coordination language on stranger remediation", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-3729-rem-"));
    temps.push(root);
    applyWorktreeOccupancy(root, {
      sessionId: "owner-a",
      intent: "mutation",
      now: new Date("2026-10-04T00:00:00Z"),
    });
    const record = readOccupancy(root);
    expect(record).not.toBeNull();
    const message = formatOccupancyRemediation(record!, new Date("2026-10-04T00:05:00Z"), "other");
    expect(message.startsWith(OCCUPANCY_ADVISORY_COORDINATION_PREFACE)).toBe(true);
    expect(message).toContain("Use another worktree");
    expect(OCCUPANCY_ADVISORY_COORDINATION_PREFACE).toMatch(/advisory coordination/i);
    expect(OCCUPANCY_ADVISORY_COORDINATION_PREFACE).toMatch(/not same-user authorization/i);
  });
});
