import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFT_UPSTREAM_URL,
  emitCheckUpdates,
  extractUpstreamHostname,
  type GitRunner,
  isAllowlistedUpstreamUrl,
  isPrivateOrLinkLocalUpstreamHost,
  isSafeGitLsRemoteTarget,
  maxSemverTag,
  parseLsRemoteTags,
  parseSemverTag,
  resolveProbeCurrentVersion,
  resolveProbeTimeout,
  resolveUpstreamUrl,
  runCheckUpdates,
  runRemoteProbe,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
  temps.length = 0;
});

function fakeGit(tags: string[] | "timeout" | "os-error"): GitRunner {
  return {
    lsRemoteTags() {
      return tags;
    },
  };
}

describe("parseLsRemoteTags", () => {
  it("rejects unsafe git ls-remote targets", () => {
    expect(isSafeGitLsRemoteTarget("--upload-pack=echo pwned")).toBe(false);
    expect(isSafeGitLsRemoteTarget("")).toBe(false);
    expect(isSafeGitLsRemoteTarget(DEFT_UPSTREAM_URL)).toBe(true);
  });

  it("extracts semver tag names and skips junk lines", () => {
    expect(parseLsRemoteTags("abc123\trefs/tags/v1.0.0\nignored\nsha\trefs/tags/\n")).toEqual([
      "v1.0.0",
    ]);
  });
});

describe("maxSemverTag ordering", () => {
  it("ranks stable releases above prereleases on the same triple", () => {
    expect(maxSemverTag(["v1.0.0-rc.2", "v1.0.0-rc.10", "v1.0.0"])).toBe("v1.0.0");
  });
});

describe("parseSemverTag", () => {
  it.each([
    ["v1.2.3", [1, 2, 3, 1, ""]],
    ["1.2.3", [1, 2, 3, 1, ""]],
    ["v0.23.0-rc.1", [0, 23, 0, 0, "rc.1"]],
  ] as const)("parses %s", (tag, expectedPrefix) => {
    const parsed = parseSemverTag(tag);
    expect(parsed?.slice(0, 3)).toEqual(expectedPrefix.slice(0, 3));
  });

  it.each([
    "",
    "v",
    "junk",
    "1.2",
    "v1.2.3.4",
    "release-2026Q1",
  ])("returns null for invalid %s", (tag) => {
    expect(parseSemverTag(tag)).toBeNull();
  });
});

describe("maxSemverTag", () => {
  it("picks highest stable semver and skips junk", () => {
    expect(maxSemverTag(["junk", "v1.0.0", "v2.5.0", "release-2026", "v2.4.9"])).toBe("v2.5.0");
  });

  it("stable outranks prerelease on same triple", () => {
    expect(maxSemverTag(["v1.2.3-rc.1", "v1.2.3"])).toBe("v1.2.3");
  });

  it("returns null for empty list", () => {
    expect(maxSemverTag([])).toBeNull();
  });

  it("orders prerelease suffixes lexicographically", () => {
    expect(maxSemverTag(["v1.0.0-alpha", "v1.0.0-beta"])).toBe("v1.0.0-beta");
  });

  it("orders numeric rc prereleases correctly", () => {
    expect(maxSemverTag(["v1.0.0-rc.2", "v1.0.0-rc.10"])).toBe("v1.0.0-rc.10");
  });

  it("returns a tag when all candidates are equal semver", () => {
    expect(maxSemverTag(["v1.0.0", "v1.0.0"])).toBe("v1.0.0");
  });
});

describe("resolveProbeTimeout", () => {
  it("honors DEFT_REMOTE_PROBE_TIMEOUT", () => {
    expect(resolveProbeTimeout({ DEFT_REMOTE_PROBE_TIMEOUT: "12.5" })).toBe(12.5);
  });

  it("falls back on invalid values", () => {
    expect(resolveProbeTimeout({ DEFT_REMOTE_PROBE_TIMEOUT: "not-a-number" })).toBe(5);
    expect(resolveProbeTimeout({ DEFT_REMOTE_PROBE_TIMEOUT: "-3" })).toBe(5);
  });
});

