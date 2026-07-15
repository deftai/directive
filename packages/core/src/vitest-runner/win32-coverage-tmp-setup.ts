import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const COVERAGE_TMP = resolve(process.cwd(), "coverage", ".tmp");

function ensureCoverageTmpDir(): void {
  mkdirSync(COVERAGE_TMP, { recursive: true });
}

/**
 * Win32 globalSetup for coverage runs (#2580).
 *
 * Vitest's v8 provider writes per-suite JSON under coverage/.tmp without always
 * re-mkdir'ing before writeFile. Under parallel fork load the directory can
 * disappear mid-suite, surfacing as ENOENT after an otherwise green run.
 * Keep the directory present for the coordinator process; late ENOENT flakes
 * are tolerated via vitest dangerouslyIgnoreUnhandledErrors (#2546) without
 * soft-failing real coverage threshold failures.
 */
export default function setup(): void {
  if (process.platform !== "win32") return;

  ensureCoverageTmpDir();

  const keepalive = setInterval(ensureCoverageTmpDir, 100);
  keepalive.unref?.();
}
