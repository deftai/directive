/**
 * Real-Git fixture for #4714 R5/R8/R9: activation tip brief, product merge blob,
 * retained dest transport into isolated checkout, lifecycle land, fresh-clone proof.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeRetainedBrief } from "./brief-transport.js";
import { evaluateLifecycleDiff, expectedLifecycleRels } from "./lifecycle-diff.js";
import { originActiveBriefPresent } from "./origin-active-brief.js";
import { runText } from "./subprocess.js";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

describe("real-git leftover land (#4714 R9)", () => {
  it("proves origin-active, retained transport, causal diff, and fresh-clone completed twin", () => {
    const bare = mkdtempSync(join(tmpdir(), "deft-4714-bare-"));
    const primary = mkdtempSync(join(tmpdir(), "deft-4714-primary-"));
    const retained = mkdtempSync(join(tmpdir(), "deft-4714-retained-"));
    const fresh = mkdtempSync(join(tmpdir(), "deft-4714-fresh-"));
    try {
      git(bare, ["init", "--bare"]);
      git(primary, ["init"]);
      git(primary, ["remote", "add", "origin", bare]);
      git(primary, ["config", "user.email", "4714@test.local"]);
      git(primary, ["config", "user.name", "4714"]);
      mkdirSync(join(primary, "xbrief", "active"), { recursive: true });
      writeFileSync(
        join(primary, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        JSON.stringify({
          plan: { title: "P", status: "running", policy: { deliveryBranch: "master" } },
        }),
        "utf8",
      );
      const briefRel = "xbrief/active/story-1.xbrief.json";
      const brief = {
        plan: {
          id: "story-1",
          status: "running",
          references: [
            {
              uri: "https://github.com/example/app/issues/1",
              type: "x-xbrief/github-issue",
            },
          ],
          items: [{ id: "c1", title: "ship", status: "pending", command: "pnpm test" }],
        },
      };
      const briefBytes = `${JSON.stringify(brief, null, 2)}\n`;
      writeFileSync(join(primary, briefRel), briefBytes, "utf8");
      git(primary, ["add", "-A"]);
      git(primary, ["commit", "-m", "activation: land active brief"]);
      // Ensure master exists for older git defaults.
      try {
        git(primary, ["branch", "-M", "master"]);
      } catch {
        /* already master */
      }
      git(primary, ["push", "-u", "origin", "master"]);

      const originProbe = originActiveBriefPresent(primary, "master", briefRel, (cmd, opts) =>
        runText(cmd, opts),
      );
      expect(originProbe.present).toBe(true);

      // Product merge commit carries the same brief bytes (reviewed blob).
      const mergeSha = git(primary, ["rev-parse", "HEAD"]);

      // Retained dest keeps exact reviewed bytes; isolated checkout starts empty of active.
      mkdirSync(join(retained, "xbrief", "active"), { recursive: true });
      writeFileSync(join(retained, briefRel), briefBytes, "utf8");
      const lifecycle = mkdtempSync(join(tmpdir(), "deft-4714-lifecycle-"));
      mkdirSync(join(lifecycle, "xbrief"), { recursive: true });
      const moved = materializeRetainedBrief({
        checkoutRoot: lifecycle,
        projectRoot: primary,
        relPath: briefRel,
        retainedRoots: [retained],
        reviewedCommitIsh: mergeSha,
        deliveryBranch: "master",
        runGit: (cmd, opts) => runText(cmd, opts),
      });
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        expect(readFileSync(moved.path, "utf8")).toBe(briefBytes);
      }

      // Simulate complete: move active → completed in lifecycle checkout and push.
      mkdirSync(join(lifecycle, "xbrief", "completed"), { recursive: true });
      const completedRel = "xbrief/completed/story-1.xbrief.json";
      writeFileSync(join(lifecycle, completedRel), briefBytes, "utf8");
      rmSync(join(lifecycle, briefRel), { force: true });
      const staged = [briefRel, completedRel];
      const diff = evaluateLifecycleDiff(staged, expectedLifecycleRels([briefRel]));
      expect(diff.ok).toBe(true);

      git(lifecycle, ["init"]);
      git(lifecycle, ["remote", "add", "origin", bare]);
      git(lifecycle, ["config", "user.email", "4714@test.local"]);
      git(lifecycle, ["config", "user.name", "4714"]);
      git(lifecycle, ["fetch", "origin", "master"]);
      git(lifecycle, ["checkout", "-B", "swarm/finalize/story-1", "origin/master"]);
      // Re-write after checkout replaced tree.
      mkdirSync(join(lifecycle, "xbrief", "completed"), { recursive: true });
      writeFileSync(join(lifecycle, completedRel), briefBytes, "utf8");
      if (existsSync(join(lifecycle, briefRel))) {
        rmSync(join(lifecycle, briefRel), { force: true });
      }
      git(lifecycle, ["add", "-A", "xbrief/"]);
      git(lifecycle, ["commit", "-m", "chore(xbrief): complete story-1 post-merge"]);
      git(lifecycle, ["push", "origin", "HEAD:master"]);

      git(fresh, ["clone", bare, "."]);
      expect(existsSync(join(fresh, completedRel))).toBe(true);
      expect(readFileSync(join(fresh, completedRel), "utf8")).toContain("story-1");
      expect(existsSync(join(fresh, briefRel))).toBe(false);
      rmSync(lifecycle, { recursive: true, force: true });
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
      rmSync(retained, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
