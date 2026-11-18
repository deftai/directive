/**
 * Parity matrix for the two activation writers (#6264).
 *
 * scope:activate (`runTransition("activate")`) and xbrief:activate
 * (`activate()`) must give the same exit code and the same lane-state write for
 * the same brief, from pending/ and from active/. Each verb runs on its own copy
 * of the fixture so neither run sees the other's writes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmallChangeLaneGateOverrides } from "../policy/small-change-lane.js";
import { activate } from "../vbrief-activate/activate.js";
import * as laneIngressGate from "./lane-ingress-gate.js";
import { runTransition } from "./transition.js";

const NAME = "2026-11-17-thin.xbrief.json";
const NOW = new Date("2026-11-17T12:00:00Z");
const MARKER_KEY = "x-directive/smallChangeLane";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function laneOverrides(root: string, lines: number): SmallChangeLaneGateOverrides {
  return {
    depth: "rapid",
    bound: { maxProductionFiles: 1, maxChangedLines: 5 },
    runGit: (args) => {
      const joined = args.join(" ");
      if (joined.startsWith("rev-parse --show-toplevel")) return { status: 0, stdout: `${root}\n` };
      if (joined.startsWith("rev-parse --verify")) return { status: 0, stdout: "parent0\n" };
      if (joined.startsWith("ls-files")) return { status: 0, stdout: "" };
      if (joined.startsWith("diff --numstat")) {
        return { status: 0, stdout: `${lines}\t0\tpackages/core/src/x.ts\0` };
      }
      if (joined.includes("diff -U0")) {
        return {
          status: 0,
          stdout: "diff --git a/packages/core/src/x.ts b/packages/core/src/x.ts\n+const x = 1;\n",
        };
      }
      return { status: 1, stdout: "" };
    },
  };
}

function marker(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "deft.small-change-lane.v1", state, admitBase: "admitbase0", ...extra };
}

type Start = "pending" | "active";
type Verb = "scope:activate" | "xbrief:activate";

interface Row {
  readonly name: string;
  readonly laneMarker: Record<string, unknown> | null;
  /** Changed lines the lane measures (bound is 5). */
  readonly lines: number;
  /** Acceptance carries a clause, so the #4768 ingress check passes on its own. */
  readonly clauses: boolean;
  readonly expectOk: boolean;
  /** Lane state on disk after the run; null when the brief has no lane marker. */
  readonly expectState: string | null;
  /** The refusal names the verb as a small-change lane refusal. */
  readonly laneRefusal: boolean;
}

const ROWS: readonly Row[] = [
  {
    name: "admitted within bound",
    laneMarker: marker("admitted"),
    lines: 3,
    clauses: false,
    expectOk: true,
    expectState: "admitted",
    laneRefusal: false,
  },
  {
    name: "admitted over bound",
    laneMarker: marker("admitted"),
    lines: 50,
    clauses: false,
    expectOk: false,
    expectState: "crossed",
    laneRefusal: true,
  },
  {
    name: "admitted over bound, acceptance with clauses",
    laneMarker: marker("admitted"),
    lines: 50,
    clauses: true,
    expectOk: false,
    expectState: "crossed",
    laneRefusal: true,
  },
  {
    name: "crossed",
    laneMarker: marker("crossed", { crossedReason: "bound crossed" }),
    lines: 3,
    clauses: false,
    expectOk: false,
    expectState: "crossed",
    laneRefusal: true,
  },
  {
    name: "crossed, acceptance with clauses",
    laneMarker: marker("crossed", { crossedReason: "bound crossed" }),
    lines: 3,
    clauses: true,
    expectOk: false,
    expectState: "crossed",
    laneRefusal: true,
  },
  {
    name: "escalated without full shape",
    laneMarker: marker("escalated"),
    lines: 3,
    clauses: false,
    expectOk: false,
    expectState: "escalated",
    laneRefusal: true,
  },
  {
    name: "escalated without full shape, acceptance with clauses",
    laneMarker: marker("escalated"),
    lines: 3,
    clauses: true,
    expectOk: false,
    expectState: "escalated",
    laneRefusal: true,
  },
  {
    name: "no-marker command-only",
    laneMarker: null,
    lines: 3,
    clauses: false,
    expectOk: false,
    expectState: null,
    laneRefusal: false,
  },
];

