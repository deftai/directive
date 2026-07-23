import { lintTaskRegistry } from "./lint.js";
import { TASK_REGISTRY } from "./registry.js";

export { DEFAULT_TASK_CACHE_ROOT, TASK_CACHE_MANIFEST } from "./constants.js";
export { runWithCache } from "./executor.js";
export { composeCacheKey, expandInputGlobs, hashTaskInputs } from "./hash.js";
export { lintTaskContract, lintTaskRegistry } from "./lint.js";
export {
  defaultNonCacheableContract,
  lookupTaskContract,
  resolveTaskContract,
  TASK_REGISTRY,
} from "./registry.js";
export {
  clearTaskCache,
  readCachedTaskRecord,
  taskCacheRoot,
  writeCachedTaskRecord,
} from "./store.js";
export type {
  CachedTaskRecord,
  RegistryLintFinding,
  RunWithCacheOptions,
  TaskContract,
  TaskInputSpec,
  TaskRunResult,
} from "./types.js";

/** Lint the shipped registry; under-declared cacheable tasks fail closed. */
export function lintShippedRegistry(): {
  ok: boolean;
  findings: ReturnType<typeof lintTaskRegistry>;
} {
  const findings = lintTaskRegistry(TASK_REGISTRY);
  const blocking = findings.filter((f) => f.kind === "under-declared-input");
  return { ok: blocking.length === 0, findings };
}
