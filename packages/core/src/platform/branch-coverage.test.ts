import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsRefreshPlan,
  frameworkRoot,
  hasV3ManagedMarker,
  parseManagedSectionAttrs,
  renderManagedSection,
} from "./agents-md.js";
import { ENV_VAR } from "./constants.js";
import { detectIpTerms, ipRiskScopeItems, plainRiskSummary } from "./ip-risk.js";
import {
  extractIssueNumbers,
  findFirstTerm,
  indexOfIgnoreCase,
  isEntryBulletLine,
  isWordChar,
  matchAt,
  parseManagedOpenMarker,
  parseSectionHeader,
  parseSubsectionHeader,
  wordBoundaryMatch,
} from "./linear-scan.js";
import {
  getPlatformCapabilities,
  probeRuntimeCapabilities,
  readUidMap,
  reportToDict,
} from "./platform-capabilities.js";
import { resolveChangelog } from "./resolve-changelog-unreleased.js";
import {
  isPublishable,
  latestLocalPublishableTag,
  latestPublishableTag,
  latestRemotePublishableTag,
  NonPublishableVersionError,
  payloadIsOwnGitRoot,
  resolveVersion,
  tagNameFromRef,
  toPep440,
} from "./resolve-version.js";
import { disambiguateSlug, normalizeSlug } from "./slug-normalize.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "platform-branch-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolve-version parse + classify branch coverage", () => {
  it("toPep440 covers every parse rejection branch", () => {
    expect(toPep440("v1.2.3")).toBe("1.2.3");
    expect(toPep440("V1.2.3")).toBe("1.2.3"); // uppercase V prefix
    expect(toPep440("1.2.3-alpha.1")).toBe("1.2.3a1");
    expect(toPep440("1.2.3-beta.2")).toBe("1.2.3b2");
    expect(toPep440("1.2.3-rc.3")).toBe("1.2.3rc3");
    expect(() => toPep440(123 as unknown as string)).toThrow(/must be a string/);
    expect(() => toPep440("")).toThrow(/non-empty/);
    expect(() => toPep440("   ")).toThrow(/non-empty/);
    for (const bad of [
      "abc", // major NaN
      "1", // missing dot after major
      "1.2", // missing dot after minor
      "1.x", // minor NaN
      "1.2.", // patch NaN
      "1.2.x", // patch NaN
      "1.2.3extra", // trailing not '-'
      "1.2.3-rcX", // no dot terminating kind
      "1.2.3-foo.1", // unknown kind
      "1.2.3-rc.X", // num NaN
      "1.2.3-rc.1x", // trailing after num
    ]) {
      expect(() => toPep440(bad), bad).toThrow(/Cannot normalize/);
    }
    expect(() => toPep440("1.2.3-test.1")).toThrow(NonPublishableVersionError);
  });

  it("isPublishable reflects publishability", () => {
    expect(isPublishable("v1.2.3")).toBe(true);
    expect(isPublishable("1.2.3-rc.1")).toBe(true);
    expect(isPublishable("garbage")).toBe(false);
    expect(isPublishable("1.2.3-test.1")).toBe(false);
  });

  it("tagNameFromRef covers split / suffix / prefix branches", () => {
    expect(tagNameFromRef("")).toBe("");
    expect(tagNameFromRef("   ")).toBe("");
    expect(tagNameFromRef("v1.0.0")).toBe("v1.0.0"); // single token, no split
    expect(tagNameFromRef("refs/tags/v2.0.0")).toBe("v2.0.0"); // prefix strip, no space
    expect(tagNameFromRef("abc123 refs/tags/v3.0.0^{}")).toBe("v3.0.0"); // split + ^{} + prefix
  });

  it("latestPublishableTag ranks and filters", () => {
    expect(
      latestPublishableTag([
        "v1.0.0",
        "v1.1.0-rc.1",
        "v0.0.0-test.1", // non-publishable, filtered
        "garbage", // unparseable, filtered
        "refs/tags/v2.0.0",
      ]),
    ).toBe("v2.0.0");
    // rc ranks below the final release of the same x.y.z
    expect(latestPublishableTag(["v1.2.0-rc.1", "v1.2.0"])).toBe("v1.2.0");
    expect(latestPublishableTag([])).toBeNull();
    expect(latestPublishableTag(["nope", "v0.0.0-test.9"])).toBeNull();
    // Two identical keys exercise the compareTuple "all equal" (return 0) branch.
    expect(latestPublishableTag(["v1.0.0", "v1.0.0"])).toBe("v1.0.0");
  });

  it("resolveVersion default seams read manifest / deft-version / env", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "VERSION"),
        ["# comment", "noise: x", 'tag: "v3.4.5"', "ref: 'v3.4.5'"].join("\n"),
        "utf8",
      );
      // No fromManifest seam -> exercises the default readManifestTag (quote + v strip).
      expect(resolveVersion({ frameworkRoot: dir, fromEnv: () => null })).toBe("3.4.5");
    });

    withTempDir((dir) => {
      writeFileSync(join(dir, ".deft-version"), "v6.7.8\n", "utf8");
      expect(
        resolveVersion({
          frameworkRoot: dir,
          fromEnv: () => null,
          fromManifest: () => null,
        }),
      ).toBe("6.7.8");
    });

    withTempDir((dir) => {
      // Empty manifest line (no usable value) falls through to dev fallback.
      writeFileSync(join(dir, "VERSION"), "tag:\nref:   \n", "utf8");
      expect(
        resolveVersion({
          frameworkRoot: dir,
          fromEnv: () => null,
          fromDeftVersion: () => null,
          fromGit: () => null,
        }),
      ).toBe("0.0.0-dev");
    });
  });

  it("resolveVersion default fromEnv honors the env var", () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = "9.9.9";
    try {
      withTempDir((dir) => {
        expect(resolveVersion({ frameworkRoot: dir })).toBe("9.9.9");
      });
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it("git-backed helpers fail closed on a non-repo path", () => {
    expect(payloadIsOwnGitRoot("/nonexistent-platform-branch-xyz")).toBe(false);
    expect(latestLocalPublishableTag("/nonexistent-platform-branch-xyz")).toBeNull();
    expect(latestRemotePublishableTag("origin", "/nonexistent-platform-branch-xyz")).toBeNull();
  });
});

