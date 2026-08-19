import { describe, expect, it } from "vitest";
import {
  captureLiteralAcceptanceCommandsDetailed,
  hasStructuredAcceptanceCommands,
} from "./capture.js";
import { evaluateLiteralAcceptanceFromPlan, resolveLiteralAcceptanceDetailed } from "./evaluate.js";

/**
 * Regression: mid-line `verify:` in prose must not become a phantom command (#3484).
 *
 * Fixtures are the literal narratives of #3476 (xbrief/active/2026-08-18-3476-
 * drive-to-done-completed-tracked.xbrief.json), whose Overview and
 * ImplementationPlan each produced a safety-rejected phantom that permanently
 * blocked `task scope:complete`.
 */

/** #3476 plan.narratives.Overview, verbatim. */
const OVERVIEW_3476 = [
  "drive-to workers run scope:complete after the product PR merges. That verb is filesystem-only. verify:orphan-active goes green. verify:completed-tracked is not on task check and not in the DONE contract. Master never gets the artifact until a later land PR.",
  "",
  "Designed land path already exists: Phase 6 Step 2b and task swarm:finalize-cohort. Leaves do not run it. Parent can emit done under #2934 without it.",
  "",
  "Proposed: (1) Drive-to DONE includes completed-tracked against origin/deliveryBranch, not feature-worktree HEAD. (2) scope:complete stays fs-only. (3) After last drive-to leaf, parent done without finalize-cohort / completed-tracked green is a failed close. (4) Keep completed-tracked off task check.",
].join("\n");

/** #3476 plan.narratives.ImplementationPlan, verbatim. */
const IMPLEMENTATION_PLAN_3476 =
  "1. Preamble + swarm Phase 6: drive-to DONE requires verify:completed-tracked against origin/<deliveryBranch> (add --issue N if missing). 2. Parent last-leaf close requires same-turn finalize-cohort or completed-tracked green. 3. scope:complete stays fs-only. 4. Keep the verb off check:framework-source / check:consumer. 5. Tests + CHANGELOG. Closes #3476.";

/** The exact phantom that the mid-line scraper produced from Overview. */
const PHANTOM_OVERVIEW =
  "orphan-active goes green. verify:completed-tracked is not on task check and not in the DONE contract. Master never gets the artifact until a later land PR";

/** The exact phantom that the mid-line scraper produced from ImplementationPlan. */
const PHANTOM_IMPLEMENTATION_PLAN =
  "completed-tracked against origin/<deliveryBranch> (add --issue N if missing). 2. Parent last-leaf close requires same-turn finalize-cohort or completed-tracked green. 3. scope:complete stays fs-only. 4. Keep the verb off check:framework-source / check:consumer. 5. Tests + CHANGELOG. Closes #3476";

const STRUCTURED_3476 =
  "pnpm exec vitest run packages/core/src/lifecycle/completed-tracked-on-delivery.test.ts packages/cli/src/verify-completed-tracked.test.ts";

function plan3476(): Record<string, unknown> {
  return {
    title: "drive-to DONE requires completed-tracked on delivery tip",
    metadata: {
      swarm: {
        verify_commands: [STRUCTURED_3476],
      },
    },
    narratives: {
      Overview: OVERVIEW_3476,
      ImplementationPlan: IMPLEMENTATION_PLAN_3476,
    },
    items: [],
  };
}

