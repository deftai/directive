import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

function coldStartBlock(readme: string): string {
  const start = readme.indexOf("<!-- deft:cold-start-bootstrap");
  const end = readme.indexOf("<!-- /deft:cold-start-bootstrap v1 -->");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
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
const NPX_INIT = "npx @deftai/directive init";
const NPX_REFRESH_CARRIER = "npx -y @deftai/directive@<pin> agents:refresh";
const NPX_REFRESH_CURRENT = "npx -y @deftai/directive@latest agents:refresh";
const DOCTOR_RAN_AS_SKIP = "Already installed? Run `directive doctor`";

describe("already-installed skip (#4539)", () => {
  it("README trigger names PATH version behind the pin", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(
      "New clone, or `deft` / `directive` won't run, or PATH version is behind the pin",
    );
  });
  it("README skip predicate compares PATH --version to the pin outside doctor", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(`directive --version`);
    expect(block).toContain(`deft --version`);
    expect(block).toContain("Doctor exit 0 is not skip");
    expect(block).toContain("A process that starts is not bootstrap success");
  });
  it("README behind-pin hop installs @<pin> and re-probes PATH, not @latest", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(PINNED_GLOBAL);
    expect(block).toContain("re-probe");
    expect(block).not.toContain(LATEST_GLOBAL);
  });
  it("README no-pin hop is npx init then return to the compare", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(NPX_INIT);
    expect(block.toLowerCase()).toMatch(/return to (this |the )?compare|then return to step 1/);
  });
  it("README intro does not use PATH-version equality as the universal stop", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).not.toContain("whose PATH version matches the pin");
    expect(block).toMatch(/not the stop for every case/i);
  });
  it("README names the npx agents:refresh carrier with a presence postcondition", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain(NPX_REFRESH_CARRIER);
    expect(block).toMatch(/Refresh exit 0 is not (that )?evidence/i);
    expect(block).toContain(NPX_REFRESH_CURRENT);
    expect(block).toContain("directive update");
  });
  it("README already-installed hop uses doctor --full", () => {
    const block = coldStartBlock(readText("README.md"));
    expect(block).toContain("directive doctor --full");
  });
  it("agents-entry session-routing is the every-session then reading", () => {
    const bootstrap = sessionRoutingBootstrap();
    expect(bootstrap).toContain(`directive --version`);
    expect(bootstrap).toContain(`deft --version`);
    expect(bootstrap).toContain("doctor exit 0 is not skip");
    expect(bootstrap).toContain("evaluateSkew");
    expect(bootstrap).toContain("reject-global");
    expect(bootstrap).toContain(PINNED_GLOBAL);
    expect(bootstrap).toContain("directive doctor --full");
    expect(bootstrap).toContain(NPX_INIT);
  });
  it.each([
    "main.md",
    "SKILL.md",
  ] as const)("%s recover stays failure-scoped and does not skip on doctor-ran", (relPath) => {
    const head = recoverPreamble(relPath);
    expect(head).not.toContain(DOCTOR_RAN_AS_SKIP);
    expect(head).toContain(`directive --version`);
    expect(head).toContain(`deft --version`);
    expect(head).toContain("doctor exit 0 is not skip");
    expect(head).toContain(PINNED_GLOBAL);
    expect(head).toContain("directive doctor --full");
    expect(head).toContain(NPX_INIT);
    expect(head).not.toContain(LATEST_GLOBAL);
  });
  it("one ladder: recover and session-routing share pin specifier and doctor --full", () => {
    const bootstrap = sessionRoutingBootstrap();
    const main = recoverPreamble("main.md");
    const skill = recoverPreamble("SKILL.md");
    const readme = coldStartBlock(readText("README.md"));
    for (const surface of [bootstrap, main, skill, readme]) {
      expect(surface).toContain(PINNED_GLOBAL);
      expect(surface).toContain("directive doctor --full");
      expect(surface).toContain(`directive --version`);
    }
  });
});