describe("agents-md hasV3ManagedMarker branch coverage", () => {
  it("returns false when markers exhaust without a v3 entry", () => {
    // A v2 marker as the entire text: the scan loop advances past it, the while
    // condition fails, and the function returns false at the post-loop return.
    const v2Only = "<!-- deft:managed-section v2 -->";
    expect(hasV3ManagedMarker("/root", () => v2Only)).toBe(false);
  });

  it("returns true on a v3 marker and false on a missing file", () => {
    expect(hasV3ManagedMarker("/root", () => "<!-- deft:managed-section v3 -->\nx")).toBe(true);
    expect(hasV3ManagedMarker("/root", () => null)).toBe(false);
  });

  it("default reader returns false for absent and unreadable AGENTS.md", () => {
    withTempDir((dir) => {
      // Absent AGENTS.md -> existsSync false branch.
      expect(hasV3ManagedMarker(dir)).toBe(false);
      // AGENTS.md is a directory -> readFileSync throws -> catch branch.
      mkdirSync(join(dir, "AGENTS.md"));
      expect(hasV3ManagedMarker(dir)).toBe(false);
    });
  });
});

describe("slug-normalize branch coverage", () => {
  it("covers truncation, reserved names, and checkbox edges", () => {
    expect(normalizeSlug(null)).toBe("untitled");
    expect(normalizeSlug("   !!!   ")).toBe("untitled");
    expect(normalizeSlug("hello", 0)).toBe("hello"); // maxLen<1 resets to default
    expect(normalizeSlug("con")).toBe("con-scope"); // windows-reserved
    expect(normalizeSlug("[x] done task")).toBe("done-task");
    expect(normalizeSlug("[ ] open task")).toBe("open-task");
    expect(normalizeSlug("[z] kept marker")).toBe("z-kept-marker"); // non-checkbox mid char
    // Truncation: hyphen boundary past the half mark is honored.
    expect(normalizeSlug("alpha-bravo-charlie-delta", 14)).toBe("alpha-bravo");
    // Truncation: next char is a hyphen -> cut exactly at maxLen, no word backtrack.
    expect(normalizeSlug("abcdefghij-klmno", 10)).toBe("abcdefghij");
    // Truncation: only hyphen sits before the half mark -> no backtrack, edges trimmed.
    expect(normalizeSlug("ab-cdefghijklmnop", 12)).toBe("ab-cdefghijk");
  });

  it("disambiguateSlug numbers collisions and trims long bodies", () => {
    expect(disambiguateSlug("free", new Set<string>())).toBe("free");
    expect(disambiguateSlug("dup", new Set(["dup"]))).toBe("dup-2");
    expect(disambiguateSlug("dup", new Set(["dup", "dup-2"]))).toBe("dup-3");
    // Long base forces the candidate.length > maxLen trimming branch.
    const long = "a".repeat(20);
    const out = disambiguateSlug(long, new Set([long]), { maxLen: 10 });
    expect(out.endsWith("-2")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
    // All-hyphen trimmed body hits the `|| base.slice(...)` fallback.
    const hyphenBase = "-----name";
    const fb = disambiguateSlug(hyphenBase, new Set([hyphenBase]), { maxLen: 4 });
    expect(fb.endsWith("-2")).toBe(true);
  });

  it("throws when the collision space is exhausted", () => {
    const taken = new Set<string>(["x"]);
    for (let n = 2; n <= 10_000; n += 1) taken.add(`x-${n}`);
    expect(() => disambiguateSlug("x", taken)).toThrow(/unable to resolve collision/);
  });
});

describe("platform-capabilities branch coverage", () => {
  it("readUidMap skips comments, blanks, malformed and non-numeric rows", () => {
    withTempDir((dir) => {
      const path = join(dir, "uid_map");
      writeFileSync(
        path,
        ["# header", "", "0 1000 1", "x y z", "1 2", "3 4 5 6"].join("\n"),
        "utf8",
      );
      const entries = readUidMap(path);
      expect(entries).toEqual([{ insideId: 0, outsideId: 1000, length: 1 }]);
    });
    expect(readUidMap("/no/such/uid_map")).toEqual([]);
  });

  it("classifies cloud-headless across each signal", () => {
    const mode = (environ: Record<string, string>): string =>
      getPlatformCapabilities({
        environ,
        effectiveUidOverride: 1000,
        uidMapPath: "/none",
        cwd: "/none",
      }).runtimeMode;
    expect(mode({ CURSOR_AGENT: "1" })).toBe("cloud-headless");
    expect(mode({ GROK_BUILD: "true" })).toBe("cloud-headless");
    expect(mode({ DEFT_AGENT_RUNTIME: "grok-build" })).toBe("cloud-headless");
    expect(mode({ DEFT_AGENT_RUNTIME: "cloud" })).toBe("cloud-headless");
    expect(mode({ DEFT_AGENT_RUNTIME: "headless" })).toBe("cloud-headless");
    expect(mode({ GITHUB_ACTIONS: "yes" })).toBe("cloud-headless");
    expect(mode({ BUILDKITE: "on" })).toBe("cloud-headless");
    expect(mode({ CI: "true" })).toBe("cloud-headless");
    // CI present but CURSOR_COMPOSER set -> NOT cloud-headless.
    expect(mode({ CI: "true", CURSOR_COMPOSER: "1" })).toBe("local-unsandboxed");
    // Cursor-native sandbox signals.
    expect(mode({ CURSOR_SANDBOX: "1" })).toBe("cursor-native-sandbox");
    expect(mode({ CURSOR_SANDBOX_LANDLOCK_STATUS: "active" })).toBe("cursor-native-sandbox");
    // No signals -> local unsandboxed.
    expect(mode({})).toBe("local-unsandboxed");
  });

  it("detects sandbox uid remap and the resulting identity", () => {
    withTempDir((dir) => {
      const path = join(dir, "uid_map");
      writeFileSync(path, "0 4242 1\n", "utf8");
      const report = probeRuntimeCapabilities({
        environ: { CURSOR_ORIG_UID: "4242", CURSOR_SANDBOX: "1" },
        uidMapPath: path,
        cwd: dir,
        effectiveUidOverride: 0,
      });
      expect(report.sandboxUidRemap).toBe(true);
      expect(report.identityKind).toBe("sandbox-remapped-local-user");
      expect(report.runtimeMode).toBe("cursor-native-sandbox");
      expect(reportToDict(report).sandbox_uid_remap).toBe(true);
    });
  });

  it("real-root, unknown uid, and getuid seam paths", () => {
    const root = probeRuntimeCapabilities({
      environ: {},
      uidMapPath: "/none",
      cwd: "/none",
      effectiveUidOverride: 0,
    });
    expect(root.identityKind).toBe("real-root");
    const unknown = probeRuntimeCapabilities({ environ: {}, uidMapPath: "/none", cwd: "/none" });
    expect(unknown.identityKind).toBe("unknown");
    const viaGetuid = probeRuntimeCapabilities({
      environ: {},
      uidMapPath: "/none",
      cwd: "/none",
      getuid: () => 1000,
    });
    expect(viaGetuid.effectiveUid).toBe(1000);
    expect(viaGetuid.identityKind).toBe("local-user");
  });

  it("reportToDict emits null ownership when cwd is unreadable", () => {
    const report = probeRuntimeCapabilities({
      environ: { USER: "tester" },
      uidMapPath: "/none",
      cwd: "/nonexistent-cwd-platform-branch",
      effectiveUidOverride: 1000,
    });
    expect(report.ownership).toBeNull();
    expect(reportToDict(report).ownership).toBeNull();
    expect(report.effectiveUsername).toBe("tester");
  });
});

describe("resolve-changelog outside-marker branch coverage", () => {
  const HEADER = "# Changelog\n\n";

  it("rejects conflict markers outside [Unreleased] when none are inside", () => {
    const content =
      `${HEADER}## [Unreleased]\n\n### Added\n- clean (#1)\n\n` +
      "## [0.1.0] - 2026-01-01\n<<<<<<< HEAD\n- a (#2)\n=======\n- b (#3)\n>>>>>>> x\n";
    const result = resolveChangelog(content);
    expect(result.content).toBeNull();
    expect(result.message).toContain("outside [Unreleased]");
  });

  it("rejects when a block resolves inside but markers remain outside", () => {
    const content =
      `${HEADER}## [Unreleased]\n\n### Added\n` +
      "<<<<<<< HEAD\n- in-a (#1)\n=======\n- in-b (#2)\n>>>>>>> x\n\n" +
      "## [0.1.0] - 2026-01-01\n<<<<<<< HEAD\n- out (#3)\n=======\n>>>>>>> y\n";
    const result = resolveChangelog(content);
    expect(result.content).toBeNull();
    expect(result.message).toContain("remain outside [Unreleased]");
  });
});

describe("linear-scan branch coverage", () => {
  it("findFirstTerm skips non-bounded hits and finds later bounded ones", () => {
    // First "curl" is glued to word chars (not bounded); the standalone one wins.
    const hit = findFirstTerm("xcurlx curl tail", ["curl"]);
    expect(hit?.index).toBe(7);
    // No bounded occurrence at all -> null.
    expect(findFirstTerm("abcurlxyz", ["curl"])).toBeNull();
    // Earliest of multiple terms wins.
    const multi = findFirstTerm("see fetch then wget", ["wget", "fetch"]);
    expect(multi?.term.toLowerCase()).toBe("fetch");
    expect(wordBoundaryMatch("a curl", 2, "curl")).toBe(true);
  });

  it("parseManagedOpenMarker rejects bad prefixes, versions, and missing close", () => {
    expect(parseManagedOpenMarker("<!-- deft:managed-section v3 no close", 0)).toBeNull();
    expect(parseManagedOpenMarker("not a marker", 0)).toBeNull();
    expect(parseManagedOpenMarker("<!-- wrong-marker v3 -->", 0)).toBeNull();
    expect(parseManagedOpenMarker("<!-- deft:managed-section x -->", 0)).toBeNull(); // no 'v'
    expect(parseManagedOpenMarker("<!-- deft:managed-section v9 -->", 0)).toBeNull(); // bad version
    const ok = parseManagedOpenMarker("<!-- deft:managed-section v2 sha=x -->", 0);
    expect(ok?.version).toBe(2);
  });

  it("isWordChar / matchAt / indexOfIgnoreCase / wordBoundaryMatch primitives", () => {
    expect(isWordChar("a")).toBe(true);
    expect(isWordChar("9")).toBe(true);
    expect(isWordChar("_")).toBe(true);
    expect(isWordChar("-")).toBe(false);
    expect(isWordChar("")).toBe(false); // length !== 1
    expect(isWordChar("ab")).toBe(false); // length !== 1
    expect(matchAt("curl", 0, "curl")).toBe(true);
    expect(matchAt("cur", 0, "curl")).toBe(false); // needle overruns
    expect(indexOfIgnoreCase("xxCURLxx", "curl")).toBe(2);
    expect(wordBoundaryMatch("a curl b", 2, "curl")).toBe(true);
    expect(wordBoundaryMatch("xcurl", 1, "curl")).toBe(false); // word char before
    expect(wordBoundaryMatch("curlx", 0, "curl")).toBe(false); // word char after
    expect(wordBoundaryMatch("nope", 0, "curl")).toBe(false); // no match at pos
  });
});

describe("ip-risk branch coverage", () => {
  it("validateIntent rejects non-string intent", () => {
    expect(() => ipRiskScopeItems(7 as unknown as string)).toThrow(/must be a string/);
    const hits = detectIpTerms("Mickey Mouse appears");
    expect(() => plainRiskSummary(hits, 7 as unknown as string)).toThrow(/must be a string/);
  });

  it("plainRiskSummary sorts multiple same-category terms", () => {
    const hits = detectIpTerms("NFL and NBA and MLB stats");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const summary = plainRiskSummary(hits, "commercial");
    // Alphabetical sort within the sports-league category invokes the comparator.
    expect(summary).toContain("MLB, NBA, NFL");
    expect(summary).toContain("lawyer");
  });

  it("detectIpTerms dedups a repeated term within one category", () => {
    // Two NFL occurrences: the second hits the `seen` short-circuit branch.
    const hits = detectIpTerms("NFL versus NFL again");
    const nfl = hits.filter((h) => h.term.toUpperCase() === "NFL");
    expect(nfl.length).toBe(1);
    expect(detectIpTerms("")).toEqual([]);
    expect(plainRiskSummary([], "personal")).toBe("");
  });
});

const OPEN_V3 = "<!-- deft:managed-section v3 -->";
const CLOSE = "<!-- /deft:managed-section -->";
const BODY = "## Section\nrule one\nrule two";
const TEMPLATE = `top matter\n${OPEN_V3}\n${BODY}\n${CLOSE}\nbottom matter`;
const RENDERED = `${OPEN_V3}\n${BODY}\n${CLOSE}`;
const SEAMS = {
  readTemplate: () => TEMPLATE,
  resolveSha: () => "abc123",
  nowIso: () => "2026-01-01T00:00:00Z",
  newSession: () => "sess0001",
};

describe("agents-md refresh-plan branch coverage (seamed)", () => {
  it("reports template-missing and template-malformed", () => {
    expect(agentsRefreshPlan("/proj", { ...SEAMS, readTemplate: () => null }).state).toBe(
      "template-missing",
    );
    expect(
      agentsRefreshPlan("/proj", { ...SEAMS, readTemplate: () => "no managed markers here" }).state,
    ).toBe("template-malformed");
  });

  it("reports absent and unreadable AGENTS.md", () => {
    expect(agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => null }).state).toBe("absent");
    const unreadable = agentsRefreshPlan("/proj", {
      ...SEAMS,
      readAgents: () => {
        throw new Error("EACCES");
      },
    });
    expect(unreadable.state).toBe("unreadable");
    expect(String(unreadable.error)).toContain("EACCES");
  });

  it("wraps a legacy file with and without an existing body (missing state)", () => {
    const empty = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => "" });
    expect(empty.state).toBe("missing");
    expect(empty.new_content).toBe(`${empty.attributed_rendered}\n`);

    const withBody = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => "# legacy\n" });
    expect(withBody.state).toBe("missing");
    expect(String(withBody.new_content).startsWith("# legacy\n\n")).toBe(true);
  });

  it("collapses duplicate managed sections (stale)", () => {
    const dup = `head\n${RENDERED}\nmid\n${RENDERED}\ntail`;
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => dup });
    expect(plan.state).toBe("stale");
    expect(String(plan.new_content)).toContain(String(plan.attributed_rendered));
  });

  it("treats an up-to-date v3 section as current", () => {
    const existing = `prefix\n${RENDERED}\nsuffix`;
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => existing });
    expect(plan.state).toBe("current");
    expect(plan.new_content).toBe(existing);
  });

  it("replaces a legacy v2 marker (stale via legacy-marker branch)", () => {
    const legacy = `prefix\n<!-- deft:managed-section v2 sha=old -->\n${BODY}\n${CLOSE}\nsuffix`;
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => legacy });
    expect(plan.state).toBe("stale");
  });

  it("marks a drifted v3 section as stale", () => {
    const drifted = `prefix\n${OPEN_V3}\n## Section\nDIFFERENT RULE\n${CLOSE}\nsuffix`;
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => drifted });
    expect(plan.state).toBe("stale");
  });
});

