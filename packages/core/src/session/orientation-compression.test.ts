import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../doctor/types.js";
import {
  DEPOSIT_SHA_MATCH_NOOP,
  doctorStateFromOrientationRecord,
  ENV_SESSION_COMPACT,
  ENV_SESSION_VERBOSE,
  formatOrientationCompactLines,
  ORIENTATION_LATER_STATUS,
  type OrientationSectionResult,
  resolveSessionCompact,
  resolveSessionVerbose,
  runCacheFreshOrientationSection,
  runDoctorOrientationSection,
  runOrientationCompression,
} from "./orientation-compression.js";
import {
  type OrientationState,
  type OrientationSurfaceRecord,
  readOrientationState,
  writeOrientationState,
} from "./orientation-state.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orient-3286-"));
  temps.push(root);
  return root;
}

function section(
  name: OrientationSectionResult["name"],
  status: OrientationSectionResult["status"],
  overrides: Partial<OrientationSectionResult> = {},
): OrientationSectionResult {
  return {
    name,
    status,
    ok: status === "ok" || status === "sha_match" || status === "degraded" || status === "skipped",
    exitCode: 0,
    lines: [`[${name}] ${status}`],
    shaMatch: status === "sha_match",
    durationMs: 1,
    ...overrides,
  };
}

