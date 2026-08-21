import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, parseShowArgs, run } from "./policy.js";
import { diffCase, normalizeOutput, PARITY_CASES, renderReport } from "./policy-fixtures.js";

describe("normalizeOutput", () => {
  it("strips ISO timestamps", () => {
    expect(normalizeOutput("2026-01-01T12:00:00Z actor=x")).toBe("<TS> actor=x");
  });

  it("normalizes missing PROJECT-DEFINITION paths", () => {
    expect(
      normalizeOutput(
        "error=PROJECT-DEFINITION not found at /tmp/abc/xbrief/PROJECT-DEFINITION.xbrief.json",
      ),
    ).toBe("error=PROJECT-DEFINITION not found at <ROOT>");
    expect(
      normalizeOutput(
        "[deft policy] Branch-protection policy is ON (fail-closed: PROJECT-DEFINITION not found at /tmp/x/xbrief/PROJECT-DEFINITION.xbrief.json). Direct commits to the default branch are blocked.",
      ),
    ).toContain("fail-closed: PROJECT-DEFINITION not found at <ROOT>");
  });
});

describe("diffCase", () => {
  it("reports clean when outputs match", () => {
    const cap = { exitCode: 0, stdout: "ok\n", stderr: "" };
    const d = diffCase(cap, cap, "x");
    expect(d.exitMismatch).toBe(false);
    expect(d.stdoutMismatch).toBe(false);
  });
});

describe("PARITY_CASES", () => {
  it("defines at least one case", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });
});

describe("parseShowArgs", () => {
  it("defaults to text format", () => {
    expect(parseShowArgs([])).toEqual({
      format: "text",
      changedOnly: false,
      field: null,
      projectRoot: ".",
    });
  });

  it("parses json format and changed-only", () => {
    expect(parseShowArgs(["--format", "json", "--changed-only"])).toMatchObject({
      format: "json",
      changedOnly: true,
    });
  });

  it("rejects unknown flags", () => {
    expect(parseShowArgs(["--bogus"]).error).toContain("unrecognized");
  });
});

describe("parseArgs", () => {
  it("routes show subcommand", () => {
    expect(parseArgs(["show", "--field", "plan.policy.wipCap"]).field).toBe("plan.policy.wipCap");
  });

  it("routes resolve subcommand", () => {
    expect(parseArgs(["resolve"]).cmd).toBe("resolve");
  });

  it("errors on unknown subcommand", () => {
    expect(parseArgs(["bogus"]).error).toContain("unknown subcommand");
  });

  it("parses enforce-branches flags", () => {
    expect(parseArgs(["enforce-branches", "--actor", "t"]).actor).toBe("t");
  });
});

describe("run allow-direct-commits refusal", () => {
  it("exits 1 without confirm", () => {
    const prevStdout = process.stdout.write.bind(process.stdout);
    const prevStderr = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = run(["allow-direct-commits", "--project-root", "/nonexistent"]);
      expect(code).toBe(1);
      expect(out).toContain("Capability-cost disclosure");
      expect(out).toContain("--confirm");
    } finally {
      process.stdout.write = prevStdout;
      process.stderr.write = prevStderr;
    }
  });
});

