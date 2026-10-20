import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

function coldStartBlock(readme: string): string {
  const start = readme.indexOf("<!-- deft:cold-start-bootstrap");
  const endMatch = readme.match(/<!-- \/deft:cold-start-bootstrap v\d+ -->/);
  const end = endMatch?.index ?? -1;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end + (endMatch?.[0].length ?? 0));
}

function recoverPreamble(relPath: "main.md" | "SKILL.md"): string {
  return readText(relPath)
    .split(String.fromCharCode(10))
    .slice(0, 12)
    .join(String.fromCharCode(10));
}

function sessionRoutingBootstrap(): string {
  const template = readText("templates/agents-entry.md");
  const routing =
    template.split(String.fromCharCode(10)).find((line) => /Bootstrap:\s*Cold-start/i.test(line)) ??
    "";
  expect(routing, "agents-entry session-routing Bootstrap clause").toMatch(
    /Bootstrap:\s*Cold-start/i,
  );
  return routing;
}

const PINNED_GLOBAL = "npm i -g @deftai/directive@<pin>";
const LATEST_GLOBAL = "npm i -g @deftai/directive@latest";
const AC97_REPAIR = "directive install --repair";
const DIRECTIVE_INSTALL = "directive install";
const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";

describe("already-installed skip (#4539 / wave2r OVPR)", () => {
  it("README trigger names missing launcher or broken install", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toMatch(/New clone|won't run|launcher/i);
  });
  it("README teaches global launcher then project install/repair", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(`directive --version`);
    expect(block).toMatch(/npm i -g @deftai\/directive/);
    expect(block).toContain(AC97_REPAIR);
    expect(block).toContain(DIRECTIVE_INSTALL);
    expect(block).not.toMatch(/\bnpx\s+(-y\s+)?@deftai\/directive\b/);
    expect(block).not.toMatch(/\balign-pin\b/);
  });
  it("README behind-pin / missing launcher uses global install, not @latest-only hop", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toMatch(/npm i -g @deftai\/directive/);
    // Cold-start may name @latest for launcher refresh; must not teach npx commands.
    expect(block).not.toMatch(/\bnpx\s+(-y\s+)?@deftai\/directive\b/);
    expect(block).not.toMatch(/\bnpx\s+deft\b/);
  });
  it("README no-pin hop is directive install (not npx init)", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(DIRECTIVE_INSTALL);
    expect(block).not.toContain("npx @deftai/directive init");
  });
  it("README names package-relative runtime, not .deft/core deposit", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(RUNTIME_PREFIX);
    expect(block).toMatch(/no copied|\.deft\/core/i);
  });
  it("README already-installed hop uses doctor", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toMatch(/directive doctor/);
  });
  it("agents-entry session-routing teaches AC9.7, not npx init", () => {
    const bootstrap = sessionRoutingBootstrap();
    expect(bootstrap).toContain(`directive --version`);
    expect(bootstrap).toMatch(/npm i -g @deftai\/directive/);
    expect(bootstrap).toContain(AC97_REPAIR);
    expect(bootstrap).not.toContain("npx @deftai/directive init");
    expect(bootstrap).not.toMatch(/\balign-pin\b/);
  });
  it.each([
    "main.md",
    "SKILL.md",
  ] as const)("%s recover teaches AC9.7 and does not teach npx", (relPath) => {
    const head = recoverPreamble(relPath);
    expect(head).toContain(`directive --version`);
    expect(head).toMatch(/npm i -g @deftai\/directive/);
    expect(head).toContain(AC97_REPAIR);
    expect(head).not.toContain("npx @deftai/directive init");
    expect(head).not.toContain(LATEST_GLOBAL);
  });
  it("one ladder: recover and session-routing share launcher + repair", () => {
    const bootstrap = sessionRoutingBootstrap();
    const main = recoverPreamble("main.md");
    const skill = recoverPreamble("SKILL.md");
    const readme = coldStartBlock(readText("README.md"));
    for (const surface of [bootstrap, main, skill, readme]) {
      expect(surface).toMatch(/npm i -g @deftai\/directive/);
      expect(surface).toContain(AC97_REPAIR);
      expect(surface).toContain(`directive --version`);
      expect(surface).not.toMatch(/\bnpx\s+(-y\s+)?@deftai\/directive\b/);
    }
  });
  // Keep pin specifier available for agents-entry recovery depth.
  it("agents-entry may still name @<pin> for launcher restore", () => {
    const template = readText("templates/agents-entry.md");
    expect(template).toContain(PINNED_GLOBAL);
  });
});
