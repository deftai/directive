import { join, resolve } from "node:path";
import type { ResolutionFacts, ResolutionPlan } from "@deftai/directive-types";
import { RESOLUTION_PLAN_SCHEMA_VERSION } from "@deftai/directive-types";
import { describe, expect, it, vi } from "vitest";
import type { ClassifySeams } from "../resolution/index.js";
import {
  buildInitDispatchDryRunJson,
  classifyInitDispatch,
  decideInitDispatch,
  type InitDispatchSeams,
  initDispatchNextAction,
  printInitDispatchSummary,
  runInitDispatchCli,
  UPDATE_DELEGATION_DISCLOSURE,
} from "./init-dispatch.js";

const CWD = "/proj";

interface VirtualFs {
  dirs: Set<string>;
  files: Map<string, string>;
}

function emptyFs(): VirtualFs {
  return { dirs: new Set(), files: new Map() };
}

function classifySeamsFor(vfs: VirtualFs, extra: Partial<ClassifySeams> = {}): ClassifySeams {
  return {
    isDir: (p: string) => vfs.dirs.has(p),
    isFile: (p: string) => vfs.files.has(p),
    readText: (p: string) => vfs.files.get(p) ?? null,
    engineProbe: () => ({ reachable: false, version: null }),
    preCutoverProbe: () => false,
    ...extra,
  };
}

const AGENTS_WITH_SHA =
  "# AGENTS\n<!-- deft:managed-section v3 sha=abc123def456 refreshed=2026-07-03T00:00:00Z session=deadbeef -->\nbody\n<!-- /deft:managed-section -->\n";

/** An empty greenfield directory (no app code, no deposit). */
function scaffoldFs(): VirtualFs {
  return emptyFs();
}

/** App code present, no Directive deposit. */
function brownfieldFs(): VirtualFs {
  const vfs = emptyFs();
  vfs.files.set(join(CWD, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  return vfs;
}

/** An already-initialized + current install (deposit, managed section, pin, engine matched). */
function currentInstallFs(): VirtualFs {
  const vfs = emptyFs();
  vfs.dirs.add(join(CWD, ".deft/core"));
  vfs.dirs.add(join(CWD, "xbrief"));
  vfs.files.set(join(CWD, "AGENTS.md"), AGENTS_WITH_SHA);
  vfs.files.set(join(CWD, ".deft/core", "VERSION"), "tag: 'v0.65.0'\n");
  vfs.files.set(
    join(CWD, "package.json"),
    JSON.stringify({ private: true, devDependencies: { "@deftai/directive": "0.65.0" } }),
  );
  return vfs;
}

/** An initialized install whose deposited content is behind the committed pin. */
function staleInstallFs(): VirtualFs {
  const vfs = currentInstallFs();
  vfs.files.set(join(CWD, ".deft/core", "VERSION"), "tag: 'v0.60.0'\n");
  return vfs;
}

function currentSeams(vfs: VirtualFs): ClassifySeams {
  return classifySeamsFor(vfs, { engineProbe: () => ({ reachable: true, version: "0.65.0" }) });
}

function makeFacts(overrides: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    hasGit: false,
    hasAppCode: false,
    hasDeftCore: false,
    deftCorePayloadVersion: null,
    hasManagedSection: false,
    managedSectionSha: null,
    hasVbrief: false,
    hasXbrief: false,
    preCutoverArtifacts: false,
    engineReachable: false,
    engineVersion: null,
    pinVersion: null,
    ...overrides,
  };
}

function makePlan(mode: ResolutionPlan["mode"]): ResolutionPlan {
  return {
    schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
    mode,
    files: [],
    nextAction: { command: null, rootCause: `mode ${mode}`, remediation: `remediate ${mode}` },
    warnings: [],
  };
}

interface Recorder {
  scaffold: number;
  refresh: number;
  migrate: number;
  refreshArgs: unknown[];
  migrateArgs: unknown[];
}

function seamsWithRecorder(classifySeams: ClassifySeams): {
  seams: InitDispatchSeams;
  rec: Recorder;
} {
  const rec: Recorder = {
    scaffold: 0,
    refresh: 0,
    migrate: 0,
    refreshArgs: [],
    migrateArgs: [],
  };
  const seams: InitDispatchSeams = {
    classifySeams,
    runScaffold: async () => {
      rec.scaffold += 1;
      return 0;
    },
    runRefresh: async (options) => {
      rec.refresh += 1;
      rec.refreshArgs.push(options);
      return 0;
    },
    runMigrate: (options) => {
      rec.migrate += 1;
      rec.migrateArgs.push(options);
      return 0;
    },
  };
  return { seams, rec };
}

function captureIo(): {
  writeOut: (t: string) => void;
  writeErr: (t: string) => void;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
  };
}

