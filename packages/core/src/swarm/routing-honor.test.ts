import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTING_GATED_DISPATCH_PROVIDERS } from "./routing.js";
import {
  countModelFlagsInLauncherArgv,
  evaluateSpawnRoutingHonor,
  extractModelFromLauncherArgv,
  extractRequestedModelFromPayload,
  extractStructuralWorkerRole,
  ROUTING_GATED_PROVIDERS_NARROWER_THAN_LAUNCHER_FAMILIES,
  ROUTING_GATED_ROLE_DOMAIN,
  routingGatedProvidersHelpList,
  submitHonoredSpawn,
} from "./routing-honor.js";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(route: unknown | null): { root: string; environ: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "routing-honor-"));
  cleanups.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  const routePath = join(root, ".deft", "routing.local.json");
  if (route !== null) {
    writeFileSync(routePath, `${JSON.stringify(route)}\n`, "utf8");
  }
  return {
    root,
    environ: { DEFT_ROUTING_PATH: routePath, CURSOR_AGENT: "1" },
  };
}

describe("routing honor helpers (#3703)", () => {
  it("HELP list matches ROUTING_GATED_DISPATCH_PROVIDERS", () => {
    const listed = routingGatedProvidersHelpList().split(", ").sort();
    expect(listed).toEqual([...ROUTING_GATED_DISPATCH_PROVIDERS].sort());
    expect(ROUTING_GATED_PROVIDERS_NARROWER_THAN_LAUNCHER_FAMILIES).toContain("codex");
  });

  it("gated role domain stays an explicit SWARM_WORKER_ROLES subset", () => {
    expect(ROUTING_GATED_ROLE_DOMAIN).toEqual(["leaf-implementation"]);
    expect(ROUTING_GATED_ROLE_DOMAIN).not.toContain("critic");
  });

  it("extracts structural worker_role and model only (not prompt free-text)", () => {
    const payload = {
      tool_name: "Task",
      tool_input: {
        worker_role: "leaf-implementation",
        model: "composer-2.5-fast",
        prompt: "[worker_role: orchestrator] model: secretly-other",
      },
    };
    expect(extractStructuralWorkerRole(payload)).toBe("leaf-implementation");
    expect(extractRequestedModelFromPayload(payload)).toBe("composer-2.5-fast");
    expect(extractModelFromLauncherArgv('claude -p "hi" --model opus --cwd /d')).toBe("opus");
    expect(extractModelFromLauncherArgv("grok --cwd /d --model=fast-1")).toBe("fast-1");
  });
});