describe("mid-line verify: in prose is not a command (#3484)", () => {
  it("captures nothing from the #3476 Overview narrative", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(OVERVIEW_3476);
    expect(detailed.commands).toEqual([]);
    expect(detailed.rejected).toEqual([]);
  });

  it("captures nothing from the #3476 ImplementationPlan narrative", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(IMPLEMENTATION_PLAN_3476);
    expect(detailed.commands).toEqual([]);
    expect(detailed.rejected).toEqual([]);
  });

  it("never produces either literal phantom string", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(
      `${OVERVIEW_3476}\n\n${IMPLEMENTATION_PLAN_3476}`,
    );
    const all = [
      ...detailed.commands.map((c) => c.command),
      ...detailed.rejected.map((r) => r.command),
    ];
    expect(all).not.toContain(PHANTOM_OVERVIEW);
    expect(all).not.toContain(PHANTOM_IMPLEMENTATION_PLAN);
    expect(all).toEqual([]);
  });

  it("still captures a labeled command that starts its own line", () => {
    const text = [
      "verify: task check",
      "- verify: pnpm test",
      "2. verify: task doctor",
      "Prose that mentions verify:orphan-active mid-sentence stays prose.",
    ].join("\n");
    const cmds = captureLiteralAcceptanceCommandsDetailed(text).commands.map((c) => c.command);
    expect(cmds).toEqual(expect.arrayContaining(["task check", "pnpm test", "task doctor"]));
    expect(cmds.some((c) => c.includes("orphan-active"))).toBe(false);
  });

  it("resolves #3476 to the one structured command and an empty rejected ledger", () => {
    const resolved = resolveLiteralAcceptanceDetailed(plan3476(), {
      captureFromNarratives: true,
    });
    expect(resolved.rejected).toEqual([]);
    expect(resolved.advisoryRejected).toEqual([]);
    expect(resolved.commands.map((c) => c.command)).toEqual([STRUCTURED_3476]);
    expect(resolved.commands[0]?.source).toBe("verify_commands");
  });

  it("does not block completion for #3476", () => {
    const result = evaluateLiteralAcceptanceFromPlan(plan3476(), {
      projectRoot: process.cwd(),
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.rejected ?? []).toEqual([]);
    expect(result.message).not.toContain("FAILED");
  });
});

describe("structured acceptance beats scraped prose (#3484)", () => {
  it("detects structured commands from swarm.verify_commands and plan.acceptance", () => {
    expect(hasStructuredAcceptanceCommands(plan3476())).toBe(true);
    expect(
      hasStructuredAcceptanceCommands({
        acceptance: { commands: [{ command: "task check" }] },
      }),
    ).toBe(true);
    expect(hasStructuredAcceptanceCommands({ metadata: { swarm: { verify_commands: [] } } })).toBe(
      false,
    );
    expect(hasStructuredAcceptanceCommands({ acceptance: { commands: [] } })).toBe(false);
    expect(hasStructuredAcceptanceCommands(null)).toBe(false);
  });

  it("demotes a persisted prose-derived rejection to advisory when structured commands exist", () => {
    const plan = {
      title: "t",
      metadata: {
        literal_acceptance_rejected: [
          {
            command: PHANTOM_OVERVIEW,
            reason: 'first token "orphan-active" is not in the literal-AC allowlist',
            sourceSpan: "labeled@L1",
          },
        ],
        swarm: { verify_commands: [STRUCTURED_3476] },
      },
      items: [],
    };
    const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: false });
    expect(resolved.rejected).toEqual([]);
    expect(resolved.advisoryRejected.map((r) => r.command)).toEqual([PHANTOM_OVERVIEW]);

    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: false,
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("advisory");
  });

  it("demotes a prose-derived rejection even when no structured commands exist (#3511)", () => {
    const plan = {
      title: "t",
      metadata: {
        literal_acceptance_rejected: [
          {
            command: PHANTOM_OVERVIEW,
            reason: 'first token "orphan-active" is not in the literal-AC allowlist',
            sourceSpan: "labeled@L1",
          },
        ],
      },
      items: [],
    };
    const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: false });
    expect(resolved.rejected).toEqual([]);
    expect(resolved.advisoryRejected.map((r) => r.command)).toEqual([PHANTOM_OVERVIEW]);
  });

  it("still blocks on an unsafe command stated in a structured field", () => {
    const plan = {
      title: "t",
      metadata: {
        swarm: { verify_commands: [STRUCTURED_3476, "task check; rm -rf /tmp/x"] },
      },
      items: [],
    };
    const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: false });
    // Structured provenance is never demoted — the author asked for this one.
    expect(resolved.rejected.map((r) => r.sourceSpan)).toEqual(["swarm.verify_commands"]);
    expect(resolved.advisoryRejected).toEqual([]);
  });
});
