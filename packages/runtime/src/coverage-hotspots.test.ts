import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./coverage-hotspots.js";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("coverage-hotspots parseArgs", () => {
  it("defaults project root and diff filter", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      useDiffPaths: true,
      json: false,
      quiet: false,
      pathFilter: [],
    });
  });

  it("parses json, quiet, coverage dir, and min headroom", () => {
    expect(
      parseArgs(["--json", "--quiet", "--coverage-dir=coverage-report", "--min-headroom-pp=0.5"]),
    ).toMatchObject({
      json: true,
      quiet: true,
      coverageDir: "coverage-report",
      minHeadroomPp: 0.5,
    });
  });

  it("parses explicit path filters and disables diff filter", () => {
    expect(parseArgs(["--path", "src/a.ts,src/b.ts"]).pathFilter).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parseArgs(["--path", "src/a.ts"]).useDiffPaths).toBe(false);
    expect(parseArgs(["--paths=src/a.ts"]).pathFilter).toEqual(["src/a.ts"]);
    expect(parseArgs(["--base-ref=origin/master"]).baseRef).toBe("origin/master");
    expect(parseArgs(["--project-root=."]).projectRoot).toBe(".");
  });

  it("parses equals-form flags", () => {
    expect(parseArgs(["--paths=src/a.ts"]).pathFilter).toEqual(["src/a.ts"]);
    expect(parseArgs(["--coverage-dir=custom"]).coverageDir).toBe("custom");
    expect(parseArgs(["--min-headroom-pp=0.5"]).minHeadroomPp).toBe(0.5);
    expect(parseArgs(["--project-root=../root"]).projectRoot).toBe("../root");
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--min-headroom-pp", "nope"]).error).toBeDefined();
  });
});

describe("coverage-hotspots run", () => {
  it("returns 2 when coverage report is missing", () => {
    expect(silentRun(["--project-root", ".", "--no-diff-filter"])).toBe(2);
  });

  it("errors on missing path and coverage-dir values", () => {
    expect(parseArgs(["--path"]).error).toBeDefined();
    expect(parseArgs(["--coverage-dir"]).error).toBeDefined();
    expect(parseArgs(["--base-ref"]).error).toBeDefined();
    expect(parseArgs(["--min-headroom-pp"]).error).toBeDefined();
  });

  it("run writes json failures to stderr", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", ".", "--no-diff-filter", "--json"])).toBe(2);
      expect(err.mock.calls.join("")).toContain("coverage report missing");
    } finally {
      err.mockRestore();
    }
  });

  it("run exits 0 with json output on passing fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-cov-hotspots-"));
    temps.push(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-final.json"),
      JSON.stringify({
        "src/good.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    );
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--project-root", root, "--no-diff-filter", "--json", "--path", "src/good.ts"]),
      ).toBe(0);
      expect(out.mock.calls.join("")).toContain('"ok": true');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("run suppresses stdout when --quiet passes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-cov-hotspots-quiet-"));
    temps.push(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-final.json"),
      JSON.stringify({
        "src/good.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    );
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--project-root", root, "--no-diff-filter", "--quiet", "--path", "src/good.ts"]),
      ).toBe(0);
      expect(out.mock.calls).toHaveLength(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("run emits human-readable failures to stderr", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", ".", "--no-diff-filter"])).toBe(2);
      expect(err.mock.calls.join("")).toContain("coverage-hotspots:");
    } finally {
      err.mockRestore();
    }
  });

  it("run emits hotspot failures to stderr when headroom is insufficient", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-cov-hotspots-fail-"));
    temps.push(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-final.json"),
      JSON.stringify({
        "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
      }),
    );
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root, "--no-diff-filter", "--path", "src/a.ts"])).toBe(1);
      expect(err.mock.calls.join("")).toContain("coverage-hotspots: FAIL");
    } finally {
      err.mockRestore();
    }
  });

  it("run writes json hotspot failures to stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-cov-hotspots-json-fail-"));
    temps.push(root);
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-final.json"),
      JSON.stringify({
        "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
      }),
    );
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--project-root", root, "--no-diff-filter", "--json", "--path", "src/a.ts"]),
      ).toBe(1);
      expect(err.mock.calls.join("")).toContain('"ok": false');
    } finally {
      err.mockRestore();
    }
  });

  it("run returns 2 when parseArgs fails", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--bogus"])).toBe(2);
      expect(err.mock.calls.join("")).toContain("unrecognized argument");
    } finally {
      err.mockRestore();
    }
  });

  it("run honors custom coverage directory flag", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-cov-hotspots-dir-"));
    temps.push(root);
    mkdirSync(join(root, "custom"), { recursive: true });
    writeFileSync(
      join(root, "custom/coverage-final.json"),
      JSON.stringify({
        "src/good.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    );
    expect(
      silentRun([
        "--project-root",
        root,
        "--coverage-dir",
        join(root, "custom"),
        "--no-diff-filter",
        "--path",
        "src/good.ts",
      ]),
    ).toBe(0);
  });
});
