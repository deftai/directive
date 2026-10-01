import { describe, expect, it } from "vitest";
import {
  censusFromBaseMap,
  continuityExemptPaths,
  preMoveSameBasenameLifecyclePaths,
  resolveStoryContinuity,
  sameBasenameLifecyclePaths,
} from "./continuity.js";

describe("story continuity (#5192)", () => {
  it("resolves same-path identity and refuses plan.id relabel", () => {
    const census = censusFromBaseMap(
      new Map([
        [
          "xbrief/active/story.xbrief.json",
          JSON.stringify({
            plan: { id: "story-1", metadata: { swarm: { file_scope: ["a.ts"] } } },
          }),
        ],
      ]),
    );
    const ok = resolveStoryContinuity({
      headRel: "xbrief/active/story.xbrief.json",
      headPlanId: "story-1",
      headLifecycleRels: ["xbrief/active/story.xbrief.json"],
      census,
    });
    expect(ok.kind).toBe("resolved");

    const relabel = resolveStoryContinuity({
      headRel: "xbrief/active/story.xbrief.json",
      headPlanId: "story-other",
      headLifecycleRels: ["xbrief/active/story.xbrief.json"],
      census,
    });
    expect(relabel.kind).toBe("relabel-refuse");
  });

  it("admits unique planId move when base path is absent from head", () => {
    const census = censusFromBaseMap(
      new Map([
        [
          "xbrief/pending/old.xbrief.json",
          JSON.stringify({
            plan: { id: "story-1", metadata: { swarm: { file_scope: ["a.ts"] } } },
          }),
        ],
      ]),
    );
    const move = resolveStoryContinuity({
      headRel: "xbrief/active/new.xbrief.json",
      headPlanId: "story-1",
      headLifecycleRels: ["xbrief/active/new.xbrief.json"],
      census,
    });
    expect(move.kind).toBe("resolved");
    if (move.kind === "resolved") {
      expect(move.move).toBe(true);
      expect(move.baseRel).toBe("xbrief/pending/old.xbrief.json");
    }

    const notMove = resolveStoryContinuity({
      headRel: "xbrief/active/new.xbrief.json",
      headPlanId: "story-1",
      headLifecycleRels: ["xbrief/active/new.xbrief.json", "xbrief/pending/old.xbrief.json"],
      census,
    });
    expect(notMove.kind).toBe("ambiguous-refuse");
  });

  it("refuses duplicate planId census and skips no-plan.id moves", () => {
    const census = censusFromBaseMap(
      new Map([
        [
          "xbrief/pending/a.xbrief.json",
          JSON.stringify({ plan: { id: "dup", metadata: { swarm: { file_scope: [] } } } }),
        ],
        [
          "xbrief/active/b.xbrief.json",
          JSON.stringify({ plan: { id: "dup", metadata: { swarm: { file_scope: [] } } } }),
        ],
      ]),
    );
    expect(
      resolveStoryContinuity({
        headRel: "xbrief/active/c.xbrief.json",
        headPlanId: "dup",
        headLifecycleRels: ["xbrief/active/c.xbrief.json"],
        census,
      }).kind,
    ).toBe("duplicate-refuse");

    expect(
      resolveStoryContinuity({
        headRel: "xbrief/active/story.xbrief.json",
        headPlanId: null,
        headLifecycleRels: ["xbrief/active/story.xbrief.json"],
        census: censusFromBaseMap(
          new Map([
            [
              "xbrief/pending/story.xbrief.json",
              JSON.stringify({ plan: { metadata: { swarm: { file_scope: [] } } } }),
            ],
          ]),
        ),
      }).kind,
    ).toBe("missing");
  });

  it("lists same-basename lifecycle exempts for no-plan.id identities", () => {
    expect(sameBasenameLifecyclePaths("xbrief/active/story.xbrief.json")).toEqual(
      expect.arrayContaining([
        "xbrief/pending/story.xbrief.json",
        "xbrief/active/story.xbrief.json",
        "xbrief/completed/story.xbrief.json",
      ]),
    );
    const exempt = continuityExemptPaths({
      headRel: "xbrief/active/story.xbrief.json",
      headPlanId: null,
      continuity: { kind: "missing" },
    });
    expect(exempt).toEqual(expect.arrayContaining(["xbrief/pending/story.xbrief.json"]));
  });

  it("pre-move same-basename probes prefer active over pending (#5192)", () => {
    expect(preMoveSameBasenameLifecyclePaths("xbrief/completed/story.xbrief.json")).toEqual([
      "xbrief/active/story.xbrief.json",
      "xbrief/pending/story.xbrief.json",
      "xbrief/cancelled/story.xbrief.json",
    ]);
  });

  it("refuses moves when two HEAD briefs claim the same plan.id (#5192)", () => {
    const census = censusFromBaseMap(
      new Map([
        [
          "xbrief/pending/old.xbrief.json",
          JSON.stringify({
            plan: { id: "story-1", metadata: { swarm: { file_scope: ["a.ts"] } } },
          }),
        ],
      ]),
    );
    const dup = resolveStoryContinuity({
      headRel: "xbrief/active/new.xbrief.json",
      headPlanId: "story-1",
      headLifecycleRels: ["xbrief/active/new.xbrief.json", "xbrief/completed/also.xbrief.json"],
      census,
      headPlanIds: new Map([
        ["xbrief/active/new.xbrief.json", "story-1"],
        ["xbrief/completed/also.xbrief.json", "story-1"],
      ]),
    });
    expect(dup.kind).toBe("ambiguous-refuse");
  });

  it("does not basename-fan-out exempts for plan.id stories (#5192)", () => {
    const payload = {
      plan: { id: "story-1", metadata: { swarm: { file_scope: ["a.ts"] } } },
    };
    const exempt = continuityExemptPaths({
      headRel: "xbrief/active/story.xbrief.json",
      headPlanId: "story-1",
      continuity: {
        kind: "resolved",
        baseRel: "xbrief/active/story.xbrief.json",
        basePlanId: "story-1",
        basePayload: payload,
        baseRaw: JSON.stringify(payload),
        move: false,
      },
    });
    expect(exempt).toEqual(["xbrief/active/story.xbrief.json"]);
    expect(exempt).not.toContain("xbrief/pending/story.xbrief.json");
    expect(exempt).not.toContain("xbrief/completed/story.xbrief.json");
  });
});