describe("agents-md default-seam (filesystem) branch coverage", () => {
  it("frameworkRoot honors DEFT_ROOT", () => {
    const prev = process.env.DEFT_ROOT;
    withTempDir((dir) => {
      process.env.DEFT_ROOT = dir;
      expect(frameworkRoot({})).toBe(dir);
    });
    if (prev === undefined) delete process.env.DEFT_ROOT;
    else process.env.DEFT_ROOT = prev;
  });

  it("default template reader: missing, unreadable, and present", () => {
    // Missing templates/agents-entry.md -> template-missing.
    withTempDir((dir) => {
      expect(
        agentsRefreshPlan(dir, { ...SEAMS, readTemplate: undefined, frameworkRoot: dir }).state,
      ).toBe("template-missing");
    });
    // templates/agents-entry.md is a directory -> read throws -> caught -> template-missing.
    withTempDir((dir) => {
      mkdirSync(join(dir, "templates"));
      mkdirSync(join(dir, "templates", "agents-entry.md"));
      expect(
        agentsRefreshPlan(dir, { ...SEAMS, readTemplate: undefined, frameworkRoot: dir }).state,
      ).toBe("template-missing");
    });
    // Valid template present, AGENTS.md absent -> absent (exercises default reader + readAgents).
    withTempDir((dir) => {
      mkdirSync(join(dir, "templates"));
      writeFileSync(join(dir, "templates", "agents-entry.md"), TEMPLATE, "utf8");
      const plan = agentsRefreshPlan(dir, {
        readTemplate: undefined,
        readAgents: undefined,
        resolveSha: () => "abc123",
        nowIso: () => "2026-01-01T00:00:00Z",
        newSession: () => "sess0001",
        frameworkRoot: dir,
      });
      expect(plan.state).toBe("absent");
    });
  });

  it("default AGENTS.md reader catch: AGENTS.md is a directory", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "AGENTS.md"));
      const plan = agentsRefreshPlan(dir, {
        readTemplate: () => TEMPLATE,
        readAgents: undefined,
        resolveSha: () => "abc123",
        nowIso: () => "2026-01-01T00:00:00Z",
        newSession: () => "sess0001",
      });
      expect(plan.state).toBe("absent");
    });
  });

  it("default sha resolver falls back to 'unknown' on a non-repo root", () => {
    withTempDir((dir) => {
      const plan = agentsRefreshPlan(dir, {
        readTemplate: () => TEMPLATE,
        readAgents: () => null,
        nowIso: () => "2026-01-01T00:00:00Z",
        newSession: () => "sess0001",
        frameworkRoot: dir,
      });
      expect(plan.state).toBe("absent");
      expect(plan.sha).toBe("unknown");
    });
  });
});

