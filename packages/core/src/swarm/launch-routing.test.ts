import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, type ResolvedStory, swarmLaunch } from "./launch.js";

const story: ResolvedStory = {
  token: "story-a",
  story_id: "story-a",
  path: "/abs/story-a.vbrief.json",
  relpath: "vbrief/active/story-a.vbrief.json",
};

describe("buildManifest model stamping", () => {
  it("stamps resolved_model + model_source when a source is supplied", () => {
    const [entry] = buildManifest([story], {
      projectRoot: "/p",
      dispatchKind: "solo",
      allocationPlanId: null,
      batchingRationale: null,
      operatorApprovalEvidence: null,
      resolvedModel: "composer-2.5-fast",
      modelSource: "cursor-route",
    });
    expect(entry?.resolved_model).toBe("composer-2.5-fast");
    expect(entry?.model_source).toBe("cursor-route");
  });

  it("stamps a null resolved_model for an explicit harness default (source present)", () => {
    const [entry] = buildManifest([story], {
      projectRoot: "/p",
      dispatchKind: "solo",
      allocationPlanId: null,
      batchingRationale: null,
      operatorApprovalEvidence: null,
      resolvedModel: null,
      modelSource: "harness-default explicit",
    });
    expect(entry?.resolved_model).toBeNull();
    expect(entry?.model_source).toBe("harness-default explicit");
  });

  it("omits both fields when no model source is supplied (legacy/parity-safe)", () => {
    const [entry] = buildManifest([story], {
      projectRoot: "/p",
      dispatchKind: "solo",
      allocationPlanId: null,
      batchingRationale: null,
      operatorApprovalEvidence: null,
    });
    expect("resolved_model" in (entry ?? {})).toBe(false);
    expect("model_source" in (entry ?? {})).toBe(false);
  });
});

function writeReadyStory(project: string, storyId: string, issue: number): void {
  const full = join(project, "vbrief", "active", `${storyId}.vbrief.json`);
  mkdirSync(join(project, "vbrief", "active"), { recursive: true });
  writeFileSync(
    full,
    `${JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        id: storyId,
        title: storyId,
        status: "running",
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issue}`,
            type: "x-vbrief/github-issue",
          },
        ],
        metadata: { kind: "story", swarm: { readiness: "ready" } },
      },
    })}\n`,
    "utf8",
  );
}

describe("swarmLaunch route-file integration (#1739)", () => {
  const saved = process.env.DEFT_ROUTING_PATH;
  const cleanups: string[] = [];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.DEFT_ROUTING_PATH;
    } else {
      process.env.DEFT_ROUTING_PATH = saved;
    }
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("threads the pinned model into the manifest and bypasses the enum gate", () => {
    const project = mkdtempSync(join(tmpdir(), "launch-route-"));
    cleanups.push(project);
    writeReadyStory(project, "story-a", 8801);
    const routePath = join(project, "routing.local.json");
    writeFileSync(
      routePath,
      JSON.stringify({
        cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
      }),
    );
    process.env.DEFT_ROUTING_PATH = routePath;

    const result = swarmLaunch({
      stories: ["8801"],
      projectRoot: project,
      autonomous: true,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["cursor-cloud", "gh-cli"],
    });

    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(manifest[0]?.resolved_model).toBe("composer-2.5-fast");
    expect(manifest[0]?.model_source).toBe("cursor-route");
    expect(manifest[0]?.dispatch_provider).toBe("cursor");
    expect(manifest[0]?.worker_role).toBe("leaf-implementation");
    expect("subagent_backend" in (manifest[0] ?? {})).toBe(false);
  });

  it("fails loud (exit 2) when the gated role's decision object is malformed", () => {
    const project = mkdtempSync(join(tmpdir(), "launch-route-"));
    cleanups.push(project);
    writeReadyStory(project, "story-a", 8801);
    const routePath = join(project, "routing.local.json");
    writeFileSync(
      routePath,
      JSON.stringify({ cursor: { "leaf-implementation": "not-an-object" } }),
    );
    process.env.DEFT_ROUTING_PATH = routePath;

    const result = swarmLaunch({
      stories: ["8801"],
      projectRoot: project,
      autonomous: true,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["cursor-cloud", "gh-cli"],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("routing gate misconfigured");
    expect(result.stdout).toBe("");
  });
});
