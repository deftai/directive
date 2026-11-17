import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSkipCiIncidentCitationsFromChangelog } from "./auto-hatch.js";
import { probeOpenCoverageDebtLedger, probeSkipCiIncidentLedger } from "./coverage-debt-ledger.js";
import { parseAllowUnpaidSkipCiArgv, validateSkipCiUnpaidLedger } from "./skip-ci-incident.js";

describe("skip-ci CHANGELOG spend scan (#5239 S1)", () => {
  it("extracts allow-skip-ci citations from full CHANGELOG spend history", () => {
    const cl = [
      "## [Unreleased]",
      "",
      "no spend here",
      "",
      "## [0.119.13]",
      "Step 5 skipped with --allow-skip-ci=5239 after hang.",
      "",
      "## [0.119.12]",
      "no spend",
      "",
      "## [0.119.11]",
      "no spend",
      "",
      // Fourth released section — must still be found (Greptile P1 on #5239).
      "## [0.119.10]",
      "Step 5 skipped with --allow-skip-ci=5107 after flake.",
      "",
      "## [0.119.9]",
      "allow-skip-ci=#9999",
    ].join("\n");
    expect(extractSkipCiIncidentCitationsFromChangelog(cl)).toEqual([5107, 5239, 9999]);
    expect(extractSkipCiIncidentCitationsFromChangelog(cl, 1)).toEqual([5239]);
    expect(extractSkipCiIncidentCitationsFromChangelog(cl, 3)).toEqual([5239]);
  });
});

describe("probeSkipCiIncidentLedger (#5239 R3 + S1)", () => {
  it("marks OPEN cited issues unpaid", () => {
    const result = probeSkipCiIncidentLedger("deftai/directive", "/proj", 5239, {
      viewIssueState: () => "OPEN",
      listSkipCiSpendCitations: () => [],
      fileExists: () => false,
    });
    expect(result.unpaid).toEqual([{ issue: 5239, reasons: ["open_or_unknown"] }]);
  });

  it("marks UNKNOWN cited issues unpaid (fail closed)", () => {
    const result = probeSkipCiIncidentLedger("deftai/directive", "/proj", 5239, {
      viewIssueState: () => "UNKNOWN",
      listSkipCiSpendCitations: () => [],
      fileExists: () => false,
    });
    expect(result.unpaid).toEqual([{ issue: 5239, reasons: ["open_or_unknown"] }]);
  });

  it("marks CHANGELOG-spent citations unpaid even when CLOSED", () => {
    const result = probeSkipCiIncidentLedger("deftai/directive", "/proj", 5239, {
      viewIssueState: () => "CLOSED",
      listSkipCiSpendCitations: () => [5239, 5107],
      fileExists: () => true,
    });
    expect(result.unpaid).toEqual([{ issue: 5239, reasons: ["changelog_spent"] }]);
  });

  it("combines OPEN and spent reasons", () => {
    const result = probeSkipCiIncidentLedger("deftai/directive", "/proj", 5239, {
      viewIssueState: () => "OPEN",
      listSkipCiSpendCitations: () => [5239],
      fileExists: () => true,
    });
    expect(result.unpaid).toEqual([
      { issue: 5239, reasons: ["changelog_spent", "open_or_unknown"] },
    ]);
  });

  it("returns empty unpaid for CLOSED unspent citations", () => {
    const result = probeSkipCiIncidentLedger("deftai/directive", "/proj", 42, {
      viewIssueState: () => "CLOSED",
      listSkipCiSpendCitations: () => [5239],
      fileExists: () => true,
    });
    expect(result.unpaid).toEqual([]);
  });
});

describe("validateSkipCiUnpaidLedger (#5239)", () => {
  it("refuses unpaid citation without distinct override", () => {
    const gate = validateSkipCiUnpaidLedger({
      skipCi: true,
      allowSkipCiIssue: 5239,
      allowUnpaidSkipCiIssue: null,
      unpaidIssues: [{ issue: 5239, reasons: ["changelog_spent"] }],
    });
    expect(gate.kind).toBe("invalid");
    if (gate.kind === "invalid") {
      expect(gate.reason).toMatch(/unpaid/);
      expect(gate.reason).toMatch(/allow-unpaid-skip-ci=#5239/);
      expect(gate.reason).toMatch(/spent/);
    }
  });

  it("allows unpaid citation when override matches", () => {
    expect(
      validateSkipCiUnpaidLedger({
        skipCi: true,
        allowSkipCiIssue: 5239,
        allowUnpaidSkipCiIssue: 5239,
        unpaidIssues: [{ issue: 5239, reasons: ["open_or_unknown"] }],
      }).kind,
    ).toBe("ok");
  });

  it("refuses when override cites a different issue", () => {
    const gate = validateSkipCiUnpaidLedger({
      skipCi: true,
      allowSkipCiIssue: 5239,
      allowUnpaidSkipCiIssue: 9999,
      unpaidIssues: [{ issue: 5239, reasons: ["changelog_spent"] }],
    });
    expect(gate.kind).toBe("invalid");
  });
});

describe("parseAllowUnpaidSkipCiArgv", () => {
  it("parses equals and spaced forms", () => {
    expect(parseAllowUnpaidSkipCiArgv(["--allow-unpaid-skip-ci=#5239"])).toEqual({
      kind: "valid",
      issue: 5239,
    });
    expect(parseAllowUnpaidSkipCiArgv(["--allow-unpaid-skip-ci", "5239"])).toEqual({
      kind: "valid",
      issue: 5239,
    });
  });
});

describe("ledger scans read the effective [Unreleased] view (#6314)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function project(fragment: string | null): string {
    const r = mkdtempSync(join(tmpdir(), "deft-ledger-6314-"));
    roots.push(r);
    writeFileSync(join(r, "CHANGELOG.md"), "## [Unreleased]\n\n### Fixed\n\n## [0.1.0]\n\n- old\n");
    if (fragment !== null) {
      mkdirSync(join(r, "changelog.d"));
      writeFileSync(join(r, "changelog.d", "6314-x.md"), fragment);
    }
    return r;
  }

  it("skip-ci spend scan sees a citation in a changelog.d fragment", () => {
    const seams = { viewIssueState: () => "CLOSED" as const, whichGh: () => null };
    expect(probeSkipCiIncidentLedger("o/r", project(null), 6314, seams).unpaid).toEqual([]);
    const withFragment = project("section: Fixed\n- Cut with --allow-skip-ci=#6314 after a hang\n");
    expect(probeSkipCiIncidentLedger("o/r", withFragment, 6314, seams).unpaid).toEqual([
      { issue: 6314, reasons: ["changelog_spent"] },
    ]);
  });

  it("coverage-debt citation scan sees a citation in a changelog.d fragment", () => {
    const seams = { whichGh: () => null };
    expect(probeOpenCoverageDebtLedger("o/r", project(null), seams)).toEqual([]);
    const withFragment = project("section: Changed\n- Ships under --allow-coverage-debt=#6400\n");
    expect(probeOpenCoverageDebtLedger("o/r", withFragment, seams)).toEqual([6400]);
  });
});
