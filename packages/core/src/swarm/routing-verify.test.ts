import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRouting } from "./routing-verify.js";

function withRouteFile(contents: Record<string, unknown> | string): {
  dir: string;
  path: string;
  env: NodeJS.ProcessEnv;
} {
  const dir = mkdtempSync(join(tmpdir(), "routing-verify-"));
  const path = join(dir, "routing.local.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return { dir, path, env: { DEFT_ROUTING_PATH: path } };
}

describe("verifyRouting (enforce posture, three-state)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("exit 0 when the gated role is pinned", () => {
    const { dir, env } = withRouteFile({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    cleanups.push(dir);
    const r = verifyRouting({ projectRoot: dir, environ: env, provider: "cursor" });
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("composer-2.5-fast");
  });

  it("exit 0 on explicit harness-default", () => {
    const { dir, env } = withRouteFile({
      cursor: { "leaf-implementation": { model: null, mode: "harness-default" } },
    });
    cleanups.push(dir);
    expect(verifyRouting({ projectRoot: dir, environ: env, provider: "cursor" }).exitCode).toBe(0);
  });

  it("exit 1 when the gated role is undecided (no route file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-verify-"));
    cleanups.push(dir);
    const r = verifyRouting({
      projectRoot: dir,
      environ: { DEFT_ROUTING_PATH: join(dir, "absent.json") },
      provider: "cursor",
    });
    expect(r.exitCode).toBe(1);
    expect(r.report).toContain("undecided");
    expect(r.report).toContain("routing-set");
  });

  it("exit 2 on a malformed route file", () => {
    const { dir, env } = withRouteFile("{not json");
    cleanups.push(dir);
    expect(verifyRouting({ projectRoot: dir, environ: env, provider: "cursor" }).exitCode).toBe(2);
  });

  it("exit 2 when a harness-bound provider is pinned to a model", () => {
    const { dir, env } = withRouteFile({
      grok: { "leaf-implementation": { model: "grok-build", mode: "pinned" } },
    });
    cleanups.push(dir);
    const r = verifyRouting({ projectRoot: dir, environ: env, provider: "grok" });
    expect(r.exitCode).toBe(2);
    expect(r.report).toContain("harness-bound");
  });

  it("respects a widened --roles set", () => {
    const { dir, env } = withRouteFile({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    cleanups.push(dir);
    const r = verifyRouting({
      projectRoot: dir,
      environ: env,
      provider: "cursor",
      roles: ["leaf-implementation", "orchestrator"],
    });
    expect(r.exitCode).toBe(1);
    expect(r.report).toContain("orchestrator");
  });
});

describe("verifyRouting (advise posture, never blocks)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("exit 0 with a decided disclosure", () => {
    const { dir, env } = withRouteFile({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    });
    cleanups.push(dir);
    const r = verifyRouting({ projectRoot: dir, environ: env, provider: "cursor", advise: true });
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("all");
  });

  it("exit 0 surfacing undecided roles without blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-verify-"));
    cleanups.push(dir);
    const r = verifyRouting({
      projectRoot: dir,
      environ: { DEFT_ROUTING_PATH: join(dir, "absent.json") },
      provider: "cursor",
      advise: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain("undecided");
  });

  it("exit 0 even on a malformed route file (advisory)", () => {
    const { dir, env } = withRouteFile("{not json");
    cleanups.push(dir);
    expect(
      verifyRouting({ projectRoot: dir, environ: env, provider: "cursor", advise: true }).exitCode,
    ).toBe(0);
  });
});
