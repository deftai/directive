import { describe, expect, it } from "vitest";
import { evaluateVerifyAcFromPlan } from "../product-first-done-gate/evaluate.js";
import { evaluateScopeCompleteAcceptanceWalk } from "../scope/acceptance-evidence.js";
import { renderVerbHelp } from "../triage/help/index.js";
import {
  captureLiteralAcceptanceCommandsDetailed,
  INLINE_PROSE_MENTION_REASON,
  isInlineProseMention,
  readNotAcceptanceCommands,
} from "./capture.js";
import { evaluateLiteralAcceptanceFromPlan, resolveLiteralAcceptanceDetailed } from "./evaluate.js";
import { runLiteralAcceptanceCommands } from "./run.js";

/**
 * #3721: inline-backticked verb mentions in issue/comment prose must not become
 * stated acceptance commands that block scope:complete.
 *
 * Shape matches the live #3712 failure (do not mutate that brief): Overview
 * concatenates body + comment thread; ingest stored one inline@ task_statement;
 * complete re-scans Overview and used to add more unpromoted peers.
 */

const OVERVIEW_3712_SHAPE = [
  "Correct one sentence in AGENTS.md about scope provenance.",
  "",
  "The CI workflow cites `run: task check:merge` in a path.",
  "That clause covers `deft verify:*` and related verbs.",
  "",
  "## Issue comment thread",
  "",
  "### Comment by critic",
  "",
  "I did not run `task verify:scope-provenance`. Method was in-process evaluate.",
].join("\n");

function plan3712Shape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "docs(agents): scope provenance is not warn-on-empty only",
    narratives: {
      Overview: OVERVIEW_3712_SHAPE,
    },
    metadata: {
      literal_acceptance_commands: [
        {
          command: "deft verify:*",
          source: "task_statement",
          sourceSpan: "inline@L47",
        },
      ],
      swarm: {},
    },
    items: [],
    ...overrides,
  };
}