/** Write one fixture repo with the row's brief in `start`/; return the brief path. */
function writeFixture(row: Row, start: Start): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "activate-lane-parity-"));
  roots.push(root);
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: { title: "P", status: "running", policy: { deliveryBranch: "master", wipCap: 20 } },
    }),
    "utf8",
  );
  const acceptance: Record<string, unknown> = {
    commands: [{ command: "npx vitest run packages/core/src/x.test.ts" }],
    none_stated: false,
    source_rung: "stated",
  };
  if (row.clauses) {
    acceptance.clauses = [
      { id: 1, text: "test: returns the corrected value", artifact_path: null, ambiguous: false },
    ];
  }
  const metadata: Record<string, unknown> = { swarm: { file_scope: ["packages/core/src/x.ts"] } };
  if (row.laneMarker !== null) metadata[MARKER_KEY] = row.laneMarker;
  const path = join(root, "xbrief", start, NAME);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "fix x",
          status: start === "pending" ? "pending" : "running",
          items: [],
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/6264",
              type: "x-xbrief/github-issue",
            },
          ],
          acceptance,
          metadata,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, path };
}

interface Outcome {
  readonly exitCode: 0 | 1;
  readonly message: string;
  /** Folder that holds the brief after the run. */
  readonly folder: Start;
  /** Lane marker on disk after the run (state plus any crossing reason). */
  readonly laneMarker: Record<string, unknown> | null;
  /** The brief on disk with the lane marker removed. */
  readonly briefWithoutMarker: string;
}

function readOutcome(root: string, exitCode: 0 | 1, message: string): Outcome {
  const folder: Start = existsSync(join(root, "xbrief", "active", NAME)) ? "active" : "pending";
  const data = JSON.parse(readFileSync(join(root, "xbrief", folder, NAME), "utf8")) as {
    plan: { metadata: Record<string, unknown> };
  };
  const laneMarker = (data.plan.metadata[MARKER_KEY] as Record<string, unknown>) ?? null;
  delete data.plan.metadata[MARKER_KEY];
  return { exitCode, message, folder, laneMarker, briefWithoutMarker: JSON.stringify(data) };
}

function run(verb: Verb, row: Row, start: Start): { outcome: Outcome; before: string } {
  const { root, path } = writeFixture(row, start);
  const before = readOutcome(root, 0, "").briefWithoutMarker;
  const smallChangeLane = laneOverrides(root, row.lines);
  if (verb === "scope:activate") {
    const result = runTransition("activate", path, NOW, { smallChangeLane });
    return { outcome: readOutcome(root, result.ok ? 0 : 1, result.message), before };
  }
  const result = activate(path, { now: NOW, smallChangeLane });
  return { outcome: readOutcome(root, result.exitCode, result.message), before };
}

describe("scope:activate and xbrief:activate lane parity matrix (#6264)", () => {
  for (const row of ROWS) {
    for (const start of ["pending", "active"] as const) {
      it(`${row.name}, from ${start}/: same exit code and lane-state write`, () => {
        const scope = run("scope:activate", row, start);
        const xbrief = run("xbrief:activate", row, start);

        // Parity: same exit code, same lane-state write, same resulting folder.
        expect(xbrief.outcome.exitCode, xbrief.outcome.message).toBe(scope.outcome.exitCode);
        expect(xbrief.outcome.laneMarker).toEqual(scope.outcome.laneMarker);
        expect(xbrief.outcome.folder).toBe(scope.outcome.folder);

        // The row's expected verdict.
        expect(scope.outcome.exitCode, scope.outcome.message).toBe(row.expectOk ? 0 : 1);
        expect(scope.outcome.laneMarker?.state ?? null).toBe(row.expectState);
        expect(scope.outcome.folder).toBe(row.expectOk ? "active" : start);

        for (const [verb, { outcome, before }] of [
          ["scope:activate", scope],
          ["xbrief:activate", xbrief],
        ] as const) {
          if (row.expectOk) {
            expect(outcome.message).not.toContain("Refusing active ingress");
            continue;
          }
          // A refusal writes nothing before the move except the lane crossing record.
          expect(outcome.briefWithoutMarker, verb).toBe(before);
          if (row.laneRefusal) {
            expect(outcome.message).toContain(`${verb} refused (#6204)`);
          } else {
            expect(outcome.message).toContain("#4768");
          }
        }
      });
    }
  }

  it("both verbs call the one shared lane + ingress helper", () => {
    const spy = vi.spyOn(laneIngressGate, "evaluateLaneIngressGate");
    const row = ROWS[0] as Row;
    for (const start of ["pending", "active"] as const) {
      run("scope:activate", row, start);
      run("xbrief:activate", row, start);
    }
    expect(spy.mock.calls.map(([, options]) => options.gate)).toEqual([
      "scope:activate",
      "xbrief:activate",
      "scope:activate",
      "xbrief:activate",
    ]);
    for (const [, result] of spy.mock.results.map((r, i) => [i, r.value] as const)) {
      const verdict = result as laneIngressGate.LaneIngressGateResult;
      expect(verdict.lane.verdict?.kind).toBe("admitted");
      expect(verdict.laneAdmitsThin).toBe(true);
    }
  });
});
