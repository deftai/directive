import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate, parseAllocationSection, SWARM_COHORT_KIND } from "./evaluate.js";
import { gitPorcelain } from "./git.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

const CLEAN_TREE = "";
const DIRTY_TREE = " M scripts/foo.py\n?? scratch.txt\n";

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "deft-test",
      GIT_AUTHOR_EMAIL: "test@test.local",
      GIT_COMMITTER_NAME: "deft-test",
      GIT_COMMITTER_EMAIL: "test@test.local",
    },
  });
}

function writeVbrief(
  base: string,
  folder = "active",
  status: string | null = "running",
  name = "2026-06-01-story.vbrief.json",
): string {
  const dir = join(base, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const payload: Record<string, unknown> = { vBRIEFInfo: { version: "0.6" } };
  if (status !== null) {
    payload.plan = { title: "T", items: [], status };
  }
  writeFileSync(path, JSON.stringify(payload), "utf8");
  temps.push(base);
  return path;
}

function renderAllocation(fields: Record<string, string | null>): string {
  const lines = ["Dispatch envelope.", "", "## Allocation context", ""];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`- ${key}: ${value === null ? "null" : value}`);
  }
  lines.push("", "## Next section", "- trailing: ignored");
  return lines.join("\n");
}

const VALID_COHORT: Record<string, string | null> = {
  dispatch_kind: SWARM_COHORT_KIND,
  allocation_plan_id: "orchestrator-run-019e80bd",
  batching_rationale: "Three disjoint-file-scope stories.",
  cohort_vbriefs: "[vbrief/active/a.json]",
  operator_approval_evidence: "user directive",
};

