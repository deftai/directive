import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindClausesToDeclaredScope,
  collectPlanItemAcceptanceSurface,
  countAdjudicableClauses,
  countUnverifiedAdjudicableClauses,
  deriveAcceptanceClauses,
  formatClauseWalkMessage,
  isDeclaredArtifactPath,
  isScratchArtifactPath,
  readAcceptanceClauses,
  serializeAcceptanceClauses,
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

  // #3835 changed this pair: a path named in prose is no longer the clause's
  // binding, and a two-path line is no longer ambiguous, because neither path is
  // selected. Ambiguity survives only on clauses a brief stored explicitly.
  it("derives a clause per constraint and binds no path from the prose", () => {
    const clauses = deriveAcceptanceClauses(`
## Acceptance Criteria
- Write the helper to packages/core/src/verify-ac/clauses.ts
- Emit to packages/core/src/run-summary/types.ts or packages/core/src/run-summary/emit.ts
`);
    expect(clauses).toHaveLength(2);
    expect(clauses.map((c) => c.artifact_path)).toEqual([null, null]);
    expect(clauses.map((c) => c.ambiguous)).toEqual([false, false]);
    expect(clauses[1]?.readings).toBeUndefined();
  });

  it("extracts Test: / AcceptanceCriteria: labeled prose when no list is present", () => {
    const clauses = deriveAcceptanceClauses(
      "Overview text.\nTest: CHANGELOG.md cites #3323\nAcceptanceCriteria: packages/core/src/verify-ac/clauses.ts exists\n",
    );
    expect(clauses.map((c) => c.text)).toEqual([
      "CHANGELOG.md cites #3323",
      "packages/core/src/verify-ac/clauses.ts exists",
    ]);
    const padded = deriveAcceptanceClauses(`Test:${" ".repeat(80)}CHANGELOG.md exists\n`);
    expect(padded).toHaveLength(1);
    expect(padded[0]?.text).toBe("CHANGELOG.md exists");
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
    expect(clauses.map((c) => c.text)).toEqual([
      "First constraint binds packages/core/src/verify-ac/clauses.ts",
      "Second constraint binds packages/core/src/run-summary/types.ts",
      "Third constraint binds CHANGELOG.md",
    ]);
  });

  it("falls back to Fix lists and path-bearing bullets", () => {
    const fromFix = deriveAcceptanceClauses(`
## Fix
1. Store the walk in packages/core/src/verify-ac/clauses.ts
`);
    expect(fromFix).toHaveLength(1);
    expect(fromFix[0]?.text).toBe("Store the walk in packages/core/src/verify-ac/clauses.ts");
    // A path token still *selects* which bullet is a clause on the fallback
    // branch; #3835 stops it from becoming that clause's binding.
    const fromBare = deriveAcceptanceClauses(
      "- Write CHANGELOG.md under Unreleased\n- Ignore this narrative sentence without a path\n",
    );
    expect(fromBare).toHaveLength(1);
    expect(fromBare[0]?.text).toBe("Write CHANGELOG.md under Unreleased");
    expect(fromBare[0]?.artifact_path).toBeNull();
  });
});

describe("bindClausesToDeclaredScope (#4008)", () => {
  const declared = ["src/ui/ledger-table/useDensity.ts", "src/ui/ledger-table/useTableKeyboard.ts"];

  it("binds a clause to the exact file_scope member named in the text", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Add src/ui/ledger-table/useDensity.ts exposing mode",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      declared,
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe("src/ui/ledger-table/useDensity.ts");
  });

  it("does not bind a bare filename against a longer file_scope member", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Add useDensity.ts exposing mode",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      declared,
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe("unbound-path");
    expect(result.message).toContain("Basename matching is refused");
  });

  it("fails when two exact file_scope members are named", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Touch src/ui/ledger-table/useDensity.ts or src/ui/ledger-table/useTableKeyboard.ts",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      declared,
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe("ambiguous-scope");
  });

  it("fails a stored bare reading instead of basename-matching it", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "keyboard helper",
          artifact_path: "src/ui/ledger-table/useTableKeyboard.ts",
          ambiguous: true,
          chosen_reading: 0,
          readings: [
            { text: "keyboard helper", artifact_path: "useTableKeyboard.ts" },
            { text: "expansion helper", artifact_path: "useRowExpansion.ts" },
          ],
        },
      ],
      declared,
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe("undeclared-binding");
  });

  it("binds stored readings that already name exact file_scope members", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "keyboard helper",
          artifact_path: null,
          ambiguous: true,
          chosen_reading: 0,
          readings: [
            {
              text: "keyboard helper",
              artifact_path: "src/ui/ledger-table/useTableKeyboard.ts",
            },
          ],
        },
      ],
      declared,
    );
    expect(result.ok).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe("src/ui/ledger-table/useTableKeyboard.ts");
    expect(result.clauses[0]?.readings?.[0]?.artifact_path).toBe(
      "src/ui/ledger-table/useTableKeyboard.ts",
    );
  });

  it("leaves behavioral clauses unbound when file_scope is present", () => {
    const result = bindClausesToDeclaredScope(
      [{ id: 1, text: "No clause-count cap is introduced", artifact_path: null, ambiguous: false }],
      declared,
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.clauses[0]?.artifact_path).toBeNull();
  });

  it("binds an exact declared directory named in the clause", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Ship helpers under src/ui/ledger-table/",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      ["src/ui/ledger-table"],
    );
    expect(result.ok).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe("src/ui/ledger-table");
  });

  it("is a no-op when file_scope is empty", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Add src/ui/ledger-table/useDensity.ts exposing mode",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.clauses[0]?.artifact_path).toBeNull();
  });
});

