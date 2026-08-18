import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./vbrief-preflight.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function activeRunning(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-preflight-"));
  temps.push(root);
  const dir = join(root, "active");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "story.xbrief.json");
  writeFileSync(
    path,
    JSON.stringify({
      plan: {
        status: "running",
        metadata: {
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/new-module.ts"],
            module_boundary: "new focused module",
          },
        },
      },
    }),
    "utf8",
  );
  return path;
}

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

describe("parseArgs", () => {
  it("requires --vbrief-path or positional path", () => {
    expect(parseArgs([]).error).toContain("--vbrief-path");
    expect(parseArgs([]).error).toContain("xbrief:preflight");
  });
  it("parses --vbrief-path and --json", () => {
    expect(parseArgs(["--vbrief-path", "/x", "--json"])).toMatchObject({
      vbriefPath: "/x",
      emitJson: true,
    });
  });
  it("parses --brief-path alias", () => {
    expect(parseArgs(["--brief-path", "/x"]).vbriefPath).toBe("/x");
  });
  it("parses positional path", () => {
    expect(parseArgs(["xbrief/active/story.xbrief.json"]).vbriefPath).toBe(
      "xbrief/active/story.xbrief.json",
    );
  });
  it("accepts a lone -- separator before path (#2837)", () => {
    expect(parseArgs(["--", "xbrief/active/story.xbrief.json"]).vbriefPath).toBe(
      "xbrief/active/story.xbrief.json",
    );
    expect(parseArgs(["--", "xbrief/active/story.xbrief.json"]).error).toBeUndefined();
    expect(parseArgs(["--", "xbrief/active/story.xbrief.json"])).toEqual(
      parseArgs(["xbrief/active/story.xbrief.json"]),
    );
    expect(parseArgs(["--", "--vbrief-path", "/x"])).toEqual(parseArgs(["--vbrief-path", "/x"]));
  });
  it("parses --vbrief-path= form", () => {
    expect(parseArgs(["--vbrief-path=/y"]).vbriefPath).toBe("/y");
  });
  it("returns help without requiring a path", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true, vbriefPath: null });
    expect(parseArgs(["--help"]).error).toBeUndefined();
    expect(parseArgs(["-h"])).toMatchObject({ help: true });
  });
  it("treats task-baked --vbrief-path --help as help (#2837)", () => {
    // `task xbrief:preflight -- --help` → ENGINE_CMD prepends --vbrief-path.
    expect(parseArgs(["--vbrief-path", "--help"])).toMatchObject({
      help: true,
      vbriefPath: null,
    });
    expect(parseArgs(["--vbrief-path", "--help"]).error).toBeUndefined();
    expect(parseArgs(["--vbrief-path", "-h"])).toMatchObject({ help: true });
    expect(parseArgs(["--vbrief-path", "--json"]).error).toContain("expected one argument");
  });
  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--vbrief-path"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--"]).error).toContain("--vbrief-path");
    expect(parseArgs(["--"]).error).not.toContain("null");
  });
});

describe("run", () => {
  it("returns 0 for active running vBRIEF", () => {
    expect(silentRun(["--vbrief-path", activeRunning()])).toBe(0);
  });
  it("returns 0 for separator form matching --vbrief-path (#2837)", () => {
    const path = activeRunning();
    expect(silentRun(["--", path])).toBe(0);
    expect(silentRun(["--vbrief-path", path])).toBe(0);
  });
  it("returns 0 for --help without evaluating a path", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--help"])).toBe(0);
      const written = String(out.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("usage: xbrief:preflight");
      expect(written).toContain("deft xbrief:preflight --");
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
  it("returns 1 for pending folder", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-pending-"));
    temps.push(root);
    const dir = join(root, "pending");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "story.xbrief.json");
    writeFileSync(path, JSON.stringify({ plan: { status: "running" } }), "utf8");
    expect(silentRun(["--vbrief-path", path])).toBe(1);
  });
  it("returns 2 for a bad argument", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });
  it("writes JSON to stdout with --json", () => {
    const path = activeRunning();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--vbrief-path", path, "--json"])).toBe(0);
      expect(out).toHaveBeenCalled();
      const written = String(out.mock.calls[0]?.[0] ?? "");
      const payload = JSON.parse(written.trim()) as { ready: boolean };
      expect(payload.ready).toBe(true);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe("vbrief-preflight-parity helpers", () => {
  it("parseJsonOutput extracts structured fields", async () => {
    const { parseJsonOutput } = await import("./vbrief-preflight-fixtures.js");
    const stdout =
      '{"exit_code":1,"message":"nope","ready":false,"vbrief_path":"/x/story.xbrief.json"}';
    const out = parseJsonOutput(stdout, 1);
    expect(out.exitCode).toBe(1);
    expect(out.ready).toBe(false);
    expect(out.vbriefPath).toBe("/x/story.xbrief.json");
    expect(out.message).toBe("nope");
  });

  it("diffOutputs reports clean when outputs match", async () => {
    const { diffOutputs, parseJsonOutput } = await import("./vbrief-preflight-fixtures.js");
    const stdout = '{"exit_code":0,"message":"OK","ready":true,"vbrief_path":"/a.xbrief.json"}';
    const py = parseJsonOutput(stdout, 0);
    const ts = parseJsonOutput(stdout, 0);
    const r = diffOutputs("case", py, ts);
    expect(r.ok).toBe(true);
  });

  it("diffOutputs flags mismatches", async () => {
    const { diffOutputs, parseJsonOutput } = await import("./vbrief-preflight-fixtures.js");
    const py = parseJsonOutput('{"exit_code":1,"message":"a","ready":false,"vbrief_path":"/p"}', 1);
    const ts = parseJsonOutput('{"exit_code":0,"message":"b","ready":true,"vbrief_path":"/p"}', 0);
    const r = diffOutputs("case", py, ts);
    expect(r.ok).toBe(false);
    expect(r.exitMismatch).toBe(true);
    expect(r.messageMismatch).toBe(true);
    expect(r.readyMismatch).toBe(true);
  });

  it("buildFixtures writes all corpus files", async () => {
    const { buildFixtures, PARITY_FIXTURES } = await import("./vbrief-preflight-fixtures.js");
    const root = mkdtempSync(join(tmpdir(), "deft-parity-fix-"));
    temps.push(root);
    const paths = buildFixtures(root);
    expect(paths.size).toBe(PARITY_FIXTURES.length);
    for (const [label] of PARITY_FIXTURES) {
      expect(paths.has(label)).toBe(true);
    }
  });

  it("renderReport shows clean and divergence summaries", async () => {
    const { renderReport } = await import("./vbrief-preflight-fixtures.js");
    const clean = renderReport({
      ok: true,
      cases: [
        {
          name: "a",
          ok: true,
          pythonExit: 0,
          tsExit: 0,
          exitMismatch: false,
          messageMismatch: false,
          readyMismatch: false,
        },
      ],
    });
    expect(clean).toContain("CLEAN");
    const bad = renderReport({
      ok: false,
      cases: [
        {
          name: "x",
          ok: false,
          pythonExit: 1,
          tsExit: 0,
          exitMismatch: true,
          messageMismatch: true,
          readyMismatch: false,
        },
      ],
    });
    expect(bad).toContain("DIVERGENCE");
    expect(bad).toContain("exit mismatch");
    expect(bad).toContain("message mismatch");
  });
});
