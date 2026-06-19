import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPriorState, pendingDecisionsNudgeLine } from "./prior-state.js";

describe("prior-state probes", () => {
  it("detects mid subscription preset", () => {
    const root = mkdtempSync(join(tmpdir(), "prior-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          policy: {
            triageScope: [
              { rule: "labels", "any-of": ["urgent", "breaking", "security", "p0", "p1"] },
              { rule: "opened-since", duration: "60d" },
            ],
            wipCap: 12,
          },
        },
      }),
      "utf8",
    );
    const state = detectPriorState(root);
    expect(state.triageScopeSummary).toContain("Mid");
    expect(state.wipCapSet).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("counts cache entries", () => {
    const root = mkdtempSync(join(tmpdir(), "prior2-"));
    const entry = join(root, ".deft-cache", "github-issue", "deftai", "directive", "1");
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "raw.json"), "{}", "utf8");
    const state = detectPriorState(root);
    expect(state.cacheEntryCount).toBe(1);
    expect(state.cacheEmpty).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("pending decisions nudge when over threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "prior3-"));
    mkdirSync(join(root, "vbrief", ".audit"), { recursive: true });
    const lines = [
      JSON.stringify({ decision_id: "a", status: "pending" }),
      JSON.stringify({ decision_id: "b", status: "pending" }),
      JSON.stringify({ decision_id: "c", status: "pending" }),
      JSON.stringify({ decision_id: "d", status: "pending" }),
    ];
    writeFileSync(
      join(root, "vbrief", ".audit", "pending-human-decisions.jsonl"),
      `${lines.join("\n")}\n`,
      "utf8",
    );
    const state = detectPriorState(root);
    expect(state.pendingDecisions).toBe(4);
    expect(pendingDecisionsNudgeLine(state.pendingDecisions)).toContain("TIER-1");
    rmSync(root, { recursive: true, force: true });
  });
});