describe("agents-md parseManagedSectionAttrs branch coverage", () => {
  it("parses quoted, bare, empty-key, and extra attributes", () => {
    expect(parseManagedSectionAttrs("no marker at all")).toBeNull();
    const attrs = parseManagedSectionAttrs(
      `<!-- deft:managed-section v3 sha='deadbeef' refreshed="2026-01-01" session=s1 bare =skipped custom=val -->\n${BODY}\n${CLOSE}`,
    );
    expect(attrs).not.toBeNull();
    if (attrs) {
      expect(attrs.version).toBe(3);
      expect(attrs.sha).toBe("deadbeef"); // single-quote strip
      expect(attrs.refreshed).toBe("2026-01-01"); // double-quote strip
      expect(attrs.session).toBe("s1");
      expect(attrs.extras.custom).toBe("val");
    }
  });

  it("renderManagedSection returns null without a close marker", () => {
    expect(renderManagedSection(`${OPEN_V3}\n${BODY}`)).toBeNull();
    expect(renderManagedSection("no markers")).toBeNull();
    expect(renderManagedSection(TEMPLATE)).toBe(RENDERED);
  });
});

describe("resolve-changelog no-op / no-unreleased branch coverage", () => {
  it("no [Unreleased] and no markers is a clean no-op", () => {
    const content = "# Changelog\n\nJust prose, nothing to merge.\n";
    const result = resolveChangelog(content);
    expect(result.content).toBe(content);
    expect(result.message).toContain("no [Unreleased] section, no conflict markers");
  });

  it("markers without an [Unreleased] section are unresolvable", () => {
    const result = resolveChangelog("# Changelog\n\n<<<<<<< HEAD\n- a\n=======\n- b\n>>>>>>> x\n");
    expect(result.content).toBeNull();
    expect(result.message).toContain("no [Unreleased] section found");
  });

  it("flushes an entry on a non-indented continuation line", () => {
    // The plain prose line after a bullet is neither blank nor indented, so the
    // current entry is flushed (parseSide else-branch).
    const content = [
      "## [Unreleased]",
      "",
      "### Added",
      "<<<<<<< HEAD",
      "- entry one (#1)",
      "plain trailing prose",
      "=======",
      "- entry two (#2)",
      ">>>>>>> branch",
      "",
    ].join("\n");
    const result = resolveChangelog(content);
    expect(result.content).not.toBeNull();
    expect(result.content).toContain("entry one (#1)");
    expect(result.content).toContain("entry two (#2)");
  });

  it("an [Unreleased] section with no conflict markers is a no-op", () => {
    const content = "# Changelog\n\n## [Unreleased]\n\n### Added\n- x (#1)\n";
    const result = resolveChangelog(content);
    expect(result.content).toBe(content);
    expect(result.message).toContain("no conflict markers in [Unreleased]");
  });

  it("malformed (no separator) conflict markers are unresolvable", () => {
    const content = "# Changelog\n\n## [Unreleased]\n\n<<<<<<< HEAD\n- a (#1)\n>>>>>>> x\n";
    const result = resolveChangelog(content);
    expect(result.content).toBeNull();
    expect(result.message).toContain("malformed conflict markers");
  });

  it("union-merges a block: dedup by issue + prefix, drops orphans, adds new subsections", () => {
    const content = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "<<<<<<< HEAD",
      "- **Head only feature (#10)**",
      "- shared by prefix dedup",
      "- **head orphan",
      "=======",
      "- branch new (#20)",
      "- shared by prefix dedup",
      "- dup issue (#10)",
      "- **truncated orphan",
      "",
      "### Fixed",
      "- branch fix (#30)",
      ">>>>>>> branch",
      "",
    ].join("\n");
    const result = resolveChangelog(content);
    expect(result.content).not.toBeNull();
    expect(result.message).toContain("resolved: union-merged 1 conflict block(s)");
    // Two orphan headers (one per side) are dropped with warnings.
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    const merged = result.content ?? "";
    expect(merged).toContain("branch new (#20)");
    expect(merged).toContain("### Fixed");
    expect(merged).toContain("branch fix (#30)");
    // Orphan headers are gone.
    expect(merged).not.toContain("head orphan");
    expect(merged).not.toContain("truncated orphan");
    // Issue #10 already on the HEAD side -> the branch dup is dropped.
    expect(merged).not.toContain("dup issue");
    // "shared by prefix dedup" survives exactly once (prefix-dedup against HEAD).
    expect(merged.split("shared by prefix dedup").length - 1).toBe(1);
  });
});

