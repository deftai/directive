import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageContentPack } from "../../deposit/stage-content-pack.js";
import { repoRoot, resolveContentPath } from "./_helpers.js";

/**
 * #4097 first-project journey, measured on a staged consumer deposit.
 *
 * Snippet-to-registry resolution stays on #4094. This file is a journey-level
 * fixture: ordered sequence + Git preconditions + named terminal verb on the
 * flattened pack copy. It does not extract fences or walk Taskfile/dispatch.
 */

const staged: string[] = [];
let packRoot = "";

beforeAll(() => {
  packRoot = stagePack();
});

afterAll(() => {
  while (staged.length > 0) {
    const root = staged.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function stagePack(): string {
  const tmp = mkdtempSync(join(tmpdir(), "deft-4097-journey-"));
  staged.push(tmp);
  const pack = join(tmp, "pack");
  mkdirSync(pack, { recursive: true });
  stageContentPack({ repoRoot: repoRoot(), destDir: pack });
  return pack;
}

function readDepositJourney(pack: string): string {
  const rel = join("docs", "getting-started.md");
  const abs = join(pack, rel);
  expect(existsSync(abs), `staged deposit missing ${rel}`).toBe(true);
  expect(abs).not.toBe(resolveContentPath("docs/getting-started.md"));
  return readFileSync(abs, { encoding: "utf8" }).replace(/\r\n/g, "\n");
}

function sectionBody(text: string, heading: string): string {
  const lines = text.split("\n");
  let start = -1;
  let level = 0;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = lines[idx]?.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m && (m[2] ?? "") === heading) {
      start = idx;
      level = m[1]?.length ?? 2;
      break;
    }
  }
  expect(start, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^(#{1,6})\s+/);
    if (m && (m[1]?.length ?? 99) <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

function expectInOrder(haystack: string, needles: readonly string[]): void {
  let from = 0;
  for (const needle of needles) {
    const at = haystack.indexOf(needle, from);
    expect(at, `missing or out of order in deposit journey: ${needle}`).toBeGreaterThanOrEqual(0);
    from = at + needle.length;
  }
}

const CORE_JOURNEY = [
  "npm i -g @deftai/directive",
  "directive install",
  "directive doctor",
  "USER.md",
  "xbrief/PROJECT-DEFINITION.xbrief.json",
  "xbrief/proposed/",
  "deft scope:promote",
  "deft scope:activate",
  "git commit",
  "deft verify:story-ready",
  "deft xbrief:preflight",
  "deft check",
] as const;

describe("first-project journey on a staged deposit (#4097)", () => {
  it("core headings exist with defined minimums and are not TODO stubs", () => {
    const text = readDepositJourney(packRoot);
    expect(text).not.toMatch(/<!--\s*TODO/i);
    expect(text).not.toMatch(/\bTODO:/);

    const first = sectionBody(text, "First Project");
    expect(first.length).toBeGreaterThan(400);
    expectInOrder(first, CORE_JOURNEY);

    const strategies = sectionBody(text, "Using Strategies");
    expect(strategies).toMatch(/interview/i);
    expect(strategies).toContain("strategies/README.md");
    expect(strategies).not.toMatch(/<!--\s*TODO/i);

    const agents = sectionBody(text, "Agent Configuration");
    expect(agents).toContain("USER.md");
    expect(agents).toContain("AGENTS.md");
    expect(agents).toContain("good-agents-md.md");
    expect(agents).not.toMatch(/<!--\s*TODO/i);
  });

  it("names Git / verify:branch preconditions and the deft check success signal", () => {
    const first = sectionBody(readDepositJourney(packRoot), "First Project");
    expect(first).toMatch(/\bgit init\b/);
    expect(first).toMatch(/git switch -c|git checkout -b/);
    expect(first).toContain("deft verify:branch");
    expect(first).toContain("deft verify:story-ready");
    expect(first).toContain("--vbrief-path");
    expect(first).toMatch(/default branch/);
    expect(first).toContain("deft check");
    expect(first).toMatch(/exit 0/);
    expect(first).toMatch(/control plane/i);
    expect(first).not.toMatch(/^task (?!deft:)/m);
  });

  it("locks directive/deft vocabulary and does not teach hop-1 migrate:vbrief", () => {
    const text = readDepositJourney(packRoot);
    const first = sectionBody(text, "First Project");
    expect(first).toContain("directive install");
    expect(first).toContain("directive doctor");
    expect(first).toContain("deft check");
    expect(first).toContain("%APPDATA%\\deft\\USER.md");
    expect(first).toContain("~/.config/deft/USER.md");
    expect(first).not.toMatch(/migrate:vbrief/);
    expect(first).not.toMatch(/two-hop|hop-1|hop 1/i);
    expect(first).not.toMatch(/PROJECT\.md|SPECIFICATION\.md/);
    expect(text).toMatch(/QUICK-START/);
    expect(text).toMatch(/detect-state|detect project state/i);
  });

  it("optional backlog step is current work-selection, not withdrawn classify", () => {
    const backlog = sectionBody(readDepositJourney(packRoot), "Working an existing backlog");
    expect(backlog).toContain("deft plan-sequence:current");
    expect(backlog).toContain("deft triage:queue");
    expect(backlog).toContain("meta/security.md");
    expect(backlog).toMatch(/untrusted/i);
    expect(backlog).not.toContain("triage:classify");
    expect(backlog).not.toContain("--mirror");
    expect(backlog).not.toContain("task triage:bootstrap");
  });
});
