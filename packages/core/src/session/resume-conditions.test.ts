import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, evaluate, parse, ResumeGrammarError } from "./resume-conditions.js";

describe("resume conditions", () => {
  it("parses atomics and composition", () => {
    expect(parse("ref:closed:#42").left.kind).toBe("ref-closed");
    const andExpr = parse("ref:closed:#1 AND pending-count:>=2");
    expect(andExpr.op).toBe("AND");
    const ctx = buildContext("/tmp", {
      today: "2026-06-09",
      slices: [],
    });
    expect(evaluate(andExpr, { ...ctx, closedRefs: new Set([1]), pendingCount: 3 })).toBe(true);
  });

  it("rejects invalid grammar", () => {
    expect(() => parse("bogus")).toThrow(ResumeGrammarError);
    expect(() => parse("ref:closed:#1 AND ref:merged:#2 OR date:>=2026-01-01")).toThrow(
      ResumeGrammarError,
    );
  });

  it("buildContext reads cache and pending", () => {
    const root = mkdtempSync(join(tmpdir(), "resume-ctx-"));
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "vbrief", "pending", "a.vbrief.json"), "{}\n", "utf8");
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "1"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "1", "raw.json"),
      JSON.stringify({ state: "closed", merged: true }),
      "utf8",
    );
    const ctx = buildContext(root, { today: "2026-06-09" });
    expect(ctx.pendingCount).toBe(1);
    expect(ctx.closedRefs.has(1)).toBe(true);
    expect(ctx.mergedRefs.has(1)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
