import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initGitRepo, runDeftTs } from "./gates-cli/_helpers.js";
import { parseArgs, parseShowArgs, run } from "./policy.js";
import { diffCase, normalizeOutput, PARITY_CASES, renderReport } from "./policy-fixtures.js";

describe("normalizeOutput", async () => {
  it("strips ISO timestamps", async () => {
    expect(normalizeOutput("2026-01-01T12:00:00Z actor=x")).toBe("<TS> actor=x");
  });

  it("normalizes missing PROJECT-DEFINITION paths", async () => {
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

describe("diffCase", async () => {
  it("reports clean when outputs match", async () => {
    const cap = { exitCode: 0, stdout: "ok\n", stderr: "" };
    const d = diffCase(cap, cap, "x");
    expect(d.exitMismatch).toBe(false);
    expect(d.stdoutMismatch).toBe(false);
  });
});

describe("PARITY_CASES", async () => {
  it("defines at least one case", async () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });
});

describe("parseShowArgs", async () => {
  it("defaults to text format", async () => {
    expect(parseShowArgs([])).toEqual({
      format: "text",
      changedOnly: false,
      field: null,
      projectRoot: ".",
    });
  });

  it("parses json format and changed-only", async () => {
    expect(parseShowArgs(["--format", "json", "--changed-only"])).toMatchObject({
      format: "json",
      changedOnly: true,
    });
  });

  it("rejects unknown flags", async () => {
    expect(parseShowArgs(["--bogus"]).error).toContain("unrecognized");
  });
});

describe("parseArgs", async () => {
  it("routes show subcommand", async () => {
    expect(parseArgs(["show", "--field", "plan.policy.wipCap"]).field).toBe("plan.policy.wipCap");
  });

  it("routes resolve subcommand", async () => {
    expect(parseArgs(["resolve"]).cmd).toBe("resolve");
  });

  it("errors on unknown subcommand", async () => {
    expect(parseArgs(["bogus"]).error).toContain("unknown subcommand");
  });

  it("parses enforce-branches flags", async () => {
    expect(parseArgs(["enforce-branches", "--actor", "t"]).actor).toBe("t");
  });
});

describe("run allow-direct-commits refusal", async () => {
  it("exits 1 without confirm", async () => {
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

describe("run show + set integration", async () => {
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

  it("runs show text for a configured project", async () => {
    const r = project();
    const { code, out } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain("plan.policy.wipCap");
    expect(out).toContain("current: 5");
  });

  it("runs show json", async () => {
    const r = project();
    const { code, out } = captureRun(["show", "--format", "json", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain('"generated_at"');
  });

  it("warns to stderr when a bare plan.policy shadows the namespaced form (#2301)", async () => {
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

  it("does not warn when only the namespaced policy exists", async () => {
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

  it("runs resolve subcommand", async () => {
    const r = project();
    const { code, out } = captureRun(["resolve", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain("allowDirectCommitsToMaster=");
    expect(out).toContain("[deft policy]");
  });

  it("runs enforce-branches", async () => {
    const r = project();
    const { code, out } = captureRun(["enforce-branches", "--project-root", r, "--actor", "t"]);
    expect(code).toBe(0);
    expect(out).toContain("branch-protection ON");
  });

  it("returns 2 for unknown show field", async () => {
    const r = project();
    const { code, err } = captureRun(["show", "--field", "nope", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain("unknown --field=");
  });

  it("warns when PROJECT-DEFINITION missing", async () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-empty-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["show", "--project-root", r]);
    expect(code).toBe(0);
    expect(err).toContain("PROJECT-DEFINITION not found");
  });

  it("names the xbrief path in the not-found warning on a migrated tree (#2302)", async () => {
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

  it("recovery hint names the xbrief path on a migrated tree (#2302)", async () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-xbrief-set-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "some.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["enforce-branches", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`);
    expect(err).not.toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
  });

  it("runs allow-direct-commits with confirm", async () => {
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

  it("runs enable-value-feedback with confirm", async () => {
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

  it("disable-host-hooks refuses without --confirm", async () => {
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

  it("disable-host-hooks persists after --confirm", async () => {
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

  it("disable-host-hooks requires --host", async () => {
    expect(parseArgs(["disable-host-hooks", "--confirm"]).error).toContain("--host");
  });

  it("disable-host-hooks ignores a stray go-task -- separator", async () => {
    const parsed = parseArgs(["disable-host-hooks", "--", "--host", "cursor", "--confirm"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.host).toBe("cursor");
    expect(parsed.confirm).toBe(true);
  });

  it("returns config error when setting on missing project def", async () => {
    const r = mkdtempSync(join(tmpdir(), "deft-policy-missing-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(join(r, "xbrief", "active", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    const { code, err } = captureRun(["enforce-branches", "--project-root", r]);
    expect(code).toBe(2);
    expect(err).toContain("not found");
  });

  it("errors on empty argv", async () => {
    expect(parseArgs([]).error).toContain("usage:");
  });

  it("parses --format=json style flags", async () => {
    expect(parseShowArgs(["--format=json"]).format).toBe("json");
    expect(parseShowArgs(["--project-root=/tmp/x"]).projectRoot).toBe("/tmp/x");
    expect(parseShowArgs(["--field=plan.policy.wipCap"]).field).toBe("plan.policy.wipCap");
  });

  it("errors on missing format value", async () => {
    expect(parseShowArgs(["--format"]).error).toContain("expected one argument");
  });

  it("errors on invalid format choice", async () => {
    expect(parseShowArgs(["--format=bad"]).error).toContain("invalid choice");
  });

  it("errors on missing note value", async () => {
    expect(parseArgs(["allow-direct-commits", "--confirm", "--note"]).error).toContain(
      "expected one argument",
    );
  });

  it("returns 2 for parse error on run", async () => {
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(run(["show", "--format", "nope"])).toBe(2);
    } finally {
      process.stderr.write = prevErr;
    }
  });

  it("reports no-op when enforce-branches value already matches", async () => {
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

  it("returns config error for malformed project definition on set", async () => {
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

describe("policy-parity helpers", async () => {
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

  it("diffCase flags mismatches", async () => {
    const a = { exitCode: 0, stdout: "a\n", stderr: "" };
    const b = { exitCode: 1, stdout: "b\n", stderr: "e" };
    const d = diffCase(a, b, "t");
    expect(d.exitMismatch).toBe(true);
    expect(d.stdoutMismatch).toBe(true);
    expect(d.stderrMismatch).toBe(true);
  });

  it("renderReport shows clean and divergence messages", async () => {
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

describe("setup policy commands through the built colon router (#3609)", async () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function project(planPolicy?: {
    namespaced?: Record<string, unknown>;
    legacy?: Record<string, unknown>;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "deft-setup-policy-cli-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const plan: Record<string, unknown> = {
      title: "Setup policy fixture",
      status: "running",
      narratives: {
        Overview: "Fixture project",
        TechStack: "TypeScript library",
      },
      items: [],
    };
    if (planPolicy?.namespaced !== undefined) {
      plan["x-directive/policy"] = planPolicy.namespaced;
    }
    if (planPolicy?.legacy !== undefined) {
      plan.policy = planPolicy.legacy;
    }
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
      "utf8",
    );
    return root;
  }

  function planAt(root: string): Record<string, unknown> {
    return (
      JSON.parse(readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8")) as {
        plan: Record<string, unknown>;
      }
    ).plan;
  }

  function planAtPath(path: string): Record<string, unknown> {
    return (JSON.parse(readFileSync(path, "utf8")) as { plan: Record<string, unknown> }).plan;
  }

  it("persists branch-based default false in the namespaced block", async () => {
    const root = project();
    const result = await runDeftTs("policy:enforce-branches", [
      "--project-root",
      root,
      "--actor",
      "agent:deft-directive-setup",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const plan = planAt(root);
    expect(plan.policy).toBeUndefined();
    expect(plan["x-directive/policy"]).toMatchObject({ allowDirectCommitsToMaster: false });
  });

  it("persists confirmed trunk true and remains conformant", async () => {
    const root = project();
    const result = await runDeftTs("policy:allow-direct-commits", [
      "--confirm",
      "--project-root",
      root,
      "--actor",
      "agent:deft-directive-setup",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const plan = planAt(root);
    expect(plan.policy).toBeUndefined();
    expect(plan["x-directive/policy"]).toMatchObject({ allowDirectCommitsToMaster: true });
    initGitRepo(root);
    const conformance = await runDeftTs("verify:vbrief-conformance", ["--project-root", root]);
    expect(conformance.exitCode, conformance.stderr || conformance.stdout).toBe(0);
  });

  it("honors a noncanonical DEFT_PROJECT_PATH through writer and conformance", async () => {
    const root = project();
    const configuredPath = join(root, "config", "custom-project.xbrief.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      configuredPath,
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Configured setup policy fixture",
            status: "running",
            narratives: { Overview: "Fixture project", TechStack: "TypeScript library" },
            items: [],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    initGitRepo(root);
    const env = { DEFT_PROJECT_PATH: configuredPath };
    const result = await runDeftTs(
      "policy:enforce-branches",
      ["--project-root", root, "--actor", "agent:deft-directive-setup"],
      { env },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(planAtPath(configuredPath)["x-directive/policy"]).toMatchObject({
      allowDirectCommitsToMaster: false,
    });
    expect(
      planAtPath(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"))["x-directive/policy"],
    ).toBeUndefined();

    const configured = JSON.parse(readFileSync(configuredPath, "utf8")) as {
      plan: Record<string, unknown>;
    };
    configured.plan.rogue = true;
    writeFileSync(configuredPath, `${JSON.stringify(configured, null, 2)}\n`, "utf8");
    const rejected = await runDeftTs("verify:vbrief-conformance", ["--project-root", root], {
      env,
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("bare key 'rogue'");

    delete configured.plan.rogue;
    writeFileSync(configuredPath, `${JSON.stringify(configured, null, 2)}\n`, "utf8");
    const conformance = await runDeftTs("verify:vbrief-conformance", ["--project-root", root], {
      env,
    });
    expect(conformance.exitCode, conformance.stderr || conformance.stdout).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "preserves a configured symlink and shares its canonical writer/conformance identity",
    async () => {
      const root = project();
      const realPath = join(root, "config", "real-project.xbrief.json");
      const symlinkPath = join(root, "config", "configured-project.xbrief.json");
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(
        realPath,
        `${JSON.stringify(
          {
            xBRIEFInfo: { version: "0.8" },
            plan: { title: "Symlink fixture", status: "running", items: [] },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      symlinkSync(realPath, symlinkPath);
      initGitRepo(root);
      const env = { DEFT_PROJECT_PATH: symlinkPath };

      const result = await runDeftTs("policy:enforce-branches", ["--project-root", root], { env });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(planAtPath(realPath)["x-directive/policy"]).toMatchObject({
        allowDirectCommitsToMaster: false,
      });
      const conformance = await runDeftTs("verify:vbrief-conformance", ["--project-root", root], {
        env,
      });
      expect(conformance.exitCode, conformance.stderr || conformance.stdout).toBe(0);
    },
  );

  it("fails conformance closed for missing, unreadable, and malformed configured artifacts", async () => {
    const root = project();
    initGitRepo(root);
    const missingSecretPath = join(root, `secret-token\n\u001b[31m${"x".repeat(500)}`);
    const missing = await runDeftTs("verify:vbrief-conformance", ["--project-root", root], {
      env: { DEFT_PROJECT_PATH: missingSecretPath },
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("configured PROJECT-DEFINITION does not exist");
    expect(missing.stderr).not.toContain("secret-token");
    expect(missing.stderr.length).toBeLessThan(1_000);

    const unreadablePath = join(root, "config", "directory-not-file");
    mkdirSync(unreadablePath, { recursive: true });
    const unreadable = await runDeftTs("verify:vbrief-conformance", ["--project-root", root], {
      env: { DEFT_PROJECT_PATH: unreadablePath },
    });
    expect(unreadable.exitCode).toBe(2);
    expect(unreadable.stderr).toContain("configured PROJECT-DEFINITION is unreadable");

    const malformedPath = join(root, "config", "malformed-project.xbrief.json");
    writeFileSync(malformedPath, '{"secret-token":"do-not-print"', "utf8");
    const malformed = await runDeftTs("verify:vbrief-conformance", ["--project-root", root], {
      env: { DEFT_PROJECT_PATH: malformedPath },
    });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("configured PROJECT-DEFINITION is not valid JSON");
    expect(malformed.stderr).not.toContain("secret-token");
    expect(malformed.stderr.length).toBeLessThan(1_000);
  });

  it("keeps namespaced state as a no-op and migrates legacy-only state", async () => {
    const namespacedRoot = project({
      namespaced: { allowDirectCommitsToMaster: false, wipCap: 8 },
    });
    const keep = await runDeftTs("policy:enforce-branches", ["--project-root", namespacedRoot]);
    expect(keep.exitCode, keep.stderr).toBe(0);
    expect(keep.stdout).toContain("no-op");
    expect(existsSync(join(namespacedRoot, "meta", "policy-changes.log"))).toBe(false);

    const legacyRoot = project({ legacy: { allowDirectCommitsToMaster: false, wipCap: 6 } });
    const legacyPath = join(legacyRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const baseMerge = JSON.parse(readFileSync(legacyPath, "utf8")) as {
      plan: Record<string, unknown>;
    };
    (baseMerge.plan.narratives as Record<string, unknown>).Overview = "Confirmed setup update";
    writeFileSync(legacyPath, `${JSON.stringify(baseMerge, null, 2)}\n`, "utf8");
    expect(planAt(legacyRoot).policy).toEqual({
      allowDirectCommitsToMaster: false,
      wipCap: 6,
    });
    const migrate = await runDeftTs("policy:enforce-branches", ["--project-root", legacyRoot]);
    expect(migrate.exitCode, migrate.stderr).toBe(0);
    const migratedPlan = planAt(legacyRoot);
    expect(migratedPlan.policy).toBeUndefined();
    expect(migratedPlan["x-directive/policy"]).toMatchObject({
      allowDirectCommitsToMaster: false,
      wipCap: 6,
    });
  });

  it("returns config error and preserves bytes for every dual-block state", async () => {
    for (const legacyValue of [false, true]) {
      const root = project({
        namespaced: { allowDirectCommitsToMaster: false, wipCap: 8 },
        legacy: { allowDirectCommitsToMaster: legacyValue, triageScope: [] },
      });
      const definitionPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
      const before = readFileSync(definitionPath, "utf8");
      const result = await runDeftTs("policy:enforce-branches", ["--project-root", root]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Config error");
      expect(result.stderr).toContain("explicitly resolve every collision");
      expect(result.stderr).toContain("delete `plan.policy`");
      expect(readFileSync(definitionPath, "utf8")).toBe(before);
      expect(existsSync(join(root, "meta", "policy-changes.log"))).toBe(false);
    }
  });
});
