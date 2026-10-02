import { describe, expect, it } from "vitest";
import {
  formatSkipCiIncidentWarning,
  parseAllowUnpaidSkipCiArgv,
  parseSkipCiIncidentArgv,
  parseSkipCiIncidentIssueNumber,
  RELEASE_E2E_ENV,
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
});
