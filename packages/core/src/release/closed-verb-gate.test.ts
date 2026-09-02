import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateClosedVerb } from "../authz/closed-verb.js";
import type { HumanOriginGrant } from "../authz/types.js";
import { REHEARSAL_VERSION, REPO_SLUG_PREFIX } from "../release-e2e/constants.js";
import { evaluateReleasePublishGate } from "../release-publish/pipeline.js";
import {
  assertTagPushClosedVerb,
  evaluateReleaseTagPushGate,
  isRehearsalClosedVerbExempt,
  TAG_PUSH_CLOSED_VERB,
} from "./closed-verb-gate.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { runPipeline } from "./pipeline.js";
import { seedReleaseProjectDir } from "./pipeline-fixture.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

/** v0.105.0 cut: tag push published npm with no closed-verb challenge (#3527). */
const V105 = "0.105.0";

function operatorPublishGrant(target = V105): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id: "grant-tag-push-3527",
    origin: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-08-19T00:00:00Z",
      mintedVia: "deft authz:grant",
      eventRef: "template:release-publish",
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces: [target, `v${target}`],
      operations: ["release-publish"],
      storyIds: [],
      issueIds: [],
      cohortId: null,
    },
    semantics: {
      expiresAt: null,
      singleUse: false,
      usedAt: null,
      revokedAt: null,
    },
  };
}

function v105Config(projectRoot: string, overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    version: V105,
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot,
    dryRun: false,
    skipTag: false,
    skipRelease: true,
    allowDirty: false,
    draft: true,
    skipCi: true,
    skipBuild: true,
    summary: null,
    allowVbriefDrift: true,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: 716,
    ...overrides,
  };
}

