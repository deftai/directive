import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegistryCache,
  DEFAULT_EVENT_LOG,
  emit,
  KNOWN_EVENTS,
  main,
  REQUIRED_PAYLOAD,
  readEvents,
  validatePairing,
} from "./events.js";

const EXPECTED_BEHAVIORAL_NAMES = new Set([
  "session:interrupted",
  "session:resumed",
  "plan:approved",
  "legacy:detected",
]);

afterEach(() => {
  clearRegistryCache();
  delete process.env.DEFT_EVENT_LOG;
});

describe("behavioral events registry", () => {
  it("known events match expected set", () => {
    expect(new Set(KNOWN_EVENTS)).toEqual(EXPECTED_BEHAVIORAL_NAMES);
  });

  it("required payload keys present for every event", () => {
    for (const name of EXPECTED_BEHAVIORAL_NAMES) {
      expect(REQUIRED_PAYLOAD.has(name)).toBe(true);
      expect(REQUIRED_PAYLOAD.get(name).length).toBeGreaterThan(0);
    }
  });

  it("required payload keys match known events exactly", () => {
    expect(new Set(REQUIRED_PAYLOAD.keys())).toEqual(EXPECTED_BEHAVIORAL_NAMES);
  });

  it("session pair required payloads", () => {
    expect(REQUIRED_PAYLOAD.get("session:interrupted")).toContain("session_id");
    expect(REQUIRED_PAYLOAD.get("session:interrupted")).toContain("reason");
    expect(REQUIRED_PAYLOAD.get("session:resumed")).toContain("interrupted_id");
  });

  it("default event log is under deft-cache", () => {
    expect(DEFAULT_EVENT_LOG).toBe(".deft-cache/events.jsonl");
  });

  it("lazy proxies expose registry helpers", () => {
    expect(KNOWN_EVENTS.has("session:interrupted")).toBe(true);
    expect(KNOWN_EVENTS.has("not-real")).toBe(false);
    expect(KNOWN_EVENTS.size).toBe(4);
    expect(KNOWN_EVENTS.equals(EXPECTED_BEHAVIORAL_NAMES)).toBe(true);
    expect(KNOWN_EVENTS.equals(new Set(["session:interrupted"]))).toBe(false);
    expect(KNOWN_EVENTS.equals("not-a-set")).toBe(false);
    expect(KNOWN_EVENTS.equals(KNOWN_EVENTS)).toBe(true);
    expect(REQUIRED_PAYLOAD.has("plan:approved")).toBe(true);
    expect(REQUIRED_PAYLOAD.has(42)).toBe(false);
    expect(REQUIRED_PAYLOAD.get("missing-event")).toEqual([]);
    expect(REQUIRED_PAYLOAD.keys()).toContain("legacy:detected");
    expect(REQUIRED_PAYLOAD.values().length).toBe(4);
    expect(REQUIRED_PAYLOAD.entries().length).toBe(4);
    expect(REQUIRED_PAYLOAD.size).toBe(4);
    clearRegistryCache();
    expect([...KNOWN_EVENTS]).toHaveLength(4);
  });
});