describe("orientation compression (#3286)", () => {
  it("composes doctor + preflight sections with per-section status", () => {
    const root = tempRoot();
    const bundle = runOrientationCompression({
      projectRoot: root,
      persistState: true,
      doctorSection: section("doctor", "ok", {
        lines: ["[deft doctor] status: ok"],
      }),
      toolchainPreflight: {
        status: "ok",
        ok: true,
        degraded: false,
        findings: [],
        lines: ["[deft preflight] toolchain status: ok"],
        skipGateIds: [],
      },
      agentsRefreshSection: section("agents_refresh", "sha_match", {
        lines: [`agents:refresh: ${DEPOSIT_SHA_MATCH_NOOP}`],
        shaMatch: true,
      }),
      cacheFreshSection: section("cache_fresh", "ok", {
        lines: ["✓ deft cache-fresh: bootstrap"],
      }),
      depositShaOptions: {
        inputs: {
          engineVersion: "e",
          payloadVersion: "p",
          templatesHash: "t",
        },
      },
    });

    const names = bundle.sections.map((s) => s.name);
    expect(names).toEqual(["doctor", "preflight", "agents_refresh", "cache_fresh"]);
    expect(bundle.lines.some((l) => l.includes("doctor"))).toBe(true);
    expect(bundle.lines.some((l) => l.includes("preflight") || l.includes("toolchain"))).toBe(true);
    expect(bundle.later.status).toBe(ORIENTATION_LATER_STATUS);
    expect(bundle.orientationCallCount).toBe(4);
    expect(bundle.compact).toBe(false);

    const stored = readOrientationState(root);
    expect(stored?.deposit_sha).toBe(bundle.depositSha);
    expect(stored?.agents_refresh?.ok).toBe(true);
  });

  it("agents content-current emits sha-match; cache-fresh always evaluates live", () => {
    const root = tempRoot();
    const inputs = {
      engineVersion: "1.2.3",
      payloadVersion: "1.2.3",
      templatesHash: "tmpl",
    };
    const first = runOrientationCompression({
      projectRoot: root,
      persistState: true,
      doctorSection: section("doctor", "ok"),
      toolchainPreflight: {
        status: "ok",
        ok: true,
        degraded: false,
        findings: [],
        lines: ["[deft preflight] toolchain status: ok"],
        skipGateIds: [],
      },
      agentsRefreshSection: section("agents_refresh", "sha_match", {
        lines: [`agents:refresh: ${DEPOSIT_SHA_MATCH_NOOP}`],
        shaMatch: true,
      }),
      cacheFreshSection: section("cache_fresh", "ok", {
        lines: ["✓ cache fresh (live evaluate)"],
        shaMatch: false,
      }),
      depositShaOptions: { inputs },
    });

    // Second session: agents may still be content-current (sha-match phrasing);
    // cache-fresh always re-evaluates (no deposit-sha short-circuit).
    const second = runOrientationCompression({
      projectRoot: root,
      persistState: false,
      includeDoctor: false,
      includePreflight: false,
      depositShaOptions: { inputs },
      agentsRefreshSection: section("agents_refresh", "sha_match", {
        lines: [`agents:refresh: ${DEPOSIT_SHA_MATCH_NOOP}`],
        shaMatch: true,
      }),
      cacheFreshSection: section("cache_fresh", "ok", {
        lines: ["✓ cache fresh again (live evaluate)"],
        shaMatch: false,
      }),
    });

    const agents = second.sections.find((s) => s.name === "agents_refresh");
    const cache = second.sections.find((s) => s.name === "cache_fresh");
    expect(agents?.shaMatch).toBe(true);
    expect(agents?.lines.join("\n")).toContain(DEPOSIT_SHA_MATCH_NOOP);
    expect(cache?.shaMatch).toBe(false);
    expect(cache?.lines.join("\n")).toContain("live evaluate");
    expect(first.depositSha).toBe(second.depositSha);
  });

  it("resolves DEFT_SESSION_VERBOSE for whole-stdout ceremony dump (#4966)", () => {
    expect(resolveSessionVerbose({ verbose: true })).toBe(true);
    expect(resolveSessionVerbose({ verbose: false })).toBe(false);
    expect(resolveSessionVerbose({ env: { [ENV_SESSION_VERBOSE]: "1" } })).toBe(true);
    expect(resolveSessionVerbose({ env: { [ENV_SESSION_VERBOSE]: "0" } })).toBe(false);
    expect(resolveSessionVerbose({ verbose: false, env: { [ENV_SESSION_VERBOSE]: "1" } })).toBe(
      false,
    );
  });

  it("--compact / DEFT_SESSION_COMPACT emits terse machine format", () => {
    const sections = [
      section("doctor", "ok"),
      section("preflight", "ok"),
      section("agents_refresh", "sha_match"),
      section("cache_fresh", "sha_match"),
    ];
    const compact = formatOrientationCompactLines(sections);
    expect(compact).toEqual([
      "doctor=ok",
      "preflight=ok",
      "agents_refresh=sha_match",
      "cache_fresh=sha_match",
    ]);

    const degraded = formatOrientationCompactLines([
      section("preflight", "degraded", {
        lines: [
          "[deft orientation] preflight: degraded",
          "[deft preflight] task: MISSING — cause: not on PATH; remedy: install go-task",
          "[deft preflight] node: ok",
        ],
      }),
      section("cache_fresh", "dirty", {
        lines: ["❌ deft cache-fresh: cache is 32.2h old (max-age=24h); oldest x."],
      }),
    ]);
    expect(degraded).toEqual([
      "preflight=degraded",
      "[deft preflight] task: MISSING — cause: not on PATH; remedy: install go-task",
      "cache_fresh=dirty",
      "❌ deft cache-fresh: cache is 32.2h old (max-age=24h); oldest x.",
    ]);

    expect(resolveSessionCompact({ compact: true })).toBe(true);
    expect(resolveSessionCompact({ compact: false })).toBe(false);
    expect(resolveSessionCompact({ env: { [ENV_SESSION_COMPACT]: "1" } })).toBe(true);
    expect(resolveSessionCompact({ env: { [ENV_SESSION_COMPACT]: "0" } })).toBe(false);

    const root = tempRoot();
    const bundle = runOrientationCompression({
      projectRoot: root,
      compact: true,
      persistState: false,
      doctorSection: section("doctor", "ok"),
      toolchainPreflight: {
        status: "ok",
        ok: true,
        degraded: false,
        findings: [],
        lines: ["verbose preflight line should not appear in compact"],
        skipGateIds: [],
      },
      agentsRefreshSection: section("agents_refresh", "sha_match"),
      cacheFreshSection: section("cache_fresh", "ok"),
      depositShaOptions: {
        inputs: { engineVersion: "e", payloadVersion: "p", templatesHash: "t" },
      },
    });
    expect(bundle.compact).toBe(true);
    expect(bundle.lines.every((l) => l.includes("="))).toBe(true);
    expect(bundle.lines.join("\n")).not.toContain("verbose preflight");
  });

  it("invalidates sha fast-path when a deposit input changes", () => {
    const root = tempRoot();
    writeOrientationState(root, {
      schema_version: 1,
      deposit_sha: "aaaaaaaaaaaa",
      updated_at: "2026-08-11T00:00:00Z",
      agents_refresh: {
        ok: true,
        ts: "2026-08-11T00:00:00Z",
        exit_code: 0,
      },
      cache_fresh: {
        ok: true,
        ts: "2026-08-11T00:00:00Z",
        exit_code: 0,
      },
    });

    const bundle = runOrientationCompression({
      projectRoot: root,
      persistState: false,
      includeDoctor: false,
      includePreflight: false,
      depositShaOptions: {
        inputs: {
          engineVersion: "changed",
          payloadVersion: "p",
          templatesHash: "t",
        },
      },
      // Inject non-match results that real runners would produce when sha differs
      agentsRefreshSection: section("agents_refresh", "ok", {
        lines: ["[deft agents:refresh] updated (state=stale)"],
        shaMatch: false,
      }),
      cacheFreshSection: section("cache_fresh", "ok", {
        lines: ["✓ full evaluate"],
        shaMatch: false,
      }),
    });
    expect(bundle.depositSha).not.toBe("aaaaaaaaaaaa");
    expect(bundle.sections.every((s) => s.shaMatch === false)).toBe(true);
  });

  it("reports named actionable cause (not error) when a consumer deposit has no cache (#3335)", () => {
    const root = tempRoot();
    const section = runCacheFreshOrientationSection(root, { depositSha: "deadbeef" });
    expect(section.name).toBe("cache_fresh");
    expect(section.status).toBe("dirty");
    expect(section.status).not.toBe("error");
    expect(section.ok).toBe(false);
    expect(section.lines.join("\n")).toMatch(/triage cache not populated|triage:bootstrap/i);
    expect(section.lines.join("\n")).not.toMatch(/status: "error"/);
  });
});

