import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScopeVbrief } from "./build.js";
import { DEPRECATION_SENTINEL } from "./constants.js";
import { pythonJsonPretty } from "./json.js";
import {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
  projectDefinitionPath,
} from "./project-definition-io.js";
import { buildScopeVbriefFromReconciled } from "./routing.js";
import {
  deriveOverviewNarrative,
  extractTechStack,
  firstProseParagraph,
  parseRoadmapItems,
  resolveRepoUrl,
} from "./sources.js";
import { createSpeckitScopeVbrief, migrateSpeckitPlan } from "./speckit.js";

describe("branch coverage helpers", () => {
  it("covers sources resolver and overview fallbacks", () => {
    expect(
      deriveOverviewNarrative({ plan: { narratives: { Overview: 123 } } }, null, null, 0),
    ).toContain("Project overview was not auto-derived");
    expect(deriveOverviewNarrative({ plan: { narratives: "bad" } }, null, null, 0)).toContain(
      "Project overview was not auto-derived",
    );
    expect(deriveOverviewNarrative(null, `# Spec\n${DEPRECATION_SENTINEL}\n`, null, 0)).toContain(
      "Project overview was not auto-derived",
    );
    expect(resolveRepoUrl({ vBRIEFInfo: { repository: "" } })).toBe("");
    expect(
      resolveRepoUrl({ plan: { references: [null, { uri: "https://github.com/only" }] } }),
    ).toBe("");
    // Oracle parity: the heading's ``\s*\n`` consumes the blank lines, so the
    // remainder "## Next" has no leading "\n" for the "\n##\s" terminator and is
    // captured to \Z. Confirmed against scripts/_vbrief_sources.py (returns
    // "## Next"). The prior "" assertion encoded the \Z-mistranslation bug.
    expect(extractTechStack("## Tech Stack\n\n\n## Next")).toBe("## Next");
  });

  it("covers roadmap parsing branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-br-"));
    writeFileSync(
      join(root, "ROADMAP.md"),
      [
        "## Phase Z",
        "",
        "Intro",
        "",
        "### Tier A",
        "",
        "- **#7** -- Seven",
        "",
        "## Completed",
        "",
        "- ~~Done without number~~",
      ].join("\n"),
      "utf8",
    );
    const parsed = parseRoadmapItems(join(root, "ROADMAP.md"));
    expect(parsed.items[0]?.tier).toBe("Tier A");
    expect(parsed.completedItems[0]?.number).toBe("");
    rmSync(root, { recursive: true, force: true });
  });

  it("covers prose, build, routing, and speckit branches", () => {
    expect(firstProseParagraph("Line one.\n- bullet\n")).toBe("Line one.");
    expect(firstProseParagraph("Only paragraph.\n")).toBe("Only paragraph.");
    expect(firstProseParagraph("> quote\n\nReal text.\n")).toBe("Real text.");
    expect(firstProseParagraph("| table |\n\nReal text.\n")).toBe("Real text.");
    expect(createScopeVbrief({ number: "1", title: "T", phase: "P" }, "   ")).toBeTruthy();
    expect(
      buildScopeVbriefFromReconciled({
        title: "T",
        folder: "pending",
        references: [
          "bad",
          { uri: "https://github.com/a/b/issues/2", type: "x-vbrief/github-issue" },
        ],
      }),
    ).toBeTruthy();
    expect(
      createSpeckitScopeVbrief(
        {
          title: "IP-1",
          narrative: {
            Summary: "From summary",
            Phase: "   ",
            PhaseDescription: "PD",
            Tier: "T1",
            Acceptance: "  ",
            Traces: "",
          },
          references: [
            { type: "x-vbrief/plan", uri: "dup" },
            { type: "x-vbrief/web-page", uri: "u" },
          ],
        },
        { ipIndex: 1, dependencies: [], specRef: "specification.vbrief.json" },
      ),
    ).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "vb-br-sp-"));
    const planPath = join(root, "plan.vbrief.json");
    writeFileSync(
      planPath,
      pythonJsonPretty({
        plan: { title: "", items: [{ id: "ip-1", title: "IP-1: X" }], edges: "not-array" },
      }),
      "utf8",
    );
    expect(migrateSpeckitPlan(planPath, { date: "2026-06-01" })[0]).toBe(true);
    writeFileSync(
      planPath,
      pythonJsonPretty({
        vBRIEFInfo: "bad",
        plan: { items: [{ id: "ip-2", title: "IP-2: Y" }] },
      }),
      "utf8",
    );
    expect(migrateSpeckitPlan(planPath, { today: "2026-06-02" })[0]).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers additional roadmap and atomic write error cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-br-more-"));
    writeFileSync(
      join(root, "ROADMAP.md"),
      "## Phase Q\n\nDesc\n\n-\n\n- **#8** -- Eight\n",
      "utf8",
    );
    expect(parseRoadmapItems(join(root, "ROADMAP.md")).phaseDescriptions["Phase Q"]).toBe("Desc");
    writeFileSync(join(root, "blocked"), "x", "utf8");
    expect(() =>
      atomicWriteProjectDefinition(join(root, "blocked", "PROJECT-DEFINITION.vbrief.json"), {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T" },
      }),
    ).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project-definition lock sidecar and atomic write", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-br-pd-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const path = projectDefinitionPath(root);
    writeFileSync(
      path,
      pythonJsonPretty({ vBRIEFInfo: { version: "0.6" }, plan: { title: "T", items: [] } }),
      "utf8",
    );
    writeFileSync(`${path}.lock`, "\0", "utf8");
    projectDefinitionMutationLock(root, () => {
      const [data, pdPath] = loadProjectDefinitionForMutation(root);
      atomicWriteProjectDefinition(pdPath, data);
    });
    expect(readFileSync(path, "utf8")).toContain('"title": "T"');
    rmSync(root, { recursive: true, force: true });
  });
});