function recordingSeams(overrides: ReleaseSeams = {}): ReleaseSeams & { gitMutations: string[][] } {
  const gitMutations: string[][] = [];
  const seams: ReleaseSeams & { gitMutations: string[][] } = {
    gitMutations,
    spawnText: (_cmd, args) => {
      const argv = [...args];
      if (argv.includes("tag") || argv.includes("push")) {
        gitMutations.push(argv);
      }
      if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    checkTagAvailable: () => [true, "ok"],
    checkVbriefLifecycleSync: () => [true, 0, ""],
    fileExists: (p) => /\.(md|toml)$/.test(p),
    readFile: () => `## [Unreleased]\n\n### Added\n- x\n`,
    writeFile: () => undefined,
    refreshRoadmap: () => [true, "ok"],
    runBuild: () => [true, "ok"],
    todayIso: () => "2026-08-19",
    ...overrides,
  };
  if (!("closedVerbEnv" in overrides) && !("closedVerbGrants" in overrides)) {
    seams.closedVerbEnv = {};
    seams.closedVerbGrants = [];
  }
  return seams;
}

describe("tag-push closed-verb gate (#3527)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the same closed-verb as the draft-flip gate", () => {
    expect(TAG_PUSH_CLOSED_VERB).toBe("release-publish");
  });

  it("v0.105.0 sequence: ungated tag push is now fail-closed without a grant", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams();
    const rc = runPipeline(v105Config(projectRoot), seams);
    expect(rc).toBe(EXIT_VIOLATION);
    expect(seams.gitMutations.some((a) => a.includes("tag") && a.includes("-a"))).toBe(false);
    expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(false);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("closed-verb-deny-missing");
    expect(out).toContain("release-publish");
    expect(out).toContain(V105);
    expect(out).toMatch(/DEFT_ALLOW_RELEASE_PUBLISH|authz:grant/i);
    expect(out).not.toContain("pushed master");
  });

  it("tag + atomic push proceed when a matching human-origin grant is present", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams({
      closedVerbGrants: [operatorPublishGrant()],
      closedVerbEnv: {},
    });
    const rc = runPipeline(v105Config(projectRoot), seams);
    expect(rc).toBe(EXIT_OK);
    expect(seams.gitMutations.some((a) => a.includes("tag") && a.includes("-a"))).toBe(true);
    expect(seams.gitMutations.some((a) => a.includes("push") && a.includes("--atomic"))).toBe(true);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("closed-verb-allow");
  });

  it("tag + atomic push proceed with DEFT_ALLOW_RELEASE_PUBLISH=1", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams({
      closedVerbEnv: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
      closedVerbGrants: [],
    });
    expect(runPipeline(v105Config(projectRoot), seams)).toBe(EXIT_OK);
    expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(true);
  });

  it("--skip-tag does not require a grant (no npm distribution)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams();
    expect(runPipeline(v105Config(projectRoot, { skipTag: true }), seams)).toBe(EXIT_OK);
    expect(seams.gitMutations).toEqual([]);
  });

  it("dry-run skip-tag-false does not fail closed and does not git-mutate", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams();
    const rc = runPipeline(v105Config(projectRoot, { dryRun: true }), seams);
    expect(rc).toBe(EXIT_OK);
    expect(seams.gitMutations).toEqual([]);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("DRYRUN");
    expect(out).toContain("DEFT_ALLOW_RELEASE_PUBLISH");
  });

  it("evaluateReleaseTagPushGate denies missing grant the same as draft-flip", () => {
    const denied = evaluateReleaseTagPushGate(
      V105,
      ".",
      { closedVerbGrants: [], closedVerbEnv: {} },
      "deftai/directive",
    );
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("closed-verb-deny-missing");
    const publish = evaluateReleasePublishGate(V105, ".", {
      grants: [],
      env: {},
      repo: "deftai/directive",
    });
    expect(publish.allowed).toBe(false);
    expect(publish.code).toBe("closed-verb-deny-missing");
  });

  it("release:publish draft-flip still refuses an agent with no grant", () => {
    const d = evaluateReleasePublishGate(V105, ".", {
      grants: [],
      env: {},
      repo: "deftai/directive",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-missing");
    expect(d.reason).toMatch(/authz:grant/);
  });

  it("assertTagPushClosedVerb skipTag short-circuits", () => {
    expect(
      assertTagPushClosedVerb(v105Config("/tmp", { skipTag: true }), {
        closedVerbGrants: [],
        closedVerbEnv: {},
      }),
    ).toBe(EXIT_OK);
  });

  it("conjunction of throwaway slug prefix and sentinel version is rehearsal-owned", () => {
    const slug = `${REPO_SLUG_PREFIX}20260902-abc`;
    expect(isRehearsalClosedVerbExempt(`deftai/${slug}`, REHEARSAL_VERSION)).toBe(true);
    expect(isRehearsalClosedVerbExempt(`deftai/${slug}`, `v${REHEARSAL_VERSION}`)).toBe(true);
    expect(isRehearsalClosedVerbExempt("deftai/directive", REHEARSAL_VERSION)).toBe(false);
    expect(isRehearsalClosedVerbExempt(`deftai/${slug}`, V105)).toBe(false);
    expect(isRehearsalClosedVerbExempt("deftai/directive", V105)).toBe(false);
    expect(isRehearsalClosedVerbExempt(`evil-${slug}`, REHEARSAL_VERSION)).toBe(false);
    expect(isRehearsalClosedVerbExempt(`otherorg/${slug}`, REHEARSAL_VERSION)).toBe(false);
    expect(isRehearsalClosedVerbExempt(slug, REHEARSAL_VERSION)).toBe(false);
  });

  it("production deftai/directive + real version + DEFT_RELEASE_E2E=1 still denies (#4000)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prev = process.env.DEFT_RELEASE_E2E;
    process.env.DEFT_RELEASE_E2E = "1";
    try {
      const seams = recordingSeams({
        closedVerbEnv: { DEFT_RELEASE_E2E: "1" },
        closedVerbGrants: [],
      });
      expect(runPipeline(v105Config(projectRoot), seams)).toBe(EXIT_VIOLATION);
      expect(seams.gitMutations.some((a) => a.includes("tag") && a.includes("-a"))).toBe(false);
      expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(false);
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("closed-verb-deny-missing");
      expect(out).not.toContain("rehearsal-closed-verb-exempt");
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_RELEASE_E2E;
      } else {
        process.env.DEFT_RELEASE_E2E = prev;
      }
    }
  });

  it("evaluateClosedVerb does not honour DEFT_RELEASE_E2E on production identity (#4000)", () => {
    const d = evaluateClosedVerb({
      verb: "release-publish",
      target: V105,
      grants: [],
      env: { DEFT_RELEASE_E2E: "1" },
      repo: "deftai/directive",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("closed-verb-deny-missing");
    const publish = evaluateReleasePublishGate(V105, ".", {
      grants: [],
      env: { DEFT_RELEASE_E2E: "1" },
      repo: "deftai/directive",
    });
    expect(publish.allowed).toBe(false);
    expect(publish.code).toBe("closed-verb-deny-missing");
  });

  it("evaluator still denies rehearsal identity; exemption is the tag-push wrapper (#4000)", () => {
    const repo = `deftai/${REPO_SLUG_PREFIX}20260902-abc`;
    const denied = evaluateReleaseTagPushGate(
      REHEARSAL_VERSION,
      ".",
      { closedVerbGrants: [], closedVerbEnv: {} },
      repo,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("closed-verb-deny-missing");
  });

  it("rehearsal slug + sentinel version tags without a grant or env bypass (#4000)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repo = `deftai/${REPO_SLUG_PREFIX}20260902-abc`;
    const seams = recordingSeams();
    const rc = runPipeline(
      v105Config(projectRoot, { version: REHEARSAL_VERSION, repo, skipRelease: true }),
      seams,
    );
    expect(rc).toBe(EXIT_OK);
    expect(seams.gitMutations.some((a) => a.includes("tag") && a.includes("-a"))).toBe(true);
    expect(seams.gitMutations.some((a) => a.includes("push") && a.includes("--atomic"))).toBe(true);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("rehearsal-closed-verb-exempt");
    expect(out).not.toContain("closed-verb-allow");
    expect(out).not.toContain("closed-verb-env-bypass");
    expect(out).not.toMatch(/grant=/);
  });

  it("sentinel version on deftai/directive still denies (#4000)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams();
    expect(
      runPipeline(
        v105Config(projectRoot, { version: REHEARSAL_VERSION, skipRelease: true }),
        seams,
      ),
    ).toBe(EXIT_VIOLATION);
    expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(false);
  });

  it("prefix-matching slug under another owner still denies (#4000)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams();
    expect(
      runPipeline(
        v105Config(projectRoot, {
          version: REHEARSAL_VERSION,
          repo: `otherorg/${REPO_SLUG_PREFIX}20260902-abc`,
          skipRelease: true,
        }),
        seams,
      ),
    ).toBe(EXIT_VIOLATION);
    expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(false);
  });

  it("throwaway slug with a real version still denies (#4000)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams();
    expect(
      runPipeline(
        v105Config(projectRoot, {
          repo: `deftai/${REPO_SLUG_PREFIX}20260902-abc`,
        }),
        seams,
      ),
    ).toBe(EXIT_VIOLATION);
    expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(false);
  });

  it("env-bypass OK log does not share the authorized-grant shape (#4000 / #3916 AC3)", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recordingSeams({
      closedVerbEnv: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
      closedVerbGrants: [],
    });
    expect(runPipeline(v105Config(projectRoot), seams)).toBe(EXIT_OK);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("closed-verb-env-bypass");
    expect(out).not.toContain("closed-verb-allow");
    expect(out).not.toMatch(/grant=/);
  });

  it("production path reads DEFT_ALLOW_RELEASE_PUBLISH from process.env when seams omit env", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prev = process.env.DEFT_ALLOW_RELEASE_PUBLISH;
    process.env.DEFT_ALLOW_RELEASE_PUBLISH = "1";
    try {
      const seams = recordingSeams({ closedVerbEnv: undefined, closedVerbGrants: undefined });
      expect(runPipeline(v105Config(projectRoot), seams)).toBe(EXIT_OK);
      expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_ALLOW_RELEASE_PUBLISH;
      } else {
        process.env.DEFT_ALLOW_RELEASE_PUBLISH = prev;
      }
    }
  });

  it("production path fail-closed loads disk grants when seams omit env and grants", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prev = process.env.DEFT_ALLOW_RELEASE_PUBLISH;
    delete process.env.DEFT_ALLOW_RELEASE_PUBLISH;
    try {
      const seams = recordingSeams({ closedVerbEnv: undefined, closedVerbGrants: undefined });
      expect(runPipeline(v105Config(projectRoot), seams)).toBe(EXIT_VIOLATION);
      expect(seams.gitMutations.some((a) => a.includes("push"))).toBe(false);
      expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "closed-verb-deny-missing",
      );
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_ALLOW_RELEASE_PUBLISH;
      } else {
        process.env.DEFT_ALLOW_RELEASE_PUBLISH = prev;
      }
    }
  });
});