describe("parseAllocationSection", () => {
  it("returns false when no heading", () => {
    const [found, fields] = parseAllocationSection("no heading");
    expect(found).toBe(false);
    expect(fields).toEqual({});
  });

  it("extracts fields and normalises null", () => {
    const text = renderAllocation({
      dispatch_kind: SWARM_COHORT_KIND,
      allocation_plan_id: null,
      batching_rationale: "why",
    });
    const [found, fields] = parseAllocationSection(text);
    expect(found).toBe(true);
    expect(fields.dispatch_kind).toBe(SWARM_COHORT_KIND);
    expect(fields.allocation_plan_id).toBeNull();
    expect(fields.batching_rationale).toBe("why");
    expect(fields.trailing).toBeUndefined();
  });

  it("strips backticked values", () => {
    const [found, fields] = parseAllocationSection(
      "## Allocation context\n- dispatch_kind: `swarm-cohort`\n",
    );
    expect(found).toBe(true);
    expect(fields.dispatch_kind).toBe(SWARM_COHORT_KIND);
  });

  it("returns false on undefined input", () => {
    const [found] = parseAllocationSection(undefined);
    expect(found).toBe(false);
  });

  it("ignores bullets without a colon", () => {
    const [found, fields] = parseAllocationSection(
      "## Allocation context\n- no-colon-bullet\n- dispatch_kind: solo\n",
    );
    expect(found).toBe(true);
    expect(fields.dispatch_kind).toBe("solo");
    expect(fields["no-colon-bullet"]).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("dirty tree is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const result = evaluate(path, { gitStatus: DIRTY_TREE });
    expect(result.exitCode).toBe(1);
    expect(result.message.toLowerCase()).toContain("dirty");
  });

  it("missing allocation context solo is ready (exit 0)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: null });
    expect(result.exitCode).toBe(0);
    expect(result.message.toLowerCase()).toContain("solo");
  });

  it("valid swarm-cohort is ready (exit 0)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const envelope = renderAllocation(VALID_COHORT);
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: envelope });
    expect(result.exitCode).toBe(0);
    expect(result.message.toLowerCase()).toContain("swarm-cohort");
  });

  it("malformed allocation missing dispatch_kind is config error (exit 2)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const fields = { ...VALID_COHORT };
    delete fields.dispatch_kind;
    const envelope = renderAllocation(fields);
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: envelope });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("dispatch_kind");
  });

  it("unrecognised dispatch_kind is config error (exit 2)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const envelope = renderAllocation({ ...VALID_COHORT, dispatch_kind: "bonus-round" });
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: envelope });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("unrecognised dispatch_kind");
  });

  it("swarm-cohort null consent field is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const envelope = renderAllocation({ ...VALID_COHORT, allocation_plan_id: null });
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: envelope });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("allocation_plan_id");
  });

  it("allow-dirty overrides dirty tree", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const result = evaluate(path, { gitStatus: DIRTY_TREE, allowDirty: true });
    expect(result.exitCode).toBe(0);
    expect(result.message.toLowerCase()).toContain("allow-dirty");
    expect(result.message.toLowerCase()).not.toContain("tree clean");
  });

  it("git undeterminable is config error (exit 2)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const result = evaluate(path, { gitStatus: null });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("working-tree state");
  });

  it("vbrief in pending is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base, "pending");
    const result = evaluate(path, { gitStatus: CLEAN_TREE });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("pending/");
  });

  it("vbrief not running is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base, "active", "approved");
    const result = evaluate(path, { gitStatus: CLEAN_TREE });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("running");
  });

  it("honours pre-parsed section", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const result = evaluate(path, {
      gitStatus: CLEAN_TREE,
      allocationContext: "## Allocation context\n- dispatch_kind: swarm-cohort\n",
      parsed: [true, { dispatch_kind: "solo" }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.message.toLowerCase()).toContain("solo");
  });

  it("missing vbrief is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const missing = join(base, "vbrief", "active", "nope.vbrief.json");
    const result = evaluate(missing, { gitStatus: CLEAN_TREE });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not found");
  });

  it("explicit solo dispatch is ready (exit 0)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const envelope = renderAllocation({
      dispatch_kind: "solo",
      allocation_plan_id: null,
      batching_rationale: null,
      cohort_vbriefs: "[vbrief/active/only.json]",
      operator_approval_evidence: "solo-interactive",
    });
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: envelope });
    expect(result.exitCode).toBe(0);
    expect(result.message.toLowerCase()).toContain("solo");
  });

  it("swarm-cohort missing batching_rationale is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const path = writeVbrief(base);
    const fields = { ...VALID_COHORT };
    delete fields.batching_rationale;
    const envelope = renderAllocation(fields);
    const result = evaluate(path, { gitStatus: CLEAN_TREE, allocationContext: envelope });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("batching_rationale");
  });

  it("invalid vbrief json is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const dir = join(base, "vbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "bad.vbrief.json");
    writeFileSync(path, "{not json", "utf8");
    temps.push(base);
    const result = evaluate(path, { gitStatus: CLEAN_TREE });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not valid JSON");
  });

  it("vbrief without plan object is not ready (exit 1)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-sr-"));
    const dir = join(base, "vbrief", "active");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "noplan.vbrief.json");
    writeFileSync(path, JSON.stringify({ vBRIEFInfo: { version: "0.6" } }), "utf8");
    temps.push(base);
    const result = evaluate(path, { gitStatus: CLEAN_TREE });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("`plan` object");
  });
});

describe("gitPorcelain", () => {
  it("returns empty string for a clean committed repo", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sr-git-"));
    temps.push(root);
    writeFileSync(join(root, "f.txt"), "ok\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    gitCommit(root, "init");
    expect(gitPorcelain(root)).toBe("");
  });

  it("returns null outside a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sr-nogit-"));
    temps.push(root);
    expect(gitPorcelain(root)).toBeNull();
  });
});

describe("story-ready index re-exports", () => {
  it("exports evaluate from the barrel", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.evaluate).toBe("function");
    expect(typeof mod.parseAllocationSection).toBe("function");
    expect(typeof mod.gitPorcelain).toBe("function");
  });
});