describe("resolve-version default manifest/deft-version catch branches", () => {
  it("readManifestTag catch: VERSION is a directory", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "VERSION"));
      expect(
        resolveVersion({
          frameworkRoot: dir,
          fromEnv: () => null,
          fromDeftVersion: () => null,
          fromGit: () => null,
        }),
      ).toBe("0.0.0-dev");
    });
  });

  it("readDeftVersion catch: .deft-version is a directory", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".deft-version"));
      expect(
        resolveVersion({
          frameworkRoot: dir,
          fromEnv: () => null,
          fromManifest: () => null,
          fromGit: () => null,
        }),
      ).toBe("0.0.0-dev");
    });
  });
});

// A throwaway local git repo (no network, no auth, no global-config mutation) is
// the only way to exercise the `payloadIsOwnGitRoot == true` + `git describe`
// success/catch branches of the default `fromGit` seam.
function gitIn(dir: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
    cwd: dir,
    stdio: "ignore",
    timeout: 10_000,
  });
}

describe("resolve-version default git seam (local throwaway repo)", () => {
  it("own-git-root with no tags falls back to dev (describe catch)", () => {
    withTempDir((dir) => {
      gitIn(dir, ["init", "-q"]);
      expect(payloadIsOwnGitRoot(dir)).toBe(true);
      expect(
        resolveVersion({
          frameworkRoot: dir,
          fromEnv: () => null,
          fromManifest: () => null,
          fromDeftVersion: () => null,
        }),
      ).toBe("0.0.0-dev");
      expect(latestLocalPublishableTag(dir)).toBeNull();
    });
  });

  it("own-git-root with a tag resolves and strips the v prefix", () => {
    withTempDir((dir) => {
      gitIn(dir, ["init", "-q"]);
      gitIn(dir, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "init"]);
      gitIn(dir, ["tag", "v1.2.3"]);
      expect(
        resolveVersion({
          frameworkRoot: dir,
          fromEnv: () => null,
          fromManifest: () => null,
          fromDeftVersion: () => null,
        }),
      ).toBe("1.2.3");
      expect(latestLocalPublishableTag(dir)).toBe("v1.2.3");
    });
  });
});

