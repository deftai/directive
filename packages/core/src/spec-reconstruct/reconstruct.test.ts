import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconstructSpecDraft, runSpecReconstructCli, writeSpecReconstructDraft } from "./reconstruct.js";

describe("spec-reconstruct (#1589 C1)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function setup(completed: Array<{ name: string; title: string; overview?: string; supersedes?: string }>) {
    root = mkdtempSync(join(tmpdir(), "spec-recon-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "proj", status: "proposed", narratives: { Overview: "o" } },
      }),
    );
    for (const c of completed) {
      writeFileSync(
        join(root, "xbrief", "completed", c.name),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            id: c.name.replace(/\.xbrief\.json$/, ""),
            title: c.title,
            status: "completed",
            narratives: { Overview: c.overview ?? c.title },
            metadata: c.supersedes !== undefined ? { supersedes: c.supersedes } : {},
          },
        }),
      );
    }
    return root;
  }

  it("emits draft-only candidate and never claims auto-promote", () => {
    setup([
      { name: "a.xbrief.json", title: "Feature alpha landing path" },
      {
        name: "b.xbrief.json",
        title: "Feature alpha landing path revised",
        supersedes: "a",
      },
    ]);
    const draft = reconstructSpecDraft(root, { adjudicationBudget: 1 });
    expect(draft.draftOnly).toBe(true);
    expect(draft.autoPromote).toBe(false);
    expect(draft.kind).toBe("deft.spec-reconstruct.draft.v1");
    expect(draft.requirements.length).toBe(2);
    expect(draft.requirements.some((r) => r.provenance.kind.length > 0)).toBe(true);
    expect(draft.requirements.every((r) => "intendedRequirement" in r && "observedBehavior" in r)).toBe(
      true,
    );
    const out = writeSpecReconstructDraft(root, draft);
    expect(out.replace(/\\/g, "/")).toContain("xbrief/.audit/spec-reconstruct-draft.json");
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.autoPromote).toBe(false);
  });

  it("advises greenfield interview when below sufficiency threshold", () => {
    setup([{ name: "one.xbrief.json", title: "Tiny corpus item" }]);
    const draft = reconstructSpecDraft(root, { sufficiencyThreshold: 20 });
    expect(draft.sufficiency.adviseGreenfieldInterview).toBe(true);
    expect(draft.sufficiency.authorityKind).toBe("greenfield");
  });

  it("defers conflicts past adjudication budget to pending-human-decisions", () => {
    setup([
      { name: "old.xbrief.json", title: "Shared long title for supersession heuristic aaa" },
      { name: "new.xbrief.json", title: "Shared long title for supersession heuristic aaa" },
    ]);
    const draft = reconstructSpecDraft(root, { adjudicationBudget: 0 });
    expect(draft.adjudication.deferredCount).toBeGreaterThan(0);
    expect(draft.pendingHumanDecisions.length).toBeGreaterThan(0);
  });

  it("CLI writes draft and reports draftOnly", () => {
    setup([{ name: "c.xbrief.json", title: "CLI path" }]);
    const result = runSpecReconstructCli(["--project-root", root]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("draftOnly=true");
    expect(result.stdout).toContain("autoPromote=false");
  });
});
