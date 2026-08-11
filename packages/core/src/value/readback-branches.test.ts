import { describe, expect, it } from "vitest";
import type { BehavioralEventRecord } from "../lifecycle/events.js";
import {
  formatAttributedSessionLine,
  formatValueShowReport,
  parseValueShowArgs,
  parseWindowMs,
  selectSessionAttribution,
} from "./readback.js";

function evt(
  event: string,
  payload: Record<string, unknown> = {},
  detected_at = "2026-08-01T12:00:00Z",
  id = "e1",
): BehavioralEventRecord {
  return {
    event,
    id,
    detected_at,
    payload,
  } as BehavioralEventRecord;
}

/**
 * Pure-helper branch matrix for value readback (#3287 / #1709).
 * Hits format / parse / selection edges that sat below the 85% branch floor.
 */
describe("value readback pure helpers (#3287)", () => {
  it("formats every attributed event class with and without detail tails", () => {
    expect(
      formatAttributedSessionLine(
        evt("value:gate-catch", {
          source: "verify:branch",
          detail: "blocked",
          signal_class: "value",
        }),
      ),
    ).toMatch(/Gate catch.*blocked/);
    expect(formatAttributedSessionLine(evt("value:gate-catch", { signal_class: "value" }))).toMatch(
      /Gate catch \(gate\)/,
    );

    expect(
      formatAttributedSessionLine(
        evt("value:wip-cap-protect", { count: 3, cap: 20, signal_class: "value" }),
      ),
    ).toMatch(/3\/20/);
    expect(
      formatAttributedSessionLine(evt("value:wip-cap-protect", { signal_class: "value" })),
    ).toMatch(/WIP cap protected/);

    expect(
      formatAttributedSessionLine(
        evt("bypass:off-flow", { source: "hook", detail: "skip", signal_class: "bypass" }),
      ),
    ).toMatch(/Off-flow.*skip/);
    expect(formatAttributedSessionLine(evt("bypass:off-flow", { signal_class: "bypass" }))).toMatch(
      /Off-flow signal \(bypass\)/,
    );

    // Distinct detail vs capability so detail-precedence is observable.
    expect(
      formatAttributedSessionLine(
        evt("adoption:unused-capability", {
          detail: "detail-wins",
          capability: "capability-fallback",
          signal_class: "adoption",
        }),
      ),
    ).toMatch(/Unused capability.*detail-wins/);
    expect(
      formatAttributedSessionLine(
        evt("adoption:unused-capability", {
          detail: "detail-wins",
          capability: "capability-fallback",
          signal_class: "adoption",
        }),
      ),
    ).not.toMatch(/capability-fallback/);
    expect(
      formatAttributedSessionLine(
        evt("adoption:unused-capability", { capability: "triage", signal_class: "adoption" }),
      ),
    ).toMatch(/Unused capability.*triage/);
    expect(
      formatAttributedSessionLine(evt("adoption:unused-capability", { signal_class: "adoption" })),
    ).toMatch(/Unused capability\./);

    expect(
      formatAttributedSessionLine(
        evt("friction:directive-gap", {
          source: "cli",
          detail: "missing",
          signal_class: "friction",
        }),
      ),
    ).toMatch(/Directive gap.*missing/);
    expect(
      formatAttributedSessionLine(evt("friction:directive-gap", { signal_class: "friction" })),
    ).toMatch(/Directive gap \(friction\)/);

    // default branch + numeric payload fields + signal_class fallback from event prefix
    expect(
      formatAttributedSessionLine(
        evt("value:other-signal", { count: 7, source: "x" } as Record<string, unknown>),
      ),
    ).toMatch(/\[value\] value:other-signal/);
    expect(formatAttributedSessionLine(evt("mystery:event", { signal_class: "value" }))).toMatch(
      /\[value\] mystery:event/,
    );
  });

  it("selects highest-priority attribution and prefers newer ties", () => {
    expect(selectSessionAttribution([])).toBeNull();
    const selected = selectSessionAttribution([
      evt("friction:directive-gap", { signal_class: "friction" }, "2026-08-01T10:00:00Z", "f"),
      evt("value:gate-catch", { signal_class: "value" }, "2026-08-01T09:00:00Z", "v"),
      evt("bypass:off-flow", { signal_class: "bypass" }, "2026-08-01T11:00:00Z", "b"),
    ]);
    expect(selected?.id).toBe("v");

    const newer = selectSessionAttribution([
      evt("value:gate-catch", { signal_class: "value" }, "2026-08-01T09:00:00Z", "old"),
      evt("value:gate-catch", { signal_class: "value" }, "2026-08-01T12:00:00Z", "new"),
    ]);
    expect(newer?.id).toBe("new");

    // invalid / missing detected_at still sorts (null → 0)
    const withBad = selectSessionAttribution([
      evt("value:gate-catch", { signal_class: "value" }, "not-a-date", "bad"),
      evt("value:gate-catch", { signal_class: "value" }, "2026-08-01T12:00:00Z", "good"),
    ]);
    expect(withBad?.id).toBe("good");
  });

  it("parses window tokens and falls back for invalid values", () => {
    expect(parseWindowMs(undefined)).toBe(7 * 86_400_000);
    expect(parseWindowMs("")).toBe(7 * 86_400_000);
    expect(parseWindowMs("  ")).toBe(7 * 86_400_000);
    expect(parseWindowMs("bogus")).toBe(7 * 86_400_000);
    expect(parseWindowMs("0d")).toBe(7 * 86_400_000);
    expect(parseWindowMs("-3d")).toBe(7 * 86_400_000);
    expect(parseWindowMs("2d")).toBe(2 * 86_400_000);
    expect(parseWindowMs("3h")).toBe(3 * 3_600_000);
    expect(parseWindowMs("15m")).toBe(15 * 60_000);
    expect(parseWindowMs("10D")).toBe(10 * 86_400_000);
  });

  it("parses value:show argv shapes including error paths", () => {
    expect(parseValueShowArgs(["--format", "json"]).format).toBe("json");
    expect(parseValueShowArgs(["--format", "text"]).format).toBe("text");
    expect(parseValueShowArgs(["--format=json"]).format).toBe("json");
    expect(parseValueShowArgs(["--format=yaml"]).error).toMatch(/expects text\|json/);
    expect(parseValueShowArgs(["--format", "yaml"]).error).toMatch(/expects text\|json/);
    expect(parseValueShowArgs(["--window", "30d"]).window).toBe("30d");
    expect(parseValueShowArgs(["--window"]).error).toMatch(/--window requires/);
    expect(parseValueShowArgs(["--window=14d"]).window).toBe("14d");
    expect(parseValueShowArgs(["--project-root", "/tmp/x"]).projectRoot).toBe("/tmp/x");
    expect(parseValueShowArgs(["--project-root"]).error).toMatch(/--project-root requires/);
    expect(parseValueShowArgs(["--project-root=/tmp/y"]).projectRoot).toBe("/tmp/y");
    expect(parseValueShowArgs(["--unknown"]).error).toMatch(/unrecognized/);
  });

  it("formats empty and non-empty value:show reports", () => {
    const empty = formatValueShowReport({
      windowLabel: "7d",
      windowMs: 7 * 86_400_000,
      total: 0,
      byClass: { value: 0, bypass: 0, adoption: 0, friction: 0 },
      byEvent: {},
      recent: [],
    });
    expect(empty).toMatch(/No attributed signals/);

    const populated = formatValueShowReport({
      windowLabel: "7d",
      windowMs: 7 * 86_400_000,
      total: 3,
      byClass: { value: 2, bypass: 1, adoption: 0, friction: 0 },
      byEvent: { "value:gate-catch": 2, "bypass:off-flow": 1 },
      recent: [],
    });
    expect(populated).toMatch(/total/);
    expect(populated).toMatch(/value=2/);
    expect(populated).toMatch(/bypass=1/);
    expect(populated).toMatch(/value:gate-catch: 2/);
  });
});
