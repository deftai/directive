import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs, run } from "./triage-reconcile.js";

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
  const root = mkdtempSync(join(tmpdir(), "reconcile-cli-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ plan: {} }),
    "utf8",
  );
  return root;
}

describe("triage-reconcile CLI parseArgs", () => {
  it("parses dry-run json and equals-form flags", () => {
    const args = parseArgs(["--dry-run", "--json", "--project-root=/tmp", "--repo=deftai/x"]);
    expect(args.dryRun).toBe(true);
    expect(args.emitJson).toBe(true);
    expect(args.projectRoot).toBe("/tmp");
    expect(args.repo).toBe("deftai/x");
  });

  it("reports missing flag values and unknown args", () => {
    expect(parseArgs(["--project-root"]).error).toContain("--project-root");
    expect(parseArgs(["--repo"]).error).toContain("--repo");
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });
});

describe("triage-reconcile CLI run", () => {
  it("emits json summary on dry run", () => {
    const root = seedProject();
    const { code, stdout } = captureIo(() =>
      run(["--dry-run", "--json", "--project-root", root, "--repo", "deftai/directive"]),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('"dry_run": true');
  });

  it("emits text summary when json flag is absent", () => {
    const root = seedProject();
    const { code, stdout } = captureIo(() => run(["--project-root", root]));
    expect(code).toBe(0);
    expect(stdout).toContain("Triage audit-log reconcile recap");
  });

  it("rejects missing and non-directory project roots", () => {
    const missing = captureIo(() => run(["--project-root", "/no/such/root"]));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("does not exist");

    const root = seedProject();
    const file = join(root, "file.txt");
    writeFileSync(file, "x", "utf8");
    const notDir = captureIo(() => run(["--project-root", file]));
    expect(notDir.code).toBe(2);
    expect(notDir.stderr).toContain("does not exist");
  });
});
