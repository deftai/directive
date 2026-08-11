import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEPOSIT_SHA_MATCH_NOOP,
  ENV_SESSION_COMPACT,
  formatOrientationCompactLines,
  ORIENTATION_LATER_STATUS,
  resolveSessionCompact,
  runOrientationCompression,
  type OrientationSectionResult,
} from "./orientation-compression.js";
import { readOrientationState, writeOrientationState } from "./orientation-state.js";

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
    expect(bundle.lines.some((l) => l.includes("preflight") || l.includes("toolchain"))).toBe(
      true,
    );
    expect(bundle.later.status).toBe(ORIENTATION_LATER_STATUS);
    expect(bundle.orientationCallCount).toBe(4);
    expect(bundle.compact).toBe(false);

    const stored = readOrientationState(root);
    expect(stored?.deposit_sha).toBe(bundle.depositSha);
    expect(stored?.agents_refresh?.ok).toBe(true);
  });

  it("second session prints deposit-sha no-ops for agents:refresh and cache-fresh", () => {
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
      agentsRefreshSection: section("agents_refresh", "ok", {
        lines: ["[deft agents:refresh] updated"],
      }),
      cacheFreshSection: section("cache_fresh", "ok", {
        lines: ["✓ cache fresh"],
      }),
      depositShaOptions: { inputs },
    });

    // Re-run with only refresh surfaces so prior state triggers sha_match.
    const second = runOrientationCompression({
      projectRoot: root,
      persistState: false,
      includeDoctor: false,
      includePreflight: false,
      depositShaOptions: { inputs },
    });

    const agents = second.sections.find((s) => s.name === "agents_refresh");
    const cache = second.sections.find((s) => s.name === "cache_fresh");
    expect(agents?.shaMatch).toBe(true);
    expect(agents?.lines.join("\n")).toContain(DEPOSIT_SHA_MATCH_NOOP);
    expect(cache?.shaMatch).toBe(true);
    expect(cache?.lines.join("\n")).toContain(DEPOSIT_SHA_MATCH_NOOP);
    expect(first.depositSha).toBe(second.depositSha);
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
});
