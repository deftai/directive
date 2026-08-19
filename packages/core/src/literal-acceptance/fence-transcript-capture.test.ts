import { describe, expect, it } from "vitest";
import { captureLiteralAcceptanceCommandsDetailed } from "./capture.js";
import { evaluateLiteralAcceptanceFromPlan, resolveLiteralAcceptanceDetailed } from "./evaluate.js";

/**
 * Regression: fenced terminal transcript and inline mentions must not become
 * blocking acceptance commands (#3511). Fixtures follow #3502 (zero structured
 * commands) and #3506 (fat rejected ledger + stated commands).
 */

/** #3502 Evidence fences plus the Not-in-scope inline mention, verbatim. */
const OVERVIEW_3502 = [
  "Observed on this repo during the v0.105.0 cut:",
  "",
  "```",
  "[1/13] Pre-flight git status... FAIL (working tree is dirty; commit/stash or pass --allow-dirty)",
  "```",
  "",
  "A nested `biome.json` inside an agent worktree was picked up by biome:",
  "",
  "```",
  "[ts:check-lane] `pnpm run lint` failed (exit 1).",
  "  .claude/worktrees/agent-<id>/biome.json configuration ━━━━━━━━",
  "  $ biome migrate --write",
  "```",
  "",
  "Once agent worktrees are ignored they will still be on disk; if a stray nested `biome.json` can still break `pnpm run lint`, that needs its own handling.",
].join("\n");

const PHANTOM_PREFLIGHT =
  "[1/13] Pre-flight git status... FAIL (working tree is dirty; commit/stash or pass --allow-dirty)";
const PHANTOM_TS_LANE = "[ts:check-lane] `pnpm run lint` failed (exit 1)";
const PHANTOM_BIOME_CONFIG = ".claude/worktrees/agent-<id>/biome.json configuration ━━━━━━━━";
const PHANTOM_BIOME_MIGRATE = "biome migrate --write";
const PHANTOM_PNPM_LINT = "pnpm run lint";

/** Persisted #3502 ledger (ingest-time capture, source spans frozen). */
const REJECTED_3502: readonly { command: string; reason: string; sourceSpan: string }[] = [
  {
    command: PHANTOM_PREFLIGHT,
    reason: 'shell metacharacter "(" is not allowed in literal AC commands',
    sourceSpan: "fence@L13",
  },
  {
    command: PHANTOM_TS_LANE,
    reason: 'shell metacharacter "`" is not allowed in literal AC commands',
    sourceSpan: "fence@L21",
  },
  {
    command: PHANTOM_BIOME_CONFIG,
    reason: 'shell metacharacter "<" is not allowed in literal AC commands',
    sourceSpan: "fence@L21",
  },
  {
    command: PHANTOM_BIOME_MIGRATE,
    reason: 'first token "biome" is not in the literal-AC allowlist',
    sourceSpan: "fence@L21",
  },
  {
    command: PHANTOM_PNPM_LINT,
    reason:
      "package-manager args must be test|exec vitest|run test|run check|--version (arbitrary scripts/network install denied for ambient-authority)",
    sourceSpan: "inline@L22",
  },
];

function plan3502(): Record<string, unknown> {
  return {
    title: "agent-host working dirs are not gitignored",
    acceptance: { commands: [], none_stated: true, source_rung: "derived" },
    metadata: {
      literal_acceptance_commands: [],
      literal_acceptance_rejected: REJECTED_3502,
      swarm: {},
    },
    narratives: { Overview: OVERVIEW_3502 },
    items: [],
  };
}

/** Frozen #3506 rejected ledger (prose/fence/inline phantoms). */
const REJECTED_3506: readonly { command: string; reason: string; sourceSpan: string }[] = [
  {
    command: "task agents:refresh",
    reason:
      "wrapper subcommand must be check|doctor|verify:*|help|--version (scope/policy/swarm/scm/merge and other ambient-authority verbs denied)",
    sourceSpan: "fence@L51",
  },
  {
    command:
      "Recovery: run `deft session:ready` (one-shot: session:start + gated ritual + cache recovery as needed)",
    reason: 'shell metacharacter "`" is not allowed in literal AC commands',
    sourceSpan: "prompt@L14",
  },
  {
    command: "verify:session-ritual --tier=gated",
    reason: "path-like first token is not allowlisted",
    sourceSpan: "inline@L3",
  },
  {
    command: "deft session:ready",
    reason:
      "wrapper subcommand must be check|doctor|verify:*|help|--version (scope/policy/swarm/scm/merge and other ambient-authority verbs denied)",
    sourceSpan: "inline@L3",
  },
  {
    command: "cache fetch-all",
    reason: 'first token "cache" is not in the literal-AC allowlist',
    sourceSpan: "inline@L3",
  },
  {
    command: 'verifySessionRitual(root, {tier:"gated"})',
    reason: 'shell metacharacter "(" is not allowed in literal AC commands',
    sourceSpan: "inline@L7",
  },
  {
    command: "task pr:check-closing-keywords",
    reason:
      "wrapper subcommand must be check|doctor|verify:*|help|--version (scope/policy/swarm/scm/merge and other ambient-authority verbs denied)",
    sourceSpan: "inline@L70",
  },
];

function plan3506(opts: { structured: boolean }): Record<string, unknown> {
  return {
    title: "gated ritual failure never surfaces session:ready",
    acceptance: opts.structured
      ? {
          commands: [{ command: "task check" }],
          none_stated: false,
          source_rung: "stated",
        }
      : { commands: [], none_stated: true, source_rung: "derived" },
    metadata: {
      literal_acceptance_commands: opts.structured
        ? [
            {
              command: "task check",
              source: "verify_commands",
              sourceSpan: "swarm.verify_commands",
            },
          ]
        : [],
      literal_acceptance_rejected: REJECTED_3506,
      swarm: opts.structured ? { verify_commands: ["task check"] } : {},
    },
    narratives: {
      Overview: "Consumer deposit names the one-shot in `agents-entry.md`.",
    },
    items: [],
  };
}

