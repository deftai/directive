import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectIpTerms, ipRiskScopeItems, plainRiskSummary } from "./ip-risk.js";
import {
  classifyIdentityKind,
  classifyRuntimeMode,
  detectSandboxUidRemap,
  readUidMap,
} from "./platform-capabilities.js";
import {
  DEV_FALLBACK,
  isPublishable,
  NonPublishableVersionError,
  resolveVersion,
  tagNameFromRef,
  toPep440,
} from "./resolve-version.js";

describe("resolveVersion", () => {
  it("follows env override priority", () => {
    expect(
      resolveVersion({
        frameworkRoot: "/tmp",
        fromEnv: () => "1.2.3",
        fromManifest: () => "9.9.9",
        fromDeftVersion: () => null,
        fromGit: () => null,
      }),
    ).toBe("1.2.3");
  });

  it("falls back to dev", () => {
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

  it("normalizes pep440 and publishability", () => {
    expect(toPep440("v0.22.0")).toBe("0.22.0");
    expect(toPep440("v0.20.0-rc.3")).toBe("0.20.0rc3");
    expect(isPublishable("v0.22.0")).toBe(true);
    expect(() => toPep440("v0.0.0-test.1")).toThrow(NonPublishableVersionError);
    expect(tagNameFromRef("abc123 refs/tags/v1.0.0")).toBe("v1.0.0");
  });
});

describe("platformCapabilities", () => {
  it("detects sandbox uid remap", () => {
    const uidMap = readUidMapFromLines(["0 1000 1", "1 100001 1"]);
    expect(detectSandboxUidRemap(uidMap, { effectiveUid: 0, cursorOrigUid: 1000 })).toBe(true);
    expect(classifyIdentityKind({ effectiveUid: 0, sandboxUidRemap: true })).toBe(
      "sandbox-remapped-local-user",
    );
    expect(
      classifyRuntimeMode(
        { CURSOR_SANDBOX: "1" },
        detectSandboxUidRemap(uidMap, {
          effectiveUid: 0,
          cursorOrigUid: 1000,
        }),
      ),
    ).toBe("cursor-native-sandbox");
  });
});

function readUidMapFromLines(lines: string[]): ReturnType<typeof readUidMap> {
  const dir = mkdtempSync(join(tmpdir(), "uid-map-"));
  const path = join(dir, "map");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  const entries = readUidMap(path);
  rmSync(dir, { recursive: true, force: true });
  return entries;
}

describe("ipRisk", () => {
  it("detects branded terms and builds scope items", () => {
    const hits = detectIpTerms("Magic: The Gathering deck builder");
    expect(hits.some((h) => h.category === "branded-game-or-universe")).toBe(true);
    const items = ipRiskScopeItems("commercial");
    expect(items.length).toBe(3);
    const summary = plainRiskSummary(hits, "unknown");
    expect(summary).toContain("interview MUST capture");
  });
});
