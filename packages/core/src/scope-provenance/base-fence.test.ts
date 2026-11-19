import { describe, expect, it } from "vitest";
import { loadRefusalDeclarations } from "../refusal-declarations/table.js";
import {
  evaluateApprovedScopeMembership,
  evaluateProductionScopeFence,
  isConcreteFileScopeEntry,
  isTestOrFixturePath,
  PRODUCTION_ALLOWANCE_CAP,
  PRODUCTION_ALLOWANCE_FLOOR,
  productionAllowance,
} from "./base-fence.js";

/** The shipped rows with every row set to enforce: the refusal a later release ships. */
const ENFORCE_ROWS = loadRefusalDeclarations().map((row) => ({ ...row, mode: "enforce" as const }));

describe("production allowance (#4956)", () => {
  it("clamps concrete production count to floor 2 and cap 5", () => {
    expect(productionAllowance(0)).toBe(PRODUCTION_ALLOWANCE_FLOOR);
    expect(productionAllowance(1)).toBe(PRODUCTION_ALLOWANCE_FLOOR);
    expect(productionAllowance(3)).toBe(3);
    expect(productionAllowance(10)).toBe(PRODUCTION_ALLOWANCE_CAP);
  });

  it("treats globs as non-concrete", () => {
    expect(isConcreteFileScopeEntry("packages/core/src/a.ts")).toBe(true);
    expect(isConcreteFileScopeEntry("packages/core/src/**")).toBe(false);
    expect(isConcreteFileScopeEntry("src/*.ts")).toBe(false);
  });
});

