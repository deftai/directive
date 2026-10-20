import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

/**
 * Two Node contracts (#4089 / lean 5513424285).
 *
 * Consumer-run surfaces share a Node 20+ floor and must not cite `.nvmrc`
 * or mandate the maintainer toolchain. Maintainer-build surfaces share
 * `.nvmrc` / root `engines.node` = 24. This is not `verify:contract-drift`.
 */

const CONSUMER_FLOOR = /Node(?:\.js)?\s*(?:20\+|≥\s*20|>=\s*20)/;
const MAINTAINER_BARE_TOOLCHAIN = /task\s+toolchain:check(?![^\n]*--consumer)/;
const COREPACK_PNPM_MANDATE = /corepack\s+prepare\s+pnpm/;
const PYTHON_UV_MANDATE = /Python\s*\(`uv`\)/;

const CONSUMER_RUN_SOURCES = [
  "README.md",
  "docs-site/install.html",
  "docs-site/index.html",
  "packages/core/src/verify-env/node-runtime.ts",
  "packages/core/src/session/toolchain-preflight.ts",
  "packages/runtime/src/dispatch.ts",
  "packages/core/src/check/named-cause.ts",
  "packages/core/src/doctor/payload-staleness.ts",
  "skills/deft-directive-sync/SKILL.md",
] as const;

function readRepo(relPath: string): string {
  if (
    relPath === "README.md" ||
    relPath.startsWith("skills/") ||
    relPath.startsWith("docs-site/")
  ) {
    return readText(relPath);
  }
  return readFileSync(join(repoRoot(), relPath), { encoding: "utf8" }).replace(/\r\n/g, "\n");
}

function consumerReadmeSlice(readme: string): string {
  const coldStart =
    readme.match(
      /<!-- deft:cold-start-bootstrap[\s\S]*?<!-- \/deft:cold-start-bootstrap v\d+ -->/,
    )?.[0] ?? "";
  const start = readme.indexOf("## 🚀 Getting Started");
  const maintainer = readme.indexOf("#### Framework maintainers");
  const setup = readme.indexOf("### 2. Set Up Your Preferences");
  const endCandidates = [maintainer, setup].filter((n) => n > start);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : -1;
  const gettingStarted = start >= 0 && end > start ? readme.slice(start, end) : "";
  const next = readme.match(/\*\*Next Steps\*\*:[\s\S]*?(?=\n---\n)/)?.[0] ?? "";
  return [coldStart, gettingStarted, next].join("\n");
}

describe("node version contracts (#4089)", () => {
  it("keeps the maintainer pin at Node 24", () => {
    const nvmrc = readFileSync(join(repoRoot(), ".nvmrc"), { encoding: "utf8" }).trim();
    expect(nvmrc).toBe("24");
    const rootPkg = JSON.parse(
      readFileSync(join(repoRoot(), "package.json"), { encoding: "utf8" }),
    ) as { engines?: { node?: string } };
    expect(rootPkg.engines?.node).toBe(">=24");
  });

  it("does not add engines>=24 to the published CLI as this collapse", () => {
    const cliPkg = JSON.parse(
      readFileSync(join(repoRoot(), "packages/cli/package.json"), { encoding: "utf8" }),
    ) as { engines?: { node?: string } };
    // OVPR consumer floor is Node >=20 on the published launcher; maintainer pin stays 24.
    expect(cliPkg.engines?.node).toBe(">=20");
    expect(cliPkg.engines?.node).not.toMatch(/>=\s*24/);
  });

  it("names Node 24 and pnpm on the maintainer CONTRIBUTING path", () => {
    const text = readText("CONTRIBUTING.md");
    const prereq = text.slice(0, text.indexOf("## Grok Build as parent"));
    expect(prereq).toMatch(/Node(?:\.js)?\s*24/);
    expect(prereq).toMatch(/pnpm/i);
  });

  it.each(
    CONSUMER_RUN_SOURCES,
  )("%s shares the consumer Node floor and does not cite .nvmrc", (relPath) => {
    const text = readRepo(relPath);
    expect(text, `${relPath} missing consumer Node floor`).toMatch(CONSUMER_FLOOR);
    expect(text, `${relPath} cites .nvmrc as consumer proof`).not.toMatch(/\.nvmrc/);
  });

  it("keeps README consumer install off the maintainer toolchain", () => {
    const slice = consumerReadmeSlice(readText("README.md"));
    expect(slice.length).toBeGreaterThan(200);
    expect(slice).toMatch(CONSUMER_FLOOR);
    expect(slice).toContain("directive init");
    expect(slice).toContain("directive doctor");
    expect(slice).toContain("toolchain:check --consumer");
    expect(slice).not.toMatch(/\.nvmrc/);
    expect(slice).not.toMatch(MAINTAINER_BARE_TOOLCHAIN);
    expect(slice).not.toMatch(COREPACK_PNPM_MANDATE);
    expect(slice).not.toMatch(PYTHON_UV_MANDATE);
  });

  it("keeps docs-site install off the maintainer toolchain", () => {
    const install = readText("docs-site/install.html");
    expect(install).toMatch(CONSUMER_FLOOR);
    expect(install).toContain("directive init");
    expect(install).toContain("directive doctor");
    expect(install).toContain("toolchain:check --consumer");
    expect(install).not.toMatch(/\.nvmrc/);
    expect(install).not.toMatch(MAINTAINER_BARE_TOOLCHAIN);
    expect(install).not.toMatch(COREPACK_PNPM_MANDATE);
    expect(install).not.toMatch(PYTHON_UV_MANDATE);
  });
});
