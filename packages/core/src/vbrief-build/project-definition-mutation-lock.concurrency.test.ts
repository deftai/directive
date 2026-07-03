import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { PLAN_POLICY_KEY } from "../policy/plan-extensions.js";
import { setPolicy } from "../policy/resolve.js";
import { writeWipCap } from "../triage/welcome/writers.js";
import { projectDefinitionMutationLock } from "./project-definition-io.js";

/**
 * #1260 -- every PROJECT-DEFINITION read-modify-write mutator now serialises
 * behind the shared mutation lock, so concurrent mutators cannot lose an update
 * or desync the typed field from its audit row.
 */
function makeMigratedProject(): { root: string; defPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pd-conc-"));
  const xbriefDir = join(root, "xbrief");
  mkdirSync(xbriefDir, { recursive: true });
  const defPath = join(xbriefDir, "PROJECT-DEFINITION.xbrief.json");
  writeFileSync(
    defPath,
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", [PLAN_POLICY_KEY]: {}, items: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, defPath };
}

/**
 * Parse a PROJECT-DEFINITION and guard the top-level shape. `JSON.parse` can
 * return `null` (or a non-object) without throwing, so property access must
 * follow a null/object guard rather than run against the raw parsed value.
 */
function readGuarded(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} top-level value is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

describe("projectDefinitionMutationLock concurrency (#1260)", () => {
  it("two different setters compose without losing an update", () => {
    const { root, defPath } = makeMigratedProject();
    try {
      // Distinct mutators, run back to back. The second RMW must observe the
      // first's persisted state rather than clobbering it with a stale read.
      setPolicy(root, { allowDirectCommits: true, actor: "test" });
      writeWipCap(root, 5, { actor: "test" });

      const data = readGuarded(defPath);
      const plan = data.plan as Record<string, Record<string, unknown>>;
      const policy = plan[PLAN_POLICY_KEY];
      expect(policy.allowDirectCommitsToMaster).toBe(true);
      expect(policy.wipCap).toBe(5);
      // The sidecar lock is always released.
      expect(existsSync(`${defPath}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a serialised second mutation observes the first's on-disk value before mutating", () => {
    const { root, defPath } = makeMigratedProject();
    try {
      const path = resolveProjectDefinitionPath(root);
      projectDefinitionMutationLock(root, () => {
        const data = readGuarded(path);
        const plan = data.plan as Record<string, Record<string, number>>;
        plan[PLAN_POLICY_KEY].wipCap = 3;
        writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      });

      let observed: unknown;
      projectDefinitionMutationLock(root, () => {
        const data = readGuarded(path);
        const plan = data.plan as Record<string, Record<string, number>>;
        observed = plan[PLAN_POLICY_KEY].wipCap;
        plan[PLAN_POLICY_KEY].wipCap = plan[PLAN_POLICY_KEY].wipCap + 1;
        writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      });

      expect(observed).toBe(3);
      const final = readGuarded(defPath);
      const finalPlan = final.plan as Record<string, Record<string, unknown>>;
      expect(finalPlan[PLAN_POLICY_KEY].wipCap).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a re-entrant acquisition so a nested/racing entry cannot interleave", () => {
    const { root } = makeMigratedProject();
    try {
      expect(() =>
        projectDefinitionMutationLock(root, () => {
          projectDefinitionMutationLock(root, () => undefined);
        }),
      ).toThrow(/not reentrant/);
      // The guard is released even after the throw, so later mutators still work.
      expect(() => projectDefinitionMutationLock(root, () => undefined)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("places the sidecar lock beside the migrated xbrief artifact, not under vbrief/", () => {
    const { root, defPath } = makeMigratedProject();
    try {
      let lockSeenNextToArtifact = false;
      projectDefinitionMutationLock(root, () => {
        lockSeenNextToArtifact = existsSync(`${defPath}.lock`);
      });
      expect(lockSeenNextToArtifact).toBe(true);
      // No stray legacy vbrief/ directory is created on a migrated tree.
      expect(existsSync(join(root, "vbrief"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