describe("inline backtick in prose is not a stated command (#3721)", () => {
  it("does not capture backticked verbs from #3712-shaped Overview as stated commands", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(OVERVIEW_3712_SHAPE);
    const stated = detailed.commands.map((c) => c.command);
    expect(stated).not.toContain("task check");
    expect(stated).not.toContain("deft verify:*");
    expect(stated).not.toContain("task verify:scope-provenance");
    expect(detailed.rejected.map((r) => r.command)).toEqual(
      expect.arrayContaining(["deft verify:*", "task verify:scope-provenance"]),
    );
    expect(detailed.rejected.every((r) => r.reason === INLINE_PROSE_MENTION_REASON)).toBe(true);
  });

  it("completes a brief whose Overview contains backticked verb prose without promotion", () => {
    const plan = plan3712Shape();
    const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: true });
    expect(resolved.commands.filter((c) => c.source === "task_statement")).toEqual([]);
    expect(resolved.rejected).toEqual([]);

    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: true,
      runner: () => {
        throw new Error("must not spawn; no stated executable AC");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/gate FAILED/i);
    expect(result.message).not.toMatch(/capture-only/);
  });

  it("demotes a stored inline@ task_statement row so ingest leftovers do not block", () => {
    expect(
      isInlineProseMention({
        source: "task_statement",
        sourceSpan: "inline@L47",
      }),
    ).toBe(true);
    expect(
      isInlineProseMention({
        source: "task_statement",
        sourceSpan: "labeled@L1",
      }),
    ).toBe(false);

    const result = runLiteralAcceptanceCommands(
      [{ command: "deft verify:*", source: "task_statement", sourceSpan: "inline@L47" }],
      {
        projectRoot: process.cwd(),
        runner: () => {
          throw new Error("must not execute an inline prose mention");
        },
      },
    );
    expect(result.ok).toBe(true);
  });

  it("still requires promotion for a labeled verify: line (protection preserved)", () => {
    const plan = {
      title: "t",
      narratives: { Overview: "verify: task check" },
      items: [],
    };
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: true,
      runner: () => {
        throw new Error("must fail closed on unpromoted labeled statement");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.commands.map((c) => c.command)).toContain("task check");
    expect(result.message).toMatch(/capture-only|Promote|verify_commands/);
    expect(result.message).toMatch(/literal_acceptance_not_commands/);
  });

  it("still requires promotion for a fenced acceptance command (fences stay stated)", () => {
    const plan = {
      title: "t",
      narratives: {
        Overview: ["## Acceptance", "```bash", "task doctor", "```"].join("\n"),
      },
      items: [],
    };
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: true,
      runner: () => {
        throw new Error("must fail closed on unpromoted fence statement");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.commands.map((c) => c.command)).toContain("task doctor");
  });

  it("lets the operator disposition a labeled capture without promoting it", () => {
    const plan = {
      title: "t",
      narratives: { Overview: "verify: task check" },
      metadata: {
        literal_acceptance_not_commands: [
          { command: "task check", reason: "mentioned in critic footnote, not story AC" },
        ],
      },
      items: [],
    };
    expect(readNotAcceptanceCommands(plan).has("task check")).toBe(true);
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: true,
      runner: () => {
        throw new Error("must not run a dispositioned capture");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.commands.map((c) => c.command)).not.toContain("task check");
    expect(result.advisoryRejected?.map((r) => r.command)).toContain("task check");
    const swarm = (plan.metadata as { swarm?: { verify_commands?: string[] } }).swarm;
    expect(swarm?.verify_commands ?? []).not.toContain("task check");
  });

  it("does not execute ingest-stamped plan.acceptance.commands that are inline mentions", () => {
    const plan = plan3712Shape({
      acceptance: {
        commands: [{ command: "deft verify:*" }],
        none_stated: false,
        source_rung: "stated",
      },
    });
    const result = evaluateVerifyAcFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: true,
      runner: () => {
        throw new Error("must not run deft verify:* from the #3449 fallback");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.runs).toEqual([]);
  });

  it("lets the complete verify:ac walk pass the #3712 shape without promotion", () => {
    const walk = evaluateScopeCompleteAcceptanceWalk(
      plan3712Shape({
        acceptance: {
          commands: [{ command: "deft verify:*" }],
          none_stated: false,
          source_rung: "stated",
        },
      }),
      {
        projectRoot: process.cwd(),
        runner: () => {
          throw new Error("must not spawn on the complete walk");
        },
      },
    );
    expect(walk.ok).toBe(true);
  });

  it("still blocks an unsafe command stated in a structured field", () => {
    const plan = {
      title: "t",
      metadata: {
        swarm: { verify_commands: ["task check; rm -rf /tmp/x"] },
      },
      items: [],
    };
    const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: false });
    expect(resolved.rejected.map((r) => r.sourceSpan)).toEqual(["swarm.verify_commands"]);
    expect(resolved.advisoryRejected).toEqual([]);
  });
});

describe("readNotAcceptanceCommands (#3721)", () => {
  it("reads string, camelCase, and mixed array forms; ignores junk", () => {
    expect(readNotAcceptanceCommands(null).size).toBe(0);
    expect(readNotAcceptanceCommands({}).size).toBe(0);
    expect(
      readNotAcceptanceCommands({
        metadata: { literal_acceptance_not_commands: "task check" },
      }).has("task check"),
    ).toBe(true);
    const mixed = readNotAcceptanceCommands({
      metadata: {
        literalAcceptanceNotCommands: ["  pnpm test  ", "", 3, { command: "task doctor" }],
      },
    });
    expect(mixed.has("pnpm test")).toBe(true);
    expect(mixed.has("task doctor")).toBe(true);
    expect(mixed.size).toBe(2);
  });

  it("treats a missing sourceSpan as stated, not an inline mention", () => {
    expect(isInlineProseMention({ source: "task_statement", sourceSpan: null })).toBe(false);
    expect(isInlineProseMention({ source: "explicit", sourceSpan: "inline@L1" })).toBe(false);
  });
});

describe("scope:complete --help lists delivery flags (#3721)", () => {
  it("registry help names --merge-commit and --pr", () => {
    const text = renderVerbHelp("task scope:complete");
    expect(text).toMatch(/--merge-commit/);
    expect(text).toMatch(/--pr N/);
  });
});
