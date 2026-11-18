import { describe, expect, it } from "vitest";
import { LIVE_PROCEDURE_EXCLUSIONS } from "../../deposit/live-procedure-exclusions.js";
import { isFile, readText } from "./_helpers.js";

/**
 * Bound lean 5514459336 / #4098: one deposited symptom index.
 * Every other surface is a pointer. Recovery bytes stay in doctor / #4090.
 */

const HUB = "docs/SUPPORT.md";
const README_HUB_POINTER = "content/docs/SUPPORT.md";
const GETTING_STARTED_POINTER = "content/docs/getting-started.md";

const REQUIRED_SYMPTOMS = [
  /path|package manager/i,
  /node/i,
  /stale deposit/i,
  /permission/i,
  /windows/i,
  /hook/i,
  /migration/i,
  /offline/i,
  /corporate|mirror/i,
] as const;

const FORBIDDEN_RECOVERY_BYTES = [
  "npm i -g",
  "pnpm add -g",
  "deft-install --yes",
  "disable-host-hooks",
  "doctor --redact",
] as const;

function supportHubMarkdown(): string {
  return readText(HUB);
}

function readme(): string {
  return readText("README.md");
}

function tableDataRows(text: string): string[] {
  return text.split("\n").filter((line) => {
    if (!line.startsWith("|")) return false;
    if (/^\|[\s|:-]+\|$/.test(line)) return false;
    if (/^\|\s*Symptom\s*\|/i.test(line)) return false;
    return true;
  });
}

describe("support hub for #4098 / lean 5514459336", () => {
  it("fails when the canonical deposited hub is missing", () => {
    expect(isFile(HUB), "content/docs/SUPPORT.md must exist").toBe(true);
  });

  it("fails when README lacks one-click Support and getting-started pointers", () => {
    const text = readme();
    expect(text, "README missing Support hub pointer").toContain(README_HUB_POINTER);
    expect(text, "README missing getting-started pointer").toContain(GETTING_STARTED_POINTER);
    // #5867: the cold-start block moved to the end of the README, so the
    // pointers are checked from the top of the page.
    const coldAt = text.indexOf("<!-- deft:cold-start-bootstrap");
    const top = text.slice(0, coldAt >= 0 ? coldAt : text.length);
    const hubAt = top.indexOf(README_HUB_POINTER);
    const gettingStartedHeading = top.indexOf("## \uD83D\uDE80 Getting Started");
    expect(hubAt, "Support pointer must sit above Getting Started").toBeGreaterThanOrEqual(0);
    expect(gettingStartedHeading).toBeGreaterThan(hubAt);
    const gsAt = top.indexOf(GETTING_STARTED_POINTER);
    expect(gsAt, "getting-started pointer must sit above Getting Started").toBeGreaterThanOrEqual(
      0,
    );
    expect(gettingStartedHeading).toBeGreaterThan(gsAt);
  });

  it("does not duplicate the hub symptom table in README", () => {
    const text = readme();
    expect(text).not.toMatch(/\|\s*Symptom\s*\|/i);
    expect(text.toLowerCase()).not.toContain("stale deposit");
  });

  it("indexes symptoms to doctor --full or README cold-start without a second ladder", () => {
    const text = supportHubMarkdown();
    expect(text).toContain("directive doctor --full");
    expect(text.toLowerCase()).toContain("cold-start");
    expect(text).toContain("Next command:");

    const rows = tableDataRows(text);
    expect(rows.length, "hub must ship a symptom table").toBeGreaterThanOrEqual(
      REQUIRED_SYMPTOMS.length,
    );

    for (const needle of REQUIRED_SYMPTOMS) {
      const row = rows.find((line) => needle.test(line));
      expect(row, `missing symptom row matching ${needle}`).toBeDefined();
      expect(row, `row ${needle} must name doctor --full or README cold-start`).toMatch(
        /doctor --full|cold-start/i,
      );
    }

    for (const token of FORBIDDEN_RECOVERY_BYTES) {
      expect(text, `hub must not inline recovery byte ${token}`).not.toContain(token);
    }
  });

  it("routes hook-runtime and corporate-registry to owners without restating them", () => {
    const text = supportHubMarkdown();
    expect(text).toContain("hook-runtime-unavailable.md");
    expect(text).toContain("templates/agents-entry.md");
    expect(text).toContain("UPGRADING.md#corporate-or-mirrored-npm-registry");
    expect(text).not.toContain("--registry=https://registry.npmjs.org/");
  });

  it("does not use paste-JSON or a doctor --redact verb as the capture control", () => {
    const text = supportHubMarkdown();
    expect(text).toMatch(/do not paste/i);
    expect(text).toContain("Next command:");
    expect(text).not.toContain("doctor --redact");
    expect(text.toLowerCase()).not.toContain("paste-the-json");
  });

  it("splits ordinary issues from root SECURITY.md", () => {
    const text = supportHubMarkdown();
    expect(text).toContain("SECURITY.md");
    expect(text).not.toContain("docs/security.md");
  });

  it("keeps the hub off LIVE_PROCEDURE_EXCLUSIONS", () => {
    expect(LIVE_PROCEDURE_EXCLUSIONS.some((entry) => entry.path.includes("SUPPORT"))).toBe(false);
  });
});
