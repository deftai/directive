import { afterAll, beforeAll } from "vitest";

/**
 * Host agent markers that leak from the shell running the tests (#6298).
 * Same pattern as hooks/dispatcher.test.ts (#6227), plus AI_AGENT.
 */
export const HOST_ENV_PATTERN = /^(CLAUDE|CURSOR_|GROK_|DEFT_|OPENCLAW|WARP_)/;

export function isHostEnvKey(key: string): boolean {
  return HOST_ENV_PATTERN.test(key) || key === "AI_AGENT";
}

/**
 * Register beforeAll/afterAll hooks that remove ambient host markers from
 * process.env and restore them afterwards. Call once at file top level.
 * Tests that exercise a host path set the markers inside the test.
 */
export function useCleanHostEnv(): void {
  const saved: Record<string, string> = {};
  beforeAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!isHostEnvKey(key)) continue;
      saved[key] = process.env[key] as string;
      delete process.env[key];
    }
  });
  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (isHostEnvKey(key)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });
}
