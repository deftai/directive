import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSIST_SESSION_POSTURE_ENV,
  decideHook,
  type HookPolicySeams,
} from "../hooks/dispatcher.js";
import { writePhase2NarrativesMain } from "../render/phase2-narratives-cli.js";
import { storePhase2Narratives } from "../render/project-render.js";
import { runSessionStartHookWrite } from "../session/session-start-hook.js";
import { PHASE2_NARRATIVE_KEYS, type Phase2Narratives } from "./phase2-narratives.js";
import { projectDefinitionPath } from "./project-definition-io.js";

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

function readySeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => ({
      ready: true,
      path: "/project/xbrief/active/story.xbrief.json",
      message: "OK active scope",
    }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    ...overrides,
  };
}

const NARRATIVES: Phase2Narratives = {
  Overview: "A sample project",
  TechStack: "Library using TypeScript — vitest",
  Strategy: "Use interview for this project",
  Quality: "Run task check before every commit. Achieve >= 90% coverage.",
  ProjectRules: "No project-specific rules defined.",
  Branching: "Branch-based workflow (default)",
};

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "phase2-narratives-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  writeFileSync(join(root, "xbrief", "active", ".gitkeep"), "", "utf8");
  return root;
}

function readArtifact(root: string): Record<string, unknown> {
  const path = projectDefinitionPath(root);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function planOf(doc: Record<string, unknown>): Record<string, unknown> {
  return doc.plan as Record<string, unknown>;
}

describe("Phase 2 narrative writer (#4663)", () => {
  it("stores the six strings while xbrief/active is empty and sets no policy keys", () => {
    const root = tempProject();
    const [ok, message] = storePhase2Narratives(root, {
      narratives: NARRATIVES,
      title: "Sample",
    });
    expect(ok).toBe(true);
    expect(message).toContain("created");
    const doc = readArtifact(root);
    const plan = planOf(doc);
    expect(plan.narratives).toEqual(NARRATIVES);
    expect(plan.title).toBe("Sample");
    expect(plan.items).toEqual([]);
    expect(plan.policy).toBeUndefined();
    expect(plan["x-directive/policy"]).toBeUndefined();
    expect(Object.keys(plan.narratives as object).sort()).toEqual(
      [...PHASE2_NARRATIVE_KEYS].sort(),
    );
    const activeNames = ["xbrief", "active", ".gitkeep"];
    expect(readFileSync(join(root, ...activeNames), "utf8")).toBe("");
  });

  it("updates narratives on an existing file and leaves policy and other keys untouched", () => {
    const root = tempProject();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "proposed", "2026-09-22-sample.xbrief.json"),
      "{}\n",
      "utf8",
    );
    const existing = {
      xBRIEFInfo: { version: "0.8", description: "keep" },
      plan: {
        title: "Keep title",
        status: "running",
        narratives: { Overview: "old", Architecture: "keep me" },
        items: [],
        policy: { wipCap: 7, allowDirectCommitsToMaster: true },
        "x-directive/policy": { allowDirectCommitsToMaster: false, wipCap: 4 },
      },
    };
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify(existing, null, 2)}\n`,
      "utf8",
    );
    const [ok] = storePhase2Narratives(root, { narratives: NARRATIVES });
    expect(ok).toBe(true);
    const plan = planOf(readArtifact(root));
    expect(plan.narratives).toEqual({ ...NARRATIVES, Architecture: "keep me" });
    expect(plan.title).toBe("Keep title");
    expect(plan.items).toEqual([]);
    expect(plan.policy).toEqual({ wipCap: 7, allowDirectCommitsToMaster: true });
    expect(plan["x-directive/policy"]).toEqual({
      allowDirectCommitsToMaster: false,
      wipCap: 4,
    });
    expect(readArtifact(root).xBRIEFInfo).toEqual(existing.xBRIEFInfo);
  });

  it("honors DEFT_PROJECT_PATH and does not write the canonical artifact", () => {
    const root = tempProject();
    const previous = process.env.DEFT_PROJECT_PATH;
    process.env.DEFT_PROJECT_PATH = "custom/IDENTITY.xbrief.json";
    try {
      const [ok] = storePhase2Narratives(root, { narratives: NARRATIVES });
      expect(ok).toBe(true);
      const written = readArtifact(root);
      expect(projectDefinitionPath(root)).toBe(resolve(root, "custom", "IDENTITY.xbrief.json"));
      expect(planOf(written).narratives).toEqual(NARRATIVES);
      expect(planOf(written).policy).toBeUndefined();
      expect(planOf(written)["x-directive/policy"]).toBeUndefined();
      expect(() =>
        readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
      ).toThrow();
    } finally {
      if (previous === undefined) delete process.env.DEFT_PROJECT_PATH;
      else process.env.DEFT_PROJECT_PATH = previous;
    }
  });

  it("does not copy policy keys out of a narratives document", () => {
    const root = tempProject();
    const file = join(root, "narratives.json");
    writeFileSync(
      file,
      JSON.stringify({
        plan: {
          title: "From file",
          narratives: NARRATIVES,
          policy: { allowDirectCommitsToMaster: true },
          "x-directive/policy": { allowDirectCommitsToMaster: true },
        },
      }),
      "utf8",
    );
    expect(writePhase2NarrativesMain(["--project-root", root, "--narratives-file", file])).toBe(0);
    const plan = planOf(readArtifact(root));
    expect(plan.title).toBe("From file");
    expect(plan.narratives).toEqual(NARRATIVES);
    expect(plan.policy).toBeUndefined();
    expect(plan["x-directive/policy"]).toBeUndefined();
  });
});

describe("PROJECT-DEFINITION agent patch denials stay (#4663)", () => {
  const target = "xbrief/PROJECT-DEFINITION.xbrief.json";
  const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`;

  it("denies an agent patch under requirements posture with write-requirements-out-of-class", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "ApplyPatch", tool_input: { path: target, patch } },
        environ: { [ASSIST_SESSION_POSTURE_ENV]: "requirements" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({
      verdict: "deny",
      code: "write-requirements-out-of-class",
    });
    expect(decision.message).toContain("requirements posture does not authorize this path");
  });

  it("denies the same patch under mutation posture with an empty active set as scope-not-ready", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "ApplyPatch", tool_input: { path: target, patch } },
        environ: { [ASSIST_SESSION_POSTURE_ENV]: "mutation" },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message:
            "No active xBRIEF artifact was found under xbrief/active/ (or the legacy vbrief/active/ compatibility path).",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("No active xBRIEF artifact was found under xbrief/active/");
  });

  it("does not classify the deft writer command as an agent patch", () => {
    const command =
      "deft project:write-narratives --project-root . --narratives-file narratives.json";
    for (const posture of ["requirements", "mutation"] as const) {
      const decision = decideHook(
        {
          host: "grok",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
          environ: { [ASSIST_SESSION_POSTURE_ENV]: posture },
        },
        readySeams({
          inspectScope: () => ({
            ready: false,
            path: null,
            message: "No active xBRIEF artifact was found under xbrief/active/",
          }),
        }),
      );
      expect(decision.verdict).toBe("allow");
      expect(decision.code).toBe("shell-op-unclassifiable");
      expect(decision.code).not.toBe("write-requirements-out-of-class");
      expect(decision.code).not.toBe("scope-not-ready");
    }
  });
});

