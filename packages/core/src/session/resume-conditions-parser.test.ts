import { describe, expect, it } from "vitest";
import { buildContext, evaluate, parse, ResumeGrammarError } from "./resume-conditions.js";

const SID = "11111111-1111-1111-1111-111111111111";

describe("resume-conditions parser coverage", () => {
  it("parses each atomic kind", () => {
    expect(parse("ref:closed:#5").left.kind).toBe("ref-closed");
    expect(parse("ref:merged:#5").left.kind).toBe("ref-merged");
    expect(parse("date:>=2026-06-09").left.kind).toBe("date-ge");
    expect(parse("pending-count:>=3").left.kind).toBe("pending-count-ge");
    expect(parse("pending-count:<=3").left.kind).toBe("pending-count-le");
    expect(parse(`slice-wave-ready:${SID}:2`).left.kind).toBe("slice-wave-ready");
  });

  it("rejects malformed atomic conditions", () => {
    expect(() => parse("ref:closed:#x")).toThrow(ResumeGrammarError);
    expect(() => parse("ref:merged:#x")).toThrow(ResumeGrammarError);
    expect(() => parse("date:>=not-a-date")).toThrow(ResumeGrammarError);
    expect(() => parse("date:>=2026-13-99")).not.toThrow();
    expect(() => parse("pending-count:>=x")).toThrow(ResumeGrammarError);
    expect(() => parse("pending-count:<=x")).toThrow(ResumeGrammarError);
    expect(() => parse("totally-unknown")).toThrow(ResumeGrammarError);
    expect(() => parse("   ")).toThrow(ResumeGrammarError);
  });

  it("rejects non-string and empty expressions", () => {
    expect(() => parse(123 as unknown as string)).toThrow(ResumeGrammarError);
    expect(() => parse("")).toThrow(ResumeGrammarError);
  });

  it("rejects malformed slice-wave-ready", () => {
    expect(parse.bind(null, "slice-wave-ready:short:2")).toThrow(ResumeGrammarError);
    expect(parse.bind(null, `slice-wave-ready:${SID}:notnum`)).toThrow(ResumeGrammarError);
    expect(parse.bind(null, `slice-wave-ready:${SID}:0`)).toThrow(ResumeGrammarError);
    expect(parse.bind(null, `slice-wave-ready:${SID}`)).toThrow(ResumeGrammarError);
    expect(parse.bind(null, `slice-wave-ready:zzzzzzzz-1111-1111-1111-111111111111:2`)).toThrow(
      ResumeGrammarError,
    );
  });

  it("parses AND / OR compositions and rejects mixed/nested", () => {
    const and = parse("ref:closed:#1 AND ref:merged:#2");
    expect(and.op).toBe("AND");
    const or = parse("ref:closed:#1 OR ref:merged:#2");
    expect(or.op).toBe("OR");
    expect(() => parse("ref:closed:#1 AND ref:merged:#2 OR ref:closed:#3")).toThrow(
      ResumeGrammarError,
    );
    expect(() => parse("a AND b AND c")).toThrow(ResumeGrammarError);
  });

  it("evaluates AND / OR semantics", () => {
    const ctx = buildContext("/tmp", {
      today: "2026-06-09",
    });
    const withRefs = { ...ctx, closedRefs: new Set([1]), mergedRefs: new Set([2]) };
    expect(evaluate(parse("ref:closed:#1 AND ref:merged:#2"), withRefs)).toBe(true);
    expect(evaluate(parse("ref:closed:#1 AND ref:merged:#9"), withRefs)).toBe(false);
    expect(evaluate(parse("ref:closed:#9 OR ref:merged:#2"), withRefs)).toBe(true);
    expect(evaluate(parse("ref:closed:#9 OR ref:merged:#9"), withRefs)).toBe(false);
  });

  it("evaluates date and pending-count atoms", () => {
    const ctx = buildContext("/tmp", { today: "2026-06-09" });
    expect(evaluate(parse("date:>=2026-06-01"), ctx)).toBe(true);
    expect(evaluate(parse("date:>=2026-07-01"), ctx)).toBe(false);
    expect(evaluate(parse("pending-count:>=1"), { ...ctx, pendingCount: 3 })).toBe(true);
    expect(evaluate(parse("pending-count:>=5"), { ...ctx, pendingCount: 3 })).toBe(false);
    expect(evaluate(parse("pending-count:<=5"), { ...ctx, pendingCount: 3 })).toBe(true);
    expect(evaluate(parse("pending-count:<=1"), { ...ctx, pendingCount: 3 })).toBe(false);
  });

  it("evaluates slice-wave-ready gating", () => {
    const ctx = buildContext("/tmp", {
      today: "2026-06-09",
      slices: [
        {
          slice_id: SID,
          children: [
            { wave: 1, n: 10 },
            { wave: 1, n: 11 },
            { wave: 2, n: 12 },
            "not-an-object",
            { wave: "x", n: 1 },
          ],
        },
      ],
    });
    const expr = parse(`slice-wave-ready:${SID}:2`);
    expect(evaluate(expr, { ...ctx, closedRefs: new Set([10, 11]) })).toBe(true);
    expect(evaluate(expr, { ...ctx, closedRefs: new Set([10]) })).toBe(false);
    expect(evaluate(parse(`slice-wave-ready:${SID}:1`), ctx)).toBe(false);
    const missing = parse(`slice-wave-ready:22222222-2222-2222-2222-222222222222:2`);
    expect(evaluate(missing, ctx)).toBe(false);
    const noChildren = buildContext("/tmp", {
      today: "2026-06-09",
      slices: [{ slice_id: SID, children: "nope" }],
    });
    expect(evaluate(expr, noChildren)).toBe(false);
  });
});
