import type { TaskContract } from "./types.js";

/** Internal gate/task registry for directive dogfood (#1713). */
export const TASK_REGISTRY: readonly TaskContract[] = [
  {
    id: "verify:biome-config",
    cacheable: true,
    inputs: { globs: ["biome.json", "biome.jsonc"] },
    knownReadSet: { globs: ["biome.json", "biome.jsonc"] },
  },
  {
    id: "verify:encoding",
    cacheable: true,
    inputs: {
      globs: ["biome.json", "packages/**/*.ts", "packages/**/*.tsx", "content/**/*"],
    },
    knownReadSet: {
      globs: ["biome.json", "packages/**/*.ts", "packages/**/*.tsx", "content/**/*"],
    },
  },
  {
    id: "toolchain:check",
    cacheable: true,
    inputs: {
      globs: ["package.json", "pnpm-lock.yaml", ".nvmrc", ".node-version"],
      env: ["PATH"],
    },
    knownReadSet: {
      globs: ["package.json", "pnpm-lock.yaml", ".nvmrc", ".node-version"],
      env: ["PATH"],
    },
  },
  {
    id: "verify:branch",
    cacheable: false,
    inputs: { env: ["GIT_BRANCH", "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT"] },
    knownReadSet: {
      globs: [".git/HEAD"],
      env: ["GIT_BRANCH", "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT"],
    },
  },
  {
    id: "verify:cache-fresh",
    cacheable: false,
    inputs: {},
    knownReadSet: { globs: [".deft-cache/**/*", "xbrief/.triage-cache/**/*"] },
  },
  {
    id: "doctor",
    cacheable: false,
    inputs: {},
    knownReadSet: { globs: ["**/*"] },
  },
];

const REGISTRY_MAP = new Map(TASK_REGISTRY.map((entry) => [entry.id, entry]));

export function lookupTaskContract(taskId: string): TaskContract | undefined {
  return REGISTRY_MAP.get(taskId);
}

export function defaultNonCacheableContract(taskId: string): TaskContract {
  return {
    id: taskId,
    cacheable: false,
    inputs: {},
  };
}

export function resolveTaskContract(taskId: string): TaskContract {
  return lookupTaskContract(taskId) ?? defaultNonCacheableContract(taskId);
}
