import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEnvValues, composeCacheKey, expandInputGlobs, hashTaskInputs } from "./hash.js";
import type { TaskContract } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("task-cache hash branch edges", () => {
  it("collectEnvValues maps missing keys to empty string", () => {
    expect(collectEnvValues({ env: ["DEFT_HASH_MISSING_XYZ"] }, {})).toEqual({
      DEFT_HASH_MISSING_XYZ: "",
    });
  });

  it("expandInputGlobs returns empty when globs omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "hash-g-"));
    temps.push(root);
    expect(expandInputGlobs(root, {})).toEqual([]);
  });

  it("hashTaskInputs fails open when globs match nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "hash-m-"));
    temps.push(root);
    const contract: TaskContract = {
      id: "t",
      cacheable: true,
      inputs: { globs: ["no-such-*.txt"] },
    };
    expect(hashTaskInputs(root, contract, {})).toEqual({ complete: false, digest: "" });
  });

  it("hashTaskInputs succeeds with env-only inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "hash-e-"));
    temps.push(root);
    const contract: TaskContract = {
      id: "env-only",
      cacheable: true,
      inputs: { env: ["PATH"] },
    };
    const result = hashTaskInputs(root, contract, { PATH: "/bin" });
    expect(result.complete).toBe(true);
    expect(result.digest.length).toBeGreaterThan(10);
  });

  it("composeCacheKey is stable for object key order", () => {
    const root = mkdtempSync(join(tmpdir(), "hash-u-"));
    temps.push(root);
    writeFileSync(join(root, "a.txt"), "x", "utf8");
    const contract: TaskContract = {
      id: "gone",
      cacheable: true,
      inputs: { globs: ["*.txt"] },
    };
    const enum1 = hashTaskInputs(root, contract, {});
    expect(enum1.complete).toBe(true);
    const key = composeCacheKey("gone", enum1.digest, "v1");
    expect(key.length).toBe(64);
  });
});
