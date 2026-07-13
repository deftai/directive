import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedReleaseProjectDir } from "./pipeline-fixture.js";

describe("seedReleaseProjectDir", () => {
  it("creates changelog and roadmap on disk", () => {
    const dir = seedReleaseProjectDir();
    try {
      expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(true);
      expect(existsSync(join(dir, "ROADMAP.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