describe("Phase 2 narrative writer edges (#4663)", () => {
  it("rejects a non-object narratives file and does not create the artifact", () => {
    const root = tempProject();
    const file = join(root, "narratives.json");
    writeFileSync(file, "[]\n", "utf8");
    expect(writePhase2NarrativesMain(["--project-root", root, "--narratives-file", file])).toBe(2);
    expect(() => readArtifact(root)).toThrow();
  });

  it("rejects a missing narrative string and leaves an existing artifact unchanged", () => {
    const root = tempProject();
    const artifact = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    writeFileSync(artifact, '{"plan":{"title":"stay"}}\n', "utf8");
    const file = join(root, "narratives.json");
    const partial = { ...NARRATIVES, Quality: 1 };
    writeFileSync(file, JSON.stringify(partial), "utf8");
    expect(writePhase2NarrativesMain(["--project-root", root, "--narratives-file", file])).toBe(2);
    expect(readFileSync(artifact, "utf8")).toContain('"stay"');
  });

  it("reports usage, missing file, and invalid JSON", () => {
    expect(writePhase2NarrativesMain(["--help"])).toBe(0);
    expect(writePhase2NarrativesMain(["-h"])).toBe(0);
    expect(writePhase2NarrativesMain(["--narratives-file"])).toBe(2);
    expect(writePhase2NarrativesMain(["--project-root"])).toBe(2);
    expect(writePhase2NarrativesMain(["--title"])).toBe(2);
    expect(writePhase2NarrativesMain(["--narratives-file="])).toBe(2);
    expect(writePhase2NarrativesMain(["--bogus"])).toBe(2);
    const root = tempProject();
    expect(
      writePhase2NarrativesMain([
        "--project-root",
        root,
        "--narratives-file",
        join(root, "missing.json"),
      ]),
    ).toBe(2);
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{", "utf8");
    expect(writePhase2NarrativesMain(["--project-root", root, "--narratives-file", bad])).toBe(2);
  });

  it("lets --title override a document title and accepts equals-form flags", () => {
    const root = tempProject();
    const file = join(root, "narratives.json");
    writeFileSync(
      file,
      JSON.stringify({ plan: { title: "From file", narratives: NARRATIVES } }),
      "utf8",
    );
    expect(
      writePhase2NarrativesMain([
        `--project-root=${root}`,
        `--narratives-file=${file}`,
        "--title",
        "Override",
      ]),
    ).toBe(0);
    expect(planOf(readArtifact(root)).title).toBe("Override");
  });

  it("refuses a non-object plan or narratives block without persisting", () => {
    const root = tempProject();
    const artifact = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    writeFileSync(artifact, '{"plan":[]}\n', "utf8");
    expect(storePhase2Narratives(root, { narratives: NARRATIVES })[0]).toBe(false);
    expect(readFileSync(artifact, "utf8")).toBe('{"plan":[]}\n');
    writeFileSync(artifact, '{"plan":{"narratives":[]}}\n', "utf8");
    expect(storePhase2Narratives(root, { narratives: NARRATIVES })[0]).toBe(false);
    expect(readFileSync(artifact, "utf8")).toBe('{"plan":{"narratives":[]}}\n');
  });

  it("fills a missing plan and uses the legacy envelope for a vbrief path", () => {
    const root = tempProject();
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}\n", "utf8");
    const [ok] = storePhase2Narratives(root, { narratives: NARRATIVES, title: "Named" });
    expect(ok).toBe(true);
    const plan = planOf(readArtifact(root));
    expect(plan.title).toBe("Named");
    expect(plan.narratives).toEqual(NARRATIVES);

    const previous = process.env.DEFT_PROJECT_PATH;
    process.env.DEFT_PROJECT_PATH = "custom/IDENTITY.vbrief.json";
    try {
      const legacyRoot = tempProject();
      const [created] = storePhase2Narratives(legacyRoot, { narratives: NARRATIVES });
      expect(created).toBe(true);
      const doc = readArtifact(legacyRoot) as { vBRIEFInfo?: { version?: string } };
      expect(doc.vBRIEFInfo?.version).toBe("0.8");
      expect(planOf(doc).policy).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DEFT_PROJECT_PATH;
      else process.env.DEFT_PROJECT_PATH = previous;
    }
  });

  it("returns failure when the captured artifact cannot be parsed", () => {
    const root = tempProject();
    const artifact = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    mkdirSync(artifact);
    expect(storePhase2Narratives(root, { narratives: NARRATIVES })[0]).toBe(false);
    const file = join(root, "narratives.json");
    writeFileSync(file, JSON.stringify(NARRATIVES), "utf8");
    expect(writePhase2NarrativesMain(["--project-root", root, "--narratives-file", file])).toBe(1);
  });
});

describe("session start with an empty active set (#4663)", () => {
  it("stays exit 0 when xbrief/active has no scope artifact", () => {
    const root = tempProject();
    const writeSentinelFn = vi.fn(() => {
      throw new Error("sentinel must not run with no active xBRIEF");
    });
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "feat/x",
      writeSentinelFn,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(writeSentinelFn).not.toHaveBeenCalled();
  });
});
