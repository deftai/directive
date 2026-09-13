import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECOVERY_LADDER_NPM_GLOBAL, RECOVERY_LADDER_NPX_PREFIX } from "../../doctor/constants.js";
import { REPO_ROOT, readRepoFile } from "./helpers.js";

/**
 * #4430 Bound-remedy: named recovery targets must resolve in a fresh consumer
 * clone. Separate from CANONICAL_PATHS (main.md / SKILL.md preamble shape).
 * Layout-agnostic spelling so C1 flatten still resolves.
 */
const RECOVERY_CARRIERS = ["templates/agents-entry.md", "main.md", "SKILL.md"] as const;

const FUSED_FOURTH_SPELLING = `${RECOVERY_LADDER_NPM_GLOBAL} && directive doctor`;

function recoveryWindow(relPath: (typeof RECOVERY_CARRIERS)[number], text: string): string {
  const lines = text.split("\n");
  if (relPath === "templates/agents-entry.md") {
    const fallback = lines.find((line) => line.includes(".agents/skills")) ?? "";
    const routing = lines.find((line) => /Bootstrap:\s*Cold-start/i.test(line)) ?? "";
    const bootstrap = routing.match(/Bootstrap:\s*Cold-start[^;]+/i)?.[0] ?? "";
    return [fallback, bootstrap].filter((part) => part.length > 0).join("\n");
  }
  return lines.slice(0, 12).join("\n");
}

function looksLikeFilePath(token: string): boolean {
  return /\.(md|json)$/i.test(token) || token.includes("/");
}

function isTriggerPath(token: string): boolean {
  return token.includes(".agents/skills");
}

const RECOVERY_LADDER_NPM_GLOBAL_PINNED = `${RECOVERY_LADDER_NPM_GLOBAL}@<pin>`;

function isFilelessCommand(token: string): boolean {
  return (
    token === RECOVERY_LADDER_NPM_GLOBAL ||
    token === RECOVERY_LADDER_NPM_GLOBAL_PINNED ||
    token.startsWith(`${RECOVERY_LADDER_NPM_GLOBAL}@`) ||
    token === RECOVERY_LADDER_NPX_PREFIX ||
    token.startsWith(`${RECOVERY_LADDER_NPX_PREFIX} `) ||
    token === "directive doctor" ||
    token === "deft doctor" ||
    token === "deft agents:refresh" ||
    token === "deft update"
  );
}

/** File paths an agent is told to read as the recovery target, not the trigger. */
export function namedRecoveryFileTargets(window: string): string[] {
  const targets = new Set<string>();
  for (const match of window.matchAll(/`([^`]+)`/g)) {
    const token = match[1] ?? "";
    if (isFilelessCommand(token) || isTriggerPath(token) || !looksLikeFilePath(token)) {
      continue;
    }
    targets.add(token);
  }
  if (/README\s*§\s*Cold-start/i.test(window)) {
    targets.add("README.md");
  }
  if (/read the \*\*Cold-start bootstrap\*\* block/i.test(window)) {
    targets.add("README.md");
  }
  if (window.includes(".deft/core/QUICK-START.md")) {
    targets.add(".deft/core/QUICK-START.md");
  }
  return [...targets].sort();
}

/**
 * A recovery target must resolve on a greenfield clone (payload untracked)
 * AND when the payload happens to be committed. Payload paths and undeposited
 * README.md fail greenfield, so they fail the both-layouts property.
 */
export function resolvesOnBothLayouts(target: string): boolean {
  return resolvesInFreshClone(target, false) && resolvesInFreshClone(target, true);
}

export function resolvesInFreshClone(target: string, payloadCommitted: boolean): boolean {
  if (isFilelessCommand(target) || !looksLikeFilePath(target)) {
    return true;
  }
  if (target.startsWith(".deft/core/") || target.startsWith("content/")) {
    return payloadCommitted;
  }
  if (/(^|\/)README\.md$/i.test(target)) {
    return false;
  }
  return target === "AGENTS.md" || target === "package.json";
}

function recoveryInstructions(window: string): string[] {
  const instructions: string[] = [];
  const fallback = window.match(/If any \.deft\/core\/\.agents\/skills\/[^\n]+/);
  if (fallback?.[0]) instructions.push(fallback[0]);
  const bootstrap = window.match(/Bootstrap:\s*Cold-start[^;\n]+/i);
  if (bootstrap?.[0]) instructions.push(bootstrap[0]);
  const toRecover = window.match(/To recover:[^\n]+/);
  if (toRecover?.[0]) instructions.push(toRecover[0]);
  return instructions.length > 0 ? instructions : [window];
}

describe("recovery target resolvability (#4430 / #2273)", () => {
  it("uses a separate carrier list that includes templates/agents-entry.md", () => {
    expect(RECOVERY_CARRIERS).toContain("templates/agents-entry.md");
    const preambleSrc = readFileSync(
      join(REPO_ROOT, "packages/core/src/content-contracts/skills/main_md_preamble.test.ts"),
      "utf8",
    );
    expect(preambleSrc).toContain('const CANONICAL_PATHS = ["main.md", "SKILL.md"]');
    expect(preambleSrc).not.toMatch(/CANONICAL_PATHS = \[[^\]]*agents-entry/);
  });

  it.each(
    RECOVERY_CARRIERS,
  )("named recovery targets resolve on greenfield and tracked-payload clones: %s", (relPath) => {
    const window = recoveryWindow(relPath, readRepoFile(relPath));
    const targets = namedRecoveryFileTargets(window);
    const unresolved = targets.filter((target) => !resolvesOnBothLayouts(target));
    expect(unresolved).toEqual([]);
  });

  it("managed carrier reuses #4090 ladder, doctor-first, no fused fourth spelling", () => {
    const template = readRepoFile("templates/agents-entry.md");
    const window = recoveryWindow("templates/agents-entry.md", template);
    expect(window).toContain(RECOVERY_LADDER_NPM_GLOBAL_PINNED);
    expect(window).toContain("directive doctor");
    expect(window).not.toContain(FUSED_FOURTH_SPELLING);
    expect(window).not.toContain(".deft/core/QUICK-START.md");
    expect(window).not.toMatch(/README\s*§\s*Cold-start/);
    for (const instruction of recoveryInstructions(window)) {
      const doctorAt = instruction.indexOf("directive doctor");
      const installAt = instruction.indexOf(RECOVERY_LADDER_NPM_GLOBAL_PINNED);
      expect(doctorAt).toBeGreaterThanOrEqual(0);
      expect(installAt).toBeGreaterThanOrEqual(0);
      expect(doctorAt).toBeLessThan(installAt);
    }
  });

  it.each(
    RECOVERY_CARRIERS,
  )("recovery install appends @<pin> from package.json, not an unversioned registry default: %s", (relPath) => {
    const window = recoveryWindow(relPath, readRepoFile(relPath));
    const instructions = recoveryInstructions(window);
    expect(instructions.length).toBeGreaterThan(0);
    for (const instruction of instructions) {
      expect(instruction).toContain(RECOVERY_LADDER_NPM_GLOBAL_PINNED);
      expect(instruction).not.toMatch(/`npm i -g @deftai\/directive`/);
    }
  });
});