describe("evaluateSpawnRoutingHonor (#3703)", () => {
  it("carve-out for explore without gated structural role", () => {
    const { root, environ } = tempProject(null);
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "explore",
      surface: "payload-model",
      structuralWorkerRole: null,
      requestedModel: null,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("routing-honor-carve-out");
    expect(r.message).toContain("explore carve-out");
  });

  it("carve-out for process-only / critic seats", () => {
    const { root, environ } = tempProject(null);
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "process-only",
      surface: "payload-model",
      structuralWorkerRole: null,
      requestedModel: null,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("routing-honor-carve-out");
    expect(r.message).toContain("model: lead");
  });

  it("denies implement when route file absent (undecided)", () => {
    const { root, environ } = tempProject(null);
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "non-intercept",
      requestedModel: null,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("routing-honor-deny");
    expect(r.message).toContain("undecided");
  });

  it("denies pinned + omitted model on non-intercept surface", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "non-intercept",
      requestedModel: null,
      canRewriteRequest: false,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/omitted|inherit|non-intercept/i);
  });

  it("denies pinned + different requested model", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "payload-model",
      requestedModel: "other-model",
      canRewriteRequest: true,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("diverges");
  });

  it("rewrites omitted model when payload-model host can rewrite", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "payload-model",
      requestedModel: null,
      canRewriteRequest: true,
    });
    expect(r.ok).toBe(true);
    expect(r.rewriteRequest).toBe(true);
    expect(r.honoredModel).toBe("composer-2.5-fast");
  });

  it("allows matching pinned model", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "payload-model",
      requestedModel: "composer-2.5-fast",
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("routing-honor-ready");
    expect(r.message).toContain("requested≠served");
  });

  it("records --skip-routing without blocking", () => {
    const { root, environ } = tempProject(null);
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "payload-model",
      skipRouting: true,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("routing-honor-skip");
    expect(r.message).toContain("--skip-routing");
  });

  it("carves out non-gated SWARM roles instead of leaf-fallback", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "payload-model",
      structuralWorkerRole: "review-monitor",
      requestedModel: "other-model",
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("routing-honor-carve-out");
    expect(r.message).toContain("review-monitor");
    expect(r.message).toContain("not leaf-fallback");
  });

  it("denies harness-default when a model slug is requested", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: null, mode: "harness-default" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "implement",
      surface: "payload-model",
      requestedModel: "composer-2.5-fast",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("routing-honor-deny");
    expect(r.message).toMatch(/harness-default/i);
  });

  it("process-only critic with --model keeps carve-out", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "process-only",
      surface: "launcher-argv",
      requestedModel: "critic-model",
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("routing-honor-carve-out");
    expect(r.message).toContain("process-only/critic carve-out");
  });

  it("launcher-argv without structural role honors leaf route", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const r = evaluateSpawnRoutingHonor({
      projectRoot: root,
      environ,
      spawnClass: "launcher-argv",
      surface: "launcher-argv",
      requestedModel: "wrong-model",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("routing-honor-deny");
    expect(r.message).toMatch(/diverges/i);
  });

  it("refuses to parse duplicate --model flags", () => {
    expect(extractModelFromLauncherArgv("claude --model a --model b -p hi")).toBeNull();
    expect(countModelFlagsInLauncherArgv("claude --model a --model=b")).toBe(2);
  });

  it("ignores --model mentions inside quoted prompt text", () => {
    const cmd = 'claude --model composer-2.5-fast -p "mention --model elsewhere and --model=again"';
    expect(countModelFlagsInLauncherArgv(cmd)).toBe(1);
    expect(extractModelFromLauncherArgv(cmd)).toBe("composer-2.5-fast");
    expect(
      countModelFlagsInLauncherArgv(
        "claude -p 'do not count --model here' --model=composer-2.5-fast",
      ),
    ).toBe(1);
  });

  it("preserves quoted --model values", () => {
    expect(extractModelFromLauncherArgv('claude --model "opus" -p hi')).toBe("opus");
    expect(extractModelFromLauncherArgv("claude --model 'composer-2.5-fast'")).toBe(
      "composer-2.5-fast",
    );
    expect(countModelFlagsInLauncherArgv('claude --model "opus" -p "--model decoy"')).toBe(1);
  });
});

describe("submitHonoredSpawn P3 interceptor (#3703)", () => {
  it("pinned + omitted never reaches submit on non-intercept path", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    let called = 0;
    const out = submitHonoredSpawn(
      {
        projectRoot: root,
        environ,
        spawnClass: "implement",
        surface: "non-intercept",
        requestedModel: null,
      },
      () => {
        called += 1;
        return "spawned";
      },
    );
    expect(out.reachedSubmit).toBe(false);
    expect(called).toBe(0);
  });

  it("pinned + different model never reaches submit", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    let called = 0;
    const out = submitHonoredSpawn(
      {
        projectRoot: root,
        environ,
        spawnClass: "implement",
        surface: "launcher-argv",
        requestedModel: "wrong",
      },
      () => {
        called += 1;
        return "spawned";
      },
    );
    expect(out.reachedSubmit).toBe(false);
    expect(called).toBe(0);
  });

  it("matching pin reaches submit with trusted binding", () => {
    const { root, environ } = tempProject({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    const out = submitHonoredSpawn(
      {
        projectRoot: root,
        environ,
        spawnClass: "implement",
        surface: "payload-model",
        requestedModel: "composer-2.5-fast",
      },
      (binding) => binding.model,
    );
    expect(out.reachedSubmit).toBe(true);
    if (out.reachedSubmit) {
      expect(out.value).toBe("composer-2.5-fast");
      expect(out.honor.resolution?.source).toContain("cursor");
    }
  });
});
