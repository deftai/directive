import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POST_PUBLISH_INSTALL_BACKOFF_MS,
  POST_PUBLISH_INSTALL_RETRY_BOUND_MS,
} from "./constants.js";
import {
  isRegistryPropagationFailure,
  isTwoPassDeferredWarning,
  postPublishTwoPassCliStatus,
  runPostPublishTwoPassFixture,
  runTagBoundRegistryInstall,
} from "./npm-ops.js";

const ETARGET = "npm error ETARGET: No matching version found for @deftai/directive-core@0.116.0";

describe("post-publish install retry (#4398)", () => {
  it("classifies propagation vs real install failure", () => {
    expect(isRegistryPropagationFailure(ETARGET)).toBe(true);
    expect(
      isRegistryPropagationFailure(
        "npm error 404 Not Found - GET https://registry.npmjs.org/@deftai/directive-core/0.116.0",
      ),
    ).toBe(true);
    expect(
      isRegistryPropagationFailure(
        "Your package is being processed and may take a few minutes @deftai/directive-core",
      ),
    ).toBe(true);
    expect(isRegistryPropagationFailure("E404 Not Found")).toBe(false);
    expect(isRegistryPropagationFailure("npm error E401 Unauthorized")).toBe(false);
    expect(isRegistryPropagationFailure("npm error E403 Forbidden")).toBe(false);
    expect(isRegistryPropagationFailure("EPERM unlink")).toBe(false);
    expect(
      isRegistryPropagationFailure(
        "npm error ETARGET: No matching version found for lodash@1.0.0",
        ["@deftai/directive-core@0.116.0"],
      ),
    ).toBe(false);
  });

  it("fuzzes the propagation classifier without a live registry", () => {
    const hits = [
      "ETARGET No matching version found for @deftai/directive-core@0.116.0",
      "etarget: No matching version found for @deftai/directive-core",
      "npm ERR! code ETARGET @deftai/directive-core",
      "No matching version found for @deftai/directive@1.0.0",
      "E404 @deftai/directive-types",
      "e404 not found @deftai/directive-content",
      "404 Not Found @deftai/directive",
      "npm error 404 Not Found @deftai/directive-core",
      "being processed @deftai/directive-core",
      "Your package is being processed @deftai/directive",
      "Not Found - GET https://registry.npmjs.org/@deftai/directive-core/0.116.0",
      "ETARGET\nNo matching version found for @deftai/directive-core",
      "npm error E404 @deftai/directive-core",
      "still being processed and may take a few minutes to become available @deftai/directive-core",
    ];
    const misses = [
      "E401 Unauthorized",
      "E403 Forbidden",
      "EPERM",
      "ENOSPC",
      "EACCES",
      "ERESOLVE could not resolve",
      "ECONNREFUSED",
      "certificate has expired",
      "EINTEGRITY",
      "invalid package.json",
      "npm missing (hard fail)",
      "tag-bind FAIL",
      "Pass 2 precondition failed",
      "E409 Conflict",
      "usage: npm install",
      "",
      "ok",
      "published",
      "E500",
      "socket hang up",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "EJSONPARSE",
      "peer dep missing",
      "Cannot find module",
      "ERR_MODULE_NOT_FOUND",
      "EEXIST",
      "ENOENT package.json",
      "audit error",
      "cb() never called",
      "Maximum call stack",
      "unexpected end of JSON",
      "EUNSUPPORTEDPROTOCOL",
      "invalid spec",
      "ELOOP",
      "EISDIR",
      "not a git repository",
      "ETARGET",
      "E404",
      "404 Not Found",
      "being processed",
      "npm error ETARGET: No matching version found for lodash@1.0.0",
    ];
    expect(hits.length + misses.length).toBeGreaterThanOrEqual(50);
    for (const sample of hits) expect(isRegistryPropagationFailure(sample)).toBe(true);
    for (const sample of misses) expect(isRegistryPropagationFailure(sample)).toBe(false);
  });

  it("retries ETARGET with real backoff then succeeds", () => {
    let attempts = 0;
    const sleeps: number[] = [];
    let now = 0;
    const [ok, reason] = runTagBoundRegistryInstall(
      {
        npmPath: "/usr/bin/npm",
        cleanDir: mkdtempSync(join(tmpdir(), "deft-4398-retry-")),
        specs: ["@deftai/directive-core@1.2.3"],
      },
      {
        now: () => new Date(now),
        sleepMs: (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        spawnText: (_cmd, args, options) => {
          expect(args).toContain("install");
          expect(args).toContain("--ignore-scripts");
          expect(args.includes("view")).toBe(false);
          if (attempts === 0) {
            expect(options?.timeoutMs).toBe(POST_PUBLISH_INSTALL_RETRY_BOUND_MS);
          }
          expect(options?.timeoutMs).toBeLessThanOrEqual(POST_PUBLISH_INSTALL_RETRY_BOUND_MS);
          attempts += 1;
          if (attempts === 1) {
            return { status: 1, stdout: "", stderr: ETARGET };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(ok).toBe(true);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([POST_PUBLISH_INSTALL_BACKOFF_MS[0]]);
    expect(reason).toContain("tag-bound registry install OK");
    expect(isTwoPassDeferredWarning(reason)).toBe(false);
  });

  it("warns after the bound instead of failing a still-propagating registry", () => {
    const sleeps: number[] = [];
    let now = 0;
    let attempts = 0;
    const [ok, reason] = runTagBoundRegistryInstall(
      {
        npmPath: "/usr/bin/npm",
        cleanDir: mkdtempSync(join(tmpdir(), "deft-4398-warn-")),
        specs: ["@deftai/directive-core@0.116.0"],
      },
      {
        now: () => new Date(now),
        sleepMs: (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        spawnText: () => {
          attempts += 1;
          return { status: 1, stdout: "", stderr: ETARGET };
        },
      },
    );
    expect(ok).toBe(true);
    expect(isTwoPassDeferredWarning(reason)).toBe(true);
    expect(reason).toContain(String(POST_PUBLISH_INSTALL_RETRY_BOUND_MS));
    expect(attempts).toBeGreaterThan(1);
    expect(sleeps[0]).toBe(POST_PUBLISH_INSTALL_BACKOFF_MS[0]);
    expect(now).toBeGreaterThanOrEqual(POST_PUBLISH_INSTALL_RETRY_BOUND_MS);
    expect(postPublishTwoPassCliStatus(ok, reason)).toEqual({
      exitCode: 0,
      stream: "stderr",
    });
  });

  it("hard-fails non-propagation install errors without sleeping", () => {
    const sleeps: number[] = [];
    const [ok, reason] = runTagBoundRegistryInstall(
      {
        npmPath: "/usr/bin/npm",
        cleanDir: mkdtempSync(join(tmpdir(), "deft-4398-hard-")),
        specs: ["@deftai/directive-core@1.2.3"],
      },
      {
        sleepMs: (ms) => sleeps.push(ms),
        spawnText: () => ({
          status: 1,
          stdout: "",
          stderr: "npm error E401 Unauthorized",
        }),
      },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("E401");
    expect(sleeps).toEqual([]);
    expect(postPublishTwoPassCliStatus(ok, reason)).toEqual({
      exitCode: 1,
      stream: "stderr",
    });
  });

  it("hard-fails ETARGET for an unrelated transitive dependency", () => {
    const sleeps: number[] = [];
    const [ok, reason] = runTagBoundRegistryInstall(
      {
        npmPath: "/usr/bin/npm",
        cleanDir: mkdtempSync(join(tmpdir(), "deft-4398-unrelated-")),
        specs: ["@deftai/directive-core@0.116.0"],
      },
      {
        sleepMs: (ms) => sleeps.push(ms),
        spawnText: () => ({
          status: 1,
          stdout: "",
          stderr: "npm error ETARGET: No matching version found for lodash@1.0.0",
        }),
      },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("lodash");
    expect(sleeps).toEqual([]);
  });

  it("caps each install spawn to the remaining bound", () => {
    const timeouts: number[] = [];
    let now = 0;
    let spawns = 0;
    runTagBoundRegistryInstall(
      {
        npmPath: "/usr/bin/npm",
        cleanDir: mkdtempSync(join(tmpdir(), "deft-4398-cap-")),
        specs: ["@deftai/directive-core@0.116.0"],
      },
      {
        now: () => new Date(now),
        sleepMs: (ms) => {
          now += ms;
        },
        spawnText: (_cmd, _args, options) => {
          timeouts.push(options?.timeoutMs ?? 0);
          spawns += 1;
          if (spawns === 1) now = POST_PUBLISH_INSTALL_RETRY_BOUND_MS - 45_000;
          return { status: 1, stdout: "", stderr: ETARGET };
        },
      },
    );
    expect(timeouts[0]).toBe(POST_PUBLISH_INSTALL_RETRY_BOUND_MS);
    expect(timeouts[1]).toBe(30_000);
    expect(timeouts.every((ms) => ms <= POST_PUBLISH_INSTALL_RETRY_BOUND_MS)).toBe(true);
  });

  it("fixture returns deferred warn without dropping tag-bind on success", () => {
    const clean = mkdtempSync(join(tmpdir(), "deft-4398-fix-"));
    mkdirSync(join(clean, "node_modules", "@deftai", "directive"), { recursive: true });
    writeFileSync(
      join(clean, "node_modules", "@deftai", "directive", "package.json"),
      JSON.stringify({ name: "@deftai/directive", version: "1.2.3" }),
    );
    let now = 0;
    const [deferredOk, deferredReason] = runPostPublishTwoPassFixture(
      { cleanDir: clean, workspaceRoot: process.cwd(), version: "1.2.3" },
      {
        which: () => "/usr/bin/npm",
        now: () => new Date(now),
        sleepMs: (ms) => {
          now += ms;
        },
        spawnText: () => ({ status: 1, stdout: "", stderr: ETARGET }),
      },
    );
    expect(deferredOk).toBe(true);
    expect(isTwoPassDeferredWarning(deferredReason)).toBe(true);

    const [ok, reason] = runPostPublishTwoPassFixture(
      {
        cleanDir: clean,
        workspaceRoot: process.cwd(),
        version: "1.2.3",
        skipInstall: true,
        pass2ChangedPaths: [".deft/core/main.md"],
      },
      { which: () => "/usr/bin/npm" },
    );
    expect(ok).toBe(true);
    expect(reason).toContain("two-pass fixture green");
  });

  it("keeps Atomics.wait, ignore-scripts, provenance; skips view-as-pass and pollWorkspacePackages", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/core/src/release-e2e/npm-ops.ts"),
      "utf8",
    );
    expect(src).toContain("Atomics.wait");
    expect(src).toContain("seams.sleepMs ?? defaultPostPublishSleepMs");
    expect(src).toContain("--ignore-scripts");
    expect(src).not.toContain("() => undefined");
    expect(src).not.toContain("pollWorkspacePackages");
    const fn = src.slice(
      src.indexOf("export function runTagBoundRegistryInstall"),
      src.indexOf("export function runPostPublishTwoPassFixture"),
    );
    expect(fn).toContain("--ignore-scripts");
    expect(fn.includes("npm view")).toBe(false);
    const yml = readFileSync(join(process.cwd(), ".github/workflows/npm-publish.yml"), "utf8");
    expect(yml.match(/npm publish --provenance/g)?.length).toBe(4);
    expect(yml).toContain("--post-publish-two-pass");
  });

  it("green fixture still exits 0 on stdout", () => {
    expect(
      postPublishTwoPassCliStatus(true, "post-publish two-pass fixture green at v1.2.3"),
    ).toEqual({
      exitCode: 0,
      stream: "stdout",
    });
  });
});
