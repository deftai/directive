/**
 * Labeled/fence/prompt task_statement rows must be promotable via documented
 * slots without rewriting source (#4238). Inline mentions stay #3721.
 */

import { describe, expect, it } from "vitest";
import { evaluateLiteralAcceptanceFromPlan, readStoredLiteralAcceptanceCommands } from "./index.js";

const COMMAND = "deft doctor";

type SpanPrefix = "labeled@" | "fence@" | "prompt@";
type Slot = "verify_commands" | "plan_item" | "metadata";

function statedRow(spanPrefix: SpanPrefix) {
  return {
    command: COMMAND,
    source: "task_statement" as const,
    sourceSpan: `${spanPrefix}L27`,
  };
}

function planFor(spanPrefix: SpanPrefix, slot: Slot | "none") {
  const metadata: Record<string, unknown> = {
    literal_acceptance_commands: [statedRow(spanPrefix)],
  };
  const items: Array<Record<string, unknown>> = [];
  if (slot === "verify_commands") {
    metadata.swarm = { verify_commands: [COMMAND] };
  } else if (slot === "metadata") {
    metadata.swarm = {
      literal_acceptance_commands: [{ command: COMMAND, expectedExitCode: 0 }],
    };
  } else if (slot === "plan_item") {
    items.push({ command: COMMAND });
  }
  return { title: "t", metadata, items };
}

const SPANS: SpanPrefix[] = ["labeled@", "fence@", "prompt@"];
const SLOTS: Slot[] = ["verify_commands", "plan_item", "metadata"];
const SLOT_SOURCE: Record<Slot, string> = {
  verify_commands: "verify_commands",
  plan_item: "plan_item",
  metadata: "metadata",
};

describe("promote non-inline task_statement via documented slots (#4238)", () => {
  for (const span of SPANS) {
    for (const slot of SLOTS) {
      it(`${span} row plus ${slot} coexists and evaluates without rewriting source`, () => {
        const plan = planFor(span, slot);
        const stored = readStoredLiteralAcceptanceCommands(plan);
        expect(stored.map((c) => c.source)).toEqual(
          expect.arrayContaining(["task_statement", SLOT_SOURCE[slot]]),
        );
        expect(stored.some((c) => c.source === "explicit")).toBe(false);
        const stated = stored.find((c) => c.source === "task_statement");
        expect(stated?.sourceSpan?.startsWith(span)).toBe(true);

        let runs = 0;
        const result = evaluateLiteralAcceptanceFromPlan(plan, {
          projectRoot: process.cwd(),
          captureFromNarratives: false,
          runner: () => {
            runs += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        });
        expect(result.ok).toBe(true);
        expect(runs).toBeGreaterThan(0);
        expect(result.commands.some((c) => c.source === "task_statement")).toBe(true);
        expect(result.commands.some((c) => c.source === SLOT_SOURCE[slot])).toBe(true);
        expect(result.commands.some((c) => c.source === "explicit")).toBe(false);
      });
    }
  }

  it("labeled capture-only without a peer still fails closed", () => {
    const plan = planFor("labeled@", "none");
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: false,
      runner: () => {
        throw new Error("must not execute unpromoted labeled statement");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/capture-only|Promote/);
    expect(readStoredLiteralAcceptanceCommands(plan).map((c) => c.source)).toEqual([
      "task_statement",
    ]);
  });

  it("inline@ mention plus verify_commands stays #3721 and does not require source rewrite", () => {
    const plan = {
      title: "t",
      metadata: {
        literal_acceptance_commands: [
          { command: COMMAND, source: "task_statement", sourceSpan: "inline@L27" },
        ],
        swarm: { verify_commands: [COMMAND] },
      },
      items: [],
    };
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: false,
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.commands.some((c) => c.sourceSpan?.startsWith("inline@"))).toBe(false);
    expect(result.commands.some((c) => c.source === "verify_commands")).toBe(true);
    expect(result.commands.some((c) => c.source === "explicit")).toBe(false);
  });
});
