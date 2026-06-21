import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoutingFile, resolveRoutingPath } from "./routing.js";
import { routingSetMain } from "./routing-set-cli.js";
import { routingVerifyMain } from "./routing-verify-cli.js";

describe("routing-set + routing-verify CLIs", () => {
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

  function freshRoute(): string {
    const dir = mkdtempSync(join(tmpdir(), "routing-cli-"));
    cleanups.push(dir);
    const path = join(dir, "routing.local.json");
    process.env.DEFT_ROUTING_PATH = path;
    return dir;
  }

  it("set then verify round-trips a pinned model (exit 0)", () => {
    const dir = freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "cursor",
        "--role",
        "leaf-implementation",
        "--model",
        "composer-2.5-fast",
        "--project-root",
        dir,
      ]),
    ).toBe(0);
    const path = resolveRoutingPath(dir, process.env);
    expect(loadRoutingFile(path).data?.cursor?.["leaf-implementation"]?.model).toBe(
      "composer-2.5-fast",
    );
    expect(routingVerifyMain(["--project-root", dir, "--provider", "cursor"])).toBe(0);
  });

  it("set --harness-default records an explicit default (exit 0)", () => {
    const dir = freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "cursor",
        "--role",
        "review-monitor",
        "--harness-default",
        "--project-root",
        dir,
      ]),
    ).toBe(0);
  });

  it("set rejects a missing role (exit 2)", () => {
    freshRoute();
    expect(routingSetMain(["--provider", "cursor", "--model", "x"])).toBe(2);
  });

  it("set rejects an unknown role (exit 2)", () => {
    freshRoute();
    expect(routingSetMain(["--provider", "cursor", "--role", "nonsense", "--model", "x"])).toBe(2);
  });

  it("set rejects pin with neither --model nor --harness-default (exit 2)", () => {
    freshRoute();
    expect(routingSetMain(["--provider", "cursor", "--role", "leaf-implementation"])).toBe(2);
  });

  it("set rejects pinning a harness-bound provider (exit 2)", () => {
    freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "grok",
        "--role",
        "leaf-implementation",
        "--model",
        "grok-build",
      ]),
    ).toBe(2);
  });

  it("set ignores --model when --harness-default is also passed (exit 0, records default)", () => {
    const dir = freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "cursor",
        "--role",
        "leaf-implementation",
        "--model",
        "composer-2.5-fast",
        "--harness-default",
        "--project-root",
        dir,
      ]),
    ).toBe(0);
    const path = resolveRoutingPath(dir, process.env);
    expect(loadRoutingFile(path).data?.cursor?.["leaf-implementation"]?.model).toBeNull();
  });

  it("verify rejects an unknown --roles entry (exit 2)", () => {
    const dir = freshRoute();
    expect(
      routingVerifyMain([
        "--project-root",
        dir,
        "--provider",
        "cursor",
        "--roles",
        "leaf-implemenation",
      ]),
    ).toBe(2);
  });

  it("verify --advise never blocks on undecided (exit 0)", () => {
    const dir = freshRoute();
    expect(routingVerifyMain(["--project-root", dir, "--provider", "cursor", "--advise"])).toBe(0);
  });

  it("verify enforce blocks on undecided (exit 1)", () => {
    const dir = freshRoute();
    expect(routingVerifyMain(["--project-root", dir, "--provider", "cursor"])).toBe(1);
  });
});
