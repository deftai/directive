import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRunGh } from "./gh.js";

const COLOR_GH_STUB = resolve(import.meta.dirname, "fixtures", "color-gh-stub.mjs");
const ISSUE_PATH = "repos/deftai/directive/issues/6023";

describe("defaultRunGh ENOENT", () => {
  it("returns not-found when gh binary missing", () => {
    const result = defaultRunGh(["gh", "version"]);
    if (result.returncode === -1 && result.stderr.includes("not found")) {
      expect(result.stderr).toContain("gh CLI not found");
    } else {
      expect(result.returncode).toBe(0);
    }
  });
});

describe("defaultRunGh failure path", () => {
  it("returns non-zero status with stderr on invalid subcommand", () => {
    const result = defaultRunGh(["gh", "this-subcommand-does-not-exist-xyz"]);
    expect(result.returncode).not.toBe(0);
  });
});

describe("defaultRunGh plain output under color-forcing env (#6023)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stub gh colors JSON when CLICOLOR_FORCE reaches it (fixture sanity)", () => {
    const raw = execFileSync(process.execPath, [COLOR_GH_STUB, "api", ISSUE_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLICOLOR_FORCE: "1" },
    });
    expect(raw).toContain("\u001b[");
    expect(() => JSON.parse(raw)).toThrow();
  });

  // CLICOLOR_FORCE is the documented gh color force; the FORCE_COLOR row is
  // defensive only (gh does not document it; the stub colors on it anyway).
  it.each([
    ["CLICOLOR_FORCE", "1", "documented"],
    ["FORCE_COLOR", "1", "defensive"],
  ])("returns parseable JSON with %s=%s in the parent env (%s)", (key, value) => {
    vi.stubEnv(key, value);
    vi.stubEnv("NO_COLOR", "");
    const result = defaultRunGh(["gh", COLOR_GH_STUB, "api", ISSUE_PATH], process.execPath);
    expect(result.returncode).toBe(0);
    expect(result.stdout).not.toContain("\u001b");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.state).toBe("closed");
    expect(payload.number).toBe(6023);
    expect(payload.stubNoColor).toBe("1");
    // Child-only env: the parent keeps its own value.
    expect(process.env[key]).toBe(value);
  });
});
