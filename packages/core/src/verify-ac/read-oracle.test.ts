/**
 * #3835: `verify:ac` selected the file to read, and the needle to match, from
 * untrusted issue prose, then reported a discriminating answer.
 *
 * The attack below was constructed end to end against the pre-fix head. It needs
 * no injection-shaped payload and no unusual issue: a third-party comment on any
 * issue whose body carries no checkboxes and no `## Acceptance` heading is enough,
 * and this repository is public.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AcceptanceClause,
  deriveAcceptanceClauses,
  isDeclaredArtifactPath,
  readDeclaredArtifactScope,
  walkAcceptanceClauses,
} from "./clauses.js";

/**
 * No checkbox list and no acceptance heading, so the three primary extractors
 * return zero and derivation falls through to path-bearing bullets — which reads
 * the comment thread, not just the body.
 */
const HOSTILE_STATEMENT_BODY = `
bug(session): the occupancy lease survives a host kill

## Summary

Analysis prose describing a lease that is never released. There is no acceptance
list here and no acceptance heading, which is the ordinary shape of a filed bug.
`;

/** The attacker controls both the path and the needle, in one ordinary bullet. */
function hostileComment(needle: string): string {
  return `
### Comment by @drive-by

- The repository config at \`.git/config\` at its stated path contains "${needle}".
`;
}

function attackClause(needle: string): AcceptanceClause {
  return {
    id: 1,
    text: `The repository config at \`.git/config\` at its stated path contains "${needle}"`,
    artifact_path: ".git/config",
    ambiguous: false,
  };
}

function rootWithGitConfig(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".git", "config"),
    '[remote "origin"]\n\turl = https://example.invalid/secret-repo.git\n',
    "utf8",
  );
  return root;
}

const PRESENT_NEEDLE = "url = https://example.invalid/secret-repo.git";
const ABSENT_NEEDLE = "url = https://example.invalid/other-repo.git";

describe("untrusted prose cannot select the artifact (#3835)", () => {
  it("derives the third-party clause but binds no path from it", () => {
    const clauses = deriveAcceptanceClauses(
      HOSTILE_STATEMENT_BODY + hostileComment(PRESENT_NEEDLE),
    );
    // The line is still transcribed — this fix is about the binding, not about
    // filtering which prose becomes a clause, which was measured to narrow the
    // attack surface by zero.
    expect(clauses.length).toBeGreaterThan(0);
    expect(clauses.some((clause) => clause.text.includes(".git/config"))).toBe(true);
    expect(clauses.every((clause) => clause.artifact_path === null)).toBe(true);
    expect(clauses.every((clause) => clause.ambiguous === false)).toBe(true);
    expect(clauses.every((clause) => (clause.readings ?? []).length === 0)).toBe(true);
  });

  it("binds no path even when the prose names a file that exists and is in scope", () => {
    const clauses = deriveAcceptanceClauses(`
## Acceptance Criteria
- Write the helper to packages/core/src/verify-ac/clauses.ts
`);
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.artifact_path).toBeNull();
  });
});

describe("the walk reads nothing it was not told to read (#3835)", () => {
  it("gives the same answer whether or not the attacker's needle is present", () => {
    const root = rootWithGitConfig("clause-3835-oracle-");
    const walkFor = (needle: string) =>
      walkAcceptanceClauses([attackClause(needle)], root, { declaredScope: [] }).clauses[0];

    const hit = walkFor(PRESENT_NEEDLE);
    const miss = walkFor(ABSENT_NEEDLE);

    // Non-discrimination is the property, not the label: pre-fix these were
    // `verified` and `failed`, which is a one-bit read of the file's contents.
    expect(hit?.outcome).toBe("unverifiable");
    expect(miss?.outcome).toBe(hit?.outcome);
    expect(miss?.detail).toBe(hit?.detail);
    expect(hit?.detail).toContain("plan.metadata.swarm.file_scope");
    expect(hit?.detail).not.toContain("secret-repo");
    expect(hit?.detail).not.toContain("other-repo");
  });

  it("gives the same answer whether or not the attacker's path exists at all", () => {
    const root = rootWithGitConfig("clause-3835-existence-");
    const walkOneAt = (artifactPath: string) =>
      walkAcceptanceClauses(
        [
          {
            id: 1,
            text: `the artifact exists at its stated path \`${artifactPath}\``,
            artifact_path: artifactPath,
            ambiguous: false,
          },
        ],
        root,
        { declaredScope: [] },
      ).clauses[0];

    expect(walkOneAt(".git/config")?.outcome).toBe("unverifiable");
    expect(walkOneAt("no/such/file.ts")?.outcome).toBe("unverifiable");
  });

  it("leaves an undeclared clause out of the adjudicable set rather than failing it", () => {
    const root = rootWithGitConfig("clause-3835-adjudicable-");
    const report = walkAcceptanceClauses([attackClause(ABSENT_NEEDLE)], root, {
      declaredScope: [],
    });
    expect(report.failed).toHaveLength(0);
    expect(report.clauses[0]?.adjudicable).toBe(false);
  });
});

