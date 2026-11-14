import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindClausesToDeclaredScope,
  classifyQuotedTokenPolarity,
  collectDeclaredAcceptanceNarrativeSurface,
  collectDoneWhenLines,
  collectPlanItemAcceptanceSurface,
  countAdjudicableClauses,
  countUnverifiedAdjudicableClauses,
  deriveAcceptanceClauses,
  evaluateStatementSentenceCoverage,
  extractExpectedTokens,
  extractQuotedSpans,
  extractStatementSentences,
  formatClauseWalkMessage,
  formatZeroClauseAcceptanceShapedNotice,
  isBindableMatchAnyFilePointer,
  isDeclaredArtifactPath,
  isFileShapedPointer,
  isScratchArtifactPath,
  looksLikeDefectDescription,
  readAcceptanceClauses,
  resolveClauseSourceKind,
  serializeAcceptanceClauses,
  stampDerivedClausesOnAcceptance,
  stripInlineMarkdownBold,
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

  function rootWith(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "clause-bind-"));
    for (const file of files) {
      const abs = join(root, file);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "ok\n", "utf8");
    }
    return root;
  }

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
      rootWith(declared),
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
      rootWith(declared),
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
      rootWith(declared),
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
      rootWith(declared),
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
      rootWith(declared),
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
      rootWith(declared),
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.clauses[0]?.artifact_path).toBeNull();
  });

  it("does not bind a directory stand-in mentioned in a clause (#4840)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-bind-dir-"));
    mkdirSync(join(root, "packages", "a", "src"), { recursive: true });
    const mentioned = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Ship helpers under packages/a",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      ["packages/a"],
      root,
    );
    expect(mentioned.ok).toBe(true);
    expect(mentioned.clauses[0]?.artifact_path).toBeNull();
    const stored = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Ship helpers under packages/a",
          artifact_path: "packages/a",
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(stored.ok).toBe(false);
    expect(stored.failures[0]?.kind).toBe("undeclared-binding");
    expect(stored.clauses[0]?.artifact_path).toBe("packages/a");
  });

  it("does not copy ./ or backslash directory prefixes onto artifact_path (#4840)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-bind-dir-prefix-"));
    mkdirSync(join(root, "src", "ui", "ledger-table"), { recursive: true });
    const dirDeclared = ["src/ui/ledger-table"];
    const dotted = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Ship helpers under ./src/ui/ledger-table",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      dirDeclared,
      root,
    );
    expect(dotted.ok).toBe(true);
    expect(dotted.clauses[0]?.artifact_path).toBeNull();
    const win = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Ship helpers under src\\ui\\ledger-table",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      dirDeclared,
      root,
    );
    expect(win.ok).toBe(true);
    expect(win.clauses[0]?.artifact_path).toBeNull();
  });

  it("binds a stored extensionless Dockerfile under matchAny when it is a file (#4840)", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "ship Dockerfile",
          artifact_path: "Dockerfile",
          ambiguous: false,
        },
      ],
      ["Dockerfile"],
      rootWith(["Dockerfile"]),
    );
    expect(result.ok).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe("Dockerfile");
  });

  it("binds Dockerfile under glob file_scope when it is a regular file (#4840)", () => {
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "ship Dockerfile",
          artifact_path: "Dockerfile",
          ambiguous: false,
        },
      ],
      ["*"],
      rootWith(["Dockerfile"]),
    );
    expect(result.ok).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe("Dockerfile");
  });

  it("binds a stored non-glob matchAny file under a glob file_scope (#4840)", () => {
    const pointer = "packages/a/index.ts";
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "unit covers packages/a/index.ts",
          artifact_path: pointer,
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      rootWith([pointer]),
    );
    expect(result.ok).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe(pointer);
  });

  it("binds a missing matchAny file named in the clause under glob file_scope (#4840)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-bind-future-"));
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    const fromText = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Add packages/a/new-file.ts",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(fromText.ok).toBe(true);
    expect(fromText.clauses[0]?.artifact_path).toBe("packages/a/new-file.ts");
    const stored = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "Add packages/a/new-file.ts",
          artifact_path: "packages/a/new-file.ts",
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(stored.ok).toBe(true);
    expect(stored.clauses[0]?.artifact_path).toBe("packages/a/new-file.ts");
  });

  it("binds a file token in clause text under a glob file_scope (#4840)", () => {
    const pointer = "packages/a/index.ts";
    const result = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "unit covers packages/a/index.ts",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      rootWith([pointer]),
    );
    expect(result.ok).toBe(true);
    expect(result.clauses[0]?.artifact_path).toBe(pointer);
  });

  it("refuses glob-shaped stored paths and declared-member glob text hits (#4840)", () => {
    const root = rootWith(["packages/a/index.ts"]);
    const stored = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "covers glob",
          artifact_path: "packages/a/**",
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(stored.ok).toBe(false);
    expect(stored.failures[0]?.kind).toBe("undeclared-binding");
    const fromText = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "covers `packages/a/**`",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(fromText.ok).toBe(false);
    expect(fromText.failures[0]?.kind).toBe("unbound-path");
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
      rootWith(declared),
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

describe("isDeclaredArtifactPath glob-refusing matchAny (#4840)", () => {
  it("accepts a non-glob file under a glob file_scope and refuses glob-shaped pointers", () => {
    expect(isDeclaredArtifactPath("packages/a/index.ts", ["packages/a/**"])).toBe(true);
    expect(isDeclaredArtifactPath("packages/a/**", ["packages/a/**"])).toBe(false);
    expect(isDeclaredArtifactPath("packages/a/foo*.ts", ["packages/a/**"])).toBe(false);
  });
});

describe("isFileShapedPointer (#4840)", () => {
  it("accepts extensionless files and refuses glob-shaped pointers", () => {
    expect(isFileShapedPointer("Dockerfile")).toBe(true);
    expect(isFileShapedPointer("Makefile")).toBe(true);
    expect(isFileShapedPointer("LICENSE")).toBe(true);
    expect(isFileShapedPointer("packages/a/index.ts")).toBe(true);
    expect(isFileShapedPointer("packages/a/**")).toBe(false);
    expect(isFileShapedPointer("foo*.ts")).toBe(false);
    expect(isFileShapedPointer("")).toBe(false);
  });
});

describe("isBindableMatchAnyFilePointer (#4840)", () => {
  it("binds a missing in-scope file", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-bindable-missing-"));
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    expect(isBindableMatchAnyFilePointer("packages/a/new-file.ts", ["packages/a/**"], root)).toBe(
      true,
    );
  });

  it("binds an existing in-scope regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-bindable-file-"));
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "index.ts"), "export {}\n", "utf8");
    expect(isBindableMatchAnyFilePointer("packages/a/index.ts", ["packages/a/**"], root)).toBe(
      true,
    );
  });

  it("does not bind an in-repo symlink to an external regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-bindable-symlink-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "clause-bindable-outside-"));
    const outsideFile = join(outsideDir, "secret.ts");
    writeFileSync(outsideFile, "export {}\n", "utf8");
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    const pointer = "packages/a/index.ts";
    try {
      symlinkSync(outsideFile, join(root, pointer));
    } catch {
      // Windows without symlink privilege: skip rather than fail the suite
      return;
    }
    expect(isBindableMatchAnyFilePointer(pointer, ["packages/a/**"], root)).toBe(false);
    const stored = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "unit covers packages/a/index.ts",
          artifact_path: pointer,
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(stored.ok).toBe(false);
    expect(stored.failures[0]?.kind).toBe("undeclared-binding");
    const fromText = bindClausesToDeclaredScope(
      [
        {
          id: 1,
          text: "unit covers packages/a/index.ts",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      ["packages/a/**"],
      root,
    );
    expect(fromText.ok).toBe(false);
    expect(fromText.failures[0]?.kind).toBe("unbound-path");
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

  it("walks a matchAny file under glob file_scope and fails a directory stand-in (#4840)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-glob-"));
    mkdirSync(join(root, "packages", "a", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "index.ts"), "export {}\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "artifact exists at packages/a/index.ts",
          artifact_path: "packages/a/index.ts",
          ambiguous: false,
        },
        {
          id: 2,
          text: "artifact exists at packages/a",
          artifact_path: "packages/a",
          ambiguous: false,
        },
        {
          id: 3,
          text: "covers packages/a/**",
          artifact_path: "packages/a/**",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["packages/a/**"] },
    );
    expect(report.clauses[0]?.outcome).toBe("verified");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.clauses[1]?.outcome).toBe("failed");
    expect(report.clauses[1]?.adjudicable).toBe(true);
    expect(report.clauses[1]?.detail).toMatch(/not a shipped file/);
    expect(report.clauses[2]?.outcome).toBe("unverifiable");
    expect(report.clauses[2]?.adjudicable).toBe(false);
  });

  it("fails a missing matchAny path at walk (#4840)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-walk-missing-"));
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "artifact exists at packages/a/new-file.ts",
          artifact_path: "packages/a/new-file.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["packages/a/**"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.clauses[0]?.detail).toMatch(/missing/);
  });

  it("walks an extensionless Dockerfile as a shipped file (#4840)", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-docker-"));
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "artifact exists at Dockerfile",
          artifact_path: "Dockerfile",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["Dockerfile"] },
    );
    expect(report.clauses[0]?.outcome).toBe("verified");
    expect(report.clauses[0]?.adjudicable).toBe(true);
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

const PHASE3_BARE_PROSE = [
  "Login rejects empty passwords",
  "Session token persists across refresh",
  "Logout clears the stored token",
  "Invalid credentials return 401",
  "CHANGELOG cites the setup write shape",
].join("\n");

const PHASE3_LIST_ITEMS = [
  "- Login rejects empty passwords",
  "- Session token persists across refresh",
  "- Logout clears the stored token",
  "- Invalid credentials return 401",
  "- CHANGELOG cites the setup write shape",
].join("\n");

describe("stripInlineMarkdownBold (#4374)", () => {
  it("strips bold markers and keeps dunder identifiers", () => {
    expect(stripInlineMarkdownBold("Login rejects **empty** passwords")).toBe(
      "Login rejects empty passwords",
    );
    expect(stripInlineMarkdownBold("Reject invalid configuration in __init__")).toBe(
      "Reject invalid configuration in __init__",
    );
  });
});

describe("collectDeclaredAcceptanceNarrativeSurface (#4374)", () => {
  it("parses heading-less list items from AcceptanceCriteria as declared surface", () => {
    const surface = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { AcceptanceCriteria: PHASE3_LIST_ITEMS, Overview: "do not scrape me" },
    });
    expect(surface.present).toBe(true);
    expect(surface.keys).toEqual(["AcceptanceCriteria"]);
    expect(surface.lines).toHaveLength(5);
    expect(surface.acceptanceCriteriaLines).toEqual(surface.lines);
    expect(surface.lines[0]).toBe("Login rejects empty passwords");
  });

  it("records one AcceptanceCriteria line when that key repeats it (#4867)", () => {
    const surface = collectDeclaredAcceptanceNarrativeSurface({
      narratives: {
        AcceptanceCriteria: "- Login rejects empty passwords\n- Login rejects empty passwords\n",
      },
    });
    expect(surface.acceptanceCriteriaLines).toEqual(["Login rejects empty passwords"]);
    expect(surface.lines).toEqual(["Login rejects empty passwords"]);
  });

  it("parses labeled lines when the declared key has no list items", () => {
    const surface = collectDeclaredAcceptanceNarrativeSurface({
      narratives: {
        Test: "test: CHANGELOG.md cites #4374\nacceptance: the form rejects empty passwords",
      },
    });
    expect(surface.lines).toEqual(["CHANGELOG.md cites #4374", "the form rejects empty passwords"]);
    expect(surface.acceptanceCriteriaLines).toEqual([]);
  });

  it("treats bare prose as present with zero lines", () => {
    const surface = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { AcceptanceCriteria: PHASE3_BARE_PROSE },
    });
    expect(surface.present).toBe(true);
    expect(surface.lines).toEqual([]);
    expect(surface.acceptanceCriteriaLines).toEqual([]);
  });

  it("ignores Overview and Requirements", () => {
    expect(
      collectDeclaredAcceptanceNarrativeSurface({
        narratives: {
          Overview: PHASE3_LIST_ITEMS,
          Requirements: "- FR-1: Widget opens",
        },
      }),
    ).toEqual({ present: false, lines: [], keys: [], acceptanceCriteriaLines: [] });
  });

  it("returns absent when narratives are missing, empty, or non-string", () => {
    expect(collectDeclaredAcceptanceNarrativeSurface({})).toEqual({
      present: false,
      lines: [],
      keys: [],
      acceptanceCriteriaLines: [],
    });
    expect(
      collectDeclaredAcceptanceNarrativeSurface({
        narratives: { AcceptanceCriteria: "  ", Test: 12, Verification: "" },
      }),
    ).toEqual({ present: false, lines: [], keys: [], acceptanceCriteriaLines: [] });
  });

  it("parses numbered Verification items and drops duplicate/meta bullets", () => {
    const surface = collectDeclaredAcceptanceNarrativeSurface({
      narratives: {
        Verification:
          "1. Login rejects empty passwords\n1. Login rejects empty passwords\n- Relates #4374\n",
      },
    });
    expect(surface.keys).toEqual(["Verification"]);
    expect(surface.lines).toEqual(["Login rejects empty passwords"]);
    expect(surface.acceptanceCriteriaLines).toEqual([]);
  });

  it("names a fallback key list when the notice is called with no keys", () => {
    expect(formatZeroClauseAcceptanceShapedNotice([])).toMatch(
      /acceptance-shaped narrative keys \(AcceptanceCriteria, Test, Verification\)/,
    );
  });
});

describe("deriveAcceptanceClauses declared narrative surface (#4374)", () => {
  it("uses heading-less AcceptanceCriteria bullets instead of scraping the blob", () => {
    const blob = `## Overview\n${PHASE3_BARE_PROSE}\n\n- Write CHANGELOG.md under Unreleased\n`;
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { AcceptanceCriteria: PHASE3_LIST_ITEMS },
    });
    const clauses = deriveAcceptanceClauses(blob, { declaredNarrative: declared });
    expect(clauses.map((c) => c.text)).toEqual([
      "Login rejects empty passwords",
      "Session token persists across refresh",
      "Logout clears the stored token",
      "Invalid credentials return 401",
      "CHANGELOG cites the setup write shape",
    ]);
  });

  it("does not fall through to statement scrape when the declared key is bare prose", () => {
    const blob =
      "- Write CHANGELOG.md under Unreleased\n- Ignore this narrative sentence without a path\n";
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { AcceptanceCriteria: PHASE3_BARE_PROSE },
    });
    expect(deriveAcceptanceClauses(blob, { declaredNarrative: declared })).toEqual([]);
    expect(formatZeroClauseAcceptanceShapedNotice(["AcceptanceCriteria"])).toMatch(
      /0 clauses derived from acceptance-shaped narrative keys \(AcceptanceCriteria\)/,
    );
  });

  it("uses parseable AcceptanceCriteria lines instead of item titles (#4867)", () => {
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { AcceptanceCriteria: PHASE3_LIST_ITEMS },
    });
    const clauses = deriveAcceptanceClauses("thread", {
      itemSurface: ["plan item title 1", "plan item title 2"],
      declaredNarrative: declared,
    });
    expect(clauses.map((c) => c.text)).toEqual([
      "Login rejects empty passwords",
      "Session token persists across refresh",
      "Logout clears the stored token",
      "Invalid credentials return 401",
      "CHANGELOG cites the setup write shape",
    ]);
    expect(clauses.map((c) => c.text).some((text) => text.startsWith("plan item title"))).toBe(
      false,
    );
  });

  it("keeps item titles when AcceptanceCriteria is bare prose (#4867)", () => {
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { AcceptanceCriteria: PHASE3_BARE_PROSE },
    });
    const clauses = deriveAcceptanceClauses("thread", {
      itemSurface: ["plan item title 1"],
      declaredNarrative: declared,
    });
    expect(clauses.map((c) => c.text)).toEqual(["plan item title 1"]);
  });

  it("keeps Test lines with AcceptanceCriteria when the item surface is empty (#4374)", () => {
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: {
        AcceptanceCriteria: "- Login rejects empty passwords",
        Test: "- CHANGELOG cites #4867",
      },
    });
    const clauses = deriveAcceptanceClauses("blob", { declaredNarrative: declared });
    expect(clauses.map((c) => c.text)).toEqual([
      "Login rejects empty passwords",
      "CHANGELOG cites #4867",
    ]);
  });

  it("drops Test and item titles when AcceptanceCriteria lines parse (#4867)", () => {
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: {
        AcceptanceCriteria: "- Login rejects empty passwords",
        Test: "- CHANGELOG cites #4867",
      },
    });
    const clauses = deriveAcceptanceClauses("blob", {
      itemSurface: ["plan item title 1"],
      declaredNarrative: declared,
    });
    expect(clauses.map((c) => c.text)).toEqual(["Login rejects empty passwords"]);
  });

  it("keeps the item surface when only Test is declared (#3826)", () => {
    const declared = collectDeclaredAcceptanceNarrativeSurface({
      narratives: { Test: "- CHANGELOG cites #4867" },
    });
    const clauses = deriveAcceptanceClauses("blob", {
      itemSurface: ["plan item title 1"],
      declaredNarrative: declared,
    });
    expect(clauses.map((c) => c.text)).toEqual(["plan item title 1"]);
  });
});

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

  it("stamps AcceptanceCriteria lines when items have titles (#4867)", () => {
    const { clauses } = stampDerivedClausesOnAcceptance(
      {
        items: [
          { title: "plan item title 1", narrative: {} },
          {
            title: "plan item title 2",
            narrative: { Acceptance: "item narrative acceptance line" },
          },
        ],
        narratives: { AcceptanceCriteria: PHASE3_LIST_ITEMS },
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      THREAD_SCRAPE_STATEMENT,
    );
    expect(clauses.map((c) => c.text)).toEqual([
      "Login rejects empty passwords",
      "Session token persists across refresh",
      "Logout clears the stored token",
      "Invalid credentials return 401",
      "CHANGELOG cites the setup write shape",
    ]);
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

describe("extractExpectedTokens quote-class pairing (#4103)", () => {
  const bound = (text: string) => ({
    id: 1,
    text,
    artifact_path: "shipped.ts",
    ambiguous: false,
  });

  it("extracts no quoted token from a lone possessive with no other quote-class character", () => {
    expect(extractExpectedTokens(bound("the schedule's total"))).toEqual([]);
  });

  it("does not extract a spurious fragment from a two-apostrophe contraction-pair clause", () => {
    expect(
      extractExpectedTokens(bound("verify:ac doesn't fail when the artifact isn't scratch")),
    ).toEqual([]);
  });

  it("does not steal a genuine quoted literal from a mixed apostrophe/double-quote clause", () => {
    expect(
      extractExpectedTokens(
        bound('the response returns the user\'s id and logs "unauthorized" on failure'),
      ),
    ).toEqual(["unauthorized"]);
  });

  it("still extracts a genuine same-delimiter quoted literal for verbatim match", () => {
    expect(extractExpectedTokens(bound('shipped.ts contains "exact string"'))).toEqual([
      "exact string",
    ]);
    expect(extractExpectedTokens(bound("the clause names 'exact string' verbatim"))).toEqual([
      "exact string",
    ]);
  });

  it("does not FAIL a correct artifact on a contraction-pair clause", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4103-pair-"));
    writeFileSync(join(root, "shipped.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [bound("verify:ac doesn't fail when the artifact isn't scratch")],
      root,
      { declaredScope: ["shipped.ts"] },
    );
    expect(report.clauses[0]?.outcome).not.toBe("failed");
    expect(report.clauses[0]?.detail).not.toMatch(/expected token/);
  });
});

describe("bound behavioral clauses have no static oracle (#4240)", () => {
  it("does not treat a bound no-token no-existence clause as adjudicable", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-bound-"));
    writeFileSync(join(root, "README.md"), "existing callers stay as they are\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "existing callers are unchanged",
          artifact_path: "README.md",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["README.md"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
    expect(countAdjudicableClauses(report.clauses)).toBe(0);
    expect(countUnverifiedAdjudicableClauses(report.clauses)).toBe(0);
    expect(report.verified).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it("keeps the same text unbound and non-blocking", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-unbound-"));
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "existing callers are unchanged",
          artifact_path: null,
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["README.md"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("still fails a bound existence claim whose artifact is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-missing-"));
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "README.md exists at the stated path",
          artifact_path: "README.md",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["README.md"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("still fails unrecognized absence wording when the bound artifact is present", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-absent-"));
    writeFileSync(join(root, "README.md"), "still here\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "README.md must be absent",
          artifact_path: "README.md",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["README.md"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.clauses[0]?.detail).toMatch(/requires absence/);
    expect(report.ok).toBe(false);
  });

  it("does not treat other-subject absence prose as a claim the bound file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-behavior-"));
    writeFileSync(join(root, "shipped.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "the helper returns a directory that must be absent from the runtime graph",
          artifact_path: "shipped.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["shipped.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("does not treat a longer filename as the bound basename", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-basename-"));
    writeFileSync(join(root, "shipped.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "shipped.tsx must be absent",
          artifact_path: "shipped.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["shipped.ts"] },
    );
    expect(report.clauses[0]?.outcome).not.toBe("failed");
    expect(report.ok).toBe(true);
  });

  it("fails a short bound name whose clause requires absence", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-short-"));
    writeFileSync(join(root, "ab"), "x\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "ab must not exist",
          artifact_path: "ab",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["ab"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("does not treat a short basename as an artifact when it is later English prose", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-short-prose-"));
    writeFileSync(join(root, "go"), "package main\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "the helper should not exist before we go",
          artifact_path: "go",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["go"] },
    );
    expect(report.clauses[0]?.outcome).not.toBe("failed");
    expect(report.ok).toBe(true);
  });

  it("fails a short name with one intervening word before the absence phrase", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-short-file-"));
    writeFileSync(join(root, "go"), "package main\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "the go file must not exist",
          artifact_path: "go",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["go"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("fails a ./ prefixed absence clause against the normalized bound path", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-dotslash-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "result.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "./src/result.ts must not exist",
          artifact_path: "src/result.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["src/result.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.adjudicable).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("does not fail other-subject should-not-exist prose on a present bound file", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-4240-should-not-"));
    writeFileSync(join(root, "shipped.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: "the helper returns a directory that should not exist yet",
          artifact_path: "shipped.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["shipped.ts"] },
    );
    expect(report.clauses[0]?.outcome).not.toBe("failed");
    expect(report.ok).toBe(true);
  });
});

describe("bug-report defect-description polarity (#5393)", () => {
  it("prefers Done-when over Failures paste in statement scrape", () => {
    const clauses = deriveAcceptanceClauses(`
## Failures
- error TS2532: Object is possibly 'undefined' in packages/core/src/verify-ac/clauses.ts
- 3 files fail format check in packages/core/src/foo.ts

Done when npm run check exits 0 on main.
`);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.text).toMatch(/done when/i);
    expect(clauses[0]?.source_kind).toBeUndefined();
  });

  it("keeps Acceptance Criteria alongside Done-when (does not drop explicit criteria)", () => {
    const clauses = deriveAcceptanceClauses(`
## Acceptance Criteria
- packages/core/src/verify-ac/clauses.ts must export looksLikeDefectDescription

Done when npm run check exits 0 on main.
`);
    expect(clauses.map((c) => c.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/done when/i),
        expect.stringMatching(/looksLikeDefectDescription/),
      ]),
    );
    expect(clauses.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps imperative checklist items with must items (does not drop Add …)", () => {
    const clauses = deriveAcceptanceClauses(`
- packages/core/src/verify-ac/clauses.ts must export resolveClauseSourceKind
- Add packages/core/src/verify-ac/clauses.test.ts coverage for defect polarity
`);
    expect(clauses.map((c) => c.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/must export resolveClauseSourceKind/),
        expect.stringMatching(/^Add packages\/core\/src\/verify-ac\/clauses\.test\.ts/),
      ]),
    );
  });

  it("does not classify mixed diagnostic + must-contain as defect-description", () => {
    const text = "After fixing TS2304, `src/output.ts` must contain 'resolved'";
    expect(looksLikeDefectDescription(text)).toBe(false);
    expect(
      resolveClauseSourceKind({
        id: 1,
        text,
        artifact_path: "src/output.ts",
        ambiguous: false,
      }),
    ).toBe("acceptance");
  });

  it("yields 0 clauses for Failures-only bug report without Done-when", () => {
    const clauses = deriveAcceptanceClauses(`
## Failures
- error TS2532: Object is possibly 'undefined' in packages/core/src/verify-ac/clauses.ts
- 3 files fail format check in packages/core/src/foo.ts
`);
    expect(clauses).toEqual([]);
  });

  it("round-trips source_kind defect-description through read/serialize", () => {
    const stamped = serializeAcceptanceClauses([
      {
        id: 1,
        text: 'error TS2532: Object is possibly "undefined"',
        artifact_path: "packages/core/src/verify-ac/clauses.ts",
        ambiguous: false,
        source_kind: "defect-description",
      },
    ]);
    expect(stamped[0]?.source_kind).toBe("defect-description");
    const read = readAcceptanceClauses({ clauses: stamped });
    expect(read[0]?.source_kind).toBe("defect-description");
    expect(
      resolveClauseSourceKind(
        read[0] ?? { id: 0, text: "", artifact_path: null, ambiguous: false },
      ),
    ).toBe("defect-description");
  });

  it("classifies legacy Failures text as defect-description without the field", () => {
    expect(looksLikeDefectDescription('Object is possibly "undefined" (TS2532)')).toBe(true);
    expect(
      resolveClauseSourceKind({
        id: 1,
        text: 'Object is possibly "undefined" (TS2532)',
        artifact_path: "src/a.ts",
        ambiguous: false,
      }),
    ).toBe("defect-description");
  });

  it("collects inline and heading Done-when lines", () => {
    expect(collectDoneWhenLines("Done when task check exits 0\n")).toEqual([
      "Done when task check exits 0",
    ]);
    expect(
      collectDoneWhenLines(`## Done when
- npm run check exits 0
`),
    ).toEqual(["npm run check exits 0"]);
  });

  it("marks missing defect tokens unverifiable and non-adjudicable", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-5393-absent-"));
    writeFileSync(join(root, "fixed.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: 'fails with "possibly undefined"',
          artifact_path: "fixed.ts",
          ambiguous: false,
          source_kind: "defect-description",
        },
      ],
      root,
      { declaredScope: ["fixed.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
    expect(countUnverifiedAdjudicableClauses(report.clauses)).toBe(0);
  });

  it("does not credit verified when defect tokens remain present", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-5393-present-"));
    writeFileSync(join(root, "still.ts"), "possibly undefined\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: 'error quotes "possibly undefined"',
          artifact_path: "still.ts",
          ambiguous: false,
          source_kind: "defect-description",
        },
      ],
      root,
      { declaredScope: ["still.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
    expect(report.clauses[0]?.outcome).not.toBe("verified");
  });

  it("uses text-local fallback when source_kind is absent on a stamped defect row", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-5393-legacy-"));
    writeFileSync(join(root, "fixed.ts"), "export const ok = true;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: 'TS2532 Object is possibly "undefined"',
          artifact_path: "fixed.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["fixed.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
  });

  it("marks missing defect-description artifacts unverifiable and non-adjudicable", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-5393-missing-"));
    const report = walkAcceptanceClauses(
      [
        {
          id: 1,
          text: 'fails with "possibly undefined"',
          artifact_path: "missing.ts",
          ambiguous: false,
          source_kind: "defect-description",
        },
      ],
      root,
      { declaredScope: ["missing.ts"] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
    expect(report.clauses[0]?.outcome).not.toBe("failed");
  });
});

describe("quoted-token removal polarity (#6269)", () => {
  const DOC = "docs/x.md";

  function rootWithDoc(body: string): string {
    const root = mkdtempSync(join(tmpdir(), "clause-6269-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, DOC), body, "utf8");
    return root;
  }

  function clause(text: string, artifactPath: string | null = DOC) {
    return { id: 1, text, artifact_path: artifactPath, ambiguous: false };
  }

  function walkText(text: string, body: string) {
    return walkAcceptanceClauses([clause(text)], rootWithDoc(body), { declaredScope: [DOC] })
      .clauses[0];
  }

  const REMOVAL_FORMS = [
    'Removes "old phrase" from docs/x.md',
    'Remove "old phrase" from docs/x.md.',
    'Deletes "old phrase" from `docs/x.md`',
    'Delete "old phrase"',
    'Drops "old phrase" from ./docs/x.md',
    'Drop "old phrase" from "docs/x.md"',
    'Recuts "old phrase" from docs/x.md',
    'Recut "old phrase"',
    'docs/x.md no longer contains "old phrase"',
    '`docs/x.md` no longer contains "old phrase".',
  ];

  for (const text of REMOVAL_FORMS) {
    it(`verifies when the literal is absent and fails when present: ${text}`, () => {
      const absent = walkText(text, "the new phrase only\n");
      expect(absent?.outcome).toBe("verified");
      expect(absent?.adjudicable).toBe(true);
      const present = walkText(text, "still has the old phrase here\n");
      expect(present?.outcome).toBe("failed");
      expect(present?.detail).toMatch(/still in docs\/x\.md: old phrase/);
    });
  }

  it("checks all four replace combinations: only X absent and Y present verifies", () => {
    const text = 'Replaces "old phrase" with "new phrase" in docs/x.md';
    expect(walkText(text, "the new phrase\n")?.outcome).toBe("verified");
    expect(walkText(text, "the old phrase and the new phrase\n")?.outcome).toBe("failed");
    expect(walkText(text, "the old phrase\n")?.outcome).toBe("failed");
    // Must-not (clause-wide flip): both literals absent is failed, not verified.
    const neither = walkText(text, "nothing relevant\n");
    expect(neither?.outcome).toBe("failed");
    expect(neither?.detail).toMatch(/expected token\(s\) missing from docs\/x\.md: new phrase/);
    expect(walkText('Replace "old phrase" with "new phrase"', "the new phrase\n")?.outcome).toBe(
      "verified",
    );
  });

  it("keeps the presence check for spans no closed form governs", () => {
    const text = 'Adds "new phrase" to docs/x.md';
    expect(walkText(text, "the new phrase\n")?.outcome).toBe("verified");
    expect(walkText(text, "nothing\n")?.outcome).toBe("failed");
    expect(classifyQuotedTokenPolarity(clause(text))).toEqual({
      kind: "presence",
      present: ["new phrase"],
    });
  });

  it("does not read removal words inside a quoted literal or inline code as a verb", () => {
    expect(classifyQuotedTokenPolarity(clause('Logs "removed from cache"')).kind).toBe("presence");
    expect(classifyQuotedTokenPolarity(clause('`scope:remove` prints "all done"')).kind).toBe(
      "presence",
    );
    expect(classifyQuotedTokenPolarity(clause('scope:remove prints "all done"')).kind).toBe(
      "presence",
    );
    expect(
      classifyQuotedTokenPolarity(clause('Adds "all done" to docs/remove-me.md', null)).kind,
    ).toBe("presence");
  });

  const UNRESOLVED: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["negated removal verb", 'Does not remove "old phrase" from docs/x.md', /negated/],
    ["two governing verbs", 'Removes and adds "old phrase" in docs/x.md', /more than one/],
    [
      "same literal under both polarities",
      'Removes "old phrase" from docs/x.md and keeps "old phrase"',
      /more than once/,
    ],
    ["replace with no with", 'Replaces "old phrase" in docs/x.md', /replace with no with/],
    ["X equal to Y", 'Replaces "old phrase" with "old phrase"', /equals its replacement/],
    [
      "object not exactly the quoted span",
      'Removes the "old phrase" heading from docs/x.md',
      /not exactly one quoted span/,
    ],
    ["past-tense removal", '"old phrase" is removed from docs/x.md', /not exactly one/],
    ["another path", 'Removes "old phrase" from docs/other.md', /other than the bound/],
  ];

  for (const [name, text, reason] of UNRESOLVED) {
    it(`returns adjudicable unverifiable, never verified, for ${name}`, () => {
      for (const body of ["the old phrase\n", "nothing\n"]) {
        const row = walkText(text, body);
        expect(row?.outcome).toBe("unverifiable");
        expect(row?.adjudicable).toBe(true);
        expect(row?.detail).toMatch(reason);
        expect(row?.detail).toContain('Removes|Deletes|Drops|Recuts "X"');
        expect(row?.detail).toContain('PATH no longer contains "X"');
        expect(row?.detail).toContain('Replaces "X" with "Y"');
      }
    });
  }

  it("keeps each quoted span with its own position, with no dedupe before polarity", () => {
    const text = 'Removes "old phrase" from docs/x.md and keeps "old phrase"';
    const spans = extractQuotedSpans(clause(text));
    expect(spans.map((s) => s.token)).toEqual(["old phrase", "old phrase"]);
    expect(spans[1]?.start).toBeGreaterThan(spans[0]?.start ?? 0);
    expect(text.slice(spans[1]?.start, spans[1]?.end)).toBe('"old phrase"');
    // The legacy expected-token list still dedupes for presence-only callers.
    expect(extractExpectedTokens(clause(text))).toEqual(["old phrase"]);
    // The second span is evaluated: the clause is unresolved, not a clean removal.
    expect(classifyQuotedTokenPolarity(clause(text)).kind).toBe("unresolved");
  });

  it("pairs quotes in order so a closing quote never opens a literal", () => {
    // A regex retry used to capture the text between two short literals.
    expect(extractQuotedSpans(clause('Closed replace form: `Replaces "X" with "Y"`'))).toEqual([]);
    expect(
      extractQuotedSpans(clause('Replaces "ab" with "new phrase"')).map((s) => s.token),
    ).toEqual(["new phrase"]);
    expect(
      classifyQuotedTokenPolarity(clause('Closed replace form: `Replaces "X" with "Y"`')).kind,
    ).toBe("none");
  });

  it("keeps inner quotes of the other kind inside the outer literal", () => {
    const text = `Removes "the 'old' phrase" from docs/x.md`;
    expect(extractQuotedSpans(clause(text)).map((s) => s.token)).toEqual(["the 'old' phrase"]);
    expect(walkText(text, "the old phrase and the 'new' one\n")?.outcome).toBe("verified");
    expect(walkText(text, "keeps the 'old' phrase\n")?.outcome).toBe("failed");
    expect(extractQuotedSpans(clause(`Logs 'say "hello" now'`, null)).map((s) => s.token)).toEqual([
      'say "hello" now',
    ]);
  });

  it("checks a quoted file-path literal named as the removal object", () => {
    const text = 'Removes "legacy.ts" from docs/x.md';
    expect(classifyQuotedTokenPolarity(clause(text))).toEqual({
      kind: "absence",
      absent: ["legacy.ts"],
      present: [],
    });
    expect(walkText(text, "imports nothing\n")?.outcome).toBe("verified");
    expect(walkText(text, "import from legacy.ts\n")?.outcome).toBe("failed");
    // The presence check still skips path-shaped literals, as before.
    expect(extractExpectedTokens(clause('Adds "legacy.ts" to the list'))).toEqual([]);
    expect(classifyQuotedTokenPolarity(clause('Adds "legacy.ts" to the list')).kind).toBe("none");
    // Single-quoted and plural forms take the same path-literal object.
    expect(walkText("Delete 'legacy.ts'", "import from legacy.ts\n")?.outcome).toBe("failed");
    expect(walkText('Drops "src/legacy.ts" from docs/x.md', "nothing\n")?.outcome).toBe("verified");
  });

  it("blocks a closed form whose only quoted object is the bound path", () => {
    for (const text of ['Removes "docs/x.md"', 'Deletes "docs/x.md" from docs/x.md']) {
      for (const body of ["docs/x.md is listed\n", "nothing\n"]) {
        const row = walkText(text, body);
        expect(row?.outcome).toBe("unverifiable");
        expect(row?.adjudicable).toBe(true);
        expect(row?.detail).toMatch(/object is the bound artifact path/);
      }
    }
  });

  it("accepts a quoted bound path and refuses a basename-only path", () => {
    expect(walkText('Removes "old phrase" from "docs/x.md"', "nothing\n")?.outcome).toBe(
      "verified",
    );
    expect(classifyQuotedTokenPolarity(clause('Removes stale rows from "docs/x.md"')).kind).toBe(
      "none",
    );
    const basename = walkText('Removes "old phrase" from x.md', "nothing\n");
    expect(basename?.outcome).toBe("unverifiable");
    expect(basename?.detail).toMatch(/other than the bound/);
  });

  it("treats a colon after the removal verb as prose, not a command name", () => {
    const row = walkText('Removes: "old phrase" from docs/x.md', "keeps the old phrase\n");
    expect(row?.outcome).toBe("unverifiable");
    expect(row?.adjudicable).toBe(true);
  });

  it("keeps ok false when an unresolved row has a verified sibling", () => {
    const root = rootWithDoc("the new phrase\n");
    const report = walkAcceptanceClauses(
      [
        { ...clause('Removes "old phrase" from docs/x.md'), id: 1 },
        { ...clause('Does not remove "old phrase" from docs/x.md'), id: 2 },
      ],
      root,
      { declaredScope: [DOC] },
    );
    expect(report.verified.map((r) => r.id)).toEqual([1]);
    expect(report.failed).toEqual([]);
    expect(countUnverifiedAdjudicableClauses(report.clauses)).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("classifies token absence before the bound-artifact absence branch", () => {
    // The literal holds an ABSENCE_ALTERNATION phrase and the clause names the
    // bound path, which used to route to the path-absence failed row.
    const text = 'Removes "must be absent" from docs/x.md';
    const row = walkText(text, "the rule text is gone\n");
    expect(row?.outcome).toBe("verified");
    expect(row?.detail).not.toMatch(/requires absence/);
    expect(walkText(text, "this must be absent\n")?.outcome).toBe("failed");
  });

  it("keeps the path-absence row for a clause with no quoted span", () => {
    const row = walkText("docs/x.md must be absent", "anything\n");
    expect(row?.outcome).toBe("failed");
    expect(row?.detail).toMatch(/clause requires absence/);
  });

  it("keeps the path-absence row for a presence span with a path-absence phrase", () => {
    const row = walkText('docs/x.md must be absent and "anything" stays', "anything\n");
    expect(row?.outcome).toBe("failed");
    expect(row?.detail).toMatch(/clause requires absence/);
  });

  it("runs the scope, existence and file-type guards before any token check", () => {
    const root = rootWithDoc("nothing\n");
    mkdirSync(join(root, "docs", "dir.md"), { recursive: true });
    const report = walkAcceptanceClauses(
      [
        { ...clause('Removes "old phrase" from docs/gone.md', "docs/gone.md"), id: 1 },
        { ...clause('Removes "old phrase" from docs/dir.md', "docs/dir.md"), id: 2 },
        { ...clause('Removes "old phrase" from docs/undeclared.md', "docs/undeclared.md"), id: 3 },
      ],
      root,
      { declaredScope: ["docs/gone.md", "docs/dir.md"] },
    );
    expect(report.clauses[0]?.outcome).toBe("failed");
    expect(report.clauses[0]?.detail).toMatch(/artifact missing/);
    expect(report.clauses[1]?.outcome).toBe("failed");
    expect(report.clauses[1]?.detail).toMatch(/not a shipped file/);
    expect(report.clauses[2]?.outcome).toBe("unverifiable");
    expect(report.clauses[2]?.adjudicable).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("matches the exact literal: case and inner whitespace stay significant", () => {
    const text = 'Removes "Old  Phrase" from docs/x.md';
    expect(walkText(text, "old phrase\nOld Phrase\nOLD  PHRASE\n")?.outcome).toBe("verified");
    expect(walkText(text, "keeps Old  Phrase\n")?.outcome).toBe("failed");
  });

  it("keeps quoted whitespace through stored and derived clauses", () => {
    const text = 'Removes  "Old  Phrase"\tfrom docs/x.md';
    const stored = readAcceptanceClauses({
      clauses: [{ id: 1, text, artifact_path: DOC, ambiguous: false }],
    });
    // Whitespace outside the quotes collapses; inside the literal it is kept.
    expect(stored[0]?.text).toBe('Removes "Old  Phrase" from docs/x.md');
    const { clauses: derived } = stampDerivedClausesOnAcceptance(
      {
        items: [{ title: text, narrative: {} }],
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      "Title only",
    );
    expect(derived[0]?.text).toBe('Removes "Old  Phrase" from docs/x.md');
    for (const clauses of [
      stored,
      bindClausesToDeclaredScope(derived, [DOC], rootWithDoc("")).clauses,
    ]) {
      const failRoot = rootWithDoc("still has Old  Phrase\n");
      expect(
        walkAcceptanceClauses(clauses, failRoot, { declaredScope: [DOC] }).clauses[0]?.outcome,
      ).toBe("failed");
      const passRoot = rootWithDoc("now says Old Phrase\n");
      expect(
        walkAcceptanceClauses(clauses, passRoot, { declaredScope: [DOC] }).clauses[0]?.outcome,
      ).toBe("verified");
    }
  });

  it("maps a quoted-spacing sentence to its clause in sentence coverage", () => {
    const clauseText = 'Removes "Old  Phrase" from the guide';
    // Intake now keeps quoted spacing when it extracts statement sentences.
    expect(extractStatementSentences(`- ${clauseText}\n`)).toEqual([clauseText]);
    const clauses = [clause(clauseText)];
    // A sentence stored by an older intake (spacing collapsed) still maps.
    for (const sentence of [clauseText, 'Removes "Old Phrase" from the guide']) {
      const coverage = evaluateStatementSentenceCoverage({ sentences: [sentence] }, clauses);
      expect(coverage.unmappedSentenceCount).toBe(0);
    }
    const confessed = evaluateStatementSentenceCoverage(
      { sentences: ["Not a  clause"], confessions: ["Not a clause"] },
      clauses,
    );
    expect(confessed.unmappedSentenceCount).toBe(0);
  });

  it("leaves the #5393 defect-description exemption unchanged", () => {
    const root = rootWithDoc("still says possibly undefined\n");
    const report = walkAcceptanceClauses(
      [
        {
          ...clause('Removes "possibly undefined" from docs/x.md'),
          source_kind: "defect-description" as const,
        },
      ],
      root,
      { declaredScope: [DOC] },
    );
    expect(report.clauses[0]?.outcome).toBe("unverifiable");
    expect(report.clauses[0]?.adjudicable).toBe(false);
  });

  it("counts a removal-only clause as a token clause, not a behavioral one", () => {
    const removal = clause('Removes "old phrase" from docs/x.md');
    const coverage = evaluateStatementSentenceCoverage({ sentences: [removal.text] }, [removal]);
    expect(coverage.behavioralClauseCount).toBe(0);
    expect(
      evaluateStatementSentenceCoverage({}, [clause("a behavioral claim with no literal")])
        .behavioralClauseCount,
    ).toBe(1);
  });

  it("walks a removal clause derived from plan.items", () => {
    const { clauses } = stampDerivedClausesOnAcceptance(
      {
        items: [{ title: 'Removes "old phrase" from docs/x.md', narrative: {} }],
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      "Title only",
    );
    const root = rootWithDoc("the new phrase\n");
    const bound = bindClausesToDeclaredScope(clauses, [DOC], root);
    expect(bound.ok).toBe(true);
    expect(bound.clauses[0]?.artifact_path).toBe(DOC);
    const report = walkAcceptanceClauses(bound.clauses, root, { declaredScope: [DOC] });
    expect(report.clauses[0]?.outcome).toBe("verified");
    expect(report.ok).toBe(true);
    writeFileSync(join(root, DOC), "the old phrase\n", "utf8");
    expect(walkAcceptanceClauses(bound.clauses, root, { declaredScope: [DOC] }).ok).toBe(false);
  });
});