describe("behavioral emit", () => {
  it("rejects unknown event", () => {
    const log = join(mkdtempSync(join(tmpdir(), "be-log-")), "events.jsonl");
    expect(() => emit("definitely:not-a-real-event", {}, { logPath: log })).toThrow(
      "unknown event",
    );
  });

  it("rejects missing required field", () => {
    const log = join(mkdtempSync(join(tmpdir(), "be-missing-")), "events.jsonl");
    expect(() => emit("session:interrupted", { session_id: "s1" }, { logPath: log })).toThrow(
      "missing required fields",
    );
  });

  it("appends jsonl record with envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "be-emit-"));
    const log = join(root, "events.jsonl");
    const record = emit(
      "session:interrupted",
      { reason: "context-window-shift", session_id: "s1" },
      { logPath: log },
    );
    expect(record.event).toBe("session:interrupted");
    expect(record.payload).toEqual({ reason: "context-window-shift", session_id: "s1" });
    expect(typeof record.id).toBe("string");
    expect(record.detected_at.endsWith("Z")).toBe(true);
    const roundtrip = readEvents(log);
    expect(roundtrip).toHaveLength(1);
    expect(roundtrip[0]?.id).toBe(record.id);
    rmSync(root, { recursive: true, force: true });
  });

  it("legacy detected payload minimum", () => {
    const root = mkdtempSync(join(tmpdir(), "be-legacy-"));
    const log = join(root, "events.jsonl");
    const record = emit(
      "legacy:detected",
      {
        flagged: true,
        inline: true,
        range: "140-170",
        sidecar: null,
        size_bytes: 300,
        source: "PRD.md",
        title: "Open Questions",
      },
      { logPath: log },
    );
    expect(record.payload.flagged).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("emit uses sort_keys ordering", () => {
    const root = mkdtempSync(join(tmpdir(), "be-sort-"));
    const log = join(root, "events.jsonl");
    emit(
      "plan:approved",
      { approver: "msadams", plan_ref: "https://example/pr/1" },
      {
        logPath: log,
      },
    );
    const line = readEvents(log)[0];
    const keys = Object.keys(line as object).sort();
    expect(keys).toEqual(["detected_at", "event", "id", "payload"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("default emit writes under deft-cache", () => {
    const root = mkdtempSync(join(tmpdir(), "be-default-"));
    const cwd = process.cwd();
    process.chdir(root);
    emit("plan:approved", { approver: "msadams", plan_ref: "https://example/pr/1" });
    expect(existsSync(join(root, ".deft-cache", "events.jsonl"))).toBe(true);
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("emit uses DEFT_EVENT_LOG when set", () => {
    const root = mkdtempSync(join(tmpdir(), "be-envlog-"));
    const log = join(root, "custom.jsonl");
    process.env.DEFT_EVENT_LOG = log;
    emit("plan:approved", { approver: "test", plan_ref: "ref" });
    expect(readEvents(log)).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("session pairing", () => {
  it("well formed pair has no orphans", () => {
    const root = mkdtempSync(join(tmpdir(), "be-pair-"));
    const log = join(root, "events.jsonl");
    const opened = emit(
      "session:interrupted",
      { reason: "context-window-shift", session_id: "s1" },
      { logPath: log },
    );
    emit("session:resumed", { interrupted_id: opened.id, session_id: "s1" }, { logPath: log });
    expect(validatePairing(undefined, { logPath: log })).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("orphan resumed is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "be-orphan-"));
    const log = join(root, "events.jsonl");
    emit("session:resumed", { interrupted_id: "no-such-id", session_id: "s1" }, { logPath: log });
    const orphans = validatePairing(undefined, { logPath: log });
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.event).toBe("session:resumed");
    rmSync(root, { recursive: true, force: true });
  });

  it("double resumed against one interrupt is orphan", () => {
    const root = mkdtempSync(join(tmpdir(), "be-double-"));
    const log = join(root, "events.jsonl");
    const opened = emit(
      "session:interrupted",
      { reason: "context-window-shift", session_id: "s1" },
      { logPath: log },
    );
    emit("session:resumed", { interrupted_id: opened.id, session_id: "s1" }, { logPath: log });
    emit("session:resumed", { interrupted_id: opened.id, session_id: "s1" }, { logPath: log });
    expect(validatePairing(undefined, { logPath: log })).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips malformed log lines", () => {
    const root = mkdtempSync(join(tmpdir(), "be-badline-"));
    const log = join(root, "events.jsonl");
    emit(
      "session:interrupted",
      { reason: "context-window-shift", session_id: "s1" },
      { logPath: log },
    );
    appendFileSync(log, "not-json\n", "utf8");
    expect(readEvents(log)).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("events cli", () => {
  it("emit via cli", () => {
    const root = mkdtempSync(join(tmpdir(), "be-cli-"));
    const log = join(root, "events.jsonl");
    const rc = main([
      "emit",
      "plan:approved",
      "--log",
      log,
      "--plan-ref",
      "https://github.com/example/repo/pull/42",
      "--approver",
      "msadams",
      "--approval-phrase",
      "yes",
      "--pr-number",
      "42",
    ]);
    expect(rc).toBe(0);
    const records = readEvents(log);
    expect(records[0]?.event).toBe("plan:approved");
    expect(records[0]?.payload.pr_number).toBe(42);
    rmSync(root, { recursive: true, force: true });
  });

  it("validate pairing cli exits nonzero on orphan", () => {
    const root = mkdtempSync(join(tmpdir(), "be-cli-bad-"));
    const log = join(root, "events.jsonl");
    emit("session:resumed", { interrupted_id: "missing", session_id: "s1" }, { logPath: log });
    expect(main(["validate-pairing", "--log", log])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("validate pairing cli exits zero on well formed pair", () => {
    const root = mkdtempSync(join(tmpdir(), "be-cli-ok-"));
    const log = join(root, "events.jsonl");
    const opened = emit(
      "session:interrupted",
      { reason: "context-window-shift", session_id: "s1" },
      { logPath: log },
    );
    emit("session:resumed", { interrupted_id: opened.id, session_id: "s1" }, { logPath: log });
    expect(main(["validate-pairing", "--log", log])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("list command prints sorted json lines", () => {
    const root = mkdtempSync(join(tmpdir(), "be-list-"));
    const log = join(root, "events.jsonl");
    emit(
      "session:interrupted",
      { reason: "alignment-probe", session_id: "s-cli" },
      { logPath: log },
    );
    const chunks: string[] = [];
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    expect(main(["list", "--log", log])).toBe(0);
    process.stdout.write = stdoutWrite;
    expect(chunks.join("")).toContain('"event"');
    rmSync(root, { recursive: true, force: true });
  });

  it("main without args prints usage", () => {
    expect(main([])).toBe(2);
  });

  it("emit without event name fails", () => {
    expect(main(["emit", "--session-id", "s1", "--reason", "x"])).toBe(2);
  });

  it("invalid payload json fails", () => {
    expect(main(["emit", "session:interrupted", "--payload", "{bad json"])).toBe(2);
  });

  it("unknown command prints usage", () => {
    expect(main(["not-a-command"])).toBe(2);
  });

  it("emit legacy detected with optional flags", () => {
    const root = mkdtempSync(join(tmpdir(), "be-legacy-"));
    const log = join(root, "events.jsonl");
    expect(
      main([
        "emit",
        "legacy:detected",
        "--log",
        log,
        "--title",
        "SPECIFICATION.md",
        "--source",
        "root",
        "--range",
        "1-100",
        "--size-bytes",
        "4096",
        "--inline",
        "true",
        "--sidecar",
        "meta/spec.md",
        "--flagged",
        "false",
      ]),
    ).toBe(0);
    const record = readEvents(log)[0];
    expect(record?.payload.inline).toBe(true);
    expect(record?.payload.flagged).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("resumed before interrupted is orphan in stream order", () => {
    const root = mkdtempSync(join(tmpdir(), "be-order-"));
    const log = join(root, "events.jsonl");
    const opened = emit(
      "session:interrupted",
      { reason: "context-window-shift", session_id: "s1" },
      { logPath: log },
    );
    const allEvents = readEvents(log);
    const manualResumed = {
      detected_at: "2026-04-27T22:25:52Z",
      event: "session:resumed",
      id: "manual-resumed",
      payload: { interrupted_id: opened.id, session_id: "s1" },
    };
    writeFileSync(
      log,
      `${JSON.stringify(manualResumed)}\n${allEvents.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
    expect(validatePairing(undefined, { logPath: log })).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("lifecycle index exports", () => {
  it("re-exports lifecycle modules", async () => {
    const index = await import("./index.js");
    expect(index.lifecycleHygiene.detectLifecycleNudges).toBeTypeOf("function");
    expect(index.eventDetect.emit).toBeTypeOf("function");
    expect(index.events.emit).toBeTypeOf("function");
  });
});
