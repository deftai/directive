import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AssertLog,
  copyFixtureToTmp,
  parseSmoketestArgs,
  runSmoketest,
  STAGE_LABELS,
  TOTAL_STAGES,
} from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("AssertLog", () => {
  it("records pass and skip statuses", () => {
    const log = new AssertLog({ verbose: false });
    log.passed(1, "bootstrap", "ok");
    log.skipped(6, "scope promote", "cache-only");
    expect(log.records).toHaveLength(2);
    expect(log.records[0]?.status).toBe("PASS");
    expect(log.records[1]?.status).toBe("SKIP");
  });

  it("writes JSON assert log", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-smoke-log-"));
    temps.push(root);
    const path = join(root, "last_run.json");
    const log = new AssertLog({ verbose: false });
    log.passed(9, "summary", "chars=42");
    log.writeJson(path, { exitCode: 0, fixtureRepo: "deftai/smoketest" });
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      exit_code: number;
      stage_count: number;
    };
    expect(payload.exit_code).toBe(0);
    expect(payload.stage_count).toBe(TOTAL_STAGES);
  });
});

describe("copyFixtureToTmp", () => {
  it("copies project definition and vbrief folders", () => {
    const fixture = mkdtempSync(join(tmpdir(), "deft-smoke-fix-"));
    const tmp = mkdtempSync(join(tmpdir(), "deft-smoke-tmp-"));
    temps.push(fixture, tmp);
    mkdirSync(join(fixture, "vbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(fixture, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: {} }),
      "utf8",
    );
    writeFileSync(
      join(fixture, "vbrief", "proposed", "test-1.vbrief.json"),
      JSON.stringify({ plan: { status: "proposed" } }),
      "utf8",
    );
    const project = copyFixtureToTmp(fixture, join(tmp, "project"));
    expect(project).toContain("project");
  });
});

describe("parseSmoketestArgs", () => {
  it("parses cache-only and verbose flags", () => {
    const args = parseSmoketestArgs(["--cache-only", "--verbose"]);
    expect(args.cacheOnly).toBe(true);
    expect(args.verbose).toBe(true);
  });

  it("returns error for unknown flag", () => {
    const args = parseSmoketestArgs(["--nope"]);
    expect(args.error).toContain("unrecognized");
  });
});

describe("constants", () => {
  it("defines nine stage labels", () => {
    expect(STAGE_LABELS.length).toBe(10);
    expect(STAGE_LABELS[1]).toContain("bootstrap");
  });
});

describe("runSmoketest", () => {
  it("returns 1 when issues.json is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-smoketest-missing-"));
    temps.push(root);
    const stderr: string[] = [];
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      stderr.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(runSmoketest(root)).toBe(1);
      expect(stderr.join("")).toContain("issues.json not found");
    } finally {
      process.stderr.write = err;
    }
  });
});
