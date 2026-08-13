import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAcceptanceClauses,
  formatClauseWalkMessage,
  isScratchArtifactPath,
  readAcceptanceClauses,
  stampDerivedClausesOnAcceptance,
  walkAcceptanceClauses,
} from "./clauses.js";

const SKETCH = `
## Acceptance sketch

- A task statement with N testable constraints yields N recorded clauses at intake, before the first product edit.
- \`verify:ac\` output names each clause and its outcome; done reports lead with failed/unverifiable clauses.
- Run summary carries rung + clause count + outcomes.
- No change to rung 1 (#3267) or rung 3; no new command surface beyond the existing verify:ac.
`;

describe("deriveAcceptanceClauses (#3323)", () => {
  it("yields N clauses from N acceptance-sketch constraints", () => {
    const clauses = deriveAcceptanceClauses(SKETCH);
    expect(clauses).toHaveLength(4);
    expect(clauses.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(clauses[0]?.text).toMatch(/N recorded clauses/);
  });

  it("binds a file path and marks two-path clauses ambiguous", () => {
    const clauses = deriveAcceptanceClauses(`
## Acceptance Criteria
- Write the helper to packages/core/src/verify-ac/clauses.ts
- Emit to packages/core/src/run-summary/types.ts or packages/core/src/run-summary/emit.ts
`);
    expect(clauses).toHaveLength(2);
    expect(clauses[0]?.artifact_path).toBe("packages/core/src/verify-ac/clauses.ts");
    expect(clauses[0]?.ambiguous).toBe(false);
    expect(clauses[1]?.ambiguous).toBe(true);
    expect(clauses[1]?.readings).toHaveLength(2);
    expect(clauses[1]?.chosen_reading).toBe(0);
    expect(clauses[1]?.artifact_path).toBe("packages/core/src/run-summary/types.ts");
  });

  it("extracts Test: / AcceptanceCriteria: labeled prose when no list is present", () => {
    const clauses = deriveAcceptanceClauses(
      "Overview text.\nTest: CHANGELOG.md cites #3323\nAcceptanceCriteria: packages/core/src/verify-ac/clauses.ts exists\n",
    );
    expect(clauses).toHaveLength(2);
    expect(clauses[0]?.artifact_path).toBe("CHANGELOG.md");
    expect(clauses[1]?.artifact_path).toBe("packages/core/src/verify-ac/clauses.ts");
    const padded = deriveAcceptanceClauses(`Test:${" ".repeat(80)}CHANGELOG.md exists\n`);
    expect(padded).toHaveLength(1);
    expect(padded[0]?.artifact_path).toBe("CHANGELOG.md");
  });

  it("skips Relates meta lines and empty input", () => {
    expect(deriveAcceptanceClauses("")).toEqual([]);
    expect(
      deriveAcceptanceClauses("## Acceptance sketch\n- Relates #3267 (rung-1 mechanism)\n"),
    ).toEqual([]);
  });

  it("keeps later acceptance sections and comment-thread clauses", () => {
    const clauses = deriveAcceptanceClauses(`
## Acceptance Criteria
- First constraint binds packages/core/src/verify-ac/clauses.ts

## Acceptance sketch
- Second constraint binds packages/core/src/run-summary/types.ts

### Comment by @MScottAdams
AcceptanceCriteria: Third constraint binds CHANGELOG.md
`);
    expect(clauses.map((c) => c.artifact_path)).toEqual([
      "packages/core/src/verify-ac/clauses.ts",
      "packages/core/src/run-summary/types.ts",
      "CHANGELOG.md",
    ]);
  });

  it("falls back to Fix lists and path-bearing bullets", () => {
    const fromFix = deriveAcceptanceClauses(`
## Fix
1. Store the walk in packages/core/src/verify-ac/clauses.ts
`);
    expect(fromFix).toHaveLength(1);
    expect(fromFix[0]?.artifact_path).toBe("packages/core/src/verify-ac/clauses.ts");
    const fromBare = deriveAcceptanceClauses(
      "- Write CHANGELOG.md under Unreleased\n- Ignore this narrative sentence without a path\n",
    );
    expect(fromBare).toHaveLength(1);
    expect(fromBare[0]?.artifact_path).toBe("CHANGELOG.md");
  });
});

describe("stampDerivedClausesOnAcceptance (#3323)", () => {
  it("stamps clauses and derived rung when none_stated and commands are empty", () => {
    const { plan, clauses } = stampDerivedClausesOnAcceptance(
      {
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      SKETCH,
    );
    expect(clauses).toHaveLength(4);
    const acc = plan.acceptance as {
      source_rung: string;
      none_stated: boolean;
      clauses: unknown[];
    };
    expect(acc.none_stated).toBe(true);
    expect(acc.source_rung).toBe("derived");
    expect(acc.clauses).toHaveLength(4);
  });

  it("does not rewrite stated-command acceptance", () => {
    const input = {
      acceptance: {
        commands: [{ command: "pnpm test" }],
        none_stated: false,
        source_rung: "stated",
      },
    };
    const { plan, clauses } = stampDerivedClausesOnAcceptance(input, SKETCH);
    expect(clauses).toEqual([]);
    expect(plan.acceptance).toEqual(input.acceptance);
  });
});

describe("walkAcceptanceClauses (#3323)", () => {
  it("names verified / unverifiable / failed and leads the report with failed/unverifiable", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-walk-"));
    writeFileSync(join(root, "shipped.ts"), 'export const marker = "alpha";\n', "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: 'shipped.ts contains "alpha"',
          artifact_path: "shipped.ts",
          ambiguous: false,
        },
        {
          id: 2,
          text: "behavioral sharding scheme without a machine check",
          artifact_path: "shipped.ts",
          ambiguous: false,
        },
        {
          id: 3,
          text: "missing file must exist",
          artifact_path: "nope.ts",
          ambiguous: false,
        },
        {
          id: 4,
          text: "unbound constraint",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      root,
    );
    expect(report.clauses.map((c) => c.outcome)).toEqual([
      "verified",
      "unverifiable",
      "failed",
      "unverifiable",
    ]);
    expect(report.ok).toBe(false);
    expect(report.unverifiable).toHaveLength(2);
    expect(report.failed).toHaveLength(1);
    expect(report.message).toMatch(/^verify:ac clause walk \(#3323\):/);
    const failedAt = report.message.indexOf("[failed]");
    const unverifiableAt = report.message.indexOf("[unverifiable]");
    const verifiedAt = report.message.indexOf("[verified]");
    expect(failedAt).toBeGreaterThan(-1);
    expect(unverifiableAt).toBeGreaterThan(-1);
    expect(verifiedAt).toBeGreaterThan(unverifiableAt);
    expect(formatClauseWalkMessage(report)).toContain("clause 4");
  });

  it("fails a buffer/scratch path and verifies an existence claim on a shipped file", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-exist-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "out.ts"), "ok\n", "utf8");
    expect(isScratchArtifactPath(".deft-scratch/tmp/out.ts")).toBe(true);
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "artifact exists at src/out.ts",
          artifact_path: "src/out.ts",
          ambiguous: false,
        },
        {
          id: 2,
          text: "do not check a buffer",
          artifact_path: ".deft-scratch/buffer/out.ts",
          ambiguous: false,
        },
      ],
      root,
    );
    expect(report.clauses[0]?.outcome).toBe("verified");
    expect(report.clauses[1]?.outcome).toBe("failed");
    expect(report.clauses[1]?.detail).toMatch(/buffer\/scratch/);
  });

  it("inverts existence when the clause is negated", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-neg-"));
    writeFileSync(join(root, "present.ts"), "x\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "ghost.ts must not exist",
          artifact_path: "ghost.ts",
          ambiguous: false,
        },
        {
          id: 2,
          text: "present.ts must not exist",
          artifact_path: "present.ts",
          ambiguous: false,
        },
      ],
      root,
    );
    expect(report.clauses[0]?.outcome).toBe("verified");
    expect(report.clauses[1]?.outcome).toBe("failed");
    expect(report.clauses[1]?.detail).toMatch(/requires absence/);
  });

  it("round-trips serialized clauses including chosen ambiguous reading", () => {
    const derived = deriveAcceptanceClauses(`
## Acceptance Criteria
- Land the stamp in packages/core/src/run-summary/types.ts or packages/core/src/run-summary/emit.ts
`);
    const read = readAcceptanceClauses({ clauses: derived });
    expect(read).toHaveLength(1);
    expect(read[0]?.ambiguous).toBe(true);
    expect(read[0]?.artifact_path).toBe("packages/core/src/run-summary/types.ts");
  });

  it("fails escaped paths, directories, missing tokens, and empty artifact strings", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-edges-"));
    mkdirSync(join(root, "dir"), { recursive: true });
    writeFileSync(join(root, "shipped.ts"), "only-alpha\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: 'shipped.ts contains "missing-token"',
          artifact_path: "shipped.ts",
          ambiguous: false,
        },
        {
          id: 2,
          text: "dir is a folder not a file",
          artifact_path: "dir",
          ambiguous: false,
        },
        {
          id: 3,
          text: "escape the project",
          artifact_path: "../outside.ts",
          ambiguous: false,
        },
        { id: 4, text: "blank path", artifact_path: "   ", ambiguous: false },
      ],
      root,
    );
    expect(report.clauses.map((c) => c.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
      "unverifiable",
    ]);
    expect(report.clauses[0]?.detail).toMatch(/missing/);
    expect(report.clauses[1]?.detail).toMatch(/not a shipped file/);
    expect(report.clauses[2]?.detail).toMatch(/escaped/);
  });

  it("covers stamp and read edges", () => {
    expect(stampDerivedClausesOnAcceptance({ title: "x" }, SKETCH).clauses).toEqual([]);
    expect(
      stampDerivedClausesOnAcceptance(
        { acceptance: { commands: [], none_stated: true, source_rung: "project_floor" } },
        "no extractable clauses here",
      ).clauses,
    ).toEqual([]);
    expect(readAcceptanceClauses(null)).toEqual([]);
    expect(readAcceptanceClauses({ clauses: "nope" })).toEqual([]);
    expect(
      readAcceptanceClauses({
        clauses: [
          { text: "  ", artifact_path: "x.ts" },
          {
            id: 7,
            text: "camel path",
            artifactPath: "src/out.ts",
            ambiguous: true,
            chosenReading: 0,
            readings: [{ text: "camel path [reading: src/out.ts]", artifactPath: "src/out.ts" }],
          },
        ],
      })[0]?.artifact_path,
    ).toBe("src/out.ts");
  });
});