// Session start keeps the doctor time window in its own record (#6617).
// Doctor itself writes nothing (AC12.1); a skipped section must not extend
// the window, and a new timestamp is stamped only when doctor really ran.

const PASS_LINK: CheckResult = { name: "foreign-runtime-link", status: "pass", detail: "ok" };

function priorWith(doctor: OrientationSurfaceRecord): OrientationState {
  return { schema_version: 1, deposit_sha: "abc", updated_at: doctor.ts, doctor };
}

const CLEAN_AT_NOON: OrientationSurfaceRecord = {
  ok: true,
  ts: "2026-01-01T12:00:00Z",
  exit_code: 0,
  message: "[deft doctor] status: ok",
  error_count: 0,
  finding_count: 0,
};

const FAILING_AT_NOON: OrientationSurfaceRecord = {
  ok: false,
  ts: "2026-01-01T12:00:00Z",
  exit_code: 1,
  message: "[deft doctor] status: dirty (exit 1)",
  error_count: 2,
  finding_count: 3,
};

function hoursAfterNoon(hours: number): Date {
  return new Date(Date.parse("2026-01-01T12:00:00Z") + hours * 3_600_000);
}

function writePrior(root: string, state: OrientationState): string {
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(join(root, ".deft", "orientation-state.json"), JSON.stringify(state), "utf8");
  return root;
}

