/**
 * Wave 4b2 / 4b3 — F-4B-GO-TEACH (AC10.10) + F-4B-NPX-DOCS (AC13.8 / AC9.11).
 * CONTRIBUTING / tasks/install / RELEASING must not teach Go installer as current.
 * Agent-facing host-grokbot + host-lifecycle-duties must not teach npx recovery.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

const AC97 = "directive install --repair";
const GLOBAL_LAUNCHER = "npm i -g @deftai/directive";

/** Maintainer / release carriers that resurrected current-path Go teaching. */
const GO_TEACH_SURFACES = ["CONTRIBUTING.md", "tasks/install.yml", "docs/RELEASING.md"] as const;

/** Packed agent-facing surfaces that taught npx as narratable recovery/discovery. */
const NPX_AGENT_SURFACES = [
  "skills/deft-directive-swarm/references/host-grokbot.md",
  "contracts/host-lifecycle-duties.md",
] as const;

const DEFT_INSTALL_CURRENT_RES = [
  { id: "cmd-block", re: /(?:^|\n)\s*deft-install\s+--/m },
  { id: "go-run", re: /\bgo\s+run\s+\.\/cmd\/deft-install\b/ },
  { id: "go-build", re: /\bgo\s+build\s+\.\/cmd\/deft-install\b/ },
  { id: "go-test-cmd", re: /\bgo\s+test\s+\.\/cmd\/deft-install\b/ },
  {
    id: "required-building",
    re: /required for building the installer/i,
  },
  {
    id: "building-section",
    re: /## Building the Go Installer\b/,
  },
  {
    id: "lives-in-cmd",
    re: /The Go installer lives in `cmd\/deft-install\/`/i,
  },
  {
    id: "rebuild-runbook-current",
    re: /To make a release rebuild the Go installer/i,
  },
  {
    id: "builds-frozen-binaries",
    re: /builds the frozen legacy Go-installer binaries/i,
  },
] as const;

const FORBIDDEN_NPX_RES = [
  { id: "npx-package", re: /\bnpx\s+(-y\s+)?@deftai\/directive\b/ },
  { id: "npx-deft", re: /\bnpx\s+deft\b/ },
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
  return /do not (use|teach|download|run|rebuild)|never (use|teach|recover)|avoid teaching|not teach|⊗|has been removed|deleted|retired|historical|archaeology|no longer|absent|husk|formerly|do not rebuild|skip(?:s|ped)? the (Go )?build/i.test(
    line,
  );
}

function currentGoGuidanceHits(text: string): string[] {
  const found: string[] = [];
  for (const { id, re } of DEFT_INSTALL_CURRENT_RES) {
    for (const line of hits(text, re)) {
      if (isProhibitionOrArchaeologyLine(line)) continue;
      found.push(`${id}: ${line}`);
    }
  }
  return found;
}

function npxTeachingHits(text: string): string[] {
  const found: string[] = [];
  for (const { id, re } of FORBIDDEN_NPX_RES) {
    for (const line of hits(text, re)) {
      if (isProhibitionOrArchaeologyLine(line)) continue;
      found.push(`${id}: ${line}`);
    }
  }
  return found;
}

function readRepoRootFile(rel: string): string {
  const abs = join(repoRoot(), rel);
  return readFileSync(abs, { encoding: "utf8" }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

describe("OVPR residual docs wave4b2 (AC10.10 F-4B-GO-TEACH)", () => {
  it("cmd/deft-install remains absent on tip", () => {
    expect(existsSync(join(repoRoot(), "cmd/deft-install"))).toBe(false);
  });

  it.each(
    GO_TEACH_SURFACES,
  )("%s does not prescribe deft-install / Go installer as current guidance", (rel) => {
    const text =
      rel.startsWith("docs/") || rel === "CONTRIBUTING.md" || rel.startsWith("tasks/")
        ? readRepoRootFile(rel)
        : readText(rel);
    expect(currentGoGuidanceHits(text), `${rel} still teaches Go installer as current`).toEqual([]);
  });

  it("CONTRIBUTING teaches Node/pnpm OVPR maintainer path (not Go bootstrap)", () => {
    const text = readRepoRootFile("CONTRIBUTING.md");
    expect(text).toMatch(/Node\.js|pnpm/);
    expect(text).toMatch(/deleted|AC10\.10|historical/i);
    expect(text).not.toMatch(/required for building the installer/i);
    expect(text).not.toMatch(/## Building the Go Installer/);
    expect(text).not.toMatch(/\bgo\s+(run|build|test)\s+\.\/cmd\/deft-install\b/);
    expect(text).not.toMatch(/(?:^|\n)\s*deft-install\s+--/m);
  });

  it("tasks/install.yml does not invoke go run ./cmd/deft-install", () => {
    const text = readRepoRootFile("tasks/install.yml");
    expect(text).not.toMatch(/\bgo\s+run\s+\.\/cmd\/deft-install\b/);
    expect(text).toMatch(/AC10\.10|deleted|directive install|@deftai\/directive/i);
  });

  it("RELEASING marks Go installer freeze/rebuild as historical (not current runbook)", () => {
    const text = readRepoRootFile("docs/RELEASING.md");
    expect(text).toMatch(/Historical|deleted|AC10\.10|archaeology/i);
    expect(text).toMatch(/npm|@deftai\/directive/);
    expect(text).not.toMatch(/builds the frozen legacy Go-installer binaries/);
    expect(text).not.toMatch(/To make a release rebuild the Go installer/);
  });
});

describe("OVPR residual docs wave4b3 (AC13.8 / AC9.11 F-4B-NPX-DOCS)", () => {
  it.each(NPX_AGENT_SURFACES)("%s does not teach npx @deftai/directive or npx deft", (rel) => {
    const text = readText(rel);
    expect(npxTeachingHits(text), `${rel} still teaches npx`).toEqual([]);
  });

  it("host-grokbot narratable doctor path is OVPR (directive doctor / AC9.7)", () => {
    const text = readText("skills/deft-directive-swarm/references/host-grokbot.md");
    expect(text).toMatch(/directive doctor/);
    expect(npxTeachingHits(text)).toEqual([]);
    expect(text).toContain(AC97);
  });

  it("host-lifecycle-duties Skills Index uses non-npx discovery", () => {
    const text = readText("contracts/host-lifecycle-duties.md");
    expect(text).toMatch(/directive packs:slice skills list|packs:slice skills list/);
    expect(npxTeachingHits(text)).toEqual([]);
  });

  it("positive OVPR recovery markers remain teachable", () => {
    expect(GLOBAL_LAUNCHER).toMatch(/npm i -g/);
    expect(AC97).toMatch(/install --repair/);
  });
});
