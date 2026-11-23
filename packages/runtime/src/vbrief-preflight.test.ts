import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ISSUELESS_CODE_BEARING_REMEDIATION,
  issuelessCodeBearingNote,
  normalizePreflightPath,
  parseArgs,
  run,
  strictAxisAdvisoryForBrief,
} from "./vbrief-preflight.js";

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

  it("fail-opens when the work-claim scan throws (#4200)", () => {
    const path = activeRunning();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--vbrief-path", path, "--json"], () => {
          throw new Error("git missing");
        }),
      ).toBe(0);
      const written = String(out.mock.calls[0]?.[0] ?? "");
      const payload = JSON.parse(written.trim()) as { ready: boolean; message: string };
      expect(payload.ready).toBe(true);
      expect(payload.message).toContain("scan failed");
      expect(payload.message).toContain("Warn is success");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("still scans work-claim when preflight evaluation fails (#4200)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-pending-scan-"));
    temps.push(root);
    const dir = join(root, "pending");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "story.xbrief.json");
    writeFileSync(path, JSON.stringify({ plan: { status: "running" } }), "utf8");
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(["--vbrief-path", path], () => [
          "[deft work-claim] warning: deftai/directive#4200 carries status:claimed (busy). Warn is success; this is not a GitHub lock.",
        ]),
      ).toBe(1);
      const written = err.mock.calls.map((c) => String(c[0] ?? "")).join("");
      expect(written).toContain("status:claimed");
      expect(written).toContain("Warn is success");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
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

  it("includes the work-claim scan in --json output on success (#4200)", () => {
    const path = activeRunning();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        run(["--vbrief-path", path, "--json"], () => [
          "[deft work-claim] warning: deftai/directive#4200 carries status:claimed (busy). Warn is success; this is not a GitHub lock.",
        ]),
      ).toBe(0);
      const written = String(out.mock.calls[0]?.[0] ?? "");
      const payload = JSON.parse(written.trim()) as { ready: boolean; message: string };
      expect(payload.ready).toBe(true);
      expect(payload.message).toContain("status:claimed");
      expect(payload.message).toContain("Warn is success");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe("issue-less code-bearing remediation (#5710 P2)", () => {
  function briefWith(plan: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-5710-"));
    temps.push(root);
    mkdirSync(join(root, "active"), { recursive: true });
    const path = join(root, "active", "story.xbrief.json");
    writeFileSync(path, JSON.stringify({ plan: { status: "running", ...plan } }), "utf8");
    return path;
  }

  function capture(argv: string[]): { code: number; stdout: string } {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = run(argv, () => []);
      return { code, stdout: out.mock.calls.map((call) => String(call[0])).join("") };
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  }

  it("clause.4: prints one line naming the PR-only and issue-first paths; exit stays 0", () => {
    const path = briefWith({ metadata: { swarm: { file_scope: ["src/a.ts"] } } });
    const { code, stdout } = capture(["--vbrief-path", path]);
    expect(code).toBe(0);
    const lines = stdout.split("\n").filter((line) => line.includes("#5710"));
    expect(lines).toEqual([ISSUELESS_CODE_BEARING_REMEDIATION]);
    expect(ISSUELESS_CODE_BEARING_REMEDIATION).toMatch(/PR-only complete/);
    expect(ISSUELESS_CODE_BEARING_REMEDIATION).toMatch(/Issue-first/);
    const json = capture(["--vbrief-path", path, "--json"]);
    expect(json.code).toBe(0);
    expect((JSON.parse(json.stdout.trim()) as { message: string }).message).toContain(
      "PR-only complete",
    );
  });

  it("clause.4: stays silent for briefs with an issue origin or no code", () => {
    const issue = briefWith({
      metadata: { swarm: { file_scope: ["src/a.ts"] } },
      references: [{ uri: "https://github.com/o/r/issues/1", type: "x-xbrief/github-issue" }],
    });
    const docs = briefWith({ tags: ["docs-only"], metadata: { swarm: { file_scope: ["a.md"] } } });
    for (const path of [issue, docs]) {
      expect(issuelessCodeBearingNote(path)).toBeNull();
    }
    expect(issuelessCodeBearingNote(join(tmpdir(), "missing-5710.xbrief.json"))).toBeNull();
    const notObject = briefWith({});
    writeFileSync(notObject, "[]", "utf8");
    expect(issuelessCodeBearingNote(notObject)).toBeNull();
  });
});

describe("strict-axis advisory at preflight (#6272)", () => {
  function briefWith(plan: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-6272-"));
    temps.push(root);
    mkdirSync(join(root, "active"), { recursive: true });
    const path = join(root, "active", "story.xbrief.json");
    writeFileSync(path, JSON.stringify({ plan: { status: "running", ...plan } }), "utf8");
    return path;
  }

  function capture(argv: string[]): { code: number; stdout: string; stderr: string } {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = run(argv, () => []);
      return {
        code,
        stdout: out.mock.calls.map((call) => String(call[0])).join(""),
        stderr: err.mock.calls.map((call) => String(call[0])).join(""),
      };
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  }

  const items = [
    { id: "clause.1", title: "Smoke check passes after deploy.", status: "pending" },
    { id: "clause.2", title: "Unit tests cover the parser.", status: "pending" },
  ];

  it("clause.7: prints the clause id and axes; exit code unchanged", () => {
    const strict = briefWith({ items });
    const plain = briefWith({ items: [items[1]] });
    const listed = capture(["--vbrief-path", strict]);
    const quiet = capture(["--vbrief-path", plain]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(quiet.code).toBe(listed.code);
    expect(listed.stdout).toContain("  clause.1: smoke, deploy\n");
    expect(listed.stdout).not.toContain("clause.2:");
    expect(quiet.stdout).not.toContain("#6272");
    const json = capture(["--vbrief-path", strict, "--json"]);
    expect((JSON.parse(json.stdout.trim()) as { message: string }).message).toContain(
      "clause.1: smoke, deploy",
    );
  });

  it("clause.8: a refused preflight keeps its exit code and still lists", () => {
    const path = briefWith({ status: "pending", items });
    const result = capture(["--vbrief-path", path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("clause.1: smoke, deploy");
    expect(strictAxisAdvisoryForBrief(join(tmpdir(), "missing-6272.xbrief.json"))).toEqual([]);
  });

  it("#6591: on an active brief the advisory lists rows and does not suggest a declaration", () => {
    const declared = {
      id: "clause.3",
      title: "Deploy the docs site.",
      status: "pending",
      "x-directive/requires": "merge",
    };
    const path = briefWith({ items: [...items, declared] });
    const result = capture(["--vbrief-path", path]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("  clause.1: smoke, deploy\n");
    expect(result.stdout).toContain("  clause.3: deploy (declared)\n");
    expect(result.stdout).toContain("Advisory only; exit code unchanged.\n");
    expect(result.stdout).not.toContain("x-directive/requires");
    expect(result.stdout).not.toMatch(/reword the clause or declare/);
  });

  it("#7099: preflight rows keep their text, reasons follow, the last line names the grant", () => {
    const path = briefWith({ id: "github.issue.6272", items });
    const result = capture(["--vbrief-path", path]);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.split("\n");
    const row = lines.indexOf("  clause.1: smoke, deploy");
    expect(row).toBeGreaterThan(-1);
    expect(lines[row + 1]).toMatch(/^ {4}smoke from \S+: «untrusted:[^«»]*»$/);
    expect(lines[row + 2]).toMatch(/^ {4}deploy from \S+: «untrusted:[^«»]*»$/);
    const last = lines.find((line) => line.includes("Advisory only; exit code unchanged."));
    expect(last).toContain(
      "--template acceptance-disposition --plan-ref github.issue.6272 --story-ids clause.1 " +
        "--disposition not_applicable --reason <text> --confirm",
    );
    expect(last).toContain("#7127");
    expect(last).not.toMatch(/\bdeclare\b/);
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

describe("normalizePreflightPath (#6647)", () => {
  function projectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-preflight-norm-"));
    temps.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    return root;
  }

  it("converts an absolute path inside the project to repo-relative from the root", () => {
    const root = projectRoot();
    const abs = join(root, "xbrief", "active", "s.xbrief.json");
    expect(normalizePreflightPath(abs, root, "linux")).toBe("xbrief/active/s.xbrief.json");
  });

  it("keeps the native absolute path when the current directory is not the project root", () => {
    const root = projectRoot();
    const sub = join(root, "xbrief");
    const abs = join(root, "xbrief", "active", "s.xbrief.json");
    expect(normalizePreflightPath(abs, sub, "linux")).toBe(abs);
  });

  it("keeps the absolute path when it is outside the project root", () => {
    const root = projectRoot();
    const other = projectRoot();
    const abs = join(other, "xbrief", "active", "s.xbrief.json");
    expect(normalizePreflightPath(abs, root, "linux")).toBe(abs);
  });

  it("leaves a relative path unchanged", () => {
    const root = projectRoot();
    expect(normalizePreflightPath("xbrief/active/s.xbrief.json", root, "linux")).toBe(
      "xbrief/active/s.xbrief.json",
    );
  });

  it("maps the Git Bash /<drive>/ form on win32 and leaves it alone elsewhere", () => {
    const bare = mkdtempSync(join(tmpdir(), "deft-cli-preflight-bare-"));
    temps.push(bare);
    expect(normalizePreflightPath("/c/Repos/x/s.json", bare, "win32")).toBe("C:/Repos/x/s.json");
    expect(normalizePreflightPath("/c", bare, "win32")).toBe("C:/");
    expect(normalizePreflightPath("/c/Repos/x/s.json", bare, "linux")).toBe("/c/Repos/x/s.json");
  });

  it("run accepts a native absolute path to a ready brief", () => {
    const path = activeRunning();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(run([path], () => [])).toBe(0);
    } finally {
      out.mockRestore();
    }
  });
});
