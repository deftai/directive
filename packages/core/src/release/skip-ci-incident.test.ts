import { describe, expect, it } from "vitest";
import {
  formatSkipCiIncidentWarning,
  parseAllowUnpaidSkipCiArgv,
  parseSkipCiIncidentArgv,
  parseSkipCiIncidentIssueNumber,
  RELEASE_E2E_ENV,
  SKIP_CI_UNPAID_HATCH_5526,
  validateSkipCiIncident,
  validateSkipCiUnpaidLedger,
} from "./skip-ci-incident.js";

describe("skip-ci incident (#2652)", () => {
  it("parses --allow-skip-ci=#N", () => {
    expect(parseSkipCiIncidentArgv(["release", "--allow-skip-ci=#2652"])).toEqual({
      kind: "valid",
      issue: 2652,
    });
    expect(parseSkipCiIncidentArgv(["release", "--allow-skip-ci", "2652"])).toEqual({
      kind: "valid",
      issue: 2652,
    });
  });

  it("rejects malformed --allow-skip-ci", () => {
    expect(parseSkipCiIncidentArgv(["release", "--allow-skip-ci=#"]).kind).toBe("invalid");
    expect(parseSkipCiIncidentArgv(["release", "--allow-skip-ci"]).kind).toBe("invalid");
  });

  it("requires citation for production --skip-ci", () => {
    expect(validateSkipCiIncident(true, null, {}).kind).toBe("invalid");
    expect(validateSkipCiIncident(true, 2652, {}).kind).toBe("valid");
    expect(validateSkipCiIncident(false, null, {}).kind).toBe("none");
  });

  it("permits e2e rehearsal via DEFT_RELEASE_E2E", () => {
    expect(validateSkipCiIncident(true, null, { [RELEASE_E2E_ENV]: "1" }).kind).toBe("valid");
  });

  it("formats loud incident warning", () => {
    const warn = formatSkipCiIncidentWarning(2652);
    expect(warn).toContain("WARNING");
    expect(warn).toContain("#2652");
    expect(warn).toContain("UNTESTED");
    expect(formatSkipCiIncidentWarning(0)).toContain("release:e2e rehearsal");
  });

  it("parses bare issue numbers for citations", () => {
    expect(parseSkipCiIncidentIssueNumber("#2652")).toBe(2652);
    expect(parseSkipCiIncidentIssueNumber("2652")).toBe(2652);
    expect(parseSkipCiIncidentIssueNumber("")).toBeNull();
    expect(parseSkipCiIncidentIssueNumber("abc")).toBeNull();
    expect(parseSkipCiIncidentIssueNumber("0")).toBeNull();
  });

  it("rejects --allow-skip-ci= without a numeric value", () => {
    expect(parseSkipCiIncidentArgv(["release", "--allow-skip-ci="]).kind).toBe("invalid");
    expect(parseSkipCiIncidentArgv(["release", "--allow-skip-ci", "--skip-ci"]).kind).toBe(
      "invalid",
    );
  });

  it("rejects a later malformed duplicate after an earlier valid token (#5239)", () => {
    expect(
      parseSkipCiIncidentArgv(["release", "--allow-skip-ci=123", "--allow-skip-ci=abc"]).kind,
    ).toBe("invalid");
    expect(
      parseSkipCiIncidentArgv(["release", "--allow-skip-ci=123", "--allow-skip-ci=456"]).kind,
    ).toBe("invalid");
  });

  it("parses --allow-unpaid-skip-ci (#5239)", () => {
    expect(parseAllowUnpaidSkipCiArgv(["--allow-unpaid-skip-ci=5239"]).kind).toBe("valid");
    expect(parseAllowUnpaidSkipCiArgv(["--allow-unpaid-skip-ci"]).kind).toBe("invalid");
  });

  it("refuses unpaid skip-ci without matching override (#5239)", () => {
    const gate = validateSkipCiUnpaidLedger({
      skipCi: true,
      allowSkipCiIssue: 5239,
      allowUnpaidSkipCiIssue: null,
      unpaidIssues: [{ issue: 5239, reasons: ["open_or_unknown"] }],
    });
    expect(gate.kind).toBe("invalid");
  });

  it("refuses OPEN #5526 without distinct unpaid override (#5526)", () => {
    const gate = validateSkipCiUnpaidLedger({
      skipCi: true,
      allowSkipCiIssue: SKIP_CI_UNPAID_HATCH_5526.allowSkipCiIssue,
      allowUnpaidSkipCiIssue: null,
      unpaidIssues: [
        {
          issue: SKIP_CI_UNPAID_HATCH_5526.allowSkipCiIssue,
          reasons: ["open_or_unknown"],
        },
      ],
    });
    expect(gate.kind).toBe("invalid");
    if (gate.kind === "invalid") {
      expect(gate.reason).toMatch(/allow-unpaid-skip-ci=#5526/);
      expect(gate.reason).toMatch(/OPEN or UNKNOWN/);
      expect(gate.reason).toMatch(/#5526/);
    }
  });

  it("refuses CHANGELOG-spent #5526 without distinct unpaid override (#5526)", () => {
    const gate = validateSkipCiUnpaidLedger({
      skipCi: true,
      allowSkipCiIssue: 5526,
      allowUnpaidSkipCiIssue: null,
      unpaidIssues: [{ issue: 5526, reasons: ["changelog_spent"] }],
    });
    expect(gate.kind).toBe("invalid");
    if (gate.kind === "invalid") {
      expect(gate.reason).toMatch(/spent/);
      expect(gate.reason).toMatch(/allow-unpaid-skip-ci=#5526/);
    }
  });

  it("allows #5526 only when unpaid override matches the same issue (#5526)", () => {
    expect(
      validateSkipCiUnpaidLedger({
        skipCi: true,
        allowSkipCiIssue: SKIP_CI_UNPAID_HATCH_5526.allowSkipCiIssue,
        allowUnpaidSkipCiIssue: SKIP_CI_UNPAID_HATCH_5526.allowUnpaidSkipCiIssue,
        unpaidIssues: [
          {
            issue: SKIP_CI_UNPAID_HATCH_5526.allowSkipCiIssue,
            reasons: ["open_or_unknown", "changelog_spent"],
          },
        ],
      }).kind,
    ).toBe("ok");
    expect(
      validateSkipCiUnpaidLedger({
        skipCi: true,
        allowSkipCiIssue: 5526,
        allowUnpaidSkipCiIssue: 5239,
        unpaidIssues: [{ issue: 5526, reasons: ["open_or_unknown"] }],
      }).kind,
    ).toBe("invalid");
  });

  it("documents the #5526 hatch argv without inventing a second ledger (#5526)", () => {
    expect(SKIP_CI_UNPAID_HATCH_5526.argv).toEqual([
      "--skip-ci",
      "--allow-skip-ci=5526",
      "--allow-unpaid-skip-ci=5526",
    ]);
    expect(parseAllowUnpaidSkipCiArgv(SKIP_CI_UNPAID_HATCH_5526.argv)).toEqual({
      kind: "valid",
      issue: 5526,
    });
    expect(parseSkipCiIncidentArgv(SKIP_CI_UNPAID_HATCH_5526.argv)).toEqual({
      kind: "valid",
      issue: 5526,
    });
  });
});
