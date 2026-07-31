import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./lifecycle-stats.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-lifecycle-stats-"));
  roots.push(root);
  return root;
}

function writeActive(root: string, name: string, updated: string): void {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "t", created: updated, updated },
      plan: { id: "x", title: "x", status: "running", updated, metadata: {} },
    }),
    "utf8",
  );
}

describe("parseArgs", () => {
  it("defaults since to 7d", () => {
    expect(parseArgs([])).toEqual({
      projectRoot: ".",
      since: "7d",
      json: false,
    });
  });

  it("parses --since form and equals form", () => {
    expect(parseArgs(["--since", "24h"]).since).toBe("24h");
    expect(parseArgs(["--since=1w"]).since).toBe("1w");
  });

  it("parses --json and --project-root", () => {
    const a = parseArgs(["--json", "--project-root", "/tmp/p"]);
    expect(a.json).toBe(true);
    expect(a.projectRoot).toBe("/tmp/p");
    expect(parseArgs(["--project-root=/tmp/q"]).projectRoot).toBe("/tmp/q");
  });

  it("errors on unknown flag and missing values", () => {
    expect(parseArgs(["--nope"]).error).toMatch(/unknown flag/);
    expect(parseArgs(["--since"]).error).toMatch(/--since/);
    expect(parseArgs(["--project-root"]).error).toMatch(/--project-root/);
    expect(parseArgs(["extra"]).error).toMatch(/unexpected/);
  });
});

describe("run", () => {
  it("prints text stats for a fixture tree", () => {
    const root = fixtureRoot();
    writeActive(root, "a.xbrief.json", new Date().toISOString());
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    const code = run(["--project-root", root, "--since=7d"]);
    stdout.mockRestore();
    stderr.mockRestore();
    expect(code).toBe(0);
    expect(out.join("")).toContain("still_active: 1");
    expect(err.join("")).toBe("");
  });

  it("prints JSON with documented metrics", () => {
    const root = fixtureRoot();
    writeActive(root, "a.xbrief.json", new Date().toISOString());
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--project-root", root, "--json"]);
    expect(code).toBe(0);
    const body = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(body.still_active).toBe(1);
    expect(body).toHaveProperty("promoted");
    expect(body).toHaveProperty("activated");
    expect(body).toHaveProperty("completed");
    expect(body).toHaveProperty("cancelled_or_failed");
    expect(body).toHaveProperty("semantics");
  });

  it("exits 2 on invalid since", () => {
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(run(["--since=nope"])).toBe(2);
    expect(err.join("")).toMatch(/invalid duration|duration/);
  });

  it("exits 2 on parse error", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(2);
  });
});
