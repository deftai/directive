/**
 * Wave 2r / AC13.8 + AC9.11 + AC13.10 + D4.9–10
 * Forbid npx / pnpm-exec / align-pin / .deft/core teaching on shipped
 * user+agent surfaces; require AC9.7 / OVPR sequences; §A9 catalogue
 * coverage on known-limitations.md.
 */
import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";
const AC97 = "directive install --repair";
const GLOBAL_LAUNCHER = "npm i -g @deftai/directive";

/** Shipped surfaces that must teach OVPR, never npx/align-pin/.deft/core. */
const AGENT_USER_SURFACES = [
  "README.md",
  "main.md",
  "SKILL.md",
  "templates/agents-entry.md",
  "docs/getting-started.md",
  "docs/launcher.md",
  "QUICK-START.md",
] as const;

/** Positive teaching of the legacy deposit as current install location. */
const CORE_TEACHING_RES = [
  /Deft is installed in \.?\.?\/?\.deft\/core/i,
  /Full guidelines:\s*\.?\.?\/?\.deft\/core\//i,
  /Always start with[`'"]?\s*:\s*[`'"]?\.deft\/core\//i,
  /has [`'"]?\.deft\/core\/[`'"]? directory/i,
  /Start work in a deft-enabled project \(has [`'"]?\.deft\/core\//i,
  /Read [`'"]\.deft\/core\//,
  /See [`'"]\.deft\/core\//,
  /taskfile:\s*\.\/\.deft\/core\//i,
  /task -t \.\/\.deft\/core\//i,
] as const;

/** Command-teaching forms banned on agent/user surfaces (AC9.11 / AC13.8). */
const FORBIDDEN_COMMAND_RES = [
  { id: "npx-package", re: /\bnpx\s+(-y\s+)?@deftai\/directive\b/ },
  { id: "npx-deft", re: /\bnpx\s+deft\b/ },
  { id: "pnpm-exec", re: /\bpnpm\s+exec\b/ },
  { id: "align-pin", re: /\balign-pin\b/ },
] as const;

/** §A9 catalogue topics that must appear in known-limitations (user terms). */
const A9_TOPICS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "global-launcher-required", re: /global launcher required/i },
  { id: "launcher-can-disappear", re: /launcher can disappear/i },
  { id: "one-install-per-repo", re: /one install per repository/i },
  { id: "npm-pnpm-only", re: /npm and pnpm only/i },
  { id: "repair-no-migrate", re: /repair does not migrate/i },
  { id: "setup-on-first-eligible", re: /first eligible|PM install before hooks|local wiring/i },
  { id: "passive-skill-reads", re: /passive skill reads/i },
  { id: "uninstall-best-effort", re: /uninstall can be best-effort/i },
  { id: "old-global-clis", re: /old global CLI/i },
  { id: "no-delegate-old-runtime", re: /never delegates to an old-style|does not run old-style/i },
  { id: "historical-latest-legacy", re: /latest .+copied-core|latest package\.json-pinned|supported latest legacy/i },
  { id: "retired-verbs", re: /retired verbs/i },
  { id: "update-means-upgrade", re: /update[`'"]? means [`'"]?upgrade/i },
  { id: "ignore-entries-limited", re: /package\/readiness ignore|ignore entries/i },
  { id: "node-20-best-effort", re: /Node 20 is best-effort/i },
  { id: "directive-is-launcher", re: /@deftai\/directive[`'"]? is the launcher|changes meaning/i },
  { id: "hooks-need-runtime", re: /hooks cannot run|runtime package is absent/i },
  { id: "no-force", re: /No [`'"]?--force/i },
  { id: "private-packages", re: /private packages|core.*content.*types.*not consumable/i },
  { id: "manual-add-not-activation", re: /Manual package add is not activation/i },
  { id: "no-overlap-mutating", re: /Do not overlap|overlap.*install/i },
  { id: "edits-to-distributed", re: /Edits to distributed content|owned generated files/i },
  { id: "bounded-preapproval", re: /Preapproval plans|dry runs are bounded|bounded.*dry-?run/i },
];

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

describe("OVPR docs AC13.8 / AC9.11 / AC13.10 (wave2r)", () => {
  it.each(AGENT_USER_SURFACES)("%s forbids npx / pnpm exec / align-pin teaching", (rel) => {
    const text = readText(rel);
    const found: string[] = [];
    for (const { id, re } of FORBIDDEN_COMMAND_RES) {
      for (const line of hits(text, re)) {
        // Allow explicit prohibition lines ("Do not teach npx", "Never use npx",
        // "never recover via npx / pnpm exec").
        if (
          /do not (use|teach)|never (use|teach|recover)|avoid teaching|not teach|⊗\s*never recover via/i.test(
            line,
          )
        ) {
          continue;
        }
        found.push(`${id}: ${line}`);
      }
    }
    expect(found, `${rel} still teaches forbidden commands`).toEqual([]);
  });

  it.each(AGENT_USER_SURFACES)("%s does not teach .deft/core as current install location", (rel) => {
    const text = readText(rel);
    const found: string[] = [];
    for (const re of CORE_TEACHING_RES) {
      for (const line of hits(text, re)) {
        // Legacy conversion / "no copied .deft/core" negatives are allowed.
        if (/no copied|removes? legacy|pre-split|supported latest legacy|historical/i.test(line)) {
          continue;
        }
        found.push(line);
      }
    }
    expect(found, `${rel} still teaches .deft/core as current`).toEqual([]);
  });

  it("README / main / SKILL / agents-entry teach AC9.7 recovery", () => {
    for (const rel of ["README.md", "main.md", "SKILL.md", "templates/agents-entry.md"] as const) {
      const text = readText(rel);
      expect(text, `${rel} missing global launcher install`).toMatch(
        /npm i -g @deftai\/directive/,
      );
      expect(text, `${rel} missing install --repair`).toContain(AC97);
    }
  });

  it("README teaches OVPR happy path (install / PM / upgrade / doctor)", () => {
    const text = readText("README.md");
    expect(text).toMatch(/directive install\b/);
    expect(text).toMatch(/pnpm install|npm install/);
    expect(text).toMatch(/directive upgrade\b/);
    expect(text).toMatch(/directive doctor\b/);
    expect(text).toContain(RUNTIME_PREFIX);
  });

  it("agents-entry and SKILL point at package-relative runtime paths", () => {
    for (const rel of ["templates/agents-entry.md", "SKILL.md"] as const) {
      const text = readText(rel);
      expect(text, `${rel} missing runtime prefix`).toContain(RUNTIME_PREFIX);
      expect(text).toMatch(new RegExp(`${RUNTIME_PREFIX.replace(/\//g, "\\/")}main\\.md`));
    }
  });

  it("known-limitations covers §A9 catalogue in user terms (AC13.10)", () => {
    const text = readText("docs/known-limitations.md");
    const missing = A9_TOPICS.filter((t) => !t.re.test(text)).map((t) => t.id);
    expect(missing, "known-limitations missing §A9 topics").toEqual([]);
    expect(text).toContain(GLOBAL_LAUNCHER);
    expect(text).toContain(AC97);
  });
});
