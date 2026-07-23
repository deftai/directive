import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWithCache } from "./executor.js";
import { composeCacheKey, hashTaskInputs } from "./hash.js";
import { readCachedTaskRecord } from "./store.js";
import type { TaskContract } from "./types.js";

describe("task-cache hash", () => {
  it("returns incomplete when no inputs are declared", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    const contract: TaskContract = { id: "demo", cacheable: true, inputs: {} };
    expect(hashTaskInputs(root, contract, process.env).complete).toBe(false);
  });

  it("hashes declared files deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    writeFileSync(join(root, "alpha.txt"), "one", "utf8");
    const contract: TaskContract = {
      id: "demo",
      cacheable: true,
      inputs: { globs: ["alpha.txt"] },
    };
    const first = hashTaskInputs(root, contract, process.env);
    const second = hashTaskInputs(root, contract, process.env);
    expect(first.complete).toBe(true);
    expect(first.digest).toBe(second.digest);
  });

  it("changes digest when file content changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    const file = join(root, "alpha.txt");
    writeFileSync(file, "one", "utf8");
    const contract: TaskContract = {
      id: "demo",
      cacheable: true,
      inputs: { globs: ["alpha.txt"] },
    };
    const before = hashTaskInputs(root, contract, process.env).digest;
    writeFileSync(file, "two", "utf8");
    const after = hashTaskInputs(root, contract, process.env).digest;
    expect(before).not.toBe(after);
  });
});

describe("runWithCache", () => {
  it("replays exit-0 cache hits and skips the runner", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    writeFileSync(join(root, "input.txt"), "stable", "utf8");
    const contract: TaskContract = {
      id: "demo-hit",
      cacheable: true,
      inputs: { globs: ["input.txt"] },
    };
    const enumeration = hashTaskInputs(root, contract, process.env);
    const cacheKey = composeCacheKey("demo-hit", enumeration.digest, "1.0.0");
    mkdirSync(join(root, ".deft", "cache", "task", cacheKey.slice(0, 2), cacheKey), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft", "cache", "task", cacheKey.slice(0, 2), cacheKey, "entry.json"),
      JSON.stringify({
        taskId: "demo-hit",
        inputsHash: enumeration.digest,
        codeVersion: "1.0.0",
        exitCode: 0,
        stdout: "cached-output\n",
        stderr: "",
        storedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    let runs = 0;
    const result = runWithCache({
      projectRoot: root,
      contract,
      codeVersion: "1.0.0",
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: "live\n", stderr: "" };
      },
    });
    expect(result.fromCache).toBe(true);
    expect(result.stdout).toBe("cached-output\n");
    expect(runs).toBe(0);
  });

  it("always re-runs failures and never stores them", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    writeFileSync(join(root, "input.txt"), "stable", "utf8");
    const contract: TaskContract = {
      id: "demo-fail",
      cacheable: true,
      inputs: { globs: ["input.txt"] },
    };
    let runs = 0;
    const result = runWithCache({
      projectRoot: root,
      contract,
      codeVersion: "1.0.0",
      runner: () => {
        runs += 1;
        return { exitCode: 1, stdout: "", stderr: "boom" };
      },
    });
    expect(result.exitCode).toBe(1);
    expect(runs).toBe(1);
    const enumeration = hashTaskInputs(root, contract, process.env);
    const cacheKey = composeCacheKey("demo-fail", enumeration.digest, "1.0.0");
    expect(readCachedTaskRecord(root, cacheKey)).toBeNull();
  });

  it("invalidates when codeVersion changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    writeFileSync(join(root, "input.txt"), "stable", "utf8");
    const contract: TaskContract = {
      id: "demo-version",
      cacheable: true,
      inputs: { globs: ["input.txt"] },
    };
    let runs = 0;
    runWithCache({
      projectRoot: root,
      contract,
      codeVersion: "1.0.0",
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: "v1\n", stderr: "" };
      },
    });
    const second = runWithCache({
      projectRoot: root,
      contract,
      codeVersion: "2.0.0",
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: "v2\n", stderr: "" };
      },
    });
    expect(second.fromCache).toBe(false);
    expect(runs).toBe(2);
  });

  it("opts volatile tasks out via cacheable false", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-task-cache-"));
    const contract: TaskContract = {
      id: "demo-volatile",
      cacheable: false,
      inputs: { globs: ["input.txt"] },
    };
    let runs = 0;
    runWithCache({
      projectRoot: root,
      contract,
      codeVersion: "1.0.0",
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: "live\n", stderr: "" };
      },
    });
    runWithCache({
      projectRoot: root,
      contract,
      codeVersion: "1.0.0",
      runner: () => {
        runs += 1;
        return { exitCode: 0, stdout: "live\n", stderr: "" };
      },
    });
    expect(runs).toBe(2);
  });
});
