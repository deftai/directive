/**
 * Wave 3t / DEFT-INSTALL-RESIDUAL (AC10.10).
 * Extend residual surfaces beyond wave2x init-cli / UPGRADING set:
 * ARCHITECTURE.md, FILES.md, deft-directive-sync skill, content-manifest.
 */
import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const AC97 = "directive install --repair";
const GLOBAL_LAUNCHER = "npm i -g @deftai/directive";

/** Wave 3t residual carriers that still taught Go installer as current. */
const WAVE3T_SURFACES = [
  "docs/ARCHITECTURE.md",
  "docs/FILES.md",
  "skills/deft-directive-sync/SKILL.md",
  "conventions/content-manifest.json",
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
  {
    id: "not-deleted",
    re: /\bNot deleted\b/,
  },
  {
    id: "no-node-bridge",
    re: /no-Node bootstrap bridge/i,
  },
  {
    id: "canonical-go-bootstrap",
    re: /canonical bootstrap\/upgrade binary/i,
  },
  {
    id: "frozen-go-installer-module",
    re: /Frozen Go installer (module|source)/i,
  },
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

function isProhibitionOrArchaeologyLine(line: string): boolean {
  return /do not (use|teach|download|run)|never (use|teach|recover)|avoid teaching|not teach|⊗|has been removed|deleted|retired|historical|archaeology|no longer|absent|husk|formerly held/i.test(
    line,
  );
}

describe("OVPR residual docs wave3t (AC10.10 DEFT-INSTALL-RESIDUAL)", () => {
  it.each(WAVE3T_SURFACES)(
    "%s does not prescribe deft-install / Go installer as current guidance",
    (rel) => {
      const text = readText(rel);
      const found: string[] = [];
      for (const { id, re } of DEFT_INSTALL_CURRENT_RES) {
        for (const line of hits(text, re)) {
          if (isProhibitionOrArchaeologyLine(line)) continue;
          found.push(`${id}: ${line}`);
        }
      }
      expect(found, `${rel} still teaches deft-install as current`).toEqual([]);
    },
  );

  it("ARCHITECTURE teaches OVPR + deleted Go (not Not deleted / deft-install gate current)", () => {
    const text = readText("docs/ARCHITECTURE.md");
    expect(text).toContain(GLOBAL_LAUNCHER);
    expect(text).toContain(AC97);
    expect(text).toMatch(/directive install/);
    expect(text).toMatch(/directive upgrade/);
    expect(text).toMatch(/Deleted \/ archaeology only \(AC10\.10\)/);
    expect(text).not.toMatch(/\bNot deleted\b/);
    expect(text).not.toMatch(/no-Node bootstrap bridge/i);
  });

  it("FILES.md does not inventory cmd/deft-install or go.mod as current installer", () => {
    const text = readText("docs/FILES.md");
    expect(text).toMatch(/Archaeology husk only|Historical only \(deleted AC10\.10\)/);
    expect(text).not.toMatch(/Frozen Go installer module/);
    expect(text).not.toMatch(/Frozen Go installer source and embedded payload logic/);
  });

  it("sync skill teaches OVPR install/upgrade/repair — not Go bridge or .deft/core refresh", () => {
    const text = readText("skills/deft-directive-sync/SKILL.md");
    expect(text).toContain(GLOBAL_LAUNCHER);
    expect(text).toContain(AC97);
    expect(text).toMatch(/directive upgrade/);
    expect(text).toMatch(/is \*\*deleted\*\*/);
    expect(text).not.toMatch(/no-Node bootstrap bridge/i);
    expect(text).not.toMatch(/directive update` \(or `deft update`\) to refresh `\.deft\/core\//);
  });

  it("content-manifest does not inventory Go installer as canonical bootstrap", () => {
    const text = readText("conventions/content-manifest.json");
    expect(text).toMatch(/Historical only \(AC10\.10\)|deleted \(AC10\.10\)/);
    expect(text).not.toMatch(/canonical bootstrap\/upgrade binary/);
    expect(text).toContain(AC97);
  });
});
