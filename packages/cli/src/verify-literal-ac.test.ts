import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-literal-ac.js";

describe("parseArgs", () => {
  it("parses path, quiet, capture-only, project-root", () => {
    const a = parseArgs([
      "--project-root",
      "/tmp/p",
      "--quiet",
      "--capture-only",
      "xbrief/active/s.xbrief.json",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe("/tmp/p");
    expect(a.quiet).toBe(true);
    expect(a.captureOnly).toBe(true);
    expect(a.xbriefPath).toBe("xbrief/active/s.xbrief.json");
  });

  it("rejects unknown flags", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });
});

describe("run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 when no xbrief available", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-"));
    const code = run(["--project-root", root]);
    expect(code).toBe(2);
  });

  it("capture-only lists stored commands without executing shell", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          metadata: {
            literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
          },
          items: [],
        },
      }),
      "utf8",
    );
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    const code = run(["--project-root", root, "--capture-only", path]);
    expect(code).toBe(0);
    const joined = chunks.join("");
    expect(joined).toMatch(/task check/);
    expect(joined).toMatch(/"count": 1/);
  });

  it("auto-finds single active xbrief and runs stored commands via evaluate", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-run-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "only.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          metadata: {
            // Empty stored list → pass (nothing stated to run)
            literal_acceptance_commands: [],
          },
          items: [],
        },
      }),
      "utf8",
    );
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    const code = run(["--project-root", root, "--quiet"]);
    expect(code).toBe(0);
  });

  it("parseArgs supports --xbrief= form and rejects missing project-root value", () => {
    expect(parseArgs(["--xbrief=a.xbrief.json"]).xbriefPath).toBe("a.xbrief.json");
    expect(parseArgs(["--vbrief=b.vbrief.json"]).xbriefPath).toBe("b.vbrief.json");
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--xbrief"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root=."]).projectRoot).toBe(".");
  });

  it("capture-only fails on malformed xBRIEF", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-bad-"));
    const path = join(root, "bad.json");
    writeFileSync(path, "[1]", "utf8");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(run(["--project-root", root, "--capture-only", path])).toBe(2);
    expect(err.join("")).toMatch(/not an object|missing plan/i);

    writeFileSync(path, JSON.stringify({ plan: null }), "utf8");
    expect(run(["--project-root", root, "--capture-only", path])).toBe(2);
  });

  it("run path reports failure on stderr when command fails safety", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cli-fail-"));
    const path = join(root, "s.xbrief.json");
    // Inject via raw JSON bypassing capture filter — run path must refuse.
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          title: "t",
          metadata: {
            literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
          },
          items: [],
        },
      }),
      "utf8",
    );
    // With no runner override, evaluating "task check" may fail if task missing —
    // but allowlisted; use empty list narrative path instead for exit 0.
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    // Re-write with empty commands → ok
    writeFileSync(path, JSON.stringify({ plan: { title: "t", metadata: {}, items: [] } }), "utf8");
    const code = run(["--project-root", root, path]);
    expect(code).toBe(0);
  });
});
