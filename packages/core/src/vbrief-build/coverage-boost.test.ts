import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScopeVbrief, referenceWithDefaultTrust, setTodayForTests } from "./build.js";
import { pythonJsonPretty } from "./json.js";
import { cmdVbriefBuild, run } from "./main.js";
import * as parityScenarios from "./parity-scenarios.js";
import { runParityScenario } from "./parity-scenarios.js";
import {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
} from "./project-definition-io.js";
import {
  buildScopeVbriefFromReconciled,
  migrationTimestamp,
  planStatusMatchesFolder,
} from "./routing.js";
import {
  deriveOverviewNarrative,
  extractTechStack,
  firstProseParagraph,
  parseRoadmapItems,
  resolveRepoUrl,
} from "./sources.js";
import {
  createSpeckitScopeVbrief,
  dependenciesForItem,
  edgeNodes,
  migrateSpeckitPlan,
  speckitIpIndex,
  speckitIpSlug,
} from "./speckit.js";
import { ProjectDefinitionIOError } from "./types.js";

describe("vbrief-build coverage boost", () => {
  it("covers build edge branches", () => {
    setTodayForTests("2026-04-23");
    expect(
      createScopeVbrief({ number: "  ", title: "Bug" }, "https://github.com/o/r"),
    ).toBeTruthy();
    expect(
      createScopeVbrief({ number: "1", title: "Untitled" }, "https://github.com/o/r"),
    ).toBeTruthy();
    expect(referenceWithDefaultTrust({ type: "custom", uri: "x" })).toEqual({
      type: "custom",
      uri: "x",
    });
  });

  it("covers sources branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-boost-"));
    const roadmap = join(root, "ROADMAP.md");
    writeFileSync(
      roadmap,
      "## Phase A\n\nIntro line\n\n- plain item\n\n### Tier 1\n\n- **#1** -- One\n",
      "utf8",
    );
    expect(parseRoadmapItems(roadmap).items.length).toBeGreaterThan(0);
    expect(extractTechStack("## Tech Stack\n\nRust + TS\n\n## Other\n")).toBe("Rust + TS");
    expect(firstProseParagraph("# Title only\n")).toBe("Title only");
    expect(firstProseParagraph("Body only")).toBe("Body only");
    expect(firstProseParagraph("Body line\n# Next section\n\nLater")).toBe("Body line");
    expect(
      deriveOverviewNarrative({ plan: { narratives: { Overview: "  hi  " } } }, null, null, 0),
    ).toBe("hi");
    expect(resolveRepoUrl({ plan: { references: [{ uri: "not-a-url" }] } })).toBe("");
    rmSync(root, { recursive: true, force: true });
  });

  it("covers routing and speckit branches", () => {
    expect(planStatusMatchesFolder("pending", "active")).toBe(false);
    expect(planStatusMatchesFolder("running", "not-a-folder")).toBe(false);
    expect(migrationTimestamp()).toMatch(/Z$/);
    const bare = buildScopeVbriefFromReconciled({ title: "Bare", folder: "pending" });
    expect((bare.plan as Record<string, unknown>).metadata).toBeUndefined();
    expect(edgeNodes(null as never)).toEqual(["", ""]);
    expect(
      dependenciesForItem("x", [null as never, { type: "relates", from: "a", to: "x" }]),
    ).toEqual([]);
    expect(speckitIpSlug("", "")).toBe("ip-phase");
    expect(speckitIpIndex({ id: "no-digits", title: "No IP" }, 4)).toBe(4);
    expect(
      createSpeckitScopeVbrief(
        {
          title: "",
          narrative: "bad",
          references: [{ type: "x-vbrief/web-page", uri: "https://x" }],
        },
        { ipIndex: 2, dependencies: [], specRef: "specification.vbrief.json" },
      ),
    ).toBeTruthy();
  });

  it("covers project-definition-io error and lock branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-boost-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const path = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    writeFileSync(path, "not-json", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(ProjectDefinitionIOError);
    writeFileSync(path, "[]", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not a JSON object/);
    writeFileSync(
      path,
      pythonJsonPretty({ vBRIEFInfo: { version: "0.6" }, plan: { title: "T" } }),
      "utf8",
    );
    projectDefinitionMutationLock(root, () => {
      const [data, pdPath] = loadProjectDefinitionForMutation(root);
      atomicWriteProjectDefinition(pdPath, data);
    });
    expect(() =>
      projectDefinitionMutationLock(root, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    rmSync(root, { recursive: true, force: true });
  });

  it("covers migrateSpeckitPlan error branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-sp-boost-"));
    const missing = join(root, "missing.json");
    expect(migrateSpeckitPlan(missing)[0]).toBe(false);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const bad = join(root, "vbrief", "plan.vbrief.json");
    writeFileSync(bad, "{", "utf8");
    expect(migrateSpeckitPlan(bad)[1][0]).toContain("invalid JSON");
    writeFileSync(bad, pythonJsonPretty({ plan: { items: [] } }), "utf8");
    expect(migrateSpeckitPlan(bad)[0]).toBe(false);
    writeFileSync(bad, pythonJsonPretty({ plan: "not-an-object" }), "utf8");
    expect(migrateSpeckitPlan(bad)[0]).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers main CLI branches", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = mkdtempSync(join(tmpdir(), "vb-main-"));
    expect(run(["--scenario", "slugify-basic", "--fixture-root", root])).toBe(0);
    expect(run(["--all", "--fixture-root", root])).toBe(0);
    expect(cmdVbriefBuild(["--scenario", "missing-scenario"])).toBe(0);
    expect(cmdVbriefBuild(["--help"])).toBe(0);
    expect(cmdVbriefBuild(["--scenario"])).toBe(2);
    expect(cmdVbriefBuild(["--unexpected"])).toBe(2);
    stderr.mockRestore();
    stdout.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("covers cmd error path", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(parityScenarios, "runParityScenario").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(cmdVbriefBuild(["--scenario", "slugify-basic"])).toBe(2);
    stderr.mockRestore();
    vi.restoreAllMocks();
  });

  it("covers extended sources and routing branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-ext-"));
    writeFileSync(
      join(root, "ROADMAP.md"),
      "## Phase B\n\n- `task-1` task title\n\n- \n\n- bullet\n\n## Completed\n\n- ~~orphan~~\n",
      "utf8",
    );
    expect(parseRoadmapItems(join(root, "ROADMAP.md")).items.length).toBe(2);
    expect(extractTechStack("Tech Stack: Go")).toBe("Go");
    expect(firstProseParagraph("```\ncode\n```\n\nHello world.\n")).toBe("Hello world.");
    expect(deriveOverviewNarrative(null, null, "# Project\n\nFrom project md.\n", 0)).toBe(
      "From project md.",
    );
    expect(resolveRepoUrl({ plan: { references: [{ uri: "https://www.github.com/a/b" }] } })).toBe(
      "https://github.com/a/b",
    );
    const withRefs = buildScopeVbriefFromReconciled(
      {
        title: "T",
        folder: "pending",
        references: [{ uri: "https://github.com/a/b/issues/1", type: "x-vbrief/github-issue" }],
      },
      "",
    );
    expect((withRefs.plan as Record<string, unknown>).references).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers speckit narrative extras and migrate non-dict item", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-sp-extra-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    const planPath = join(vbrief, "plan.vbrief.json");
    writeFileSync(
      planPath,
      pythonJsonPretty({
        plan: {
          items: ["skip-me", { id: "ip-2", title: "IP-2: Next", narrative: { Phase: "P" } }],
        },
      }),
      "utf8",
    );
    const [ok] = migrateSpeckitPlan(planPath, {
      pendingDir: join(vbrief, "pending"),
      date: "2026-05-01",
    });
    expect(ok).toBe(true);
    expect(
      createSpeckitScopeVbrief(
        {
          title: "IP-3",
          narrative: { PhaseDescription: "desc", Tier: "t1", Summary: "sum" },
          references: [{ type: "x-vbrief/plan", uri: "dup" }],
        },
        { ipIndex: 3, dependencies: [], specRef: "specification.vbrief.json" },
      ),
    ).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });

  it("covers lock reentrancy guard", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-lock-"));
    expect(() =>
      projectDefinitionMutationLock(root, () => {
        projectDefinitionMutationLock(root, () => undefined);
      }),
    ).toThrow(/not reentrant/);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers unknown parity scenario payload", () => {
    const result = runParityScenario("not-real", {
      fixtureRoot: mkdtempSync(join(tmpdir(), "x-")),
    });
    expect(result.ok).toBe(false);
  });

  it("covers migrate skip-existing branch", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-sp-skip-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    const planPath = join(vbrief, "plan.vbrief.json");
    writeFileSync(
      planPath,
      pythonJsonPretty({
        vBRIEFInfo: { version: "0.5" },
        plan: { items: [{ id: "ip-1", title: "IP-1: Foundation" }] },
      }),
      "utf8",
    );
    writeFileSync(
      join(vbrief, "pending", "2026-04-23-ip001-foundation.vbrief.json"),
      pythonJsonPretty({ plan: { title: "existing" } }),
      "utf8",
    );
    const [, actions] = migrateSpeckitPlan(planPath, {
      pendingDir: join(vbrief, "pending"),
      today: "2026-04-23",
    });
    expect(actions[0]).toContain("SKIP");
    rmSync(root, { recursive: true, force: true });
  });

  it("covers empty prose and speckit plan edge shapes", () => {
    expect(firstProseParagraph("")).toBe("");
    const root = mkdtempSync(join(tmpdir(), "vb-sp-shape-"));
    const planPath = join(root, "plan.vbrief.json");
    writeFileSync(planPath, "null", "utf8");
    expect(migrateSpeckitPlan(planPath)[1][0]).toContain("no items");
    writeFileSync(
      planPath,
      pythonJsonPretty({ plan: { items: [{ title: "No id field" }] } }),
      "utf8",
    );
    mkdirSync(join(root, "pending"), { recursive: true });
    const [ok, actions] = migrateSpeckitPlan(planPath, {
      pendingDir: join(root, "pending"),
      date: "2026-06-01",
    });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.includes("CREATE"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
