import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ingestModule from "../intake/issue-ingest.js";
import * as reconcileModule from "../intake/reconcile-issues.js";
import { PRD_GENERATED_SENTINEL } from "../render/constants.js";
import { renderPrd } from "../render/prd-render.js";
import * as scmCall from "../scm/call.js";
import { lifecycleMain } from "../scope/main.js";
import * as scopeContext from "../scope/project-context.js";
import * as sliceContext from "../slice/project-context.js";
import {
  createConsumerProject,
  dispatchTaskCheck,
  makeTempRoot,
  writeScopeVbrief,
} from "./helpers.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

describe("integration-e2e consumer tasks (mirrors test_consumer_tasks.py)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatch_task_check routes vendored install to check:consumer", () => {
    const parent = makeTempRoot("deft-consumer-dispatch-");
    const consumer = createConsumerProject(parent);
    const frameworkRoot = join(consumer, ".deft", "core");
    mkdirSync(frameworkRoot, { recursive: true });
    writeFileSync(join(frameworkRoot, "Taskfile.yml"), "version: '3'\n", "utf8");

    const calls: Array<{ command: string; projectRoot: string; frameworkRoot: string }> = [];
    const rc = dispatchTaskCheck(frameworkRoot, consumer, (command, projectRoot, framework) => {
      calls.push({ command, projectRoot, frameworkRoot: framework });
      return { code: 0 };
    });
    expect(rc).toBe(0);
    expect(calls).toEqual([{ command: "check:consumer", projectRoot: consumer, frameworkRoot }]);
  });

  it("dispatch_task_check keeps symlinked core on consumer gate", () => {
    const parent = makeTempRoot("deft-consumer-symlink-");
    const consumer = createConsumerProject(parent);
    const frameworkRoot = join(consumer, ".deft", "core");
    mkdirSync(join(consumer, ".deft"), { recursive: true });
    try {
      symlinkSync(consumer, frameworkRoot, "dir");
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (message.includes("EPERM") || message.includes("not supported")) {
        return;
      }
      throw exc;
    }

    const calls: string[] = [];
    const rc = dispatchTaskCheck(frameworkRoot, consumer, (command) => {
      calls.push(command);
      return { code: 0 };
    });
    expect(rc).toBe(0);
    expect(calls).toEqual(["check:consumer"]);
  });

  it("dispatch_task_check routes source checkout to check:framework-source", () => {
    const calls: string[] = [];
    const rc = dispatchTaskCheck(repoRoot, repoRoot, (command) => {
      calls.push(command);
      return { code: 0 };
    });
    expect(rc).toBe(0);
    expect(calls).toEqual(["check:framework-source"]);
  });

  it("scope promote resolves against consumer --project-root", () => {
    const parent = makeTempRoot("deft-consumer-scope-");
    const consumer = createConsumerProject(parent);
    writeScopeVbrief(consumer, "proposed", "2026-04-22-fixture.vbrief.json");
    const unrelated = join(parent, "elsewhere");
    mkdirSync(unrelated, { recursive: true });

    const prevCwd = process.cwd();
    process.chdir(unrelated);
    try {
      const rc = lifecycleMain([
        "promote",
        "vbrief/proposed/2026-04-22-fixture.vbrief.json",
        "--project-root",
        consumer,
      ]);
      expect(rc).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }

    expect(existsSync(join(consumer, "vbrief", "pending", "2026-04-22-fixture.vbrief.json"))).toBe(
      true,
    );
    expect(existsSync(join(repoRoot, "vbrief", "proposed", "2026-04-22-fixture.vbrief.json"))).toBe(
      false,
    );
  });

  it("scope promote fails loudly without project root", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "deft-isolated-"));
    const elsewhere = join(isolatedRoot, "no_project_here");
    mkdirSync(elsewhere, { recursive: true });
    const prevCwd = process.cwd();
    const prevRoot = process.env.DEFT_PROJECT_ROOT;
    delete process.env.DEFT_PROJECT_ROOT;
    vi.spyOn(scopeContext, "resolveProjectRoot").mockReturnValue(null);
    process.chdir(elsewhere);
    const stderr: string[] = [];
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const rc = lifecycleMain(["promote", "vbrief/proposed/missing.vbrief.json"]);
      expect(rc).toBe(2);
      expect(stderr.join("").toLowerCase()).toContain("project root");
    } finally {
      process.stderr.write = prevErr;
      process.chdir(prevCwd);
      if (prevRoot !== undefined) process.env.DEFT_PROJECT_ROOT = prevRoot;
    }
  });

  it("issue ingest writes into consumer vbrief tree", () => {
    const parent = makeTempRoot("deft-consumer-ingest-");
    const consumer = createConsumerProject(parent);

    const result = ingestModule.ingestOne(
      {
        number: 101,
        title: "Consumer fixture issue",
        url: "https://github.com/owner/consumer/issues/101",
        labels: [],
      },
      {
        vbriefDir: join(consumer, "vbrief"),
        status: "proposed",
        repoUrl: "https://github.com/owner/consumer",
      },
    );
    expect(result[0]).toBe("created");

    const files = readdirSync(join(consumer, "vbrief", "proposed")).filter((f) =>
      f.endsWith(".vbrief.json"),
    );
    expect(files.length).toBeGreaterThan(0);
    const payload = JSON.parse(
      readFileSync(join(consumer, "vbrief", "proposed", files[0] as string), "utf8"),
    ) as {
      vBRIEFInfo: { version: string };
      plan: { references: Array<Record<string, unknown>> };
    };
    expect(payload.vBRIEFInfo.version).toBe("0.6");
    const ref = payload.plan.references[0];
    expect(ref?.uri).toBe("https://github.com/owner/consumer/issues/101");
    expect(ref?.type).toBe("x-vbrief/github-issue");
    expect(ref?.title).toBe("Issue #101: Consumer fixture issue");
    expect(ref).not.toHaveProperty("url");
    expect(ref).not.toHaveProperty("id");
  });

  it("issue ingest fails loudly without repo", () => {
    const parent = makeTempRoot("deft-consumer-ingest-fail-");
    const consumer = createConsumerProject(parent);
    vi.spyOn(sliceContext, "resolveProjectRepo").mockReturnValue(null);
    vi.spyOn(reconcileModule, "detectRepo").mockReturnValue(null);

    const stderr: string[] = [];
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const rc = ingestModule.issueIngestMain({
        number: 1,
        vbriefDir: join(consumer, "vbrief"),
        projectRoot: consumer,
      });
      expect(rc).toBe(2);
      expect(stderr.join("")).toContain("could not detect repo");
      expect(stderr.join("")).toContain("#538");
    } finally {
      process.stderr.write = prevErr;
    }
  });

  it("reconcile issues uses consumer repo slug", () => {
    const parent = makeTempRoot("deft-consumer-reconcile-");
    const consumer = createConsumerProject(parent);
    writeFileSync(
      join(consumer, "vbrief", "proposed", "2026-04-22-reconcile-fixture.vbrief.json"),
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "Reconcile fixture",
            status: "proposed",
            references: [
              {
                type: "x-vbrief/github-issue",
                uri: "https://github.com/owner/consumer/issues/42",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    vi.spyOn(scmCall, "call").mockReturnValue({
      returncode: 0,
      stdout: JSON.stringify({
        data: { repository: { i42: { state: "OPEN", stateReason: null } } },
      }),
      stderr: "",
    });

    const rc = reconcileModule.reconcileMain({
      vbriefDir: join(consumer, "vbrief"),
      projectRoot: consumer,
      repo: "owner/consumer",
    });
    expect(rc).toBe(0);
    expect(scmCall.call).toHaveBeenCalled();
    const firstCall = vi.mocked(scmCall.call).mock.calls[0];
    expect(firstCall?.[2]).toEqual(expect.arrayContaining(["graphql"]));
    expect(firstCall?.[3]?.cwd).toBe(consumer);
  });

  it("prd render writes consumer PRD output", () => {
    const parent = makeTempRoot("deft-consumer-prd-");
    const consumer = createConsumerProject(parent);
    const output = join(consumer, "PRD.md");
    renderPrd(join(consumer, "vbrief", "specification.vbrief.json"), output);
    expect(existsSync(output)).toBe(true);
    const content = readFileSync(output, "utf8");
    expect(content).toContain(PRD_GENERATED_SENTINEL);
    expect(content).toContain("Consumer Project");
  });

  it("prd render refuses to clobber hand-authored output", () => {
    const parent = makeTempRoot("deft-consumer-prd-refuse-");
    const consumer = createConsumerProject(parent);
    const handAuthored = join(parent, "hand_authored_PRD.md");
    writeFileSync(
      handAuthored,
      "# Hand-authored PRD\nThis file was not generated by deft.\n",
      "utf8",
    );

    const stderr: string[] = [];
    const prevErr = process.stderr.write.bind(process.stderr);
    const prevExit = process.exit;
    let exitCode: number | null = null;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit;
    try {
      expect(() =>
        renderPrd(join(consumer, "vbrief", "specification.vbrief.json"), handAuthored),
      ).toThrow(/process.exit:2/);
      expect(exitCode).toBe(2);
      expect(stderr.join("").toLowerCase()).toContain("refusing to overwrite");
      expect(readFileSync(handAuthored, "utf8")).toContain("Hand-authored PRD");
    } finally {
      process.stderr.write = prevErr;
      process.exit = prevExit;
    }
  });
});
