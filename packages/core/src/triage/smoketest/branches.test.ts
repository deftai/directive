import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AssertLog,
  copyFixtureToTmp,
  parseSmoketestArgs,
  renderCache,
  runSmoketest,
  type ScriptCapture,
  SmoketestError,
} from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function seedFixture(root: string): void {
  mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
  writeFileSync(
    join(root, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: {} }),
    "utf8",
  );
  writeFileSync(
    join(root, "issues.json"),
    JSON.stringify({ repo: "deftai/smoketest", now_iso: "2026-05-01T00:00:00Z", issues: [] }),
    "utf8",
  );
}

function mockInline(successPayload?: { exit_code: number; records: unknown[]; error?: string }) {
  return (_code: string, stdin: string): ScriptCapture => {
    if (stdin.includes('"issues"') || stdin.includes("issues_spec")) {
      if (_code.includes("cache_put")) {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify(successPayload ?? { exit_code: 0, records: [] }),
        stderr: "",
      };
    }
    return { returncode: 0, stdout: "", stderr: "" };
  };
}

describe("AssertLog branches", () => {
  it("fail returns SmoketestError and records failure", () => {
    const log = new AssertLog({ verbose: false });
    const err = log.fail(2, "audit", {
      expected: 1,
      actual: 0,
      cause: "mismatch",
    });
    expect(err).toBeInstanceOf(SmoketestError);
    expect(err.message).toContain("audit");
    expect(log.records[0]?.status).toBe("FAIL");
  });

  it("verbose mode emits pass and skip lines", () => {
    const chunks: string[] = [];
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const log = new AssertLog({ verbose: true });
      log.passed(1, "bootstrap");
      log.skipped(6, "scope", "cache-only");
      log.passed(99, "unknown-stage");
      expect(chunks.join("")).toContain("PASS");
      expect(chunks.join("")).toContain("SKIP");
    } finally {
      process.stderr.write = err;
    }
  });
});

describe("renderCache", () => {
  it("throws when inline runner fails", () => {
    expect(() =>
      renderCache(
        "/tmp/project",
        { repo: "x/y", now_iso: "2026-05-01T00:00:00Z", issues: [] },
        "/scripts",
        () => ({
          returncode: 1,
          stdout: "",
          stderr: "cache error",
        }),
      ),
    ).toThrow(/renderCache failed/);
  });

  it("succeeds with mock inline runner", () => {
    expect(() =>
      renderCache(
        "/tmp/project",
        { repo: "x/y", now_iso: "2026-05-01T00:00:00Z", issues: [] },
        "/scripts",
        () => ({
          returncode: 0,
          stdout: "",
          stderr: "",
        }),
      ),
    ).not.toThrow();
  });
});

describe("parseSmoketestArgs branches", () => {
  it("parses keep-tempdir and help flags", () => {
    expect(parseSmoketestArgs(["--keep-tempdir"]).keepTempdir).toBe(true);
    expect(parseSmoketestArgs(["--help"]).showHelp).toBe(true);
    expect(parseSmoketestArgs(["-h"]).showHelp).toBe(true);
  });

  it("returns error when --fixture lacks value", () => {
    expect(parseSmoketestArgs(["--fixture"]).error).toContain("--fixture");
  });
});

describe("copyFixtureToTmp branches", () => {
  it("skips absent optional vbrief lifecycle folders", () => {
    const fixture = mkdtempSync(join(tmpdir(), "smoke-fix-min-"));
    const tmp = mkdtempSync(join(tmpdir(), "smoke-tmp-min-"));
    temps.push(fixture, tmp);
    writeFileSync(
      join(fixture, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: {} }),
      "utf8",
    );
    const project = copyFixtureToTmp(fixture, join(tmp, "proj"));
    expect(
      readFileSync(join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    ).toContain("plan");
  });
});

describe("runSmoketest branches", () => {
  it("returns 0 on successful mocked stage runner", () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-ok-"));
    temps.push(root);
    seedFixture(root);
    expect(
      runSmoketest(root, {
        deps: {
          scriptsDir: join(root, "scripts"),
          scriptRunner: {
            run: () => ({ returncode: 0, stdout: "", stderr: "" }),
          },
          runInlinePython: mockInline(),
        },
      }),
    ).toBe(0);
    expect(readFileSync(join(root, "last_run.json"), "utf8")).toContain('"exit_code": 0');
  });

  it("returns 1 when stage runner subprocess fails", () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-runner-fail-"));
    temps.push(root);
    seedFixture(root);
    expect(
      runSmoketest(root, {
        deps: {
          scriptsDir: join(root, "scripts"),
          scriptRunner: { run: () => ({ returncode: 0, stdout: "", stderr: "" }) },
          runInlinePython: () => ({ returncode: 1, stdout: "", stderr: "python boom" }),
        },
      }),
    ).toBe(1);
  });

  it("returns 1 when stage payload reports failure", () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-stage-fail-"));
    temps.push(root);
    seedFixture(root);
    const stderr: string[] = [];
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      stderr.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(
        runSmoketest(root, {
          deps: {
            scriptsDir: join(root, "scripts"),
            scriptRunner: { run: () => ({ returncode: 0, stdout: "", stderr: "" }) },
            runInlinePython: mockInline({
              exit_code: 1,
              records: [{ stage: 1, status: "FAIL" }],
              error: "stage failed",
            }),
          },
        }),
      ).toBe(1);
      expect(stderr.join("")).toContain("stage failed");
    } finally {
      process.stderr.write = err;
    }
  });

  it("returns 1 when renderCache throws", () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-cache-fail-"));
    temps.push(root);
    seedFixture(root);
    expect(
      runSmoketest(root, {
        deps: {
          scriptsDir: join(root, "scripts"),
          scriptRunner: { run: () => ({ returncode: 0, stdout: "", stderr: "" }) },
          runInlinePython: () => ({ returncode: 1, stdout: "", stderr: "cache fail" }),
        },
      }),
    ).toBe(1);
  });

  it("preserves temp dir when keepTempdir is set", () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-keep-"));
    temps.push(root);
    seedFixture(root);
    const notes: string[] = [];
    const err = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      notes.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(
        runSmoketest(root, {
          keepTempdir: true,
          verbose: true,
          deps: {
            scriptsDir: join(root, "scripts"),
            scriptRunner: { run: () => ({ returncode: 0, stdout: "", stderr: "" }) },
            runInlinePython: mockInline(),
          },
        }),
      ).toBe(0);
      expect(notes.join("")).toContain("--keep-tempdir");
      expect(notes.join("")).toContain("exit 0");
    } finally {
      process.stderr.write = err;
    }
  });

  it("uses DEFT_ROOT env when deftRoot option is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "smoke-deft-root-"));
    temps.push(root);
    seedFixture(root);
    const prev = process.env.DEFT_ROOT;
    process.env.DEFT_ROOT = root;
    try {
      expect(
        runSmoketest(root, {
          deps: {
            scriptsDir: join(root, "scripts"),
            scriptRunner: { run: () => ({ returncode: 0, stdout: "", stderr: "" }) },
            runInlinePython: mockInline(),
          },
        }),
      ).toBe(0);
    } finally {
      process.env.DEFT_ROOT = prev;
    }
  });
});
