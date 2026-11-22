/**
 * Spec-path harvest check that does not depend on a slice label (#7001 item 5).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readSpecPathLeanStructure,
  SPEC_PATH_EMPTY_BOUND_REMEDY_REASON,
  specPathLeanHarvestRefusal,
} from "./spec-path-harvest-check.js";

const LEAN_6904 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/lean-6904-7070710091.md"),
  "utf8",
);
// Synthetic GitHub PAT-shaped token: the quarantine scanner hard-fails on it.
const SECRET = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;

function lean(sections: string): string {
  return `**Lean:** bind.\n\nSpec-path: Bound remedy on this lean\n\n${sections}`;
}

describe("specPathLeanHarvestRefusal (#7001)", () => {
  it("passes a clean lean and the #6904 lean shape with indented sub-items", () => {
    expect(
      specPathLeanHarvestRefusal(
        lean("## Bound remedy\n1. Limb.\n\n## Acceptance Criteria\n- Given x, then y.\n"),
      ),
    ).toBeNull();
    expect(specPathLeanHarvestRefusal(LEAN_6904)).toBeNull();
  });

  it("refuses an empty Bound remedy list", () => {
    expect(specPathLeanHarvestRefusal(lean("## Acceptance Criteria\n- Given x, then y.\n"))).toBe(
      SPEC_PATH_EMPTY_BOUND_REMEDY_REASON,
    );
  });

  it("refuses a Slices section error, an out-of-range reference and a reference assigned twice", () => {
    const base = "## Bound remedy\n1. Limb one.\n2. Limb two.\n\n";
    expect(specPathLeanHarvestRefusal(lean(`${base}## Slices\n- bad line\n`))).toContain(
      "cited lean Slices section:",
    );
    expect(specPathLeanHarvestRefusal(lean(`${base}## Slices\n- slice-a: B9\n`))).toBe(
      "cited lean Slices section: slice 'slice-a' names B9, which is not a harvested item",
    );
    expect(
      specPathLeanHarvestRefusal(lean(`${base}## Slices\n- slice-a: B1\n- slice-b: B1\n`)),
    ).toBe("cited lean Slices section: B1 is assigned to both 'slice-a' and 'slice-b'");
  });

  it("does not refuse a lean whose items all belong to slices (that refusal stays at ingest)", () => {
    expect(
      specPathLeanHarvestRefusal(
        lean("## Bound remedy\n1. Limb one.\n2. Limb two.\n\n## Slices\n- slice-a: B1, B2\n"),
      ),
    ).toBeNull();
  });

  it("refuses a credential hard-fail in a harvested item, including folded continuation text", () => {
    expect(specPathLeanHarvestRefusal(lean(`## Bound remedy\n1. Use ${SECRET}.\n`))).toBe(
      "quarantine scanner hard-fail on a harvested lean item",
    );
    expect(
      specPathLeanHarvestRefusal(lean(`## Bound remedy\n1. Limb.\n   token ${SECRET}\n`)),
    ).toBe("quarantine scanner hard-fail on a harvested lean item");
  });

  it("refuses a credential hard-fail in the section text outside the items", () => {
    expect(specPathLeanHarvestRefusal(lean(`## Bound remedy\n1. Limb.\n\nNote ${SECRET}\n`))).toBe(
      "quarantine scanner hard-fail on the cited lean's Bound remedy text",
    );
    expect(
      specPathLeanHarvestRefusal(
        lean(`## Bound remedy\n1. Limb.\n\n## Acceptance Criteria\n- Given x.\n\nNote ${SECRET}\n`),
      ),
    ).toBe("quarantine scanner hard-fail on the cited lean's Acceptance Criteria text");
  });

  it("refuses a credential hard-fail only under Reject, with clean lists", () => {
    expect(
      specPathLeanHarvestRefusal(
        lean(`## Bound remedy\n1. Limb.\n\n## Reject\n- Paste ${SECRET} into the config.\n`),
      ),
    ).toBe("quarantine scanner hard-fail on the cited lean's Reject / Not proposed lines");
  });
});

describe("readSpecPathLeanStructure (#7001)", () => {
  it("reads the #6904 lean with item 8 carrying sub-items (a) to (f)", () => {
    const structure = readSpecPathLeanStructure(LEAN_6904);
    expect(structure.boundRows).toHaveLength(8);
    expect(structure.acceptanceRows).toHaveLength(10);
    const item8 = structure.boundRows[7]?.title ?? "";
    expect(item8.startsWith("Tests. None needs a built `dist` worker. (a) Through the seam")).toBe(
      true,
    );
    for (const marker of ["(a)", "(b)", "(c)", "(d)", "(e)", "(f)"]) {
      expect(item8).toContain(` ${marker} `);
    }
    expect(structure.constraintLines).toHaveLength(3);
  });
});
