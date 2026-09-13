import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detect,
  parseSlizardCheckRunSummary,
  slizardCheckRunHasZeroFindings,
} from "./greptile-detector.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  here,
  "../../pr-merge-readiness/fixtures/slizard-check-run-a8a20f3.summary.txt",
);
const META = join(here, "../../pr-merge-readiness/fixtures/slizard-check-run-a8a20f3.meta.json");

const captured = readFileSync(FIXTURE, "utf8");

describe("parseSlizardCheckRunSummary (captured check-run output.summary)", () => {
  it("records capture provenance for the live bs-deepwordle#4 summary", () => {
    const meta = JSON.parse(readFileSync(META, "utf8")) as {
      repo: string;
      check_run_id: number;
      field: string;
    };
    expect(meta.repo).toBe("deftai/bs-deepwordle");
    expect(meta.check_run_id).toBe(103182122466);
    expect(meta.field).toBe("output.summary");
    expect(captured).toContain("**Decision**: request_changes");
    expect(captured).not.toContain("slizard:verdict");
  });

  it("parses emphasized Decision, Merge impact, Findings, and Severity counts", () => {
    const v = parseSlizardCheckRunSummary(captured);
    expect(v.source).toBe("prose");
    expect(v.decision).toBe("request_changes");
    expect(v.mergeImpact).toBe("blocking");
    expect(v.findingCount).toBe(1);
    expect(v.p0Count).toBe(0);
    expect(v.p1Count).toBe(1);
    expect(v.p2Count).toBe(0);
  });

  it("does not let an earlier unanchored P1: N beat the Severity counts line", () => {
    const injected = `P1: 3\n${captured}`;
    const v = parseSlizardCheckRunSummary(injected);
    expect(v.p1Count).toBe(1);
  });

  it("does not use detect() on this surface: review-body counters miss check-run counts", () => {
    const findings = detect(captured);
    expect(findings.p1_count).toBe(0);
    expect(findings.has_blocking).toBe(false);
    expect(parseSlizardCheckRunSummary(captured).p1Count).toBe(1);
  });

  it("prefers an HTML verdict comment only when that comment is on the summary itself", () => {
    const withComment = `${captured}\n<!-- slizard:verdict {"slizard_verdict":{"decision":"approve","merge_impact":"non-blocking","finding_count":0,"severity":{"P0":0,"P1":0,"P2":0}}} -->`;
    const v = parseSlizardCheckRunSummary(withComment);
    expect(v.source).toBe("html-comment");
    expect(v.decision).toBe("approve");
    expect(v.findingCount).toBe(0);
    expect(slizardCheckRunHasZeroFindings(v)).toBe(true);
  });

  it("treats Findings: 0 actionable as zero findings", () => {
    const zero = captured
      .replace("**Findings**: 1 actionable, 5 advisory", "**Findings**: 0 actionable, 5 advisory")
      .replace(
        "**Severity counts**: P0: 0, P1: 1, P2: 0, P3: 0",
        "**Severity counts**: P0: 0, P1: 0, P2: 0, P3: 0",
      );
    const v = parseSlizardCheckRunSummary(zero);
    expect(v.decision).toBe("request_changes");
    expect(v.findingCount).toBe(0);
    expect(v.p1Count).toBe(0);
    expect(slizardCheckRunHasZeroFindings(v)).toBe(true);
  });

  it("returns empty source for a missing summary", () => {
    const v = parseSlizardCheckRunSummary(undefined);
    expect(v.source).toBe("empty");
    expect(slizardCheckRunHasZeroFindings(v)).toBe(false);
  });

  it("falls through to prose when the HTML comment is not JSON", () => {
    const v = parseSlizardCheckRunSummary(`${captured}\n<!-- slizard:verdict {not-json -->`);
    expect(v.source).toBe("prose");
    expect(v.decision).toBe("request_changes");
  });

  it("falls through when the HTML comment has no object payload", () => {
    const v = parseSlizardCheckRunSummary("<!-- slizard:verdict -->\nDecision: approve\n");
    expect(v.source).toBe("prose");
    expect(v.decision).toBe("approve");
  });

  it("falls through when slizard_verdict is missing or not an object", () => {
    expect(parseSlizardCheckRunSummary('<!-- slizard:verdict {"other":1} -->').source).toBe(
      "prose",
    );
    expect(
      parseSlizardCheckRunSummary('<!-- slizard:verdict {"slizard_verdict":[]} -->').source,
    ).toBe("prose");
    expect(parseSlizardCheckRunSummary("<!-- slizard:verdict [1] -->").source).toBe("prose");
  });

  it("reads HTML comment severity only when it is an object", () => {
    const v = parseSlizardCheckRunSummary(
      '<!-- slizard:verdict {"slizard_verdict":{"decision":"reject","merge_impact":"blocking","finding_count":"x","severity":[1]}} -->',
    );
    expect(v.source).toBe("html-comment");
    expect(v.decision).toBe("reject");
    expect(v.findingCount).toBeNull();
    expect(v.p0Count).toBeNull();
  });

  it("parses a bare Findings count without actionable", () => {
    const v = parseSlizardCheckRunSummary("Findings: 4 leftover notes\n");
    expect(v.findingCount).toBe(4);
  });

  it("leaves findingCount null when Findings has no leading number", () => {
    const v = parseSlizardCheckRunSummary("Findings: none\n");
    expect(v.findingCount).toBeNull();
    expect(slizardCheckRunHasZeroFindings(v)).toBe(false);
  });

  it("treats all-zero severity with unknown findingCount as zero findings", () => {
    const v = parseSlizardCheckRunSummary("Severity counts: P0: 0, P1: 0, P2: 0, P3: 0\n");
    expect(v.findingCount).toBeNull();
    expect(slizardCheckRunHasZeroFindings(v)).toBe(true);
  });

  it("parses an unclosed HTML verdict comment as JSON from the first brace", () => {
    const v = parseSlizardCheckRunSummary(
      '<!-- slizard:verdict {"slizard_verdict":{"decision":"comment","finding_count":0,"severity":{"P0":0,"P1":0,"P2":0}}}',
    );
    expect(v.source).toBe("html-comment");
    expect(v.decision).toBe("comment");
    expect(slizardCheckRunHasZeroFindings(v)).toBe(true);
  });
});
