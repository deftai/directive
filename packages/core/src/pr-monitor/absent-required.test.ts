import { describe, expect, it } from "vitest";
import {
  formatAbsentRequiredMessage,
  readAbsentRequiredContexts,
  shouldEscalateAbsentRequired,
} from "./absent-required.js";
import { ABSENT_REQUIRED_GRACE_POLLS } from "./constants.js";

function absentPayload(contexts: readonly string[]): Record<string, unknown> {
  return {
    via: "primary",
    merge_ready: false,
    failures: [
      `Required status-check contexts absent on HEAD (ci_absent_required): ${contexts.join(", ")}`,
    ],
    partial_data: {
      ci: {
        ready_state: "ci_absent_required",
        absent_required: [...contexts],
        pending_required: [],
      },
    },
  };
}

describe("readAbsentRequiredContexts", () => {
  it("reads #3234 ci_absent_required contexts", () => {
    expect(readAbsentRequiredContexts(absentPayload(["Greptile Review"]))).toEqual([
      "Greptile Review",
    ]);
  });

  it("returns null on first-class pending required runs", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        failures: ["waiting"],
        partial_data: {
          ci: {
            ready_state: "not_ready_yet",
            absent_required: [],
            pending_required: ["Greptile Review"],
          },
        },
      }),
    ).toBeNull();
  });

  it("does not treat pending_required as absent even if ready_state is absent", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        partial_data: {
          ci: {
            ready_state: "ci_absent_required",
            absent_required: ["Greptile Review"],
            pending_required: ["TypeScript (build + lint + test)"],
          },
        },
      }),
    ).toBeNull();
  });

  it("does not treat ci_failures as absent even when failures mention ci_absent_required", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        failures: [
          "Required status-check contexts absent on HEAD (ci_absent_required): Greptile Review",
          "CI failed",
        ],
        partial_data: {
          ci: {
            ready_state: "ci_failures",
            absent_required: ["Greptile Review"],
            pending_required: [],
          },
        },
      }),
    ).toBeNull();
  });

  it("falls back to failures when partial_data.ci is missing", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        failures: ["Required status-check contexts absent on HEAD (ci_absent_required): x"],
      }),
    ).toEqual([]);
  });

  it("returns empty contexts when ci_absent_required has a non-list absent_required", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        partial_data: {
          ci: {
            ready_state: "ci_absent_required",
            absent_required: "Greptile Review",
            pending_required: "nope",
          },
        },
      }),
    ).toEqual([]);
  });

  it("ignores non-object partial_data and ci wrappers", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        failures: "not-a-list",
        partial_data: [],
      }),
    ).toBeNull();
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        failures: ["other"],
        partial_data: { ci: ["not-an-object"] },
      }),
    ).toBeNull();
  });

  it("returns null when neither ci ready_state nor failure mentions absent", () => {
    expect(
      readAbsentRequiredContexts({
        via: "primary",
        merge_ready: false,
        failures: ["blocked"],
        partial_data: { ci: { ready_state: "blocked", absent_required: [] } },
      }),
    ).toBeNull();
  });
});

describe("shouldEscalateAbsentRequired", () => {
  it("does not escalate on the first-poll grace window", () => {
    expect(shouldEscalateAbsentRequired(ABSENT_REQUIRED_GRACE_POLLS)).toBe(false);
    expect(shouldEscalateAbsentRequired(1)).toBe(false);
  });

  it("escalates once consecutive polls pass the grace window", () => {
    expect(shouldEscalateAbsentRequired(ABSENT_REQUIRED_GRACE_POLLS + 1)).toBe(true);
    expect(shouldEscalateAbsentRequired(2)).toBe(true);
  });
});

describe("formatAbsentRequiredMessage", () => {
  it("names missing contexts", () => {
    expect(formatAbsentRequiredMessage(["Greptile Review", "terraform-plan"])).toBe(
      "ABSENT-REQUIRED: Greptile Review, terraform-plan",
    );
  });

  it("uses a distinct fallback when the context list is empty", () => {
    expect(formatAbsentRequiredMessage([])).toContain("ABSENT-REQUIRED");
  });
});
