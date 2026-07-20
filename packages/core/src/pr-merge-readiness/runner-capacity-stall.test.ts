import { describe, expect, it } from "vitest";
import {
  classifyCapacityStalledRequired,
  DEFAULT_CAPACITY_STALL_MS,
  isRunnerCapacityStalled,
} from "./runner-capacity-stall.js";

const NOW = Date.parse("2026-07-20T20:00:00.000Z");

describe("isRunnerCapacityStalled (#2672)", () => {
  it("is true for queued check past budget with no started_at", () => {
    expect(
      isRunnerCapacityStalled(
        {
          name: "TypeScript (build + lint + test)",
          status: "queued",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS - 1000).toISOString(),
          started_at: null,
        },
        { nowMs: NOW },
      ),
    ).toBe(true);
  });

  it("is false when still under the stall budget", () => {
    expect(
      isRunnerCapacityStalled(
        {
          name: "TypeScript (build + lint + test)",
          status: "queued",
          created_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
          started_at: null,
        },
        { nowMs: NOW },
      ),
    ).toBe(false);
  });

  it("is false for in_progress even past budget (#2652 no execution failover)", () => {
    expect(
      isRunnerCapacityStalled(
        {
          name: "TypeScript (build + lint + test)",
          status: "in_progress",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS * 2).toISOString(),
          started_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS).toISOString(),
        },
        { nowMs: NOW },
      ),
    ).toBe(false);
  });

  it("is false when queued but started_at is set (runner claimed)", () => {
    expect(
      isRunnerCapacityStalled(
        {
          name: "TypeScript (build + lint + test)",
          status: "queued",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS * 2).toISOString(),
          started_at: new Date(NOW - 1000).toISOString(),
        },
        { nowMs: NOW },
      ),
    ).toBe(false);
  });

  it("is false without created_at (cannot measure budget)", () => {
    expect(
      isRunnerCapacityStalled(
        {
          name: "TypeScript (build + lint + test)",
          status: "queued",
          created_at: null,
          started_at: null,
        },
        { nowMs: NOW },
      ),
    ).toBe(false);
  });
});

describe("classifyCapacityStalledRequired (#2672)", () => {
  it("returns only stalled names", () => {
    const stalled = classifyCapacityStalledRequired(
      [
        {
          name: "TypeScript (build + lint + test)",
          status: "queued",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS - 1).toISOString(),
          started_at: null,
        },
        {
          name: "Go (test + build)",
          status: "in_progress",
          created_at: new Date(NOW - DEFAULT_CAPACITY_STALL_MS * 2).toISOString(),
          started_at: new Date(NOW - 60_000).toISOString(),
        },
      ],
      { nowMs: NOW },
    );
    expect(stalled).toEqual(["TypeScript (build + lint + test)"]);
  });
});
