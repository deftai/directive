import { describe, expect, it } from "vitest";
import {
  classifyDesignCritiqueIngestPosture,
  DESIGN_CRITIQUE_INGEST_ADVISORY,
  hasOperativeNotWarrantedSkip,
} from "./ingest-posture.js";

describe("ingest-posture (#5716 Prefer-A Recut-3)", () => {
  it("treats complete as arced even with a stale not-warranted line", () => {
    const posture = classifyDesignCritiqueIngestPosture({
      verdict: {
        status: "complete",
        citedLeanId: 1,
        citedTableId: 2,
        synthesisCommentId: 3,
      },
      issueBody: "design-critique: not warranted, because chore",
      comments: [],
    });
    expect(posture).toBe("arced");
  });

  it("records skipped-recorded for operative not-warranted on body or comments", () => {
    expect(
      classifyDesignCritiqueIngestPosture({
        verdict: { status: "not-in-arc" },
        issueBody: "design-critique: not warranted, because chore\n",
        comments: [],
      }),
    ).toBe("skipped-recorded");
    expect(
      classifyDesignCritiqueIngestPosture({
        verdict: { status: "not-in-arc" },
        issueBody: "",
        comments: [{ id: 9, body: "design-critique: not warranted, because skip\n" }],
      }),
    ).toBe("skipped-recorded");
  });

  it("keeps warranted-only and fenced/quoted skips as neither", () => {
    expect(
      classifyDesignCritiqueIngestPosture({
        verdict: { status: "not-in-arc" },
        issueBody: "design-critique: warranted, because mechanism\n",
        comments: [],
      }),
    ).toBe("neither");
    expect(
      hasOperativeNotWarrantedSkip("```"+"\ndesign-critique: not warranted, because x\n"+"```"+"\n", []),
    ).toBe(false);
    expect(
      hasOperativeNotWarrantedSkip("> design-critique: not warranted, because x\n", []),
    ).toBe(false);
    expect(
      classifyDesignCritiqueIngestPosture({
        verdict: { status: "not-in-arc" },
        issueBody: "ordinary body",
        comments: [],
      }),
    ).toBe("neither");
  });

  it("excludes blocked from the three-state denominator", () => {
    expect(
      classifyDesignCritiqueIngestPosture({
        verdict: { status: "blocked", reason: "missing-record", detail: "x" },
        issueBody: "design-critique: not warranted, because chore",
        comments: [],
      }),
    ).toBeNull();
  });

  it("locks advisory copy without echoing a because-clause", () => {
    expect(DESIGN_CRITIQUE_INGEST_ADVISORY).toContain("deft-directive-design-critique");
    expect(DESIGN_CRITIQUE_INGEST_ADVISORY).toContain(
      "design-critique: not warranted, because …",
    );
    expect(DESIGN_CRITIQUE_INGEST_ADVISORY).toContain("never blocks");
    expect(DESIGN_CRITIQUE_INGEST_ADVISORY).not.toMatch(/because chore|because skip/);
  });
});