const greenRunner = () => ({ exitCode: 0, stdout: "", stderr: "" });

describe("output-shaped fences are not captured (#3511)", () => {
  it("does not capture the #3502 [1/13] / biome transcript fences", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(OVERVIEW_3502);
    const all = [
      ...detailed.commands.map((c) => c.command),
      ...detailed.rejected.map((r) => r.command),
    ];
    expect(all).not.toContain(PHANTOM_PREFLIGHT);
    expect(all).not.toContain(PHANTOM_TS_LANE);
    expect(all).not.toContain(PHANTOM_BIOME_CONFIG);
    expect(all).not.toContain(PHANTOM_BIOME_MIGRATE);
    expect(detailed.rejected.some((r) => r.sourceSpan?.startsWith("fence@"))).toBe(false);
  });

  it("does not capture $ biome migrate --write from inside a transcript fence as prompt@", () => {
    const detailed = captureLiteralAcceptanceCommandsDetailed(OVERVIEW_3502);
    expect(detailed.rejected.map((r) => r.command)).not.toContain(PHANTOM_BIOME_MIGRATE);
    expect(detailed.commands.map((c) => c.command)).not.toContain(PHANTOM_BIOME_MIGRATE);
  });

  it("does not let a 4-backtick fence suppress later labeled commands (#3511 P1)", () => {
    const text = [
      "````",
      "inner fence content that is not a command",
      "````",
      "verify: task check",
      "Please run `pnpm test` before done.",
    ].join("\n");
    const cmds = captureLiteralAcceptanceCommandsDetailed(text).commands.map((c) => c.command);
    expect(cmds).toEqual(expect.arrayContaining(["task check", "pnpm test"]));
  });

  it("still captures a genuine command next to a comment in an acceptance fence", () => {
    const text = [
      "## Acceptance",
      "```bash",
      "pnpm exec vitest run packages/core/src/literal-acceptance",
      "# Error: last run was red — rerun this command",
      "$ task check",
      "```",
    ].join("\n");
    const cmds = captureLiteralAcceptanceCommandsDetailed(text).commands.map((c) => c.command);
    expect(cmds).toEqual(
      expect.arrayContaining([
        "pnpm exec vitest run packages/core/src/literal-acceptance",
        "task check",
      ]),
    );
  });

  it("still captures a genuine acceptance fence without transcript markers", () => {
    const text = [
      "## Acceptance",
      "```bash",
      "pnpm exec vitest run packages/core/src/literal-acceptance",
      "$ task check",
      "```",
    ].join("\n");
    const cmds = captureLiteralAcceptanceCommandsDetailed(text).commands.map((c) => c.command);
    expect(cmds).toEqual(
      expect.arrayContaining([
        "pnpm exec vitest run packages/core/src/literal-acceptance",
        "task check",
      ]),
    );
  });
});

describe("prose/fence-derived rejections are advisory without structured commands (#3511)", () => {
  it("demotes persisted fence@ and inline@ rejections on the #3502 brief (count 0 structured)", () => {
    const resolved = resolveLiteralAcceptanceDetailed(plan3502(), {
      captureFromNarratives: true,
    });
    expect(resolved.rejected).toEqual([]);
    const spans = resolved.advisoryRejected.map((r) => r.sourceSpan ?? "");
    expect(spans.some((s) => s.startsWith("fence@"))).toBe(true);
    expect(spans.some((s) => s.startsWith("inline@"))).toBe(true);
    expect(resolved.advisoryRejected.map((r) => r.command)).toEqual(
      expect.arrayContaining([PHANTOM_PREFLIGHT, PHANTOM_PNPM_LINT]),
    );
  });

  it("does not block evaluate / scope:complete on the #3502 brief as-is", () => {
    const result = evaluateLiteralAcceptanceFromPlan(plan3502(), {
      projectRoot: process.cwd(),
      runner: greenRunner,
    });
    expect(result.ok).toBe(true);
    expect(result.rejected ?? []).toEqual([]);
    expect(result.message).not.toMatch(/gate FAILED/i);
    expect(result.message).toContain("do NOT block");
  });

  it("does not block the #3506 fat ledger with or without structured commands", () => {
    for (const structured of [true, false]) {
      const result = evaluateLiteralAcceptanceFromPlan(plan3506({ structured }), {
        projectRoot: process.cwd(),
        captureFromNarratives: false,
        runner: greenRunner,
      });
      expect(result.ok).toBe(true);
      expect(result.rejected ?? []).toEqual([]);
      expect(result.advisoryRejected?.map((r) => r.sourceSpan ?? "")).toEqual(
        expect.arrayContaining(["fence@L51", "inline@L3", "prompt@L14"]),
      );
    }
  });

  it("still blocks a genuinely unsafe command stated in a structured field", () => {
    const plan = {
      title: "t",
      metadata: {
        swarm: { verify_commands: ["biome migrate --write"] },
      },
      items: [],
    };
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      captureFromNarratives: false,
      runner: greenRunner,
    });
    expect(result.ok).toBe(false);
    expect(result.rejected?.map((r) => r.command)).toEqual(["biome migrate --write"]);
    expect(result.rejected?.map((r) => r.sourceSpan)).toEqual(["swarm.verify_commands"]);
    expect(result.advisoryRejected ?? []).toEqual([]);
  });
});
