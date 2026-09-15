import { describe, expect, it } from "vitest";
import { newFacts, uncoveredDeltas } from "./diff.js";
import type { SurfaceSnapshot } from "./types.js";

const base: SurfaceSnapshot[] = [{ path: "src/ingest.ts", facts: [] }];
const throwFact = { kind: "throw-site" as const, id: "throw-site:10" };
const constFact = { kind: "numeric-const" as const, id: "numeric-const:MAX=1024", value: "1024" };

describe("intent-constraint diff (#4541)", () => {
  it("reports new throw-site and numeric-const", () => {
    const head: SurfaceSnapshot[] = [{ path: "src/ingest.ts", facts: [constFact, throwFact] }];
    const deltas = newFacts(base, head);
    expect(deltas.map((d) => d.fact.kind).sort()).toEqual(["numeric-const", "throw-site"]);
  });

  it("covers posted fixture when mint has value and rejectionScope", () => {
    const head: SurfaceSnapshot[] = [{ path: "src/ingest.ts", facts: [constFact, throwFact] }];
    const leftover = uncoveredDeltas(newFacts(base, head), [
      { value: "1024", unit: "bytes", rejectionScope: "invocation" },
    ]);
    expect(leftover).toEqual([]);
  });

  it("does not treat tests as authority", () => {
    const head: SurfaceSnapshot[] = [{ path: "src/ingest.ts", facts: [constFact] }];
    const leftover = uncoveredDeltas(newFacts(base, head), []);
    expect(leftover).toHaveLength(1);
  });
});