describe("evaluateProductionScopeFence (#4956)", () => {
  it("accepts empty merge-base file_scope with no production finding (#3715)", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: [],
      changedFiles: ["packages/core/src/a.ts", "packages/core/src/b.ts", "packages/core/src/c.ts"],
    });
    expect(hit).toBeNull();
  });

  it("spends the allowance on test-root modifies; CHANGELOG stays free (#6221)", () => {
    expect(isTestOrFixturePath("packages/core/src/foo.test.ts")).toBe(true);
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/a.ts",
        "packages/core/src/a.test.ts",
        "tests/helpers/probe.ts",
        "CHANGELOG.md",
      ],
      changeKind: () => "modify",
    });
    expect(hit).toBeNull();
  });

  it("refuses test-root paths with an unknown or add change kind once the row enforces (#6221)", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/a.ts", "packages/core/src/a.test.ts"],
      refusalRows: ENFORCE_ROWS,
    });
    expect(hit?.kind).toBe("production-scope-over-budget");
    expect(hit?.detail).toContain("extra-path-not-admitted");
  });

  it("warns for one release instead of refusing a test add; the line names the row and remedy (#6281)", () => {
    const warnings: string[] = [];
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/a.ts", "packages/core/src/a.test.ts"],
      onWarning: (line) => warnings.push(line),
    });
    expect(hit).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deft gate extra-path-not-admitted");
    expect(warnings[0]).toContain("can refuse from a later release");
    expect(warnings[0]).toContain("Remedy: `deft verify:scope-provenance`");
  });

  it("refuses a third test modify past the allowance with the shared token once the row enforces (#6221)", () => {
    const input = {
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/a.test.ts",
        "packages/core/src/b.test.ts",
        "packages/core/src/c.ts",
      ],
      changeKind: () => "modify" as const,
    };
    const hit = evaluateProductionScopeFence({ ...input, refusalRows: ENFORCE_ROWS });
    expect(hit?.detail).toContain("extra-paths-over-budget");
    expect(hit?.remediation).toMatch(/follow-up story/i);
    // Warn mode: the overflow comes from a test modify, a new refusal, so it warns.
    const warnings: string[] = [];
    expect(
      evaluateProductionScopeFence({ ...input, onWarning: (l) => warnings.push(l) }),
    ).toBeNull();
    expect(warnings[0]).toContain("deft gate extra-paths-over-budget");
  });

  it("keeps refusing production extras past the allowance in warn mode (refused before #6221)", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/b.ts", "packages/core/src/c.ts", "packages/core/src/d.ts"],
    });
    expect(hit?.kind).toBe("production-scope-over-budget");
  });

  it("under a mint, globs match but a broader mint does not widen the brief (#6221 / #5192)", () => {
    const changedFiles = [
      "packages/core/src/b.ts",
      "packages/core/src/c.ts",
      "packages/core/src/d.ts",
    ];
    const globBrief = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/**"],
      mintFileScope: ["packages/core/src/**"],
      changedFiles,
    });
    expect(globBrief).toBeNull();
    const narrowBrief = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      mintFileScope: ["packages/core/src/**"],
      changedFiles,
    });
    expect(narrowBrief?.detail).toContain("extra-paths-over-budget");
  });

  it("ignores other-class paths on the Path-independent check and reports them free (#6221)", () => {
    const seen: string[] = [];
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["docs/x.md", "content/y.md", "README.md"],
      onAssessment: (a) => {
        for (const e of a.entries) seen.push(`${e.path}:${e.pathClass}:${e.spend}`);
      },
    });
    expect(hit).toBeNull();
    expect(seen).toEqual([
      "docs/x.md:other:free",
      "content/y.md:other:free",
      "README.md:other:free",
    ]);
  });

  it("admits production extras inside the allowance", () => {
    // concrete base count 1 → allowance 2
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/a.ts", "packages/core/src/b.ts", "packages/core/src/c.ts"],
    });
    expect(hit).toBeNull();
  });

  it("fails past the cap with split remediation and no remint", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/b.ts", "packages/core/src/c.ts", "packages/core/src/d.ts"],
    });
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("production-scope-over-budget");
    expect(hit?.allowance).toBe(2);
    expect(hit?.remediation).toMatch(/follow-up story/i);
    expect(hit?.remediation).not.toMatch(/record-approved-scope/);
    expect(hit?.remediation).not.toMatch(/\bmint\b/);
  });

  it("does not treat head-only scope widening as authority (caller omits head)", () => {
    // Fence input is base scope only; extras are computed from changed files.
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/a.ts"],
      changedFiles: [
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
      ],
    });
    expect(hit?.kind).toBe("production-scope-over-budget");
    expect(hit?.expandedPaths.length).toBe(5);
  });

  it("counts only concrete production entries for the denominator", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/**", "packages/core/src/a.ts"],
      changedFiles: ["packages/core/src/a.ts", "packages/cli/src/z.ts"],
    });
    // glob is not concrete; concrete count 1 → allowance 2; one extra lands
    expect(hit).toBeNull();
  });

  it("treats glob matches as extras without a mint (#6221 glob tightening)", () => {
    const hit = evaluateProductionScopeFence({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      baseFileScope: ["packages/core/src/authz/**"],
      changedFiles: [
        "packages/core/src/authz/a.ts",
        "packages/core/src/authz/b.ts",
        "packages/core/src/authz/c.ts",
      ],
    });
    expect(hit?.kind).toBe("production-scope-over-budget");
    expect(hit?.detail).toContain("extra-paths-over-budget");
    expect(hit?.remediation).toContain("replace glob entries with concrete paths");
  });
});

describe("spec-drift ledger membership under the completion-move shape (#680 P5 / #6231)", () => {
  const LEDGER = "xbrief/.audit/spec-drift-ledger.json";
  const base = {
    xbriefRelPath: "xbrief/active/story.xbrief.json",
    planId: "story-1",
    xbriefModifiedInChangeSet: true,
    baseApprovedFileScope: ["packages/core/src/a.ts"],
    allowlistAuthority: "precommitment" as const,
    exemptRelPaths: ["xbrief/completed/story.xbrief.json"],
  };

  it("admits the ledger beside the completed brief move", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        LEDGER,
        "CHANGELOG.md",
      ],
    });
    expect(hit).toBeNull();
  });

  it("refuses the ledger beside an unrelated production file", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        LEDGER,
        "packages/core/src/a.ts",
      ],
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toEqual([LEDGER]);
  });

  it("refuses the ledger when no brief moves to completed/", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      exemptRelPaths: [],
      changedFiles: ["xbrief/active/story.xbrief.json", LEDGER],
    });
    expect(hit?.expandedPaths).toEqual([LEDGER]);
  });

  it("admits only the exact ledger path, not a sibling audit file", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        "xbrief/.audit/authority-events.jsonl",
      ],
    });
    expect(hit?.expandedPaths).toEqual(["xbrief/.audit/authority-events.jsonl"]);
  });

  it("admits spec-drift row files beside the completed brief move (#6335)", () => {
    const ROW = "xbrief/.audit/spec-drift/story-1.json";
    expect(
      evaluateApprovedScopeMembership({
        ...base,
        changedFiles: [
          "xbrief/active/story.xbrief.json",
          "xbrief/completed/story.xbrief.json",
          ROW,
          "xbrief/.audit/spec-drift/other-story.json",
        ],
      }),
    ).toBeNull();
    const withProduct = evaluateApprovedScopeMembership({
      ...base,
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
        ROW,
        "packages/core/src/a.ts",
      ],
    });
    expect(withProduct?.expandedPaths).toEqual([ROW]);
  });

  it("admits PROJECT-DEFINITION beside the completed brief move only with a registry-only proof (#6764)", () => {
    const PD = "xbrief/PROJECT-DEFINITION.xbrief.json";
    const ROW = "xbrief/.audit/spec-drift/story-1.json";
    const move = ["xbrief/active/story.xbrief.json", "xbrief/completed/story.xbrief.json", ROW, PD];
    expect(
      evaluateApprovedScopeMembership({
        ...base,
        projectDefinitionRegistryOnly: true,
        changedFiles: move,
      }),
    ).toBeNull();
    // Without the content proof (e.g. a policy edit rides along), the registry
    // is never free, so the row file loses the completion shape too.
    const unproven = evaluateApprovedScopeMembership({ ...base, changedFiles: move });
    expect(unproven?.expandedPaths).toEqual(expect.arrayContaining([ROW, PD]));
    const withProduct = evaluateApprovedScopeMembership({
      ...base,
      projectDefinitionRegistryOnly: true,
      changedFiles: [...move, "packages/core/src/a.ts"],
    });
    expect(withProduct?.expandedPaths).toEqual(expect.arrayContaining([ROW, PD]));
    expect(withProduct?.expandedPaths).toHaveLength(2);
    const noCompletion = evaluateApprovedScopeMembership({
      ...base,
      projectDefinitionRegistryOnly: true,
      exemptRelPaths: [],
      changedFiles: ["xbrief/active/story.xbrief.json", PD],
    });
    expect(noCompletion?.expandedPaths).toEqual([PD]);
  });
});

describe("evaluateApprovedScopeMembership (#4774)", () => {
  it("allows first-story when declared file_scope covers the change set", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", "CHANGELOG.md"],
    });
    expect(hit).toBeNull();
  });

  it("allows xBRIEF-only change set when allowlist is missing (#5192)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: null,
      allowlistAuthority: "missing",
      changedFiles: ["xbrief/active/story.xbrief.json", "CHANGELOG.md"],
    });
    expect(hit).toBeNull();
  });

  it("fails closed when non-exempt product paths ride with no declared allowlist", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: null,
      allowlistAuthority: "missing",
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts", ".gitignore"],
    });
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
    expect(hit?.expandedPaths).toEqual(
      expect.arrayContaining(["packages/core/src/a.ts", ".gitignore"]),
    );
    expect(hit?.remediation).toMatch(/not undeclared-by-design attestation/i);
    expect(hit?.remediation).toMatch(/Same-PR approval rewrite stays fail-closed/i);
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("peer coverage does not clear a missing own allowlist", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      planId: "story-a",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: null,
      peerXbriefRelPaths: ["xbrief/active/story-b.xbrief.json"],
      peerApprovedFileScopes: [["packages/core/src/a.ts"]],
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
      ],
    });
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
    expect(hit?.expandedPaths).toContain("packages/core/src/a.ts");
  });

  it("unions peer approved scopes so multi-story PRs do not flag peer files", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      planId: "story-a",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      peerXbriefRelPaths: ["xbrief/active/story-b.xbrief.json"],
      peerApprovedFileScopes: [["packages/core/src/b.ts"]],
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "xbrief/active/story-b.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "CHANGELOG.md",
      ],
    });
    expect(hit).toBeNull();
  });

  it("still flags paths outside own and peer approved scopes", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story-a.xbrief.json",
      planId: "story-a",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "mint",
      peerXbriefRelPaths: ["xbrief/active/story-b.xbrief.json"],
      peerApprovedFileScopes: [["packages/core/src/b.ts"]],
      changedFiles: [
        "xbrief/active/story-a.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/orphan.ts",
        ".gitignore",
      ],
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain(".gitignore");
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("admits one in-allowance concrete source-root extra under a mint (#5192)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "mint",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
      ],
    });
    expect(hit).toBeNull();
  });

  it("admits one undeclared test modify inside the allowance (#6221 / #5710 case)", () => {
    const seen: string[] = [];
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "precommitment",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/x/bank.test.ts",
      ],
      changeKind: () => "modify",
      onAssessment: (a) => {
        for (const e of a.entries) seen.push(`${e.path}:${e.pathClass}:${e.spend}`);
      },
    });
    expect(hit).toBeNull();
    expect(seen).toEqual(["packages/core/src/x/bank.test.ts:test:spent"]);
  });

  it("refuses a test add and an over-budget test modify with the shared tokens (#6221)", () => {
    const kinds: Record<string, "modify" | "add"> = {
      "packages/core/src/new.test.ts": "add",
      "packages/core/src/b.test.ts": "modify",
      "packages/core/src/c.test.ts": "modify",
      "packages/core/src/d.test.ts": "modify",
    };
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "precommitment",
      changedFiles: ["xbrief/active/story.xbrief.json", ...Object.keys(kinds)],
      changeKind: (rel) => kinds[rel] ?? null,
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toEqual([
      "packages/core/src/new.test.ts",
      "packages/core/src/d.test.ts",
    ]);
    expect(hit?.detail).toContain("extra-paths-over-budget");
    expect(hit?.detail).toContain("extra-path-not-admitted");
  });

  it("still refuses other-class undeclared paths at membership (#6221 residual)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "precommitment",
      changedFiles: ["xbrief/active/story.xbrief.json", "docs/notes.md"],
      changeKind: () => "modify",
    });
    expect(hit?.expandedPaths).toEqual(["docs/notes.md"]);
  });

  it("refuses undeclared test paths even when source-root extras are in allowance (#5192)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "precommitment",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "tests/helpers/probe.ts",
      ],
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.expandedPaths).toContain("tests/helpers/probe.ts");
    expect(hit?.remediation).toMatch(/widened concrete brief|follow-up story/i);
    expect(hit?.remediation).not.toMatch(/renewed merge-base approval/i);
  });

  it("does not admit glob-only precommitment matches without a mint (#5192 F4)", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/**"],
      allowlistAuthority: "precommitment",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/core/src/c.ts",
        "packages/core/src/d.ts",
        "packages/core/src/e.ts",
        "packages/core/src/f.ts",
      ],
    });
    // Glob filtered out → no concrete allowlist → C24-style missing declaration.
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
  });
});

describe("forge-approval membership authority (#6203)", () => {
  const base = {
    xbriefRelPath: "xbrief/active/story.xbrief.json",
    planId: "story-1",
    xbriefModifiedInChangeSet: true,
    allowlistAuthority: "forge-approval" as const,
  };

  it("admits concrete head entries", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      baseApprovedFileScope: ["packages/core/src/a.ts", "tests/helpers/probe.ts"],
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "tests/helpers/probe.ts",
      ],
    });
    expect(hit).toBeNull();
  });

  it("never admits glob entries (same F4 rule as precommitment)", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      baseApprovedFileScope: ["packages/core/src/a.ts", "tests/**"],
      changedFiles: ["xbrief/active/story.xbrief.json", "tests/helpers/probe.ts"],
    });
    expect(hit?.kind).toBe("change-set-outside-approved-scope");
    expect(hit?.detail).toMatch(/forge-approved head brief \(#6203\)/);
    expect(hit?.remediation).toMatch(/fresh qualifying human approval/);
  });

  it("treats an empty head scope as no declaration, not an authoritative mint", () => {
    const hit = evaluateApprovedScopeMembership({
      ...base,
      baseApprovedFileScope: [],
      changedFiles: ["xbrief/active/story.xbrief.json", "packages/core/src/a.ts"],
    });
    expect(hit?.kind).toBe("active-xbrief-modified-without-digest");
  });
});

describe("changelog entry paths on the fence and membership (#6314)", () => {
  it("frees a changelog.d fragment in membership like CHANGELOG.md", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "mint",
      changedFiles: [
        "xbrief/active/story.xbrief.json",
        "packages/core/src/a.ts",
        "CHANGELOG.md",
        "changelog.d/6314-x.md",
      ],
    });
    expect(hit).toBeNull();
  });

  it("still flags a nested changelog.d path outside the approved scope", () => {
    const hit = evaluateApprovedScopeMembership({
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      planId: "story-1",
      xbriefModifiedInChangeSet: true,
      baseApprovedFileScope: ["packages/core/src/a.ts"],
      allowlistAuthority: "mint",
      changedFiles: ["xbrief/active/story.xbrief.json", "changelog.d/sub/x.md"],
    });
    expect(hit?.expandedPaths).toContain("changelog.d/sub/x.md");
  });
});