describe("a declared artifact is still walked (#3835)", () => {
  it("verifies and contradicts a clause the brief declared, so capability is not removed", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3835-declared-"));
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "core", "src", "shipped.ts"),
      'export const marker = "alpha";\n',
      "utf8",
    );
    const declaredScope = ["packages/core/src/shipped.ts"];
    const walkFor = (needle: string) =>
      walkAcceptanceClauses(
        [
          {
            id: 1,
            text: `packages/core/src/shipped.ts contains "${needle}"`,
            artifact_path: "packages/core/src/shipped.ts",
            ambiguous: false,
          },
        ],
        root,
        { declaredScope },
      ).clauses[0];

    expect(walkFor("alpha")?.outcome).toBe("verified");
    expect(walkFor("beta")?.outcome).toBe("failed");
    expect(walkFor("alpha")?.adjudicable).toBe(true);
  });

  it("accepts a path under a declared directory and refuses a sibling outside it", () => {
    expect(isDeclaredArtifactPath("packages/core/src/a.ts", ["packages/core/src"])).toBe(true);
    expect(isDeclaredArtifactPath("./packages/core/src/a.ts", ["packages/core/src/"])).toBe(true);
    expect(isDeclaredArtifactPath("packages\\core\\src\\a.ts", ["packages/core/src"])).toBe(true);
    expect(isDeclaredArtifactPath("packages/core/srcX/a.ts", ["packages/core/src"])).toBe(false);
    expect(isDeclaredArtifactPath("../outside.ts", ["packages/core/src"])).toBe(false);
    expect(isDeclaredArtifactPath(".git/config", [])).toBe(false);
    expect(isDeclaredArtifactPath("   ", ["packages/core/src"])).toBe(false);
  });

  it("reads the declared surface off plan.metadata.swarm.file_scope only", () => {
    expect(
      readDeclaredArtifactScope({
        metadata: { swarm: { file_scope: ["./a/b.ts", "a/b.ts", "c/", "  ", 7] } },
      }),
    ).toEqual(["a/b.ts", "c"]);
    expect(readDeclaredArtifactScope({ metadata: { swarm: {} } })).toEqual([]);
    expect(readDeclaredArtifactScope({ metadata: { swarm: { file_scope: "a/b.ts" } } })).toEqual(
      [],
    );
    expect(readDeclaredArtifactScope({ items: [{ title: "a/b.ts" }] })).toEqual([]);
    expect(readDeclaredArtifactScope(null)).toEqual([]);
  });
});

describe("one bound path does not re-arm the whole clause set (#3835)", () => {
  it("blocks when a sibling with its own oracle did not verify", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3835-rearm-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'export const marker = "alpha";\n', "utf8");
    writeFileSync(join(root, "src", "b.ts"), "export const other = 1;\n", "utf8");
    const report = walkAcceptanceClauses(
      [
        { id: 1, text: 'src/a.ts contains "alpha"', artifact_path: "src/a.ts", ambiguous: false },
        {
          id: 2,
          text: "b sharding is behavioral and cannot be read off the file",
          artifact_path: "src/b.ts",
          ambiguous: false,
        },
      ],
      root,
      { declaredScope: ["src"] },
    );
    expect(report.verified).toHaveLength(1);
    expect(report.unverifiable).toHaveLength(1);
    expect(report.failed).toHaveLength(0);
    // Pre-fix `ok` was true here: `verified > 0` was read across the whole set,
    // so clause 1 covered clause 2's unmet oracle.
    expect(report.ok).toBe(false);
  });

  it("still passes a set where every clause with an oracle verified", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-3835-allverified-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'export const marker = "alpha";\n', "utf8");
    const report = walkAcceptanceClauses(
      [
        { id: 1, text: 'src/a.ts contains "alpha"', artifact_path: "src/a.ts", ambiguous: false },
        { id: 2, text: "a criterion with no bound path", artifact_path: null, ambiguous: false },
      ],
      root,
      { declaredScope: ["src/a.ts"] },
    );
    expect(report.verified).toHaveLength(1);
    expect(report.ok).toBe(true);
  });
});