describe("session-start doctor window (#6617)", () => {
  it("skips doctor inside the 24 h clean window", () => {
    let ran = false;
    const section = runDoctorOrientationSection(tempRoot(), {
      now: hoursAfterNoon(23),
      prior: priorWith(CLEAN_AT_NOON),
      seams: { checkRuntimeLinkOwner: () => PASS_LINK },
      doctorRunner: () => {
        ran = true;
        return 0;
      },
    });
    expect(ran).toBe(false);
    expect(section.detail?.throttle_skipped).toBe(true);
    expect(section.ok).toBe(true);
  });

  it("runs doctor once the clean window has passed", () => {
    let ran = false;
    const section = runDoctorOrientationSection(tempRoot(), {
      now: hoursAfterNoon(25),
      prior: priorWith(CLEAN_AT_NOON),
      seams: { checkRuntimeLinkOwner: () => PASS_LINK },
      doctorRunner: () => {
        ran = true;
        return 0;
      },
    });
    expect(ran).toBe(true);
    expect(section.detail?.throttle_skipped).toBe(false);
  });

  it("uses the 4 h window after a failing run and reports it dirty", () => {
    const root = tempRoot();
    const inside = runDoctorOrientationSection(root, {
      now: hoursAfterNoon(3),
      prior: priorWith(FAILING_AT_NOON),
      seams: { checkRuntimeLinkOwner: () => PASS_LINK },
      doctorRunner: () => {
        throw new Error("must stay skipped");
      },
    });
    expect(inside.detail?.throttle_skipped).toBe(true);
    expect(inside.status).toBe("dirty");
    expect(inside.lines[0]).toContain("2 errors");
    let ran = false;
    runDoctorOrientationSection(root, {
      now: hoursAfterNoon(5),
      prior: priorWith(FAILING_AT_NOON),
      seams: { checkRuntimeLinkOwner: () => PASS_LINK },
      doctorRunner: () => {
        ran = true;
        return 1;
      },
    });
    expect(ran).toBe(true);
  });

  it("never skips on a record of an errored run (exit 2)", () => {
    expect(doctorStateFromOrientationRecord({ ...CLEAN_AT_NOON, ok: false, exit_code: 2 })).toBe(
      null,
    );
  });

  it("a skipped section keeps the previous doctor record, so the window does not move", () => {
    const bundle = runOrientationCompression({
      projectRoot: writePrior(tempRoot(), priorWith(CLEAN_AT_NOON)),
      now: hoursAfterNoon(10),
      persistState: false,
      includePreflight: false,
      includeAgentsRefresh: false,
      includeCacheFresh: false,
      doctorSeams: { checkRuntimeLinkOwner: () => PASS_LINK },
    });
    expect(bundle.sections[0]?.detail?.throttle_skipped).toBe(true);
    expect(bundle.state.doctor).toEqual(CLEAN_AT_NOON);
  });

  it("a real run stamps a new record with its counts", () => {
    const root = writePrior(tempRoot(), priorWith(CLEAN_AT_NOON));
    const now = hoursAfterNoon(30);
    const bundle = runOrientationCompression({
      projectRoot: root,
      now,
      persistState: false,
      includePreflight: false,
      includeAgentsRefresh: false,
      includeCacheFresh: false,
      doctorSection: runDoctorOrientationSection(root, {
        now,
        seams: { checkRuntimeLinkOwner: () => PASS_LINK },
        doctorRunner: () => {
          process.stdout.write(
            `${JSON.stringify({ status: "completed", summary: { errors: 1, warnings: 2 } })}\n`,
          );
          return 1;
        },
      }),
    });
    expect(bundle.state.doctor?.ts).toBe("2026-01-02T18:00:00Z");
    expect(bundle.state.doctor?.exit_code).toBe(1);
    expect(bundle.state.doctor?.error_count).toBe(1);
    expect(bundle.state.doctor?.finding_count).toBe(3);
  });

  it("reads the legacy doctor-state.json once when there is no session record", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", ".triage-cache", "doctor-state.json"),
      JSON.stringify({
        last_run_at: "2026-01-01T12:00:00Z",
        last_exit_code: 0,
        last_finding_count: 0,
        last_error_count: 0,
      }),
      "utf8",
    );
    const section = runDoctorOrientationSection(root, {
      now: hoursAfterNoon(1),
      prior: null,
      seams: { checkRuntimeLinkOwner: () => PASS_LINK },
      doctorRunner: () => {
        throw new Error("legacy record inside the window must skip");
      },
    });
    expect(section.detail?.throttle_skipped).toBe(true);
  });
});
