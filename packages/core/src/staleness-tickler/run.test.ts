import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "../policy/index.js";
import { FIELD_STALENESS_TICKLER_CLI_ALIAS } from "../policy/staleness-tickler.js";
import { maybeRunStalenessTickler } from "./run.js";
import { STATE_RELATIVE_PATH } from "./state.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(options?: {
  schemaVersion?: string;
  policy?: Record<string, unknown>;
  manifestTag?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-staleness-tickler-"));
  temps.push(root);
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "core", "VERSION"),
    `sha: ${"a".repeat(40)}\nref: v${options?.manifestTag ?? "1.0.0"}\ntag: v${options?.manifestTag ?? "1.0.0"}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: options?.schemaVersion ?? "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: options?.policy,
      },
    }),
    "utf8",
  );
  return root;
}

const testEnv: NodeJS.ProcessEnv = { ...process.env, DEFT_SESSION_RITUAL_SKIP: "" };

const idleSeams = {
  idle: {
    readPorcelain: () => "",
    countInFlight: () => 0,
    insideDeftRepo: () => false,
  },
};

describe("maybeRunStalenessTickler (#2488/#2489)", () => {
  it("prompts for stale-directive-only", () => {
    const root = makeRepo();
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      probeDirective: {
        isFile: (path) => path.endsWith("VERSION"),
        readText: (path) =>
          path.endsWith("VERSION") ? `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n` : null,
        runNpmView: () => ({ ok: true, version: "1.1.0" }),
      },
      ...idleSeams,
    });
    expect(result.prompted).toBe(true);
    expect(result.lines.join("\n")).toContain("Directive payload behind");
    expect(result.lines.join("\n")).toContain("npm i -g @deftai/directive@latest");
  });

  it("prompts for stale-xbrief-only", () => {
    const root = makeRepo({ schemaVersion: "0.6" });
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      probeDirective: {
        isFile: (path) => path.endsWith("VERSION"),
        readText: (path) =>
          path.endsWith("VERSION") ? `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n` : null,
        runNpmView: () => ({ ok: true, version: "1.0.0" }),
      },
      ...idleSeams,
    });
    expect(result.prompted).toBe(true);
    expect(result.lines.join("\n")).toContain("xBRIEF schema behind-major");
    expect(result.lines.join("\n")).toContain("deft migrate:xbrief");
  });

  it("prompts when both dimensions are stale", () => {
    const root = makeRepo({ schemaVersion: "0.6" });
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      probeDirective: {
        isFile: (path) => path.endsWith("VERSION"),
        readText: (path) =>
          path.endsWith("VERSION") ? `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n` : null,
        runNpmView: () => ({ ok: true, version: "2.0.0" }),
      },
      ...idleSeams,
    });
    expect(result.lines.join("\n")).toContain("Directive payload behind");
    expect(result.lines.join("\n")).toContain("xBRIEF schema behind-major");
  });

  it("does not prompt when already current", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, STATE_RELATIVE_PATH),
      JSON.stringify({ firstDetectedAt: "2026-01-01T00:00:00Z", deferralCount: 3 }),
      "utf8",
    );
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      probeDirective: {
        isFile: (path) => path.endsWith("VERSION"),
        readText: (path) =>
          path.endsWith("VERSION") ? `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n` : null,
        runNpmView: () => ({ ok: true, version: "1.0.0" }),
      },
      ...idleSeams,
    });
    expect(result.prompted).toBe(false);
    expect(result.skippedReason).toBe("current");
    expect(readFileSync(join(root, STATE_RELATIVE_PATH), "utf8").trim()).toBe("{}");
  });

  it("suppresses on dirty tree", () => {
    const root = makeRepo({ schemaVersion: "0.6" });
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      idle: {
        readPorcelain: () => " M dirty\n",
        countInFlight: () => 0,
        insideDeftRepo: () => false,
      },
    });
    expect(result.prompted).toBe(false);
    expect(result.skippedReason).toBe("dirty-tree");
  });

  it("suppresses mid-story", () => {
    const root = makeRepo({ schemaVersion: "0.6" });
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      idle: { readPorcelain: () => "", countInFlight: () => 1, insideDeftRepo: () => false },
    });
    expect(result.skippedReason).toBe("story-in-flight");
  });

  it("honors snooze window", () => {
    const root = makeRepo({ schemaVersion: "0.6" });
    const now = new Date("2026-07-20T12:00:00Z");
    writeFileSync(
      join(root, STATE_RELATIVE_PATH),
      JSON.stringify({
        snoozedUntil: "2026-07-21T12:00:00Z",
        deferralCount: 1,
        lastTier: "notice",
      }),
      "utf8",
    );
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      now,
      isInteractive: false,
      probeDirective: {
        isFile: (path) => path.endsWith("VERSION"),
        readText: (path) =>
          path.endsWith("VERSION") ? `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n` : null,
        runNpmView: () => ({ ok: true, version: "1.0.0" }),
      },
      ...idleSeams,
    });
    expect(result.skippedReason).toBe("snoozed");
  });

  it("skips offline directive probe without blocking xbrief-only when current", () => {
    const root = makeRepo();
    const result = maybeRunStalenessTickler(root, {
      env: { ...testEnv, DEFT_NO_NETWORK: "1" },
      isInteractive: false,
      ...idleSeams,
    });
    expect(result.skippedReason).toBe("current");
  });

  it("honors opt-out policy", () => {
    const root = makeRepo({
      schemaVersion: "0.6",
      policy: { stalenessTickler: { optOut: true } },
    });
    const result = maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      ...idleSeams,
    });
    expect(result.skippedReason).toBe("policy-disabled");
  });

  it("records state after headless advisory", () => {
    const root = makeRepo({ schemaVersion: "0.6" });
    maybeRunStalenessTickler(root, {
      env: testEnv,
      isInteractive: false,
      now: new Date("2026-07-20T12:00:00Z"),
      probeDirective: {
        isFile: (path) => path.endsWith("VERSION"),
        readText: (path) =>
          path.endsWith("VERSION") ? `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n` : null,
        runNpmView: () => ({ ok: true, version: "1.0.0" }),
      },
      ...idleSeams,
    });
    const state = JSON.parse(readFileSync(join(root, STATE_RELATIVE_PATH), "utf8")) as {
      deferralCount?: number;
      snoozedUntil?: string;
    };
    expect(state.deferralCount).toBe(1);
    expect(state.snoozedUntil).toBeTruthy();
  });

  it("registers policy:show field", () => {
    const root = makeRepo({
      policy: { stalenessTickler: { enabled: false } },
    });
    const field = inspectOnePolicy(FIELD_STALENESS_TICKLER_CLI_ALIAS, root);
    expect(field?.current).toMatchObject({ enabled: false });
  });
});