describe("runRemoteProbe", () => {
  it("skips when DEFT_NO_NETWORK=1", () => {
    const gitCalls: string[] = [];
    const git: GitRunner = {
      lsRemoteTags(url) {
        gitCalls.push(url);
        return [];
      },
    };
    const result = runRemoteProbe({
      projectRoot: process.cwd(),
      env: { DEFT_NO_NETWORK: "1" },
      git,
    });
    expect(result.status).toBe("skipped");
    expect(gitCalls).toHaveLength(0);
  });

  it("reports OK when remote matches current", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-ok-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "tag: v1.0.0\nurl: https://github.com/deftai/directive.git\n",
      "utf8",
    );
    const result = runRemoteProbe({
      projectRoot: root,
      env: {},
      git: fakeGit(["v1.0.0"]),
    });
    expect(result.status).toBe("ok");
    expect(result.remote).toBe("v1.0.0");
  });

  it("reports BEHIND when remote is higher", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-behind-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "tag: v1.0.0\nurl: https://github.com/deftai/directive.git\n",
      "utf8",
    );
    const result = runRemoteProbe({
      projectRoot: root,
      env: {},
      git: fakeGit(["v999.0.0"]),
    });
    expect(result.status).toBe("behind");
    expect(result.remote).toBe("v999.0.0");
  });

  it("reports ok when remote is lower than current", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-ok-lower-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "tag: v2.0.0\nurl: https://github.com/deftai/directive.git\n",
      "utf8",
    );
    const result = runRemoteProbe({
      projectRoot: root,
      env: {},
      git: fakeGit(["v1.0.0"]),
    });
    expect(result.status).toBe("ok");
    expect(result.remote).toBe("v1.0.0");
  });

  it("never probes consumer origin (#1320)", () => {
    const result = runRemoteProbe({
      projectRoot: process.cwd(),
      env: {},
      git: fakeGit([]),
    });
    expect(result.status).toBe("no-tags");
    expect(result.upstream_url).toBe(DEFT_UPSTREAM_URL);
  });

  it("ignores non-allowlisted manifest upstream urls (#2601)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "url: https://example.com/framework.git\ntag: v1.0.0\n",
      "utf8",
    );
    expect(resolveUpstreamUrl(root)).toBe(DEFT_UPSTREAM_URL);
  });

  it("rejects private and link-local manifest upstream hosts (#2601)", () => {
    expect(isPrivateOrLinkLocalUpstreamHost("localhost")).toBe(true);
    expect(isPrivateOrLinkLocalUpstreamHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLinkLocalUpstreamHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrLinkLocalUpstreamHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrLinkLocalUpstreamHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrLinkLocalUpstreamHost("github.com")).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-private-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "url: http://127.0.0.1/evil.git\ntag: v1.0.0\n",
      "utf8",
    );
    expect(resolveUpstreamUrl(root)).toBe(DEFT_UPSTREAM_URL);
    expect(isAllowlistedUpstreamUrl("http://127.0.0.1/evil.git")).toBe(false);
    expect(extractUpstreamHostname("git@github.com:deftai/directive.git")).toBe("github.com");
  });

  it("reports timeout as ERROR with exit-friendly shape", () => {
    const lines: string[] = [];
    const code = runCheckUpdates([], {
      projectRoot: process.cwd(),
      env: {},
      git: fakeGit("timeout"),
      writeOut: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("ERROR");
    expect(lines.join("")).toContain("error=timeout");
  });

  it("reports NO-TAGS for malformed-only tags", () => {
    const result = runRemoteProbe({
      projectRoot: process.cwd(),
      env: {},
      git: fakeGit(["junk-tag", "release-2026Q1"]),
    });
    expect(result.status).toBe("no-tags");
  });

  it("json mode emits structured payload", () => {
    const lines: string[] = [];
    const code = runCheckUpdates(["--json"], {
      projectRoot: process.cwd(),
      env: { DEFT_NO_NETWORK: "1" },
      writeOut: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    const payload = JSON.parse(lines.join("").trim()) as { status: string; current: string };
    expect(payload.status).toBe("skipped");
    expect(payload.current).toBeTruthy();
  });

  it("behind json exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-behind-json-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "tag: v1.0.0\nurl: https://github.com/deftai/directive.git\n",
      "utf8",
    );
    const lines: string[] = [];
    const code = runCheckUpdates(["--json"], {
      projectRoot: root,
      env: {},
      git: fakeGit(["v999.0.0"]),
      writeOut: (text) => lines.push(text),
    });
    expect(code).toBe(1);
    const payload = JSON.parse(lines.join("").trim()) as { status: string; remote: string };
    expect(payload.status).toBe("behind");
    expect(payload.remote).toBe("v999.0.0");
  });
});

