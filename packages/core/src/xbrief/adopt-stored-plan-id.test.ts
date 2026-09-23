/**
 * xbrief:adopt-stored-plan-id copies the stored binding id and refuses a collision (#4963).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { adoptStoredPlanId, runAdoptStoredPlanIdCli } from "./adopt-stored-plan-id.js";
import { createXbrief } from "./create.js";
import { verifyXbrief } from "./verify.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const here = dirname(fileURLToPath(import.meta.url));

function restBinding(
  id: string,
  restId: number,
  origin = "deftai/directive#4963",
): Record<string, unknown> {
  return {
    version: 1,
    source: "github-rest-id",
    github_issue_id: restId,
    origin,
    id,
  };
}

function writeCreated(root: string, stem: string, planId: string): string {
  const created = createXbrief({
    format: "json",
    out: stem,
    style: "scope",
    title: "Stored mint",
    id: planId,
    projectRoot: root,
    force: true,
  });
  expect(created.exitCode, created.stderr).toBe(0);
  return join(root, `${stem}.xbrief.json`);
}

function patchPlan(path: string, mutate: (plan: Record<string, unknown>) => void): void {
  const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(doc.plan as Record<string, unknown>);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

function planOf(path: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(path, "utf8")) as { plan: Record<string, unknown> };
  return doc.plan;
}

describe("xbrief:adopt-stored-plan-id (#4963)", () => {
  it("copies the stored binding id onto plan.id and then verifies", () => {
    const root = freshRoot("xbrief-adopt-copy-");
    const stem = "xbrief/proposed/2026-09-23-adopt-copy";
    const path = writeCreated(root, stem, "hand-authored");
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.5555958091", 5555958091);
      const narratives = plan.narratives as Record<string, unknown>;
      narratives.Origin = "Ingested from https://github.com/deftai/directive/issues/4963";
    });
    const adopted = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("Set plan.id to github.issue.5555958091");
    const plan = planOf(path);
    expect(plan.id).toBe("github.issue.5555958091");
    expect(plan.id).not.toBe("github.issue.4963");
    expect((plan.metadata as Record<string, unknown>)["x-directive/plan-id"]).toMatchObject({
      id: "github.issue.5555958091",
      github_issue_id: 5555958091,
    });
    const verified = verifyXbrief({ format: "json", out: stem, projectRoot: root });
    expect(verified.exitCode, verified.stderr).toBe(0);
  });

  it("refuses when the stored id already occupies another artifact", () => {
    const root = freshRoot("xbrief-adopt-collide-");
    const stem = "xbrief/proposed/2026-09-23-adopt-live";
    const occupant = "xbrief/active/2026-09-23-adopt-taken";
    const path = writeCreated(root, stem, "hand-authored");
    writeCreated(root, occupant, "github.issue.42");
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.42", 42);
    });
    const before = readFileSync(path, "utf8");
    const adopted = runAdoptStoredPlanIdCli(["--out", stem, "--project-root", root]);
    expect(adopted.exitCode).toBe(1);
    expect(adopted.stderr).toContain("already occupies");
    expect(adopted.stderr).toContain("github.issue.42");
    expect(adopted.stdout).not.toContain("Set plan.id");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(planOf(path).id).toBe("hand-authored");
  });

  it("refuses a missing or malformed binding without writing plan.id", () => {
    const root = freshRoot("xbrief-adopt-none-");
    const stem = "xbrief/proposed/2026-09-23-adopt-none";
    const path = writeCreated(root, stem, "hand-authored");
    const missing = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("no stored x-directive/plan-id binding");
    expect(planOf(path).id).toBe("hand-authored");

    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = { version: 2 };
    });
    const malformed = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("missing source");
    expect(planOf(path).id).toBe("hand-authored");
  });

  it("sets the paired markdown frontmatter id and leaves the body", () => {
    const root = freshRoot("xbrief-adopt-both-");
    const stem = "xbrief/proposed/2026-09-23-adopt-both";
    const created = createXbrief({
      format: "both",
      out: stem,
      style: "scope",
      title: "Stored mint",
      id: "hand-authored",
      projectRoot: root,
      force: true,
    });
    expect(created.exitCode, created.stderr).toBe(0);
    const jsonPath = join(root, `${stem}.xbrief.json`);
    const mdPath = join(root, `${stem}.xbrief.md`);
    patchPlan(jsonPath, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.5555958091", 5555958091);
      const narratives = plan.narratives as Record<string, unknown>;
      narratives.Origin = "Ingested from https://github.com/deftai/directive/issues/4963";
    });
    const marked = `${readFileSync(mdPath, "utf8").trimEnd()}\n\nBODY-MARKER keep this sentence\n`;
    writeFileSync(mdPath, marked, "utf8");
    const beforeVerify = verifyXbrief({ format: "both", out: stem, projectRoot: root });
    expect(beforeVerify.exitCode).toBe(1);
    expect(beforeVerify.stderr).toContain("disagrees with stored mint");
    expect(beforeVerify.stderr).not.toContain("id mismatch");

    const adopted = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("Set plan.id to github.issue.5555958091");
    expect(planOf(jsonPath).id).toBe("github.issue.5555958091");
    const expectedMd = marked.replace("id: hand-authored", "id: github.issue.5555958091");
    const afterMd = readFileSync(mdPath, "utf8");
    expect(afterMd).toBe(expectedMd);
    expect(afterMd).toContain("BODY-MARKER keep this sentence");
    const verified = verifyXbrief({ format: "both", out: stem, projectRoot: root });
    expect(verified.exitCode, verified.stderr).toBe(0);

    const afterJson = readFileSync(jsonPath, "utf8");
    const again = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toContain("plan.id already github.issue.5555958091");
    expect(readFileSync(jsonPath, "utf8")).toBe(afterJson);
    expect(readFileSync(mdPath, "utf8")).toBe(afterMd);
  });

  it("updates a stale paired markdown id when plan.id already matches", () => {
    const root = freshRoot("xbrief-adopt-md-only-");
    const stem = "xbrief/proposed/2026-09-23-adopt-md-only";
    const created = createXbrief({
      format: "both",
      out: stem,
      style: "scope",
      title: "Stored mint",
      id: "github.issue.5555958091",
      projectRoot: root,
      force: true,
    });
    expect(created.exitCode, created.stderr).toBe(0);
    const jsonPath = join(root, `${stem}.xbrief.json`);
    const mdPath = join(root, `${stem}.xbrief.md`);
    patchPlan(jsonPath, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.5555958091", 5555958091);
      const narratives = plan.narratives as Record<string, unknown>;
      narratives.Origin = "Ingested from https://github.com/deftai/directive/issues/4963";
    });
    const stale = readFileSync(mdPath, "utf8").replace(
      "id: github.issue.5555958091",
      "id: hand-authored",
    );
    writeFileSync(mdPath, stale, "utf8");
    const jsonBefore = readFileSync(jsonPath, "utf8");
    const adopted = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("Set plan.id to github.issue.5555958091");
    expect(readFileSync(jsonPath, "utf8")).toBe(jsonBefore);
    expect(readFileSync(mdPath, "utf8")).toBe(
      stale.replace("id: hand-authored", "id: github.issue.5555958091"),
    );
    const verified = verifyXbrief({ format: "both", out: stem, projectRoot: root });
    expect(verified.exitCode, verified.stderr).toBe(0);
  });

  it("does not write plan.id when the paired markdown has no frontmatter", () => {
    const root = freshRoot("xbrief-adopt-no-front-");
    const stem = "xbrief/proposed/2026-09-23-adopt-no-front";
    const path = writeCreated(root, stem, "hand-authored");
    const mdPath = join(root, `${stem}.xbrief.md`);
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.5555958091", 5555958091);
    });
    writeFileSync(mdPath, "# Stored mint\n\nno frontmatter\n", "utf8");
    const before = readFileSync(path, "utf8");
    const adopted = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(adopted.exitCode).toBe(1);
    expect(adopted.stderr).toContain("frontmatter is missing or unclosed");
    expect(adopted.stdout).not.toContain("Set plan.id");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(planOf(path).id).toBe("hand-authored");
  });

  it("leaves an already-aligned plan.id unchanged", () => {
    const root = freshRoot("xbrief-adopt-same-");
    const stem = "xbrief/proposed/2026-09-23-adopt-same";
    const path = writeCreated(root, stem, "github.issue.42");
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.42", 42);
    });
    const before = readFileSync(path, "utf8");
    const adopted = adoptStoredPlanId({ out: stem, projectRoot: root });
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("plan.id already github.issue.42");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not mint or call the repair helper", () => {
    const source = readFileSync(join(here, "adopt-stored-plan-id.ts"), "utf8");
    for (const name of [
      "evaluateIssuePlanIdAdmission",
      "repairNonterminalIssuePlanIds",
      "attachPlanIdMint",
      "mintIssuePlanId",
    ]) {
      expect(source).not.toContain(name);
    }
    expect(source).toContain("findParentsByPlanId");
    const help = runAdoptStoredPlanIdCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("xbrief:adopt-stored-plan-id");
    expect(runAdoptStoredPlanIdCli([]).exitCode).toBe(2);
  });
});
