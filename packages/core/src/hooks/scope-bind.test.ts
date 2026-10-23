import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_SCOPE_PIN_ENV,
  bindBranchToActiveStory,
  branchStoryTokens,
  pushStoryAdmissionRefusal,
  resolveSoftMissingAcTargets,
} from "./scope.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "deft-branch-bind-"));
  temps.push(dir);
  mkdirSync(join(dir, "xbrief", "active"), { recursive: true });
  return dir;
}

function writeBrief(root: string, name: string, planId: string, issue: number): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    JSON.stringify({
      plan: {
        id: planId,
        status: "running",
        narratives: { Origin: `Ingested from https://github.com/acme/widgets/issues/${issue}` },
        references: [
          { uri: `https://github.com/acme/widgets/issues/${issue}`, type: "x-vbrief/github-issue" },
        ],
      },
    }),
    "utf8",
  );
  return path;
}

function twoActives(): { root: string; a: string; b: string; scanned: string[] } {
  const root = project();
  const a = writeBrief(root, "2026-10-23-5855-a.xbrief.json", "github.issue.111", 5855);
  const b = writeBrief(root, "2026-10-23-5836-b.xbrief.json", "github.issue.222", 5836);
  return { root, a, b, scanned: [a, b] };
}

describe("branchStoryTokens (#5855)", () => {
  it("reads issue tokens and ignores version-shaped and dotted parts", () => {
    expect(branchStoryTokens("fix/5855-multi-active").issueNumbers).toEqual([5855]);
    expect(branchStoryTokens("refs/heads/chore/pin-0.128.0").issueNumbers).toEqual([]);
    expect(branchStoryTokens("release/v0.129.0").issueNumbers).toEqual([]);
    expect(branchStoryTokens("swarm/ingest-ready/github.issue.111").issueNumbers).toEqual([]);
    expect(branchStoryTokens("HEAD").segments).toEqual([]);
    expect(branchStoryTokens(null).issueNumbers).toEqual([]);
  });
});

describe("bindBranchToActiveStory (#5855 P1)", () => {
  it("binds a unique plan.id token", () => {
    const { a, scanned } = twoActives();
    expect(
      bindBranchToActiveStory(scanned, { branch: "swarm/ingest-ready/github.issue.111", env: {} }),
    ).toEqual({ kind: "bound", path: a });
  });

  it("binds a single repo-scoped issue token", () => {
    const { b, scanned } = twoActives();
    expect(
      bindBranchToActiveStory(scanned, {
        branch: "fix/5836-thing",
        env: {},
        repoSlug: "acme/widgets",
      }),
    ).toEqual({ kind: "bound", path: b });
    // Same number in another repo does not own it.
    expect(
      bindBranchToActiveStory(scanned, {
        branch: "fix/5836-thing",
        env: {},
        repoSlug: "other/repo",
      }),
    ).toMatchObject({ kind: "refuse", denyKind: "pin-miss" });
  });

  it("admits untied for version-token and detached branches with no dispatch marker", () => {
    const { scanned } = twoActives();
    expect(bindBranchToActiveStory(scanned, { branch: "chore/pin-0.128.0", env: {} })).toEqual({
      kind: "untied",
    });
    expect(bindBranchToActiveStory(scanned, { branch: null, env: {} })).toEqual({ kind: "untied" });
  });

  it("refuses a lost pin and a dispatch expectation without a pin", () => {
    const { scanned } = twoActives();
    expect(bindBranchToActiveStory(scanned, { branch: "fix/9999-gone", env: {} })).toMatchObject({
      kind: "refuse",
      denyKind: "pin-miss",
    });
    const spawned = bindBranchToActiveStory(scanned, {
      branch: "chore/no-token",
      env: { DEFT_AGENT_ID: "worker-1" },
    });
    expect(spawned).toMatchObject({ kind: "refuse", denyKind: "pin-miss" });
    if (spawned.kind === "refuse") expect(spawned.message).toContain(ACTIVE_SCOPE_PIN_ENV);
  });

  it("refuses ambiguous multi-match and multi-token branches", () => {
    const root = project();
    const a = writeBrief(root, "a.xbrief.json", "github.issue.1", 5855);
    const b = writeBrief(root, "b.xbrief.json", "github.issue.2", 5855);
    expect(
      bindBranchToActiveStory([a, b], { branch: "fix/5855-x", env: {}, repoSlug: "acme/widgets" }),
    ).toMatchObject({ kind: "refuse", denyKind: "multiple-eligible" });
    expect(bindBranchToActiveStory([a, b], { branch: "fix/5855-5836", env: {} })).toMatchObject({
      kind: "refuse",
      denyKind: "multiple-eligible",
    });
  });
});

describe("resolveSoftMissingAcTargets branch bind is opt-in (#5855 P2)", () => {
  it("keeps the need-pin default without branchBind (sor-preflight)", () => {
    const { root } = twoActives();
    expect(resolveSoftMissingAcTargets(root, { env: {} }).kind).toBe("need-pin");
  });

  it("binds, admits untied, or refuses when opted in", () => {
    const { root, a } = twoActives();
    expect(
      resolveSoftMissingAcTargets(root, {
        env: {},
        branchBind: { branch: "fix/5855-x", env: {}, repoSlug: "acme/widgets" },
      }),
    ).toEqual({ kind: "one", path: a });
    const untied = resolveSoftMissingAcTargets(root, {
      env: {},
      branchBind: { branch: "chore/pin-0.128.0", env: {} },
    });
    expect(untied.kind).toBe("untied");
    if (untied.kind === "untied") {
      expect(untied.message).toContain("#3284 soft-missing");
      expect(untied.message).toContain("no story AC executed");
    }
    const lost = resolveSoftMissingAcTargets(root, {
      env: {},
      branchBind: { branch: "fix/9999-gone", env: {} },
    });
    expect(lost).toMatchObject({ kind: "need-pin", denyKind: "pin-miss" });
  });

  it("an explicit pin still wins over the branch", () => {
    const { root, b } = twoActives();
    expect(
      resolveSoftMissingAcTargets(root, {
        env: { [ACTIVE_SCOPE_PIN_ENV]: b },
        branchBind: { branch: "fix/5855-x", env: {} },
      }),
    ).toEqual({ kind: "one", path: b });
  });
});

describe("pushStoryAdmissionRefusal (#5855 P3)", () => {
  it("admits untied soft-missing and refuses an unresolved required story", () => {
    const { root } = twoActives();
    expect(pushStoryAdmissionRefusal(root, "refs/heads/chore/pin-0.128.0", {})).toBeNull();
    expect(pushStoryAdmissionRefusal(root, "refs/heads/fix/5855-x", {})).toBeNull();
    const refused = pushStoryAdmissionRefusal(root, "refs/heads/fix/9999-gone", {});
    expect(refused).toContain("#4285");
    expect(
      pushStoryAdmissionRefusal(root, "refs/heads/chore/x", { DEFT_AGENT_ID: "w" }),
    ).not.toBeNull();
  });

  it("does nothing with one or zero actives", () => {
    const root = project();
    expect(pushStoryAdmissionRefusal(root, "refs/heads/fix/9999-gone", {})).toBeNull();
    writeBrief(root, "only.xbrief.json", "github.issue.1", 1);
    expect(pushStoryAdmissionRefusal(root, "refs/heads/fix/9999-gone", {})).toBeNull();
  });
});