describe("platform-capabilities default-environ branch", () => {
  it("probeRuntimeCapabilities reads process.env when environ is omitted", () => {
    const report = probeRuntimeCapabilities({
      uidMapPath: "/none",
      cwd: "/none",
      effectiveUidOverride: 1000,
    });
    expect(typeof report.runtimeMode).toBe("string");
    expect(report.effectiveUid).toBe(1000);
  });
});

describe("linear-scan header/bullet/issue branch coverage", () => {
  it("parseSectionHeader handles indent, bracket, and non-matches", () => {
    expect(parseSectionHeader("   ## [Indented]")).toBe("Indented");
    expect(parseSectionHeader("## nobracket")).toBeNull();
    expect(parseSectionHeader("## [unterminated")).toBeNull();
    expect(parseSectionHeader("plain line")).toBeNull();
  });

  it("parseSubsectionHeader requires a non-empty name", () => {
    expect(parseSubsectionHeader("### Name")).toBe("Name");
    expect(parseSubsectionHeader("###    ")).toBeNull();
    expect(parseSubsectionHeader("## [x]")).toBeNull();
  });

  it("isEntryBulletLine requires a bullet then whitespace", () => {
    expect(isEntryBulletLine("- ok")).toBe(true);
    expect(isEntryBulletLine("  * ok")).toBe(true);
    expect(isEntryBulletLine("-")).toBe(false); // bullet at end of line
    expect(isEntryBulletLine("-x")).toBe(false); // no whitespace after bullet
    expect(isEntryBulletLine("plain")).toBe(false);
  });

  it("extractIssueNumbers ignores non-digit and unterminated forms", () => {
    const nums = extractIssueNumbers("see (#12) and (#x) and (#34) and (#56");
    expect([...nums].sort()).toEqual(["12", "34"]);
  });
});

describe("slug-normalize array-existing branch", () => {
  it("disambiguateSlug accepts an array for existing slugs", () => {
    expect(disambiguateSlug("x", ["x"])).toBe("x-2");
    expect(disambiguateSlug("y", ["x"])).toBe("y");
  });
});
