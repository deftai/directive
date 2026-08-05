import { describe, expect, it } from "vitest";
import { evaluateParentTurnShape, isTextRepetitionHang, PARENT_TURN_FAIL_FC14 } from "./index.js";

describe("parent-turn-shape barrel (#3131)", () => {
  it("re-exports evaluateParentTurnShape and rejects the hang class", () => {
    const line = "Checking worktrees and open PRs next to confirm leaf status.";
    const events = [
      { kind: "assistant_text" as const, text: line },
      { kind: "assistant_text" as const, text: line },
      { kind: "assistant_text" as const, text: line },
    ];
    const result = evaluateParentTurnShape({
      events,
      afterSubagentAnnounce: true,
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe(PARENT_TURN_FAIL_FC14);
    expect(isTextRepetitionHang({ events })).toBe(true);
  });
});