describe("decideInitDispatch (#2265 a1)", () => {
  it("routes pre-cutover/migrate mode to route-migrate", () => {
    expect(decideInitDispatch(makeFacts({ preCutoverArtifacts: true }), makePlan("migrate"))).toBe(
      "route-migrate",
    );
  });

  it("routes an empty greenfield dir (init mode, no app code) to scaffold", () => {
    expect(decideInitDispatch(makeFacts(), makePlan("init"))).toBe("scaffold");
  });

  it("routes a brownfield dir (init mode, app code present) to brownfield-install", () => {
    expect(decideInitDispatch(makeFacts({ hasAppCode: true }), makePlan("init"))).toBe(
      "brownfield-install",
    );
    expect(decideInitDispatch(makeFacts({ hasGit: true }), makePlan("init"))).toBe(
      "brownfield-install",
    );
  });

  it("delegates every deposit-present mode to update", () => {
    for (const mode of [
      "proceed",
      "update",
      "install-global",
      "install-sandbox",
      "install-staged",
      "blocked",
    ] as const) {
      expect(decideInitDispatch(makeFacts({ hasDeftCore: true }), makePlan(mode))).toBe(
        "delegate-update",
      );
    }
  });
});

describe("classifyInitDispatch (#2265 a1) — from an arbitrary cwd", () => {
  it("classifies empty -> scaffold", () => {
    expect(classifyInitDispatch(CWD, classifySeamsFor(scaffoldFs())).decision).toBe("scaffold");
  });

  it("classifies brownfield -> brownfield-install", () => {
    expect(classifyInitDispatch(CWD, classifySeamsFor(brownfieldFs())).decision).toBe(
      "brownfield-install",
    );
  });

  it("classifies already-current -> delegate-update", () => {
    expect(classifyInitDispatch(CWD, currentSeams(currentInstallFs())).decision).toBe(
      "delegate-update",
    );
  });

  it("classifies a stale install -> delegate-update", () => {
    const classification = classifyInitDispatch(CWD, currentSeams(staleInstallFs()));
    expect(classification.decision).toBe("delegate-update");
    expect(classification.plan.mode).toBe("update");
  });

  it("classifies pre-cutover -> route-migrate", () => {
    const seams = classifySeamsFor(scaffoldFs(), { preCutoverProbe: () => true });
    expect(classifyInitDispatch(CWD, seams).decision).toBe("route-migrate");
  });
});

describe("runInitDispatchCli delegation (#2265 a4 — single-sourced, no re-implementation)", () => {
  it("scaffold branch calls runInitDepositCli (scaffold), not update/migrate", async () => {
    const { seams, rec } = seamsWithRecorder(classifySeamsFor(scaffoldFs()));
    const io = captureIo();
    const code = await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: false,
      nonInteractive: true,
      dryRun: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    expect(code).toBe(0);
    expect(rec).toMatchObject({ scaffold: 1, refresh: 0, migrate: 0 });
    // No update disclosure on a scaffold path.
    expect(io.out.join("")).not.toContain(UPDATE_DELEGATION_DISCLOSURE);
  });

  it("brownfield branch also calls the scaffold deposit (support beside app code)", async () => {
    const { seams, rec } = seamsWithRecorder(classifySeamsFor(brownfieldFs()));
    const io = captureIo();
    await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: false,
      nonInteractive: true,
      dryRun: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    expect(rec).toMatchObject({ scaffold: 1, refresh: 0, migrate: 0 });
    expect(io.out.join("")).toContain("app source is left untouched");
  });

  it("already-current delegates to update WITH an explicit disclosure line (#2265 a2, no #2199 masquerade)", async () => {
    const { seams, rec } = seamsWithRecorder(currentSeams(currentInstallFs()));
    const io = captureIo();
    const code = await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: false,
      nonInteractive: true,
      dryRun: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    expect(code).toBe(0);
    expect(rec).toMatchObject({ scaffold: 0, refresh: 1, migrate: 0 });
    // Disclosure printed; refresh delegated with upgrade=false and resolved cwd.
    expect(io.out.join("")).toContain(UPDATE_DELEGATION_DISCLOSURE);
    expect(rec.refreshArgs[0]).toMatchObject({ projectDir: resolve(CWD), upgrade: false });
  });

  it("legacy/pre-cutover routes to migrate (runMigrateCli)", async () => {
    const classifySeams = classifySeamsFor(scaffoldFs(), { preCutoverProbe: () => true });
    const { seams, rec } = seamsWithRecorder(classifySeams);
    const io = captureIo();
    await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: false,
      nonInteractive: true,
      dryRun: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    expect(rec).toMatchObject({ scaffold: 0, refresh: 0, migrate: 1 });
    expect(rec.migrateArgs[0]).toMatchObject({ projectDir: resolve(CWD) });
    expect(io.out.join("")).toContain("routing to `migrate`");
  });
});

