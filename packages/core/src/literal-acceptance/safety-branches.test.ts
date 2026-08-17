import { describe, expect, it } from "vitest";
import { evaluateCommandSafety, isExecutableLiteralSource } from "./safety.js";

/**
 * Branch matrix for literal-AC safety allowlists (#3287 / #3267).
 * Targets residual package-manager / vitest / wrapper edges that sit below
 * the global 85% branch floor.
 */
describe("evaluateCommandSafety branch matrix (#3287)", () => {
  it("refuses empty, oversized, path-like first tokens, and non-allowlisted bins", () => {
    expect(evaluateCommandSafety("").ok).toBe(false);
    expect(evaluateCommandSafety("   ").ok).toBe(false);
    expect(evaluateCommandSafety("x".repeat(501)).reason).toMatch(/500/);
    expect(evaluateCommandSafety("./local-bin run").reason).toMatch(/path-like|allowlist/i);
    // Path-like first token with slash (platform-neutral; avoids win32-only fixtures).
    expect(evaluateCommandSafety("/usr/local/bin/task check").reason).toMatch(
      /path-like|allowlist/i,
    );
    expect(evaluateCommandSafety("tools:bin run").reason).toMatch(/path-like|allowlist/i);
    expect(evaluateCommandSafety("python -m pytest").ok).toBe(false);
    expect(evaluateCommandSafety("curl https://example.com").ok).toBe(false);
  });

  it("requires wrapper verbs to carry a verification subcommand", () => {
    expect(evaluateCommandSafety("task").ok).toBe(false);
    expect(evaluateCommandSafety("deft").ok).toBe(false);
    expect(evaluateCommandSafety("directive").ok).toBe(false);
    expect(evaluateCommandSafety("task help").ok).toBe(true);
    expect(evaluateCommandSafety("task -h").ok).toBe(true);
    expect(evaluateCommandSafety("task -v").ok).toBe(true);
    expect(evaluateCommandSafety("task test").ok).toBe(true);
    expect(evaluateCommandSafety("task verify branch").ok).toBe(true);
    expect(evaluateCommandSafety("task verify-session-ritual").ok).toBe(true);
  });

  it("covers package-manager empty rest and restricted subcommands", () => {
    expect(evaluateCommandSafety("pnpm").ok).toBe(false);
    expect(evaluateCommandSafety("npm").ok).toBe(false);
    expect(evaluateCommandSafety("yarn").ok).toBe(false);
    expect(evaluateCommandSafety("bun").ok).toBe(false);
    expect(evaluateCommandSafety("pnpm test").ok).toBe(true);
    expect(evaluateCommandSafety("pnpm test --filter core").ok).toBe(true);
    expect(evaluateCommandSafety("npm run test").ok).toBe(true);
    expect(evaluateCommandSafety("pnpm run check").ok).toBe(true);
    expect(evaluateCommandSafety("npm --version").ok).toBe(true);
    expect(evaluateCommandSafety("yarn -v").ok).toBe(true);
    expect(evaluateCommandSafety("pnpm install").ok).toBe(false);
    expect(evaluateCommandSafety("npm publish").ok).toBe(false);
  });

  it("covers npx allowlist and denials", () => {
    expect(evaluateCommandSafety("npx").ok).toBe(false);
    expect(evaluateCommandSafety("npx --version").ok).toBe(true);
    expect(evaluateCommandSafety("npx -v").ok).toBe(true);
    expect(evaluateCommandSafety("npx --help").ok).toBe(true);
    expect(evaluateCommandSafety("npx -h").ok).toBe(true);
    expect(evaluateCommandSafety("npx vitest").ok).toBe(false); // bare vitest → watch denied
    expect(evaluateCommandSafety("npx vitest run").ok).toBe(true);
    expect(evaluateCommandSafety("npx vitest run packages/core").ok).toBe(true);
    expect(evaluateCommandSafety("npx exec something").ok).toBe(false);
    expect(evaluateCommandSafety("npx cowsay hi").ok).toBe(false);
  });

  it("covers package-manager exec vitest variants and non-vitest denials", () => {
    expect(evaluateCommandSafety("pnpm exec vitest").ok).toBe(false); // bare watch
    expect(evaluateCommandSafety("pnpm exec vitest run").ok).toBe(true);
    expect(evaluateCommandSafety("pnpm exec vitest run --coverage").ok).toBe(true);
    expect(evaluateCommandSafety("npm exec vitest run").ok).toBe(true);
    expect(evaluateCommandSafety("pnpm exec node -e 1").ok).toBe(false);
    expect(evaluateCommandSafety("pnpm exec deft doctor").ok).toBe(false);
  });

  it("covers run vitest package-manager form", () => {
    expect(evaluateCommandSafety("pnpm run vitest").ok).toBe(true);
    expect(evaluateCommandSafety("pnpm run vitest run packages/core").ok).toBe(true);
    expect(evaluateCommandSafety("npm run vitest -- --run").ok).toBe(true);
  });

  it("covers vitest first-token run/version and hang-mode denials", () => {
    expect(evaluateCommandSafety("vitest").ok).toBe(false);
    expect(evaluateCommandSafety("vitest run").ok).toBe(true);
    expect(evaluateCommandSafety("vitest run packages/core/src").ok).toBe(true);
    expect(evaluateCommandSafety("vitest --run").ok).toBe(true);
    expect(evaluateCommandSafety("vitest --version").ok).toBe(true);
    expect(evaluateCommandSafety("vitest -v").ok).toBe(true);
    expect(evaluateCommandSafety("vitest watch").ok).toBe(false);
    expect(evaluateCommandSafety("vitest ui").ok).toBe(false);
    expect(evaluateCommandSafety("vitest browser").ok).toBe(false);
    expect(evaluateCommandSafety("vitest --watch").ok).toBe(false);
    expect(evaluateCommandSafety("vitest --ui").ok).toBe(false);
    expect(evaluateCommandSafety("vitest --browser").ok).toBe(false);
    expect(evaluateCommandSafety("vitest dev").ok).toBe(false);
    expect(evaluateCommandSafety("vitest run --watch").ok).toBe(false);
    expect(evaluateCommandSafety("vitest related foo").ok).toBe(false);
  });

  it("refuses no-op first tokens and classifies executable sources", () => {
    expect(evaluateCommandSafety("true").ok).toBe(false);
    expect(evaluateCommandSafety("false").ok).toBe(false);
    expect(isExecutableLiteralSource("explicit")).toBe(true);
    expect(isExecutableLiteralSource("verify_commands")).toBe(true);
    expect(isExecutableLiteralSource("task_statement")).toBe(false);
    expect(isExecutableLiteralSource("unknown")).toBe(false);
  });
});
