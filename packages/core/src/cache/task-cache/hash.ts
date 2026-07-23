import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { TaskContract, TaskInputSpec } from "./types.js";

export interface InputEnumeration {
  readonly complete: boolean;
  readonly digest: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/** Expand declared globs under projectRoot; returns sorted relative paths. */
export function expandInputGlobs(projectRoot: string, spec: TaskInputSpec): string[] {
  const root = resolve(projectRoot);
  const globs = spec.globs ?? [];
  const paths = new Set<string>();
  for (const pattern of globs) {
    let matches: string[];
    try {
      matches = globSync(pattern, { cwd: root }).filter((match) => {
        try {
          return !statSync(resolve(root, match)).isDirectory();
        } catch {
          return true;
        }
      });
    } catch {
      return [];
    }
    for (const match of matches) {
      paths.add(relative(root, resolve(root, match)).replace(/\\/g, "/"));
    }
  }
  return [...paths].sort();
}

/** Collect env values for declared keys (missing vars map to empty string). */
export function collectEnvValues(
  spec: TaskInputSpec,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of spec.env ?? []) {
    out[key] = env[key] ?? "";
  }
  return out;
}

/**
 * Hash declared inputs. Returns `complete: false` when no inputs are declared
 * (fail open to running — never cache without explicit enumeration).
 */
export function hashTaskInputs(
  projectRoot: string,
  contract: TaskContract,
  env: NodeJS.ProcessEnv,
): InputEnumeration {
  const spec = contract.inputs;
  const hasGlobs = (spec.globs?.length ?? 0) > 0;
  const hasEnv = (spec.env?.length ?? 0) > 0;
  if (!hasGlobs && !hasEnv) {
    return { complete: false, digest: "" };
  }

  const files = expandInputGlobs(projectRoot, spec);
  if (hasGlobs && files.length === 0) {
    return { complete: false, digest: "" };
  }

  const fileHashes: Record<string, string> = {};
  for (const rel of files) {
    const abs = resolve(projectRoot, rel);
    try {
      fileHashes[rel] = hashFile(abs);
    } catch {
      // Fail open: a file removed/unreadable between glob and read must not crash check.
      return { complete: false, digest: "" };
    }
  }

  const payload = {
    taskId: contract.id,
    files: fileHashes,
    env: collectEnvValues(spec, env),
  };
  const digest = createHash("sha256").update(stableJson(payload)).digest("hex");
  return { complete: true, digest };
}

/** Compose the final cache key digest including codeVersion. */
export function composeCacheKey(taskId: string, inputsHash: string, codeVersion: string): string {
  return createHash("sha256").update(stableJson({ taskId, inputsHash, codeVersion })).digest("hex");
}