describe("runInitDispatchCli --dry-run/--plan (#2265 a5)", () => {
  it("prints the classified plan and executes nothing (human mode)", async () => {
    const { seams, rec } = seamsWithRecorder(currentSeams(currentInstallFs()));
    const io = captureIo();
    const code = await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: false,
      nonInteractive: true,
      dryRun: true,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    expect(code).toBe(0);
    expect(rec).toMatchObject({ scaffold: 0, refresh: 0, migrate: 0 });
    expect(io.out.join("")).toContain("State: already initialized");
  });

  it("emits a single JSON object on stdout in --json --dry-run mode", async () => {
    const { seams, rec } = seamsWithRecorder(currentSeams(currentInstallFs()));
    const io = captureIo();
    const code = await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: true,
      nonInteractive: true,
      dryRun: true,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    expect(code).toBe(0);
    expect(rec).toMatchObject({ scaffold: 0, refresh: 0, migrate: 0 });
    const parsed = JSON.parse(io.out.join("")) as Record<string, unknown>;
    expect(parsed).toMatchObject({ action: "init", dry_run: true, dispatch: "delegate-update" });
    // Human summary went to stderr, keeping stdout a single JSON object.
    expect(io.err.join("")).toContain("[directive init] State:");
  });
});

describe("runInitDispatchCli idempotency (#2265 a5)", () => {
  it("re-running init on an initialized dir delegates to update rather than re-scaffolding", async () => {
    const { seams, rec } = seamsWithRecorder(currentSeams(currentInstallFs()));
    const io = captureIo();
    for (let i = 0; i < 2; i += 1) {
      await runInitDispatchCli({
        projectDir: CWD,
        jsonOut: false,
        nonInteractive: true,
        dryRun: false,
        writeOut: io.writeOut,
        writeErr: io.writeErr,
        seams,
      });
    }
    // Never re-scaffolds; both runs delegate to update.
    expect(rec).toMatchObject({ scaffold: 0, refresh: 2, migrate: 0 });
  });
});

describe("json-mode single-object contract (delegate branch)", () => {
  it("keeps the state summary + disclosure on stderr so stdout stays the delegate's payload", async () => {
    const classifySeams = currentSeams(currentInstallFs());
    // Real delegate replaced by a fake that writes ONE json object to stdout,
    // mirroring runRefreshDepositCli's --json contract.
    const seams: InitDispatchSeams = {
      classifySeams,
      runRefresh: async (options) => {
        options.writeOut(`${JSON.stringify({ success: true, action: "upgrade" })}\n`);
        return 0;
      },
    };
    const io = captureIo();
    await runInitDispatchCli({
      projectDir: CWD,
      jsonOut: true,
      nonInteractive: true,
      dryRun: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams,
    });
    const parsed = JSON.parse(io.out.join("")) as Record<string, unknown>;
    expect(parsed).toMatchObject({ action: "upgrade" });
    expect(io.err.join("")).toContain(UPDATE_DELEGATION_DISCLOSURE);
  });
});

describe("initDispatchNextAction + buildInitDispatchDryRunJson", () => {
  it("produces a route-migrate next action that surfaces the plan remediation", () => {
    const action = initDispatchNextAction("route-migrate", makePlan("migrate"));
    expect(action).toContain("routing to `migrate`");
    expect(action).toContain("remediate migrate");
  });

  it("throws on an unknown decision (exhaustiveness guard)", () => {
    expect(() => initDispatchNextAction("bogus" as never, makePlan("init"))).toThrow(
      /unhandled init dispatch decision/,
    );
  });

  it("builds a dry-run payload from the classification", () => {
    const classification = classifyInitDispatch(CWD, currentSeams(currentInstallFs()));
    const json = buildInitDispatchDryRunJson(CWD, classification);
    expect(json).toMatchObject({
      action: "init",
      dry_run: true,
      dispatch: "delegate-update",
      mode: "proceed",
      project_dir: CWD,
    });
  });
});

describe("printInitDispatchSummary", () => {
  it("prints the state label, next action, and each plan warning", () => {
    const io = captureIo();
    const plan: ResolutionPlan = { ...makePlan("migrate"), warnings: ["legacy layout", "orphan"] };
    printInitDispatchSummary({ printf: io.writeOut }, "route-migrate", plan);
    const text = io.out.join("");
    expect(text).toContain("[directive init] State:");
    expect(text).toContain("[directive init] Note: legacy layout");
    expect(text).toContain("[directive init] Note: orphan");
  });
});

// Guard: the module must not silently import a process-exiting helper.
it("module surface stays importable without side effects", () => {
  expect(typeof runInitDispatchCli).toBe("function");
  expect(vi.isMockFunction(runInitDispatchCli)).toBe(false);
});