describe("run show + set integration", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function project(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-cli-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", items: [], policy: { wipCap: 5 } },
      }),
      { encoding: "utf8" },
    );
    return r;
  }

  function captureRun(argv: string[]): { code: number; out: string; err: string } {
    let out = "";
    let err = "";
    const prevOut = process.stdout.write.bind(process.stdout);
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => {
      out += String(c);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      err += String(c);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: run(argv), out, err };
    } finally {
      process.stdout.write = prevOut;
      process.stderr.write = prevErr;
    }
  }

  it("runs show text for a configured project", () => {
    const r = project();
    const { code, out } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain("plan.policy.wipCap");
    expect(out).toContain("current: 5");
  });

  it("runs show json", () => {
    const r = project();
    const { code, out } = captureRun(["show", "--format", "json", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain('"generated_at"');
  });

  it("warns to stderr when a bare plan.policy shadows the namespaced form (#2301)", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-shadow-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-directive/policy": { wipCap: 8 },
          policy: { triageScope: [{ rule: "all-open" }] },
        },
      }),
      { encoding: "utf8" },
    );
    const { code, out, err } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(err).toContain("[policy:show] WARNING:");
    expect(err).toContain("bare `plan.policy`");
    expect(err).toContain("plan.policy.triageScope");
    // stdout stays clean (JSON/text render is not polluted by the warning).
    expect(out).toContain("plan.policy.wipCap");
  });

  it("does not warn when only the namespaced policy exists", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-noshadow-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", items: [], "x-directive/policy": { wipCap: 8 } },
      }),
      { encoding: "utf8" },
    );
    const { code, err } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(err).not.toContain("WARNING:");
  });

  it("runs resolve subcommand", () => {
    const r = project();
    const { code, out } = captureRun(["resolve", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain("allowDirectCommitsToMaster=");
    expect(out).toContain("[deft policy]");
  });

  it("runs enforce-branches", () => {
    const r = project();
    const { code, out } = captureRun(["enforce-branches", "--project-root", r, "--actor", "t"]);
    expect(code).toBe(0);
    expect(out).toContain("branch-protection ON");
  });

  it("returns 2 for unknown show field", () => {
    const r = project();
    const { code, err } = captureRun(["show", "--field", "nope", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain("unknown --field=");
  });

  it("warns when PROJECT-DEFINITION missing", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-empty-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(err).toContain("PROJECT-DEFINITION not found");
  });

  it("names the xbrief path in the not-found warning on a migrated tree (#2302)", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-xbrief-"));
    roots.push(r);
    // A migrated tree: xbrief/ exists and holds at least one .xbrief.json
    // artifact, but PROJECT-DEFINITION.xbrief.json is absent.
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "some.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(err).toContain(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`);
    expect(err).not.toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
  });

  it("recovery hint names the xbrief path on a migrated tree (#2302)", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-xbrief-set-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "some.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["enforce-branches", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`);
    expect(err).not.toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
  });

  it("runs allow-direct-commits with confirm", () => {
    const r = project();
    const { code, out } = captureRun([
      "allow-direct-commits",
      "--confirm",
      "--project-root",
      r,
      "--actor",
      "test",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("branch-protection OFF");
  });

  it("runs enable-value-feedback with confirm", () => {
    const r = project();
    const { code, out } = captureRun([
      "enable-value-feedback",
      "--confirm",
      "--project-root",
      r,
      "--actor",
      "test",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("value-feedback ON");
  });

  it("disable-host-hooks refuses without --confirm", () => {
    const r = project();
    const { code, out } = captureRun([
      "disable-host-hooks",
      "--host",
      "cursor",
      "--project-root",
      r,
    ]);
    expect(code).toBe(1);
    expect(out).toContain("Capability-cost disclosure");
    expect(out).toContain("--confirm");
    expect(out).toContain("deft-hook pre-execution guardrails");
  });

  it("disable-host-hooks persists after --confirm", () => {
    const r = project();
    const { code, out } = captureRun([
      "disable-host-hooks",
      "--host",
      "cursor",
      "--confirm",
      "--project-root",
      r,
      "--actor",
      "test",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("guardrails removed");
  });

  it("disable-host-hooks requires --host", () => {
    expect(parseArgs(["disable-host-hooks", "--confirm"]).error).toContain("--host");
  });

  it("disable-host-hooks ignores a stray go-task -- separator", () => {
    const parsed = parseArgs(["disable-host-hooks", "--", "--host", "cursor", "--confirm"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.host).toBe("cursor");
    expect(parsed.confirm).toBe(true);
  });

  it("returns config error when setting on missing project def", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-missing-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["enforce-branches", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain("not found");
  });

  it("errors on empty argv", () => {
    expect(parseArgs([]).error).toContain("usage:");
  });

  it("parses --format=json style flags", () => {
    expect(parseShowArgs(["--format=json"]).format).toBe("json");
    expect(parseShowArgs(["--project-root=/tmp/x"]).projectRoot).toBe("/tmp/x");
    expect(parseShowArgs(["--field=plan.policy.wipCap"]).field).toBe("plan.policy.wipCap");
  });

  it("errors on missing format value", () => {
    expect(parseShowArgs(["--format"]).error).toContain("expected one argument");
  });

  it("errors on invalid format choice", () => {
    expect(parseShowArgs(["--format=bad"]).error).toContain("invalid choice");
  });

  it("errors on missing note value", () => {
    expect(parseArgs(["allow-direct-commits", "--confirm", "--note"]).error).toContain(
      "expected one argument",
    );
  });

  it("returns 2 for parse error on run", () => {
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(run(["show", "--format", "nope"])).toBe(2);
    } finally {
      process.stderr.write = prevErr;
    }
  });

  it("reports no-op when enforce-branches value already matches", () => {
    const r = project();
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-directive/policy": { allowDirectCommitsToMaster: false, wipCap: 5 },
        },
      }),
      { encoding: "utf8" },
    );
    const { code, out } = captureRun(["enforce-branches", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain("no-op");
    expect(out).toContain("ledger unchanged");
    expect(existsSync(join(r, "meta", "policy-changes.log"))).toBe(false);
  });

  it("returns config error for malformed project definition on set", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-malformed-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: [] } }),
      { encoding: "utf8" },
    );
    const { code, err } = captureRun(["enforce-branches", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain("Config error");
  });
});

describe("policy-parity helpers", () => {
  it("buildFixtureRepo writes project definition when plan provided", async () => {
    const { buildFixtureRepo } = await import("./policy-fixtures.js");
    const root = buildFixtureRepo({ policy: { wipCap: 1 } });
    try {
      expect(root).toContain("deft-policy-parity-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFixtureRepo creates empty vbrief root without plan", async () => {
    const { buildFixtureRepo } = await import("./policy-fixtures.js");
    const root = buildFixtureRepo();
    try {
      expect(root).toContain("deft-policy-parity-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diffCase flags mismatches", () => {
    const a = { exitCode: 0, stdout: "a\n", stderr: "" };
    const b = { exitCode: 1, stdout: "b\n", stderr: "e" };
    const d = diffCase(a, b, "t");
    expect(d.exitMismatch).toBe(true);
    expect(d.stdoutMismatch).toBe(true);
    expect(d.stderrMismatch).toBe(true);
  });

  it("renderReport shows clean and divergence messages", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
    expect(
      renderReport({
        ok: false,
        diffs: [
          {
            caseName: "x",
            exitMismatch: true,
            stdoutMismatch: false,
            stderrMismatch: false,
            pythonExit: 1,
            tsExit: 0,
          },
        ],
      }),
    ).toContain("DIVERGENCE");
  });
});
