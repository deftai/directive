import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentsRefreshPlan,
  attributeRenderManagedSection,
  extractManagedSection,
  frameworkRoot,
  hasV3ManagedMarker,
  parseManagedSectionAttrs,
  renderManagedSection,
  stripManagedSectionAttrs,
} from "./agents-md.js";
import { AGENTS_MANAGED_CLOSE, AGENTS_MANAGED_OPEN_V3_LITERAL } from "./constants.js";
import { detectIpTerms, ipRiskScopeItems, isIpAdjacent, plainRiskSummary } from "./ip-risk.js";
import {
  extractIssueNumbers,
  findManagedOpenMarker,
  isEntryBulletLine,
  isWordChar,
  matchAt,
  parseManagedOpenMarker,
  parseSectionHeader,
  parseSubsectionHeader,
  wordBoundaryMatch,
} from "./linear-scan.js";
import {
  classifyIdentityKind,
  classifyRuntimeMode,
  detectSandboxUidRemap,
  getPlatformCapabilities,
  probeRuntimeCapabilities,
  readUidMap,
  reportToDict,
} from "./platform-capabilities.js";
import {
  evaluateChangelogPath,
  findAmbientSubsection,
  findConflictBlocks,
  findUnreleasedBounds,
  isOrphanHeader,
  parseSide,
  renderResolved,
  resolveChangelog,
  unionMerge,
} from "./resolve-changelog-unreleased.js";
import {
  DEV_FALLBACK,
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

const MANAGED_BODY = `${AGENTS_MANAGED_OPEN_V3_LITERAL}\nbody\n${AGENTS_MANAGED_CLOSE}`;

describe("platform module coverage", () => {
  it("covers linear-scan helpers", () => {
    expect(isWordChar("a")).toBe(true);
    expect(isWordChar("!")).toBe(false);
    expect(matchAt("Hello", 0, "hel")).toBe(true);
    expect(wordBoundaryMatch("foo bar", 4, "bar")).toBe(true);
    expect(parseSectionHeader("## [Unreleased]")).toBe("Unreleased");
    expect(parseSubsectionHeader("### Added")).toBe("Added");
    expect(isEntryBulletLine("  - item")).toBe(true);
    expect(extractIssueNumbers("Refs (#12) and (#34)")).toEqual(new Set(["12", "34"]));
    const marker = parseManagedOpenMarker(
      "<!-- deft:managed-section v3 sha=abc refreshed=2020 session=s -->",
      0,
    );
    expect(marker?.version).toBe(3);
    expect(findManagedOpenMarker(MANAGED_BODY)?.version).toBe(3);
  });

  it("covers slug normalization edge paths", () => {
    expect(normalizeSlug("", 0)).toBe("untitled");
    expect(normalizeSlug("a".repeat(80), 20).length).toBeLessThanOrEqual(20);
    expect(disambiguateSlug("x", new Set(["x"]), { maxLen: 3 })).toMatch(/^x-\d+$/);
    const blocked = new Set<string>(["slug"]);
    for (let i = 2; i <= 10_001; i += 1) blocked.add(`slug-${i}`);
    expect(() => disambiguateSlug("slug", blocked)).toThrow(/unable to resolve collision/);
  });

  it("covers agents-md current state and marker helpers", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-current-"));
    try {
      const rendered = stripManagedSectionAttrs(MANAGED_BODY);
      const attributed = attributeRenderManagedSection(rendered, {
        frameworkSha: "abc",
        refreshed: "2020-01-01T00:00:00Z",
        sessionId: "sess12345678",
      });
      writeFileSync(join(root, "AGENTS.md"), `${attributed}\n`, "utf8");
      expect(
        agentsRefreshPlan(root, {
          readTemplate: () => MANAGED_BODY,
          resolveSha: () => "abc",
          nowIso: () => "2020-01-01T00:00:00Z",
          newSession: () => "sess12345678",
        }).state,
      ).toBe("current");

      const v2Only = "<!-- deft:managed-section v2 -->\nlegacy\n<!-- /deft:managed-section -->";
      expect(hasV3ManagedMarker(root, () => v2Only)).toBe(false);
      expect(hasV3ManagedMarker(root, () => null)).toBe(false);
      expect(frameworkRoot({ frameworkRoot: root })).toBe(join(root));
      expect(renderManagedSection("no managed marker here")).toBeNull();
      expect(extractManagedSection("no managed marker here")).toBeNull();
      expect(renderManagedSection(`${AGENTS_MANAGED_OPEN_V3_LITERAL}\nno close`)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers resolve-version deft-version and git paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ver-extra-"));
    try {
      writeFileSync(join(root, ".deft-version"), "v5.6.7\n", "utf8");
      expect(
        resolveVersion({
          frameworkRoot: root,
          fromEnv: () => null,
          fromManifest: () => null,
          fromDeftVersion: () => "5.6.7",
          fromGit: () => null,
        }),
      ).toBe("5.6.7");
      expect(toPep440("v0.20.0-rc.1")).toBe("0.20.0rc1");
      expect(tagNameFromRef("abc refs/tags/v2.0.0")).toBe("v2.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers changelog evaluate write and no-op paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cl-extra-"));
    const path = join(root, "CHANGELOG.md");
    mkdirSync(root, { recursive: true });
    const clean = "# C\n\n## [Unreleased]\n\n### Added\n\n- entry (#1)\n";
    writeFileSync(path, clean, "utf8");
    expect(
      evaluateChangelogPath(path, {
        exists: true,
        isFile: true,
        readText: () => clean,
      })[0],
    ).toBe(0);

    const conflict =
      "# C\n\n## [Unreleased]\n\n### Added\n\n<<<<<<< HEAD\n- a (#1)\n=======\n- b (#2)\n>>>>>>> x\n";
    let written = "";
    expect(
      evaluateChangelogPath(path, {
        exists: true,
        isFile: true,
        readText: () => conflict,
        writeText: (content) => {
          written = content;
        },
      })[0],
    ).toBe(0);
    expect(written).toContain("(#2)");

    expect(
      evaluateChangelogPath(path, {
        exists: true,
        isFile: true,
        readText: () => "# C\n\n## [Unreleased]\n\n<<<<<<< HEAD\nnested\n",
      })[0],
    ).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  it("covers agents-md lifecycle branches", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-md-"));
    try {
      expect(agentsRefreshPlan(root, { readTemplate: () => null }).state).toBe("template-missing");
      expect(agentsRefreshPlan(root, { readTemplate: () => "no markers here" }).state).toBe(
        "template-malformed",
      );
      expect(
        agentsRefreshPlan(root, {
          readTemplate: () => MANAGED_BODY,
          resolveSha: () => "sha",
          nowIso: () => "2020-01-01T00:00:00Z",
          newSession: () => "sess",
        }).state,
      ).toBe("absent");

      expect(
        agentsRefreshPlan(root, {
          readTemplate: () => MANAGED_BODY,
          readAgents: () => {
            throw new Error("denied");
          },
        }).state,
      ).toBe("unreadable");

      writeFileSync(join(root, "AGENTS.md"), "# legacy\n", "utf8");
      expect(
        agentsRefreshPlan(root, {
          readTemplate: () => MANAGED_BODY,
          resolveSha: () => "sha",
          nowIso: () => "2020-01-01T00:00:00Z",
          newSession: () => "sess",
        }).state,
      ).toBe("missing");

      const dup = `${MANAGED_BODY}\n\n${MANAGED_BODY.replace("body", "body2")}`;
      writeFileSync(join(root, "AGENTS.md"), dup, "utf8");
      expect(
        agentsRefreshPlan(root, {
          readTemplate: () => MANAGED_BODY,
          resolveSha: () => "sha",
          nowIso: () => "2020-01-01T00:00:00Z",
          newSession: () => "sess",
        }).state,
      ).toBe("stale");

      const attrs = parseManagedSectionAttrs(
        "<!-- deft:managed-section v3 sha=x refreshed=y session=z extra=1 -->",
      );
      expect(attrs?.sha).toBe("x");
      expect(attrs?.extras.extra).toBe("1");
      expect(stripManagedSectionAttrs(MANAGED_BODY)).toContain("v3 -->");
      expect(extractManagedSection(MANAGED_BODY)).toBe(MANAGED_BODY);
      expect(
        attributeRenderManagedSection(MANAGED_BODY, {
          frameworkSha: "s",
          refreshed: "r",
          sessionId: "id",
        }),
      ).toContain("sha=s");
      expect(hasV3ManagedMarker(root)).toBe(true);
      expect(typeof frameworkRoot()).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers resolve-version branches", () => {
    expect(toPep440("v0.20.0-alpha.1")).toBe("0.20.0a1");
    expect(toPep440("v0.20.0-beta.2")).toBe("0.20.0b2");
    expect(typeof resolveVersion()).toBe("string");
    expect(() => toPep440("not-a-version")).toThrow();
    expect(() => toPep440("v0.0.0-test.1")).toThrow(NonPublishableVersionError);
    expect(isPublishable("bad")).toBe(false);
    expect(tagNameFromRef("deadbeef refs/tags/v1.2.3^{}")).toBe("v1.2.3");
    expect(latestPublishableTag(["v1.0.0", "v1.1.0-rc.1", "v0.0.0-test.1", "garbage"])).toBe(
      "v1.1.0-rc.1",
    );
    expect(latestLocalPublishableTag("/nonexistent")).toBeNull();
    expect(latestRemotePublishableTag("origin", "/nonexistent")).toBeNull();
    expect(payloadIsOwnGitRoot("/nonexistent")).toBe(false);
    expect(
      resolveVersion({
        frameworkRoot: "/tmp",
        fromEnv: () => null,
        fromManifest: () => "1.0.0",
        fromDeftVersion: () => null,
        fromGit: () => null,
      }),
    ).toBe("1.0.0");
    expect(
      resolveVersion({
        frameworkRoot: "/tmp",
        fromEnv: () => null,
        fromManifest: () => null,
        fromDeftVersion: () => "2.0.0",
        fromGit: () => null,
      }),
    ).toBe("2.0.0");
    expect(
      resolveVersion({
        frameworkRoot: "/tmp",
        fromEnv: () => null,
        fromManifest: () => null,
        fromDeftVersion: () => null,
        fromGit: () => "3.0.0",
      }),
    ).toBe("3.0.0");
    expect(
      resolveVersion({
        frameworkRoot: "/tmp",
        fromEnv: () => null,
        fromManifest: () => null,
        fromDeftVersion: () => null,
        fromGit: () => null,
      }),
    ).toBe(DEV_FALLBACK);
  });

  it("covers changelog resolver branches", () => {
    const header = "# C\n\n## [Unreleased]\n\n";
    expect(resolveChangelog("## [Unreleased]\n\n<<<<<<< HEAD\n").content).toBeNull();
    expect(
      resolveChangelog("# C\n\n## [0.1.0]\n\n<<<<<<< HEAD\n=======\n>>>>>>> x\n").content,
    ).toBeNull();
    const lines =
      `${header}### Added\n\n<<<<<<< HEAD\n- a (#1)\n=======\n- b (#2)\n>>>>>>> x\n`.split("\n");
    const bounds = findUnreleasedBounds(lines);
    expect(bounds[0]).toBe(2);
    const start = bounds[0] ?? 0;
    const end = bounds[1] ?? lines.length;
    expect(findConflictBlocks(lines, start, end)).not.toBeNull();
    expect(findAmbientSubsection(lines, 6, 2)).toBe("Added");
    expect(parseSide(["- one (#1)"], "")).toEqual([["", ["- one (#1)"]]]);
    expect(renderResolved([["Added", ["- x"]]], "Added")).toEqual(["- x"]);
    expect(isOrphanHeader("- **open only")).toBe(true);
    expect(unionMerge([["Added", ["- head (#1)"]]], [["Added", ["- branch (#1)"]]])).toEqual([
      ["Added", ["- head (#1)"]],
    ]);

    const root = mkdtempSync(join(tmpdir(), "cl-"));
    const path = join(root, "CHANGELOG.md");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, "# C\n\n", "utf8");
    expect(evaluateChangelogPath(path, { exists: false })[0]).toBe(2);
    expect(evaluateChangelogPath(path, { isFile: false })[0]).toBe(2);
    expect(
      evaluateChangelogPath(path, {
        readText: () => {
          throw new Error("read");
        },
      })[0],
    ).toBe(2);
    writeFileSync(path, "# C\n\n## [Unreleased]\n\n", "utf8");
    expect(
      evaluateChangelogPath(path, {
        exists: true,
        isFile: true,
        readText: () => readFileSync(path, "utf8"),
      })[0],
    ).toBe(0);

    const conflict =
      "# C\n\n## [Unreleased]\n\n### Added\n\n<<<<<<< HEAD\n- a (#1)\n=======\n- b (#2)\n>>>>>>> x\n";
    expect(
      evaluateChangelogPath(path, {
        exists: true,
        isFile: true,
        readText: () => conflict,
        dryRun: true,
      })[0],
    ).toBe(0);
    expect(
      evaluateChangelogPath(path, {
        exists: true,
        isFile: true,
        readText: () => conflict,
        writeText: () => {
          throw new Error("write fail");
        },
      })[0],
    ).toBe(2);

    rmSync(root, { recursive: true, force: true });
  });

  it("covers platform capabilities and ip-risk branches", () => {
    expect(readUidMap("/no/such/file")).toEqual([]);
    expect(detectSandboxUidRemap([], { effectiveUid: 1000, cursorOrigUid: 1000 })).toBe(false);
    expect(classifyIdentityKind({ effectiveUid: 1000, sandboxUidRemap: false })).toBe("local-user");
    expect(classifyIdentityKind({ effectiveUid: 0, sandboxUidRemap: false })).toBe("real-root");
    expect(classifyRuntimeMode({ CI: "true" }, false)).toBe("cloud-headless");
    expect(classifyRuntimeMode({ CURSOR_COMPOSER: "1", CI: "true" }, false)).toBe(
      "local-unsandboxed",
    );
    expect(classifyRuntimeMode({ DEFT_AGENT_RUNTIME: "headless" }, false)).toBe("cloud-headless");
    expect(classifyRuntimeMode({ GROK_BUILD: "1" }, false)).toBe("cloud-headless");
    expect(classifyRuntimeMode({ BUILDKITE: "true" }, false)).toBe("cloud-headless");
    expect(classifyRuntimeMode({ CURSOR_SANDBOX_LANDLOCK_STATUS: "active" }, false)).toBe(
      "cursor-native-sandbox",
    );
    expect(classifyIdentityKind({ effectiveUid: null, sandboxUidRemap: false })).toBe("unknown");
    const report = probeRuntimeCapabilities({
      environ: { USER: "tester", GITHUB_ACTIONS: "true" },
      effectiveUidOverride: 1000,
    });
    expect(reportToDict(report).runtime_mode).toBe("cloud-headless");
    expect(
      getPlatformCapabilities({ environ: { CURSOR_SANDBOX: "1" }, effectiveUidOverride: 0 })
        .runtimeMode,
    ).toBe("cursor-native-sandbox");

    expect(isIpAdjacent("")).toBe(false);
    expect(ipRiskScopeItems("personal")[0]?.title).toContain("disclaimer");
    expect(plainRiskSummary([], "commercial")).toBe("");
    const hits = detectIpTerms("Mickey Mouse NFL");
    expect(plainRiskSummary(hits, "commercial")).toContain("lawyer");
    expect(plainRiskSummary(hits, "personal")).toContain("personal project");
    expect(plainRiskSummary(hits, "unknown")).toContain("interview MUST capture");
    expect(detectIpTerms("plain software project")).toEqual([]);
    expect(() => ipRiskScopeItems("invalid")).toThrow();
    expect(() => plainRiskSummary(hits, "invalid")).toThrow();
  });
});
