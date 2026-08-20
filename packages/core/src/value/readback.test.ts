import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache } from "../lifecycle/events.js";
import { PROCESS_COST_EVENT_NAMES } from "../session/process-cost.js";
import {
  computeValueShowTrend,
  emitSessionValueReadback,
  formatAttributedSessionLine,
  parseValueShowArgs,
  parseWindowMs,
  readAttributionEvents,
  renderSessionReadback,
  runValueShow,
  selectSessionAttribution,
  shouldSuppressSessionReadback,
  VALUE_READBACK_HISTORY_REL,
} from "./readback.js";

const temps: string[] = [];

// `JSON.parse` returns top-level `null` (not a throw) for the literal `null`,
// so a guarded parse keeps property reads from blowing up with a TypeError.
function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `expected a JSON object payload, received ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

afterEach(() => {
  clearRegistryCache();
});

function makeRepo(options: {
  valueFeedback?: Record<string, unknown>;
  events?: Array<{ event: string; payload: Record<string, unknown>; detected_at?: string }>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-readback-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const policy =
    options.valueFeedback !== undefined
      ? { wipCap: 20, valueFeedback: options.valueFeedback }
      : { wipCap: 20 };
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy },
    }),
    "utf8",
  );
  if (options.events !== undefined && options.events.length > 0) {
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    const lines = options.events.map((entry, index) =>
      JSON.stringify({
        event: entry.event,
        id: `evt-${index}`,
        detected_at: entry.detected_at ?? "2026-07-01T12:00:00Z",
        payload: { signal_class: entry.event.split(":")[0], ...entry.payload },
      }),
    );
    writeFileSync(join(root, ".deft-cache", "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }
  return root;
}

describe("readAttributionEvents", () => {
  it("returns empty when the ledger file is absent", () => {
    const root = makeRepo({});
    expect(readAttributionEvents({ projectRoot: root })).toEqual([]);
  });

  it("filters to attribution event names only", () => {
    const root = makeRepo({
      events: [
        { event: "value:gate-catch", payload: { source: "verify:branch", detail: "blocked" } },
        { event: "session:interrupted", payload: { session_id: "s", reason: "r" } } as never,
      ],
    });
    expect(readAttributionEvents({ projectRoot: root })).toHaveLength(1);
  });
});

describe("session readback silence and budget", () => {
  it("emits no session line when the ledger is empty", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: true, emitEvents: true },
    });
    const result = renderSessionReadback(root);
    expect(result.line).toBeNull();
    expect(result.gated).toBe(false);
  });

  it("stays gated when sessionLine path is OFF", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: false, emitEvents: true },
      events: [{ event: "value:gate-catch", payload: { source: "verify:branch", detail: "x" } }],
    });
    expect(renderSessionReadback(root).line).toBeNull();
    expect(renderSessionReadback(root).gated).toBe(true);
  });

  it("renders at most one attributed line within the char budget", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: true, emitEvents: true },
      events: [
        {
          event: "adoption:unused-capability",
          payload: { source: "a", capability: "swarm", detail: "hint" },
        },
        {
          event: "value:gate-catch",
          payload: { source: "verify:branch", detail: "blocked default branch" },
        },
      ],
    });
    const result = renderSessionReadback(root, { writeHistory: false });
    expect(result.line).toMatch(/^\[value\]/);
    expect(result.line?.length ?? 0).toBeLessThanOrEqual(120);
  });

  it("prefers value signals over adoption for the single session slot", () => {
    const events = [
      {
        event: "adoption:unused-capability",
        payload: { source: "a", capability: "cost", detail: "run capacity" },
      },
      { event: "bypass:off-flow", payload: { source: "hook", detail: "skipped pre-commit" } },
      { event: "value:wip-cap-protect", payload: { source: "verify:wip-cap", count: 3, cap: 2 } },
    ];
    const selected = selectSessionAttribution(
      readAttributionEvents({
        projectRoot: makeRepo({ events }),
      }),
    );
    expect(selected?.event).toBe("value:wip-cap-protect");
  });

  it("suppresses repeat emission within the 4h debounce window", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: true, emitEvents: true },
      events: [
        { event: "value:gate-catch", payload: { source: "verify:branch", detail: "blocked" } },
      ],
    });
    const first = renderSessionReadback(root, { now: new Date("2026-07-05T10:00:00Z") });
    expect(first.line).not.toBeNull();

    const hist = join(root, VALUE_READBACK_HISTORY_REL);
    expect(existsSync(hist)).toBe(true);

    const second = renderSessionReadback(root, { now: new Date("2026-07-05T11:00:00Z") });
    expect(second.line).toBeNull();
    expect(second.suppressed).toBe(true);
  });

  it("emitSessionValueReadback writes nothing when empty", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: true, emitEvents: true },
    });
    const lines: string[] = [];
    expect(
      emitSessionValueReadback(root, { output: (l) => lines.push(l), writeHistory: false }),
    ).toBeNull();
    expect(lines).toEqual([]);
  });

  it("session boundary friction probe stays silent on the fixed #1694 omit-by-design seed (#2339 / #1694)", () => {
    // Pre-fix this seed fired friction:directive-gap via wipCap-unsatisfiable-nudge.
    // After decision-provenance, greenfield incomplete is not a contradictory gate.
    const enabledPolicy = {
      enabled: true,
      emitEvents: true,
      sessionLine: true,
      upstreamPrompt: false,
      source: "typed" as const,
      error: null,
    };
    const root = mkdtempSync(join(tmpdir(), "deft-readback-probe-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.6" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-directive/policy": { triageScope: [{ rule: "all-open" }] },
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, "xbrief", ".eval"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".eval", "candidates.jsonl"), '{"issue":1}\n', "utf8");

    renderSessionReadback(root, { writeHistory: false, policyOverride: enabledPolicy });
    const events = readAttributionEvents({ projectRoot: root });
    expect(events.some((entry) => entry.event === "friction:directive-gap")).toBe(false);

    const lineResult = renderSessionReadback(root, {
      writeHistory: false,
      policyOverride: enabledPolicy,
    });
    expect(lineResult.line).toBeNull();
  });
});

describe("formatAttributedSessionLine", () => {
  it("formats concrete gate-catch attribution", () => {
    const line = formatAttributedSessionLine({
      event: "value:gate-catch",
      id: "1",
      detected_at: "2026-07-01T00:00:00Z",
      payload: { signal_class: "value", source: "verify:branch", detail: "default branch block" },
    });
    expect(line).toContain("verify:branch");
    expect(line).toContain("default branch block");
  });
});

describe("value:show trend readout", () => {
  it("reports empty ledger for the window", () => {
    const root = makeRepo({ valueFeedback: { enabled: true } });
    const result = runValueShow({ projectRoot: root, window: "7d" });
    expect(result.exitCode).toBe(0);
    expect(result.empty).toBe(true);
    expect(result.text).toContain("ledger empty");
  });

  it("returns class and event counts for recent attribution", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, emitEvents: true },
      events: [
        {
          event: "value:gate-catch",
          payload: { source: "verify:branch", detail: "a" },
          detected_at: "2026-07-04T10:00:00Z",
        },
        {
          event: "value:gate-catch",
          payload: { source: "verify:branch", detail: "b" },
          detected_at: "2026-07-04T11:00:00Z",
        },
        {
          event: "bypass:off-flow",
          payload: { source: "hook", detail: "skip" },
          detected_at: "2026-07-04T12:00:00Z",
        },
      ],
    });
    const trend = computeValueShowTrend(root, {
      windowMs: 7 * 86_400_000,
      now: new Date("2026-07-05T12:00:00Z"),
    });
    expect(trend.total).toBe(3);
    expect(trend.byClass.value).toBe(2);
    expect(trend.byClass.bypass).toBe(1);

    const result = runValueShow({
      projectRoot: root,
      window: "7d",
      now: new Date("2026-07-05T12:00:00Z"),
      policyOverride: {
        enabled: true,
        emitEvents: true,
        sessionLine: true,
        upstreamPrompt: false,
        source: "typed",
        error: null,
      },
    });
    expect(result.text).toContain("value=2");
    expect(result.text).toContain("bypass=1");
  });

  it("supports json output", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true },
      events: [
        {
          event: "value:gate-catch",
          payload: { source: "s", detail: "d" },
          detected_at: new Date().toISOString(),
        },
      ],
    });
    const result = runValueShow({ projectRoot: root, format: "json" });
    expect(result.text.trim().startsWith("{")).toBe(true);
    expect(JSON.parse(result.text)).toHaveProperty("total", 1);
  });

  it("blocks when valueFeedback master flag is OFF", () => {
    const root = makeRepo({ valueFeedback: { enabled: false } });
    const result = runValueShow({ projectRoot: root });
    expect(result.exitCode).toBe(1);
    expect(result.gated).toBe(true);
    expect(result.text).toContain("CLI process time");
    const gatedJson = runValueShow({ projectRoot: root, format: "json" });
    expect(gatedJson.exitCode).toBe(1);
    expect(gatedJson.text).toContain("CLI process time");
    expect(gatedJson.text.trim().startsWith("{")).toBe(false);
  });

  it("composes ceremony-cost rollup from process-cost events (#3508)", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true },
      events: [
        {
          event: PROCESS_COST_EVENT_NAMES.sessionStart,
          payload: {
            ceremony_tier: "cold",
            duration_ms: 321,
            exit_code: 0,
            steps: [
              { name: "alignment", duration_ms: 11 },
              { name: "ritual_write", duration_ms: 4 },
            ],
          },
          detected_at: "2026-08-19T12:00:00Z",
        },
        {
          event: PROCESS_COST_EVENT_NAMES.sessionStart,
          payload: { ceremony_tier: "rearm", duration_ms: 18, exit_code: 0 },
          detected_at: "2026-08-19T13:00:00Z",
        },
        {
          event: PROCESS_COST_EVENT_NAMES.sessionRitualBlocked,
          payload: { tool_name: "Write", code: "ritual-not-ready", recovery_tier: "cold" },
          detected_at: "2026-08-19T13:05:00Z",
        },
      ],
    });
    const result = runValueShow({
      projectRoot: root,
      window: "7d",
      now: new Date("2026-08-20T00:00:00Z"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("last cold: 321ms");
    expect(result.text).toContain("last re-arm: 18ms");
    expect(result.text).toContain(
      "steps (last cold session:start): alignment=11ms, ritual_write=4ms",
    );
    expect(result.text).toContain("blocked-ritual");
    expect(result.text).toContain("cold=1");
    expect(result.text).toContain("not agent-turn wall clock");
    expect(result.ceremonyCost?.kind).toBe("cli_process_time");
    expect(result.ceremonyCost?.lastColdDurationMs).toBe(321);

    const json = runValueShow({
      projectRoot: root,
      format: "json",
      now: new Date("2026-08-20T00:00:00Z"),
    });
    const parsed = JSON.parse(json.text) as {
      ceremonyCost: { lastColdDurationMs: number };
      process_cost_events: { sessionStart: string };
    };
    expect(parsed.ceremonyCost.lastColdDurationMs).toBe(321);
    expect(parsed.process_cost_events.sessionStart).toBe(PROCESS_COST_EVENT_NAMES.sessionStart);
  });
});

describe("parseWindowMs", () => {
  it("parses day and hour windows", () => {
    expect(parseWindowMs("7d")).toBe(7 * 86_400_000);
    expect(parseWindowMs("24h")).toBe(24 * 3_600_000);
  });
});

describe("parseValueShowArgs", () => {
  it("errors when --window is missing its value", () => {
    expect(parseValueShowArgs(["--window"]).error).toContain("--window requires");
  });
});

describe("shouldSuppressSessionReadback", () => {
  it("returns false when history is missing", () => {
    const root = makeRepo({});
    expect(
      shouldSuppressSessionReadback("evt-0", join(root, VALUE_READBACK_HISTORY_REL), {
        now: new Date("2026-07-05T12:00:00Z"),
      }),
    ).toBe(false);
  });
});

describe("debounce history persistence", () => {
  it("records emitted session lines for suppression checks", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: true },
      events: [{ event: "value:gate-catch", payload: { source: "verify:branch", detail: "x" } }],
    });
    renderSessionReadback(root, { now: new Date("2026-07-05T10:00:00Z") });
    const hist = join(root, VALUE_READBACK_HISTORY_REL);
    expect(existsSync(hist)).toBe(true);
    const parsed = parseJsonObject(readFileSync(hist, "utf8").trim());
    expect(parsed.event_id).toBe("evt-0");
    expect(String(parsed.line).length).toBeGreaterThan(0);
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("value readback history symlink containment (#2781)", () => {
  itSymlink("does not append when history path is a symlink to an external victim file", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, sessionLine: true },
      events: [{ event: "value:gate-catch", payload: { source: "verify:branch", detail: "x" } }],
    });
    const escapeDir = mkdtempSync(join(tmpdir(), "value-readback-victim-"));
    const victim = join(escapeDir, "value-readback-history.jsonl");
    writeFileSync(victim, "victim\n", "utf8");
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    symlinkSync(victim, join(root, VALUE_READBACK_HISTORY_REL));
    renderSessionReadback(root, { now: new Date("2026-07-05T10:00:00Z") });
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    rmSync(escapeDir, { recursive: true, force: true });
  });
});
