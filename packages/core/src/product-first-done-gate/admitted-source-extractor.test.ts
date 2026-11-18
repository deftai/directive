import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIssueVbrief } from "../intake/issue-ingest.js";
import {
  ADMITTED_SOURCE_EXTRACTOR_V2,
  digestAdmittedSourceSentences,
  extractAdmittedSourceIdentitiesWithVersion,
  extractAdmittedSourceSentencesFromText,
  readAdmittedSourceExtractor,
} from "./acceptance.js";
import {
  ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE,
  ADMITTED_SOURCE_IDENTITY_REMOVED_CAUSE,
  evaluateAdmittedSourceAtActivation,
} from "./evaluate.js";

const BODY = [
  "## Summary",
  "",
  "Ingest turns every sentence into a clause.",
  "",
  "## Acceptance Criteria",
  "",
  "- First criterion holds.",
  "- Second criterion holds.",
  "- Third criterion holds.",
  "",
  "Refs #6599",
].join("\n");

function freshPlan(): Record<string, unknown> {
  const [vbrief] = buildIssueVbrief(
    { number: 6609, title: "t", body: BODY, labels: [] },
    "proposed",
    "https://github.com/o/r",
  );
  return structuredClone(vbrief.plan as Record<string, unknown>);
}

function acceptanceOf(plan: Record<string, unknown>): Record<string, unknown> {
  return plan.acceptance as Record<string, unknown>;
}

/** The attack: drop the third criterion everywhere and recompute the digest by hand. */
function trimThirdCriterion(plan: Record<string, unknown>): Record<string, unknown> {
  const acceptance = acceptanceOf(plan);
  const keep = (acceptance.admitted_source_sentences as string[]).slice(0, 2);
  acceptance.admitted_source_sentences = keep;
  acceptance.admitted_source_digest = digestAdmittedSourceSentences(keep);
  acceptance.sentences = keep;
  acceptance.clauses = (acceptance.clauses as { id: number }[]).slice(0, 2);
  return plan;
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "admitted-source-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const live = (text: string) => () => ({ ok: true as const, text });

describe("extractor version on the pin (#6609 item 4)", () => {
  it("reads version 2 and treats anything else as no version", () => {
    expect(readAdmittedSourceExtractor({ admitted_source_extractor: 2 })).toBe(2);
    expect(readAdmittedSourceExtractor({ admitted_source_extractor: 3 })).toBeNull();
    expect(readAdmittedSourceExtractor({})).toBeNull();
    expect(readAdmittedSourceExtractor(null)).toBeNull();
  });

  it("no version uses the legacy extractor exactly; version 2 uses the unit selector", () => {
    expect(extractAdmittedSourceIdentitiesWithVersion(BODY, null)).toEqual(
      extractAdmittedSourceSentencesFromText(BODY),
    );
    expect(extractAdmittedSourceIdentitiesWithVersion(BODY, ADMITTED_SOURCE_EXTRACTOR_V2)).toEqual([
      "First criterion holds.",
      "Second criterion holds.",
      "Third criterion holds.",
    ]);
  });
});

describe("admitted-source check at activation (#6609 item 7)", () => {
  it("passes an unchanged ingested brief", () =>
    withRoot((root) => {
      const plan = freshPlan();
      const result = evaluateAdmittedSourceAtActivation(plan, {
        projectRoot: root,
        fetchAdmittedSourceText: live(BODY),
        briefOnMergeBase: false,
        admittedSourceMergeBase: null,
      });
      expect(result).toEqual({ ok: true, message: "" });
    }));

  it("fails a hand-trimmed acceptance block whose digest was recomputed (working pin)", () =>
    withRoot((root) => {
      const plan = trimThirdCriterion(freshPlan());
      const result = evaluateAdmittedSourceAtActivation(plan, {
        projectRoot: root,
        fetchAdmittedSourceText: live(BODY),
        briefOnMergeBase: false,
        admittedSourceMergeBase: null,
      });
      expect(result.ok).toBe(false);
      expect(result.cause).toBe(ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE);
      expect(result.message).toContain("admitted-source digest (#5055)");
    }));

  it("fails clauses deleted from an untrimmed pin with the identity message", () =>
    withRoot((root) => {
      const plan = freshPlan();
      const acceptance = acceptanceOf(plan);
      acceptance.clauses = (acceptance.clauses as unknown[]).slice(0, 1);
      acceptance.sentences = (acceptance.sentences as string[]).slice(0, 1);
      const result = evaluateAdmittedSourceAtActivation(plan, {
        projectRoot: root,
        fetchAdmittedSourceText: live(BODY),
        briefOnMergeBase: false,
        admittedSourceMergeBase: null,
      });
      expect(result.ok).toBe(false);
      expect(result.cause).toBe(ADMITTED_SOURCE_IDENTITY_REMOVED_CAUSE);
    }));

  it("compares a HEAD-sourced pin of an unlanded body-route brief with the live body", () =>
    withRoot((root) => {
      const trimmed = trimThirdCriterion(freshPlan());
      const acceptance = acceptanceOf(trimmed);
      const result = evaluateAdmittedSourceAtActivation(trimmed, {
        projectRoot: root,
        fetchAdmittedSourceText: live(BODY),
        briefOnMergeBase: false,
        admittedSourceMergeBase: {
          sentences: acceptance.admitted_source_sentences as string[],
          digest: acceptance.admitted_source_digest as string,
          source: "head",
        },
      });
      expect(result.ok).toBe(false);
      expect(result.cause).toBe(ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE);
    }));

  it("passes an unchanged brief whose pin comes from HEAD", () =>
    withRoot((root) => {
      const plan = freshPlan();
      const acceptance = acceptanceOf(plan);
      const result = evaluateAdmittedSourceAtActivation(plan, {
        projectRoot: root,
        fetchAdmittedSourceText: live(BODY),
        briefOnMergeBase: false,
        admittedSourceMergeBase: {
          sentences: acceptance.admitted_source_sentences as string[],
          digest: acceptance.admitted_source_digest as string,
          source: "head",
        },
      });
      expect(result.ok).toBe(true);
    }));

  it("runs no live compare for a pin loaded from the merge base", () =>
    withRoot((root) => {
      const plan = freshPlan();
      const acceptance = acceptanceOf(plan);
      let fetched = 0;
      const result = evaluateAdmittedSourceAtActivation(plan, {
        projectRoot: root,
        fetchAdmittedSourceText: () => {
          fetched += 1;
          return { ok: true as const, text: "A body that changed." };
        },
        briefOnMergeBase: true,
        admittedSourceMergeBase: {
          sentences: acceptance.admitted_source_sentences as string[],
          digest: acceptance.admitted_source_digest as string,
          source: "merge-base",
        },
      });
      expect(result.ok).toBe(true);
      expect(fetched).toBe(0);
    }));

  it("is a no-op for a brief with no acceptance block", () =>
    withRoot((root) => {
      expect(evaluateAdmittedSourceAtActivation({ title: "t" }, { projectRoot: root })).toEqual({
        ok: true,
        message: "",
      });
    }));
});
