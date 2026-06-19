import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs, run } from "./triage-scope-drift.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function captureIo(fn: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: fn(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-drift-cli-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ plan: { policy: { triageScope: [] } } }),
    "utf8",
  );
  return root;
}

describe("triage-scope-drift CLI parseArgs", () => {
  it("parses equals-form flags", () => {
    expect(
      parseArgs(["--project-root=/tmp", "--cache-root=/cache", "--threshold=3"]).threshold,
    ).toBe(3);
    expect(parseArgs(["--ignore-label=bug"]).ignoreLabel).toBe("bug");
    expect(parseArgs(["--ignore-milestone=v1"]).ignoreMilestone).toBe("v1");
  });

  it("reports missing flag values", () => {
    expect(parseArgs(["--cache-root"]).error).toContain("--cache-root");
    expect(parseArgs(["--threshold"]).error).toContain("--threshold");
    expect(parseArgs(["--ignore-label"]).error).toContain("--ignore-label");
    expect(parseArgs(["--ignore-milestone"]).error).toContain("--ignore-milestone");
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });
});

describe("triage-scope-drift CLI run", () => {
  it("computes drift report for valid project root", () => {
    const root = seedProject();
    const { code, stdout } = captureIo(() => run(["--project-root", root]));
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("adds ignore label and reports next-step hint", () => {
    const root = seedProject();
    const { code, stdout, stderr } = captureIo(() =>
      run(["--project-root", root, "--ignore-label", "noise"]),
    );
    expect(code).toBe(0);
    expect(stdout + stderr).toContain("triage:scope-drift:");
  });

  it("returns no-op stderr when ignore label already present", () => {
    const root = seedProject();
    run(["--project-root", root, "--ignore-label", "dup"]);
    const { code, stderr } = captureIo(() =>
      run(["--project-root", root, "--ignore-label", "dup"]),
    );
    expect(code).toBe(0);
    expect(stderr).toContain("no-op");
  });

  it("rejects missing project root", () => {
    const { code, stderr } = captureIo(() => run(["--project-root", "/no/such/root"]));
    expect(code).toBe(2);
    expect(stderr).toContain("does not exist");
  });

  it("rejects non-directory project root", () => {
    const root = seedProject();
    const file = join(root, "not-a-dir.txt");
    writeFileSync(file, "x", "utf8");
    const { code, stderr } = captureIo(() => run(["--project-root", file]));
    expect(code).toBe(2);
    expect(stderr).toContain("does not exist");
  });
});