describe("isDeclaredArtifactPath basename refuse (#4008)", () => {
  it("does not treat a basename as a declared file_scope member", () => {
    expect(isDeclaredArtifactPath("useDensity.ts", ["src/ui/ledger-table/useDensity.ts"])).toBe(
      false,
    );
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
      { declaredScope: ["shipped.ts", "nope.ts"] },
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
      { declaredScope: ["src/out.ts", ".deft-scratch/buffer/out.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("verified");
    expect(report.clauses[1]?.outcome).toBe("failed");
    expect(report.clauses[1]?.detail).toMatch(/buffer\/scratch/);
  });

  // #3826 changed the absent half of this pair: a negation matched against the
  // whole clause text is not evidence about the bound path, so absence is now
  // unverifiable rather than verified. The present half still contradicts.
  it("fails a negated clause the artifact contradicts and cannot verify absence", () => {
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
      { declaredScope: ["ghost.ts", "present.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[1]?.outcome).toBe("failed");
    expect(report.clauses[1]?.detail).toMatch(/requires absence/);
  });

  // Derivation stopped emitting readings at #3835, but a stored brief may still
  // carry them, so the round-trip stays supported on the read side.
  it("round-trips a stored ambiguous clause and its chosen reading", () => {
    const stored = [
      {
        id: 1,
        text: "Land the stamp in the run-summary module",
        artifact_path: "packages/core/src/run-summary/types.ts",
        ambiguous: true,
        chosen_reading: 1,
        readings: [
          { text: "reading a", artifact_path: "packages/core/src/run-summary/types.ts" },
          { text: "reading b", artifact_path: "packages/core/src/run-summary/emit.ts" },
        ],
      },
    ];
    const read = readAcceptanceClauses({ clauses: serializeAcceptanceClauses(stored) });
    expect(read).toHaveLength(1);
    expect(read[0]?.ambiguous).toBe(true);
    expect(read[0]?.artifact_path).toBe("packages/core/src/run-summary/emit.ts");
  });

  it("fails escaped paths, directories, missing tokens, and empty artifact strings", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-edges-"));
    mkdirSync(join(root, "dir"), { recursive: true });
    writeFileSync(join(root, "shipped.ts"), "only-alpha\n", "utf8");
    // Filesystem root, so the path is outside the project and outside tmp — the
    // scratch predicate must not claim it before the containment check runs.
    const outsideRoot = join(parse(root).root, "outside-3835.ts");
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
          artifact_path: outsideRoot,
          ambiguous: false,
        },
        { id: 4, text: "blank path", artifact_path: "   ", ambiguous: false },
      ],
      root,
      { declaredScope: ["shipped.ts", "dir", outsideRoot] },
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

  it("refuses a relative escape before the containment check can run (#3835)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3835-escape-"));
    const report = walkAcceptanceClauses(
      [{ id: 1, text: "escape the project", artifact_path: "../outside.ts", ambiguous: false }],
      root,
      { declaredScope: ["../outside.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
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

/**
 * #3794 shape: 13 declared criteria live in `item.title` with an empty
 * `narrative`, the primary extractors find nothing in the body, and the
 * statement is the whole issue thread with path-bearing bullets in it.
 */
const THREAD_SCRAPE_STATEMENT = `
Some issue title

## Summary

Analysis prose, not acceptance.

### Comment by @critic

- Evidence. I instrumented packages/core/src/hooks/dispatcher.ts:1431-1434 and it swallowed the failure.
- Corroboration from runtime-authority.ts and authz/evaluate.ts:124-126.
- Cost. The scratch copy under .deft-scratch/worktrees/ is not the shipped path.

### Acceptance of the argument above

- The reviewer accepted packages/core/src/verify-ac/clauses.ts as the anchor.
`;

const DECLARED_ITEMS = [
  { title: "A foreign-repository target is refused rather than adopted", status: "proposed" },
  {
    title: "Git output is normalised through `normalizeHookProjectRoot` before comparison",
    status: "proposed",
  },
  { title: "CHANGELOG `[Unreleased]` entry", status: "proposed" },
];

describe("collectPlanItemAcceptanceSurface (#3826)", () => {
  it("reads item.title when narrative is empty and prefers narrative.Acceptance when set", () => {
    expect(
      collectPlanItemAcceptanceSurface({
        items: [
          { title: "criteria in the title", narrative: {} },
          {
            title: "title is ignored here",
            narrative: { Acceptance: "criteria in the narrative" },
          },
        ],
      }),
    ).toEqual(["criteria in the title", "criteria in the narrative"]);
  });

  it("drops blanks, meta lines, duplicates, and a missing or non-array items field", () => {
    expect(
      collectPlanItemAcceptanceSurface({
        items: [
          { title: "  " },
          { title: "Refs #3826" },
          { title: "**bold criterion**" },
          { title: "bold criterion" },
          "not-an-object",
          { status: "proposed" },
        ],
      }),
    ).toEqual(["bold criterion"]);
    expect(collectPlanItemAcceptanceSurface({})).toEqual([]);
    expect(collectPlanItemAcceptanceSurface({ items: "nope" })).toEqual([]);
  });
});

describe("deriveAcceptanceClauses prefers a declared item surface (#3826)", () => {
  it("uses plan.items instead of scraping an acceptance heading out of the thread", () => {
    const scraped = deriveAcceptanceClauses(THREAD_SCRAPE_STATEMENT);
    // Reproduce the defect first: with no declared surface, the thread wins.
    expect(scraped.length).toBeGreaterThan(0);
    expect(scraped.some((c) => c.text.includes("Evidence."))).toBe(true);

    const declared = deriveAcceptanceClauses(THREAD_SCRAPE_STATEMENT, {
      itemSurface: DECLARED_ITEMS.map((item) => item.title),
    });
    expect(declared.map((c) => c.text)).toEqual(DECLARED_ITEMS.map((item) => item.title));
    expect(declared.some((c) => c.text.includes("Evidence."))).toBe(false);
    expect(declared.some((c) => c.artifact_path?.includes(".deft-scratch"))).toBe(false);
  });

  it("pins the #3794 shape: three primary extractors returning zero does not scrape the thread", () => {
    const pathBearingOnly = `
### Comment by @critic

- Evidence. See packages/core/src/hooks/dispatcher.ts:1431-1434 for the swallowed failure.
- Cost. runtime-authority.ts and authz/evaluate.ts also read it.
`;
    // No acceptance heading, no labeled line: the fallback is the only branch left.
    expect(deriveAcceptanceClauses(pathBearingOnly)).toHaveLength(2);
    const declared = deriveAcceptanceClauses(pathBearingOnly, {
      itemSurface: ["The linked worktree write is refused"],
    });
    expect(declared).toHaveLength(1);
    expect(declared[0]?.text).toBe("The linked worktree write is refused");
  });

  it("introduces no clause-count cap: a declared surface of 40 yields 40 clauses", () => {
    const surface = Array.from({ length: 40 }, (_, i) => `Declared criterion number ${i + 1}`);
    expect(deriveAcceptanceClauses("Title only", { itemSurface: surface })).toHaveLength(40);
    const wide = Array.from(
      { length: 30 },
      (_, i) => `- Bullet ${i + 1} binds packages/core/src/mod${i + 1}.ts`,
    ).join("\n");
    expect(deriveAcceptanceClauses(wide)).toHaveLength(30);
  });

  it("ignores an item surface that is empty or entirely meta and keeps the statement path", () => {
    const fromStatement = deriveAcceptanceClauses(THREAD_SCRAPE_STATEMENT, {
      itemSurface: ["  ", "Refs #3826"],
    });
    expect(fromStatement.some((c) => c.text.includes("Evidence."))).toBe(true);
    expect(deriveAcceptanceClauses("", { itemSurface: [] })).toEqual([]);
  });

  it("derives a zero-failed clause set from a #3794-shaped brief", () => {
    // The blocking harm on #3794 was 55 `failed` clauses, each bound to a path
    // lifted from thread prose. A brief whose criteria are declared on plan.items
    // binds only what those criteria name, so the walk has nothing to contradict.
    const root = mkdtempSync(join(tmpdir(), "clause-3826-committable-"));
    const declared = [
      "A direct write is gated against the Git worktree containing its target",
      "`effectiveRoot` is admitted only when `--git-common-dir` matches `payloadRoot`'s",
      "Occupancy and ritual move together in this commit",
      "Authz grant scoping, the authz audit trail, and the kill-switch are pinned",
      "A foreign-repository target is refused rather than adopted",
      "CHANGELOG `[Unreleased]` entry",
    ];
    const { clauses } = stampDerivedClausesOnAcceptance(
      {
        items: declared.map((title) => ({ title, status: "proposed", narrative: {} })),
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      THREAD_SCRAPE_STATEMENT,
    );
    expect(clauses).toHaveLength(declared.length);
    const report = walkAcceptanceClauses(clauses, root, { declaredScope: [] });
    expect(report.failed).toEqual([]);
  });

  it("stamps the declared surface through stampDerivedClausesOnAcceptance", () => {
    const { clauses } = stampDerivedClausesOnAcceptance(
      {
        items: DECLARED_ITEMS,
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      THREAD_SCRAPE_STATEMENT,
    );
    expect(clauses.map((c) => c.text)).toEqual(DECLARED_ITEMS.map((item) => item.title));
  });
});

describe("absent artifacts do not verify on prose alone (#3826)", () => {
  it("reports unverifiable, not verified, when a prose negation names no bound absence", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3826-absent-"));
    // The #3794 clause 55 shape: analysis prose about something else entirely,
    // carrying a bare filename and the words "does not exist".
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "worktreePath() swallows the failure and returns a directory that does not exist yet, so git.ts never sees it",
          artifact_path: "git.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["git.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.detail).toMatch(/prose negation is not evidence/);
    expect(report.verified).toHaveLength(0);
  });

  it("does not let a false-positive verified satisfy the ok predicate", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3826-ok-"));
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "the shipped path does not exist in this analysis",
          artifact_path: "ghost.ts",
          ambiguous: false,
        },
        {
          id: 2,
          text: "a behavioral claim with no bound path",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["ghost.ts"] },
    );
    expect(report.failed).toHaveLength(0);
    expect(report.verified).toHaveLength(0);
    // One clause is still bound to a declared path, so the walk has an oracle and
    // the `verified` requirement still binds. Absence no longer satisfies it.
    expect(countAdjudicableClauses(report.clauses)).toBe(1);
    expect(report.ok).toBe(false);
  });
});

describe("verified > 0 binds only where the walk has an oracle (#3826)", () => {
  it("passes a zero-failed set whose clauses bind no artifact path", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3826-nooracle-"));
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "An absent artifact no longer yields verified",
          artifact_path: null,
          ambiguous: false,
        },
        { id: 2, text: "No clause-count cap is introduced", artifact_path: null, ambiguous: false },
      ],
      root,
      { declaredScope: [] },
    );
    expect(report.failed).toHaveLength(0);
    expect(report.verified).toHaveLength(0);
    expect(report.unverifiable).toHaveLength(2);
    expect(countAdjudicableClauses(report.clauses)).toBe(0);
    expect(report.ok).toBe(true);
  });

  it("still blocks when a bound clause contradicts the shipped tree", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3826-bound-"));
    const report = walkAcceptanceClauses(
      [
        { id: 1, text: "a criterion with no bound path", artifact_path: null, ambiguous: false },
        {
          id: 2,
          text: "the guard covers completed/ artifacts",
          artifact_path: "completed/",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["completed"] },
    );
    expect(report.failed).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it("counts only clauses the walk had an oracle for", () => {
    const rows = [
      {
        id: 1,
        text: "a",
        artifact_path: null,
        outcome: "unverifiable",
        detail: "",
        adjudicable: false,
      },
      {
        id: 2,
        text: "b",
        artifact_path: "undeclared.ts",
        outcome: "unverifiable",
        detail: "",
        adjudicable: false,
      },
      {
        id: 3,
        text: "c",
        artifact_path: "src/a.ts",
        outcome: "verified",
        detail: "",
        adjudicable: true,
      },
      {
        id: 4,
        text: "d",
        artifact_path: "src/b.ts",
        outcome: "unverifiable",
        detail: "",
        adjudicable: true,
      },
    ] as const;
    expect(countAdjudicableClauses(rows)).toBe(2);
    expect(countUnverifiedAdjudicableClauses(rows)).toBe(1);
    expect(countAdjudicableClauses([])).toBe(0);
    expect(countUnverifiedAdjudicableClauses([])).toBe(0);
  });
});
