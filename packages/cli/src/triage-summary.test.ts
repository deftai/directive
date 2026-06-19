import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./triage-summary.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-summary-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  return root;
}

function silentRun(argv: string[]): { code: number; out: string; err: string } {
  const chunks: { out: string[]; err: string[] } = { out: [], err: [] };
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.out.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.err.push(String(chunk));
    return true;
  });
  try {
    return {
      code: run(argv),
      out: chunks.out.join(""),
      err: chunks.err.join(""),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("triage-summary CLI", () => {
  it("reports parse errors with exit 2", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--unknown"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("emits empty-cache line", () => {
    const root = mkRoot();
    const { code, out } = silentRun(["--project-root", root, "--no-history"]);
    expect(code).toBe(0);
    expect(out).toContain("cache empty");
  });

  it("emits json record", () => {
    const root = mkRoot();
    const cache = join(root, ".deft-cache", "github-issue", "deftai", "directive", "1");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "meta.json"), "{}", "utf8");
    const { code, out } = silentRun(["--project-root", root, "--no-history", "--json"]);
    expect(code).toBe(0);
    const record = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(record.schema).toBe("deft.triage.summary.v1");
    expect(record.cache_empty).toBe(false);
  });

  it("returns 2 when --project-root lacks value", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
  });

  it("appends history when not suppressed", () => {
    const root = mkRoot();
    const cache = join(root, ".deft-cache", "github-issue", "deftai", "directive", "1");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "meta.json"), "{}", "utf8");
    silentRun(["--project-root", root]);
    expect(existsSync(join(root, "vbrief", ".eval", "summary-history.jsonl"))).toBe(true);
  });

  it("parses equals-form flags", () => {
    expect(parseArgs(["--project-root=/tmp/x", "--cache-root=/tmp/c"]).projectRoot).toBe("/tmp/x");
  });
});