describe("emitCheckUpdates text mode", () => {
  it("formats SKIPPED with reason", () => {
    const lines: string[] = [];
    const code = emitCheckUpdates(
      { status: "skipped", reason: "DEFT_NO_NETWORK=1", current: "1.0.0" },
      { jsonMode: false, writeOut: (t) => lines.push(t) },
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("SKIPPED reason=DEFT_NO_NETWORK");
  });

  it("reports os-error as ERROR", () => {
    const lines: string[] = [];
    const code = runCheckUpdates([], {
      projectRoot: process.cwd(),
      env: {},
      git: fakeGit("os-error"),
      writeOut: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("error=Error: git unavailable");
  });

  it("formats text modes for ok, behind, and no-upstream", () => {
    const cases: Array<{ result: Parameters<typeof emitCheckUpdates>[0]; snippet: string }> = [
      {
        result: { status: "ok", current: "1.0.0", remote: "v1.0.0" },
        snippet: "OK upstream=v1.0.0",
      },
      {
        result: {
          status: "behind",
          current: "1.0.0",
          remote: "v2.0.0",
          upstream_url: DEFT_UPSTREAM_URL,
        },
        snippet: "BEHIND upstream=v2.0.0",
      },
      {
        result: { status: "no-upstream", current: "1.0.0" },
        snippet: "NO-UPSTREAM current=v1.0.0",
      },
    ];
    for (const { result, snippet } of cases) {
      const lines: string[] = [];
      emitCheckUpdates(result, { jsonMode: false, writeOut: (t) => lines.push(t) });
      expect(lines.join("")).toContain(snippet);
    }
  });

  it("resolveProbeCurrentVersion falls back to framework VERSION", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-fallback-"));
    temps.push(root);
    expect(resolveProbeCurrentVersion(root, process.cwd())).toMatch(/\d|dev/);
  });

  it("json mode includes optional payload fields", () => {
    const lines: string[] = [];
    emitCheckUpdates(
      {
        status: "error",
        current: "1.0.0",
        upstream_url: DEFT_UPSTREAM_URL,
        error: "timeout",
        reason: "probe",
        remote: "v2.0.0",
      },
      { jsonMode: true, writeOut: (t) => lines.push(t) },
    );
    const payload = JSON.parse(lines.join("").trim()) as Record<string, string>;
    expect(payload.error).toBe("timeout");
    expect(payload.remote).toBe("v2.0.0");
  });

  it("resolveUpstreamUrl skips blank manifest url fields", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-url-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "url: \nupstream:   \ntag: v1.0.0\n",
      "utf8",
    );
    expect(resolveUpstreamUrl(root)).toBe(DEFT_UPSTREAM_URL);
  });

  it("resolveUpstreamUrl rejects unsafe manifest urls", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-unsafe-url-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "url: --upload-pack=echo pwned\ntag: v1.0.0\n",
      "utf8",
    );
    expect(resolveUpstreamUrl(root)).toBe(DEFT_UPSTREAM_URL);
  });

  it("returns ok when current version is not semver-parseable", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-nonsemver-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "tag: not-a-semver\n", "utf8");
    const result = runRemoteProbe({
      projectRoot: root,
      env: {},
      git: fakeGit(["v999.0.0"]),
    });
    expect(result.status).toBe("ok");
  });

  it("resolveProbeTimeout uses default when env unset", () => {
    expect(resolveProbeTimeout({})).toBe(5);
  });

  it("accepts canonical manifest upstream url when present (#2601)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-canonical-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      `url: ${DEFT_UPSTREAM_URL}\ntag: v1.0.0\n`,
      "utf8",
    );
    expect(resolveUpstreamUrl(root)).toBe(DEFT_UPSTREAM_URL);
  });

  it("reads vendored manifest from .deft/VERSION when core manifest is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-deft-version-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "VERSION"),
      `tag: v0.9.0\nurl: ${DEFT_UPSTREAM_URL}\n`,
      "utf8",
    );
    expect(resolveProbeCurrentVersion(root)).toBe("0.9.0");
    expect(resolveUpstreamUrl(root)).toBe(DEFT_UPSTREAM_URL);
  });

  it("reads vendored manifest from legacy deft/VERSION path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-legacy-deft-"));
    temps.push(root);
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "deft", "VERSION"), "tag: v0.8.0\n", "utf8");
    expect(resolveProbeCurrentVersion(root)).toBe("0.8.0");
  });

  it("formats NO-TAGS in text mode", () => {
    const lines: string[] = [];
    emitCheckUpdates(
      { status: "no-tags", current: "1.0.0", upstream_url: DEFT_UPSTREAM_URL },
      { jsonMode: false, writeOut: (t) => lines.push(t) },
    );
    expect(lines.join("")).toContain("NO-TAGS");
    expect(lines.join("")).toContain(`upstream=${DEFT_UPSTREAM_URL}`);
  });

  it("formats ERROR with empty optional fields", () => {
    const lines: string[] = [];
    emitCheckUpdates(
      { status: "error", current: "1.0.0" },
      { jsonMode: false, writeOut: (t) => lines.push(t) },
    );
    expect(lines.join("")).toContain("ERROR current=v1.0.0");
    expect(lines.join("")).toContain("upstream=");
    expect(lines.join("")).toContain("error=unknown");
  });

  it("skips corrupt vendored manifest files", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-corrupt-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "\0not-valid-manifest", "utf8");
    expect(resolveProbeCurrentVersion(root, process.cwd())).toMatch(/\d|dev/);
  });

  it("compares versions when current already has a v prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-check-updates-vprefix-"));
    temps.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      "tag: v1.0.0\nurl: https://github.com/deftai/directive.git\n",
      "utf8",
    );
    const result = runRemoteProbe({
      projectRoot: root,
      env: {},
      git: fakeGit(["v999.0.0"]),
    });
    expect(result.status).toBe("behind");
  });

  it("uses default stdout writer when writeOut is omitted", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = runCheckUpdates([], {
        projectRoot: process.cwd(),
        env: { DEFT_NO_NETWORK: "1" },
      });
      expect(code).toBe(0);
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
