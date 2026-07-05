import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { evaluate as evaluateBranch } from "../branch/evaluate.js";
import { clearRegistryCache, DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import { evaluate as evaluateWipCap } from "../wip-cap/evaluate.js";
import { ALL_ATTRIBUTION_EVENT_NAMES, ATTRIBUTION_EVENT_NAMES } from "./attribution-constants.js";
import {
  emitAttributionSignal,
  recordAdoptionSignal,
  recordBypassSignal,
  recordFrictionSignal,
  recordGateCatch,
  recordWipCapProtect,
} from "./attribution-ledger.js";

const ATTRIBUTION_NAME_SET = new Set<string>(ALL_ATTRIBUTION_EVENT_NAMES);

function readAttributionInTest(root: string, log?: string) {
  const path = log ?? join(root, DEFAULT_EVENT_LOG);
  return readEvents(path).filter((record) => ATTRIBUTION_NAME_SET.has(record.event));
}

const temps: string[] = [];

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
  policy?: Record<string, unknown>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-attrib-ledger-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  const policy = {
    ...(options.policy ?? {}),
    ...(options.valueFeedback !== undefined ? { valueFeedback: options.valueFeedback } : {}),
  };
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        ...(Object.keys(policy).length > 0 ? { policy } : {}),
      },
    }),
    "utf8",
  );
  return root;
}

function logPath(root: string): string {
  return join(root, ".deft-cache", "events.jsonl");
}

describe("attribution ledger policy gate", () => {
  it("does not emit when valueFeedback is disabled", () => {
    const root = makeRepo({});
    const record = recordGateCatch(root, "verify:branch", "test", { logPath: logPath(root) });
    expect(record).toBeNull();
    expect(existsSync(logPath(root))).toBe(false);
  });

  it("does not emit when enabled but emitEvents sub-flag is false", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, emitEvents: false, sessionLine: true },
    });
    const record = recordGateCatch(root, "verify:branch", "test", { logPath: logPath(root) });
    expect(record).toBeNull();
    expect(existsSync(logPath(root))).toBe(false);
  });

  it("emits when enabled with emitEvents allowed", () => {
    const root = makeRepo({ valueFeedback: { enabled: true, emitEvents: true } });
    const record = recordGateCatch(root, "verify:branch", "blocked", {
      logPath: logPath(root),
    });
    expect(record).not.toBeNull();
    expect(record?.event).toBe(ATTRIBUTION_EVENT_NAMES.valueGateCatch);
    expect(record?.payload.signal_class).toBe("value");
    expect(record?.payload.source).toBe("verify:branch");
  });

  it("returns null without throwing when the default log path is not writable", () => {
    const root = makeRepo({ valueFeedback: { enabled: true, emitEvents: true } });
    writeFileSync(join(root, ".deft-cache"), "not-a-directory", "utf8");
    expect(() => recordGateCatch(root, "verify:branch", "blocked")).not.toThrow();
    expect(readAttributionInTest(root)).toHaveLength(0);
  });
});

describe("four signal classes", () => {
  const enabled = { valueFeedback: { enabled: true, emitEvents: true } };

  it("records value, bypass, adoption, and friction with signal_class tags", () => {
    const root = makeRepo(enabled);
    const log = logPath(root);

    recordGateCatch(root, "verify:branch", "gate", { logPath: log });
    recordBypassSignal(root, "commit-hook", "skipped check", { logPath: log });
    recordAdoptionSignal(root, "decompose", "large diff unused", { logPath: log });
    recordFrictionSignal(root, "skill-router", "no skill matched", { logPath: log });

    const entries = readAttributionInTest(root, log);
    expect(entries).toHaveLength(4);
    const classes = entries.map((e) => e.payload.signal_class).sort();
    expect(classes).toEqual(["adoption", "bypass", "friction", "value"]);
    for (const entry of entries) {
      expect(ATTRIBUTION_NAME_SET.has(entry.event)).toBe(true);
    }
  });

  it("emitAttributionSignal rejects unknown names at compile time only", () => {
    const root = makeRepo(enabled);
    const record = emitAttributionSignal(
      ATTRIBUTION_EVENT_NAMES.frictionDirectiveGap,
      { source: "test", detail: "gap" },
      { projectRoot: root, logPath: logPath(root) },
    );
    expect(record?.payload.signal_class).toBe("friction");
  });
});

describe("wired gate sources", () => {
  it("branch gate records value:gate-catch on default-branch block", () => {
    const root = makeRepo({ valueFeedback: { enabled: true, emitEvents: true } });
    const log = logPath(root);
    const result = evaluateBranch(root, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(1);
    const entries = readAttributionInTest(root, log);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe("value:gate-catch");
    expect(entries[0]?.payload.source).toBe("verify:branch");
  });

  it("branch gate still blocks when telemetry write fails", () => {
    const root = makeRepo({ valueFeedback: { enabled: true, emitEvents: true } });
    writeFileSync(join(root, ".deft-cache"), "not-a-directory", "utf8");
    const result = evaluateBranch(root, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(1);
    expect(readAttributionInTest(root)).toHaveLength(0);
  });

  it("wip-cap gate records value:wip-cap-protect when over cap", () => {
    const root = makeRepo({
      valueFeedback: { enabled: true, emitEvents: true },
      policy: { wipCap: 1 },
    });
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "pending", "a.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { status: "approved", title: "A", items: [] },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "vbrief", "pending", "b.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { status: "approved", title: "B", items: [] },
      }),
      "utf8",
    );
    const log = logPath(root);
    const result = evaluateWipCap(root);
    expect(result.code).toBe(1);
    const entries = readAttributionInTest(root, log);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe("value:wip-cap-protect");
    expect(entries[0]?.payload.count).toBe(2);
    expect(entries[0]?.payload.cap).toBe(1);
  });

  it("wired sources stay silent when policy is off", () => {
    const root = makeRepo({ policy: { wipCap: 1 } });
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    for (const name of ["a.vbrief.json", "b.vbrief.json"]) {
      writeFileSync(
        join(root, "vbrief", "pending", name),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: { status: "approved", title: name, items: [] },
        }),
        "utf8",
      );
    }
    const log = logPath(root);
    evaluateBranch(root, { branchOverride: { branch: "master", detached: false } });
    evaluateWipCap(root);
    expect(readAttributionInTest(root, log)).toHaveLength(0);
  });
});

describe("ledger persistence", () => {
  it("appends entries that survive reads across calls", () => {
    const root = makeRepo({ valueFeedback: { enabled: true, emitEvents: true } });
    const log = logPath(root);
    recordWipCapProtect(root, 3, 2, { logPath: log });
    recordGateCatch(root, "verify:branch", "second", { logPath: log });

    const firstRead = readAttributionInTest(root, log);
    expect(firstRead).toHaveLength(2);

    const raw = readFileSync(log, "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
    expect(readAttributionInTest(root, log)).toEqual(firstRead);
  });
});
