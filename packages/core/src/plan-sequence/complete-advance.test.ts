import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advancePlanAfterComplete, isPlanSequenceTracked } from "./complete-advance.js";
import { planSequencePath, readPlanSequence, writePlanSequence } from "./store.js";
import { createPlanSequence } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ps-complete-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeCompleted(root: string, issue: number, folder = "completed"): string {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-11-16-${issue}-story.xbrief.json`);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: `Story ${issue}`,
        status: folder === "cancelled" ? "cancelled" : "completed",
        references: [
          { uri: `https://github.com/acme/app/issues/${issue}`, type: "x-xbrief/github-issue" },
        ],
      },
    }),
  );
  return path;
}

function seedPlan(root: string, issues: number[] = [101, 102]): void {
  const seq = createPlanSequence({
    sequence_id: "seq",
    sequence_kind: "delivery",
    authorized_by: "operator",
    entries: issues.map((n) => ({ id: String(n), kind: "issue" as const, issue: n })),
  });
  const wrote = writePlanSequence(root, seq, 0, { sourceRevision: "" });
  if (!wrote.ok) throw new Error(wrote.message);
}

const untracked = { isPlanTracked: () => false };

describe("advancePlanAfterComplete (#6205 clause.6 / clause.7)", () => {
  it("advanced: writes the stored cursor forward for an untracked plan in this checkout", () => {
    const root = tempRoot();
    seedPlan(root);
    const brief = writeCompleted(root, 101);
    const result = advancePlanAfterComplete({
      projectRoot: root,
      completedPath: brief,
      seams: untracked,
    });
    expect(result.status).toBe("advanced");
    expect(result.line).toMatch(
      /^plan-sequence: advanced \(current issue:102 index=1 generation=2\)$/,
    );
    const seq = readPlanSequence(root);
    expect(seq?.current_index).toBe(1);
    expect(seq?.entries[0]?.status).toBe("completed");
  });

  it("advanced to exhausted when the last entry completes", () => {
    const root = tempRoot();
    seedPlan(root, [101]);
    const brief = writeCompleted(root, 101);
    const result = advancePlanAfterComplete({
      projectRoot: root,
      completedPath: brief,
      seams: untracked,
    });
    expect(result.line).toContain("advanced (exhausted");
    expect(readPlanSequence(root)?.exhausted).toBe(true);
  });

  it("no-sequence: a linked worktree with no plan never writes another checkout's plan", () => {
    const base = tempRoot();
    const main = join(base, "main");
    mkdirSync(main);
    git(main, ["init", "-q"]);
    git(main, ["config", "user.email", "t@example.com"]);
    git(main, ["config", "user.name", "t"]);
    writeFileSync(join(main, "README.md"), "x\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-q", "-m", "init"]);
    seedPlan(main);
    const dest = join(base, "dest");
    git(main, ["worktree", "add", "-q", "-b", "dest", dest]);
    const brief = writeCompleted(dest, 101);
    const result = advancePlanAfterComplete({ projectRoot: dest, completedPath: brief });
    expect(result.status).toBe("no-sequence");
    expect(readPlanSequence(main)?.current_index).toBe(0);
    expect(readPlanSequence(main)?.generation).toBe(1);
  });

  it("derived-only: a tracked plan is never written by completion", () => {
    const root = tempRoot();
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "t"]);
    seedPlan(root);
    git(root, ["add", "-f", ".deft/plan-sequence.json"]);
    git(root, ["commit", "-q", "-m", "plan"]);
    expect(isPlanSequenceTracked(root)).toBe(true);
    const before = readFileSync(planSequencePath(root), "utf8");
    const brief = writeCompleted(root, 101);
    const result = advancePlanAfterComplete({ projectRoot: root, completedPath: brief });
    expect(result.status).toBe("derived-only");
    expect(result.line).toContain("readers derive current issue:102");
    expect(readFileSync(planSequencePath(root), "utf8")).toBe(before);
  });

  it("an untracked plan in a plain directory is untracked", () => {
    expect(isPlanSequenceTracked(tempRoot())).toBe(false);
  });

  it("no-entry and not-current name the case and write nothing", () => {
    const root = tempRoot();
    seedPlan(root, [101, 102, 103]);
    const other = writeCompleted(root, 999);
    expect(
      advancePlanAfterComplete({ projectRoot: root, completedPath: other, seams: untracked })
        .status,
    ).toBe("no-entry");
    const later = writeCompleted(root, 103);
    const notCurrent = advancePlanAfterComplete({
      projectRoot: root,
      completedPath: later,
      seams: untracked,
    });
    expect(notCurrent.status).toBe("not-current");
    expect(notCurrent.line).toContain("issue:103");
    expect(readPlanSequence(root)?.generation).toBe(1);
  });

  it("store-failed: a failed write changes nothing else and readers still derive", () => {
    const root = tempRoot();
    seedPlan(root);
    const brief = writeCompleted(root, 101);
    const result = advancePlanAfterComplete({
      projectRoot: root,
      completedPath: brief,
      seams: {
        ...untracked,
        writePlan: () => ({
          ok: false,
          code: "persist-error",
          current_generation: 1,
          source_revision: "",
          message: "injected persist failure",
        }),
      },
    });
    expect(result.status).toBe("store-failed");
    expect(result.line).toContain(
      "injected persist failure; readers still derive current issue:102",
    );
    expect(readPlanSequence(root)?.current_index).toBe(0);
  });

  it("store-failed: an unreadable plan never throws", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(planSequencePath(root), "{not json");
    const brief = writeCompleted(root, 101);
    const result = advancePlanAfterComplete({ projectRoot: root, completedPath: brief });
    expect(result.status).toBe("store-failed");
    expect(result.line).toContain("the completion stands");
  });

  it("no-sequence when the checkout has no plan file", () => {
    const root = tempRoot();
    const brief = writeCompleted(root, 101);
    expect(advancePlanAfterComplete({ projectRoot: root, completedPath: brief }).line).toBe(
      "plan-sequence: no-sequence (no .deft/plan-sequence.json in this checkout)",
    );
  });
});
