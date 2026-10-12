/**
 * Wave 2x / DEFT-INSTALL-DOC + DOCS-RESIDUAL (AC10.10, AC13.8, AC9.11, D4.9).
 * Residual setup/recovery surfaces beyond the wave2r gated cold-start set:
 * UPGRADING, skill-pin/discovery docs, and session-start soft-rebind SoT.
 * Prefer fixture assertions over whole-file greps; do not narrow AC13.8.
 */
import { describe, expect, it } from "vitest";
import {
  formatOpenClawSoftRebindSkillMarkdown,
  formatSoftAgentsRebindChecklist,
  SOFT_AGENTS_REBIND_CHECKLIST,
} from "../../session/compact-ritual.js";
import { readText } from "./_helpers.js";

const RUNTIME_MAIN = "node_modules/@deftai/directive-runtime/main.md";
const AC97 = "directive install --repair";
const GLOBAL_LAUNCHER = "npm i -g @deftai/directive";

/** Residual setup/recovery carriers named by wave2x findings. */
const RESIDUAL_SURFACES = [
  "UPGRADING.md",
  "docs/skill-pin-policy.md",
  "docs/skill-discovery-hosts.md",
  "QUICK-START.md",
  "README.md",
] as const;

const FORBIDDEN_COMMAND_RES = [
  { id: "npx-package", re: /\bnpx\s+(-y\s+)?@deftai\/directive\b/ },
  { id: "npx-deft", re: /\bnpx\s+deft\b/ },
  { id: "pnpm-exec", re: /\bpnpm\s+exec\b/ },
  { id: "align-pin", re: /\balign-pin\b/ },
] as const;

/** Actionable current-guidance forms that prescribe running the deleted Go installer. */
const DEFT_INSTALL_CURRENT_RES = [
  { id: "cmd-block", re: /(?:^|\n)\s*deft-install\s+--/m },
  { id: "go-run", re: /\bgo\s+run\s+\.\/cmd\/deft-install\b/ },
  {
    id: "download-latest",
    re: /Download the latest [`'"]?deft-install[`'"]? binary/i,
  },
  {
    id: "run-frozen-bridge",
    re: /Run the frozen final Go bridge installer/i,
  },
  {
    id: "uses-frozen",
    re: /If your current install uses the frozen Go installer\s*\(`?deft-install`?\)/i,
  },
] as const;

/** Positive teaching of the legacy deposit as the current install location. */
const CORE_TEACHING_RES = [
  /Deft is installed in \.?\.?\/?\.deft\/core/i,
  /Full guidelines:\s*\.?\.?\/?\.deft\/core\//i,
  /Always start with[`'"]?\s*:\s*[`'"]?\.deft\/core\//i,
  /has [`'"]?\.deft\/core\/[`'"]? directory/i,
  /lives under [`'"]?\.deft\/core\//i,
  /mirror the same four paths under [`'"]?\.deft\/core\//i,
  /re-copies the vendored [`'"]?\.deft\/core\//i,
  /refresh(?:es)? (?:the )?vendored [`'"]?\.deft\/core\//i,
  /Read and follow:\s*\.deft\/core\//i,
  /taskfile:\s*\.\/\.deft\/core\//i,
  /task -t \.\/\.deft\/core\//i,
] as const;

function hits(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  for (const m of text.matchAll(global)) {
    const lineStart = text.lastIndexOf("\n", m.index ?? 0) + 1;
    const lineEnd = text.indexOf("\n", m.index ?? 0);
    out.push(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim());
  }
  return out;
}

function isProhibitionLine(line: string): boolean {
  return /do not (use|teach)|never (use|teach|recover)|avoid teaching|not teach|⊗\s*never recover via|has been removed|deleted|retired|historical|no longer|do not run/i.test(
    line,
  );
}

function isLegacyOnlyLine(line: string): boolean {
  return /no copied|removes? legacy|pre-split|supported latest legacy|historical|retired|archaeology|legacy-only|was removed|no longer/i.test(
    line,
  );
}

describe("OVPR residual docs wave2x (AC10.10 / AC13.8 / AC9.11)", () => {
  it.each(RESIDUAL_SURFACES)("%s forbids npx / pnpm exec / align-pin teaching", (rel) => {
    const text = readText(rel);
    const found: string[] = [];
    for (const { id, re } of FORBIDDEN_COMMAND_RES) {
      for (const line of hits(text, re)) {
        if (isProhibitionLine(line)) continue;
        found.push(`${id}: ${line}`);
      }
    }
    expect(found, `${rel} still teaches forbidden commands`).toEqual([]);
  });

  it.each(RESIDUAL_SURFACES)("%s does not teach .deft/core as current install location", (rel) => {
    const text = readText(rel);
    const found: string[] = [];
    for (const re of CORE_TEACHING_RES) {
      for (const line of hits(text, re)) {
        if (isLegacyOnlyLine(line)) continue;
        found.push(line);
      }
    }
    expect(found, `${rel} still teaches .deft/core as current`).toEqual([]);
  });

  it.each(RESIDUAL_SURFACES)(
    "%s does not prescribe deft-install / Go installer as current guidance",
    (rel) => {
      const text = readText(rel);
      const found: string[] = [];
      for (const { id, re } of DEFT_INSTALL_CURRENT_RES) {
        for (const line of hits(text, re)) {
          if (isProhibitionLine(line)) continue;
          found.push(`${id}: ${line}`);
        }
      }
      expect(found, `${rel} still teaches deft-install as current`).toEqual([]);
    },
  );

  it("UPGRADING Current path teaches OVPR + AC9.7 (not deposit refresh)", () => {
    const text = readText("UPGRADING.md");
    const current = text.slice(0, text.indexOf("\n---\n", text.indexOf("## Current path")));
    expect(current).toContain(GLOBAL_LAUNCHER);
    expect(current).toMatch(/directive upgrade\b/);
    expect(current).toContain(AC97);
    expect(current).not.toMatch(/deft-install\s+--/);
    expect(current).not.toMatch(/re-copies the vendored/);
  });

  it("skill-pin-policy routes on-demand discovery without npx deft", () => {
    const text = readText("docs/skill-pin-policy.md");
    expect(text).not.toMatch(/\bnpx\s+deft\b/);
    expect(text).toMatch(/REFERENCES\.md|Skills Index|directive-runtime/);
  });

  it("session-start soft-rebind SoT uses package-relative runtime (no .deft/core)", () => {
    const deposit = SOFT_AGENTS_REBIND_CHECKLIST.find((c) => c.id === "deposit-integrity");
    expect(deposit, "deposit-integrity checklist item").toBeDefined();
    expect(deposit!.text).toContain(RUNTIME_MAIN);
    expect(deposit!.text).not.toMatch(/\.deft\/core/);
    expect(deposit!.text).toMatch(/install --repair|doctor/);

    const checklist = formatSoftAgentsRebindChecklist();
    const skill = formatOpenClawSoftRebindSkillMarkdown();
    for (const text of [checklist, skill]) {
      expect(text).toContain(RUNTIME_MAIN);
      expect(text).not.toMatch(/\.deft\/core/);
      expect(text).not.toMatch(/\bnpx\s+/);
      expect(text).not.toMatch(/\bpnpm\s+exec\b/);
      expect(text).not.toMatch(/deft-install/);
    }
  });
});
