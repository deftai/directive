import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

/**
 * OVPR cold-start teaching (#5490 / AC10.10 / AC13.8).
 * Canonical path: npm i -g @deftai/directive → directive install / repair /
 * upgrade / doctor. Go release-asset install-* one-liners are deleted — they
 * may appear only in an explicitly RETIRED / historical footnote.
 */

const COLD_START_SURFACES = ["README.md", "QUICK-START.md", "docs/getting-started.md"] as const;

const OVPR_VERBS = [
  "directive install",
  "directive install --repair",
  "directive upgrade",
  "directive doctor",
] as const;

/** Go release-asset URL shapes that must not be the current install path. */
const GO_ASSET_RES = [
  /releases\/latest\/download\/install-macos-universal/,
  /releases\/latest\/download\/install-linux-amd64/,
  /releases\/latest\/download\/install-windows-amd64\.exe/,
] as const;

function lineOf(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

function isRetiredOrHistoricalContext(line: string): boolean {
  return /historical|retired|deleted|do not download|do not run|no longer|archaeology|formerly/i.test(
    line,
  );
}

describe("OVPR install cold-start (AC10.10 / AC13.8)", () => {
  it.each(COLD_START_SURFACES)("%s teaches npm global launcher + project install", (rel) => {
    const content = readText(rel);
    expect(content, `${rel} missing global launcher`).toContain("npm i -g @deftai/directive");
    expect(content, `${rel} missing directive install`).toMatch(/directive install\b/);
  });

  it.each(COLD_START_SURFACES)("%s teaches repair / upgrade / doctor", (rel) => {
    const content = readText(rel);
    for (const verb of OVPR_VERBS) {
      expect(content, `${rel} missing ${verb}`).toContain(verb);
    }
  });

  it("README cold-start leads with npm launcher before directive install", () => {
    const content = readText("README.md");
    const npmIdx = content.indexOf("npm i -g @deftai/directive");
    const installIdx = content.indexOf("directive install");
    expect(npmIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(npmIdx);
  });

  it("README marks the Go installer as RETIRED, not a current path", () => {
    const content = readText("README.md");
    expect(content).toMatch(/Legacy Go installer\s*[—-]\s*RETIRED/i);
    expect(content).toMatch(/Go installer[\s\S]{0,120}deleted/i);
    expect(content).not.toMatch(
      /curl[^\n]*releases\/latest\/download\/install-|releases\/latest\/download\/install-[^\n]*\| sh/,
    );
  });

  it.each(
    COLD_START_SURFACES,
  )("%s does not teach Go release-asset install-* as the primary path", (rel) => {
    const content = readText(rel);
    const violations: string[] = [];
    for (const re of GO_ASSET_RES) {
      const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
      for (const m of content.matchAll(new RegExp(re.source, flags))) {
        const line = lineOf(content, m.index ?? 0);
        if (isRetiredOrHistoricalContext(line)) continue;
        // Allow a RETIRED section heading/body that names the deleted assets.
        const windowStart = Math.max(0, (m.index ?? 0) - 400);
        const window = content.slice(windowStart, (m.index ?? 0) + 200);
        if (/RETIRED|Historical only|has been removed|deleted/i.test(window)) continue;
        violations.push(line);
      }
    }
    // Bare releases/latest/download without install-* may appear in archaeology
    // pointers; only the platform install-* asset URLs were the Go one-liner.
    expect(violations, `${rel} still teaches Go install-* assets as current`).toEqual([]);
  });

  it("QUICK-START headless / agent path uses npm + directive verbs, not Go --yes flags", () => {
    const content = readText("QUICK-START.md");
    expect(content).toContain("npm i -g @deftai/directive");
    expect(content).toContain("directive install");
    expect(content).not.toContain("--yes --repo-root . --json");
  });
});
