import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prependUpgradeBanner } from "./changelog.js";
import { parseReleaseFlags } from "./flags.js";
import { checkTagAvailable, createGithubRelease, verifyReleaseDraft } from "./gh.js";
import { spawnText } from "./spawn.js";
import type { ReleaseSeams } from "./types.js";
import { toPep440 } from "./version.js";

const COLOR_GH_STUB = resolve(
  import.meta.dirname,
  "..",
  "pr-protected-issues",
  "fixtures",
  "color-gh-stub.mjs",
);

describe("checkTagAvailable remaining branches", () => {
  it("fails when git tag -l errors", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "tag list fail" }),
    };
    const [ok, reason] = checkTagAvailable("0.21.0", "r", "/p", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("git tag -l failed");
  });

  it("reports clean with gh verification", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a[0] === "release" && a[1] === "view") {
          return { status: 1, stdout: "", stderr: "not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => "/usr/bin/gh",
    };
    const [ok, reason] = checkTagAvailable("0.21.0", "deftai/directive", "/p", seams);
    expect(ok).toBe(true);
    expect(reason).toContain("no GitHub release");
  });
});

describe("verifyReleaseDraft flip failure", () => {
  it("returns false when flip fails", () => {
    let calls = 0;
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        calls += 1;
        if (calls === 1) {
          return { status: 0, stdout: '{"isDraft":false}', stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "edit failed" };
      },
      sleep: () => undefined,
    };
    const [ok] = verifyReleaseDraft("/p", "0.21.0", "r", { sleep: () => undefined }, seams);
    expect(ok).toBe(false);
  });
});

describe("prependUpgradeBanner catch", () => {
  it("returns notes when read throws", () => {
    const out = prependUpgradeBanner("notes", "deftai/directive", "/r", () => {
      throw new Error("read fail");
    });
    expect(out).toBe("notes");
  });
});

describe("toPep440 type guard", () => {
  it("throws for non-string version", () => {
    expect(() => toPep440(1 as unknown as string)).toThrow(/must be a string/);
  });
});

describe("parseReleaseFlags edge cases", () => {
  it("handles empty equals values", () => {
    const flags = parseReleaseFlags([
      "1.0.0",
      "--base-branch=",
      "--repo=",
      "--project-root=",
      "--summary=",
    ]);
    expect(flags.unknown.length).toBeGreaterThanOrEqual(3);
  });
});

describe("createGithubRelease without draft flags", () => {
  it("creates public non-prerelease release", () => {
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok, reason] = createGithubRelease(
      "/p",
      "0.21.0",
      "consumer/repo",
      "body",
      { draft: false, prerelease: false },
      seams,
    );
    expect(ok).toBe(true);
    expect(reason).not.toContain("draft");
  });
});

describe("ghReleaseViewIsDraft plain gh env (#6032)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stub colors release-view JSON when CLICOLOR_FORCE reaches it (pre-fix base)", () => {
    const raw = execFileSync(
      process.execPath,
      [
        COLOR_GH_STUB,
        "release",
        "view",
        "v0.21.0",
        "--repo",
        "deftai/directive",
        "--json",
        "isDraft",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLICOLOR_FORCE: "1" },
      },
    );
    expect(raw).toContain("\u001b[");
    expect(() => JSON.parse(raw)).toThrow();
  });

  it("verifyReleaseDraft parses draft JSON under parent CLICOLOR_FORCE=1", () => {
    vi.stubEnv("CLICOLOR_FORCE", "1");
    vi.stubEnv("NO_COLOR", "");
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      // Drop the fixture projectRoot cwd so spawnSync does not ENOENT on "/p".
      spawnText: (_cmd, args, options) =>
        spawnText(process.execPath, [COLOR_GH_STUB, ...args], {
          ...options,
          cwd: undefined,
        }),
      sleep: () => undefined,
    };
    const [ok, reason] = verifyReleaseDraft(
      "/p",
      "0.21.0",
      "deftai/directive",
      { maxAttempts: 1, sleep: () => undefined },
      seams,
    );
    expect(ok).toBe(true);
    expect(reason).toContain("verified draft");
    expect(process.env.CLICOLOR_FORCE).toBe("1");
  });
});
