import { describe, expect, it } from "vitest";
import {
  buildAcceptanceFromIntakeCapture,
  stampAcceptanceFromLiteralCapture,
  validatePlanAcceptance,
} from "../product-first-done-gate/acceptance.js";
import {
  evaluateCommandSafety,
  evaluateStampAcceptanceSafety,
  isExecutableLiteralSource,
  REJECTED_NOOP_OUTCOME,
} from "./safety.js";

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

  it.each([
    "python -m pytest",
    "python3 -m pytest",
    "py -m pytest",
    "python -m pytest tests/test_new.py -q",
    "python3 -m pytest tests/test_list.py -q",
    "py -m pytest tests/ -q",
  ])("accepts closed pytest shape %s (#4702)", (command) => {
    expect(evaluateCommandSafety(command)).toEqual({ ok: true, reason: null });
  });

  it.each([
    "node --test",
    "node --test tests/display.test.js",
    "node --test --test-reporter=spec",
    "node --test --test-reporter spec",
    "node --test --test-reporter=tap",
    "node --test --test-reporter=junit",
    "node --test --test-reporter=lcov",
    "node --test --test-reporter=dot",
    "node --test --test-name-pattern=foo",
    "node --test --experimental-test-coverage",
  ])("accepts closed node --test shape %s (#4978)", (command) => {
    expect(evaluateCommandSafety(command)).toEqual({ ok: true, reason: null });
  });

  it.each([
    ["pytest", /allowlist/],
    ["pytest --testmon", /allowlist/],
    ["uv run --with pytest python -m pytest", /allowlist/],
    [
      "uv run --no-project --with pytest --with pytest-cov python -m pytest tests/test_scan_report.py",
      /allowlist/,
    ],
    ["go test", /allowlist/],
    ["go test ./...", /allowlist/],
    ["node", /--test/],
    ["node script.js", /--test/],
    ["node -e 1", /--test/],
    ["node -r ./x", /--test/],
    ["node -p 1", /--test/],
    ["node --import=tsx --test", /--test/],
    ["node --test --import=tsx", /dash token|--import/],
    ["node --test --require=./x", /dash token|--require/],
    ["node --test --experimental-loader=./x", /dash token|--experimental-loader/],
    ["node --test --loader=./x", /dash token|--loader/],
    ["node --test --inspect=9229", /dash token|--inspect/],
    ["node --test --inspect-port=9229", /dash token|--inspect-port/],
    ["node --test --eval=1", /dash token|--eval/],
    ["node --test --import tsx", /dash token|--import/],
    ["node --test --require ./x", /dash token|--require/],
    ["node --test --watch", /dash token|--watch/],
    ["node --test --inspect-brk", /dash token|--inspect-brk/],
    ["node --test -r ./x", /dash token/],
    ["node --test -e 1", /dash token/],
    ["node --test -p 1", /dash token/],
    ["node --test --test-reporter-destination=./out", /denied|reporter-destination/],
    ["node --test --test-rerun-failures", /denied|rerun-failures/],
    ["node --test --test-rerun-failures=1", /denied|rerun-failures/],
    ["node --test --test-reporter=data:", /test-reporter/],
    ["node --test --test-reporter=./file", /test-reporter/],
    ["node --test --test-reporter data:text/javascript,1", /test-reporter/],
    ["node --test --test-reporter ./file", /test-reporter/],
    ["node --test --test-reporter", /test-reporter/],
    ["node --test --test-reporter=html", /test-reporter/],
    ["node.exe --test", /allowlist/],
    ["python -c 1", /-m pytest/],
    ["python -m pip install requests", /-m pytest/],
    ["python -m http.server", /-m pytest/],
    ["python -m http.server 8000", /-m pytest/],
    ["python3 -m pip install requests", /-m pytest/],
    ["py -m http.server", /-m pytest/],
    ["python script.py", /-m pytest/],
    ["python -mpytest", /-m pytest/],
    ["python -M pytest", /-m pytest/],
    ["python -m PYTEST", /-m pytest/],
  ] as const)("refuses %s (#4702 / #4978)", (command, reason) => {
    const result = evaluateCommandSafety(command);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it("enumerates accepted first tokens on unknown-bin refuse (#4978)", () => {
    const reason = evaluateCommandSafety("curl https://example.com").reason ?? "";
    expect(reason).toMatch(/allowlist/);
    expect(reason).toMatch(/accepted:/);
    expect(reason).toMatch(/node/);
    expect(reason).toMatch(/npm/);
  });

  it("validation surfaces every stamp refusal, not only no-op reasons (#4702)", () => {
    const refused = "node -e 1";
    const reason = evaluateCommandSafety(refused).reason ?? "";
    expect(reason).toMatch(/--test/);
    expect(
      validatePlanAcceptance({
        commands: [{ command: refused }],
        none_stated: false,
        source_rung: "derived",
      }),
    ).toContain(reason);
    expect(() => buildAcceptanceFromIntakeCapture([{ command: refused }])).toThrow(reason);
    expect(() =>
      stampAcceptanceFromLiteralCapture({
        title: "t",
        metadata: {
          literal_acceptance_commands: [{ command: refused, source: "explicit" }],
        },
      }),
    ).toThrow(reason);
    expect(
      validatePlanAcceptance({
        commands: [{ command: "python -m pytest" }],
        none_stated: false,
        source_rung: "derived",
      }),
    ).toEqual([]);
    expect(
      validatePlanAcceptance({
        commands: [{ command: "node --test" }],
        none_stated: false,
        source_rung: "derived",
      }),
    ).toEqual([]);
  });
  it.each([
    "python -M pytest",
    "python -m PYTEST",
  ])("refuses non-exact pytest grammar %s at validation (#4702)", (command) => {
    const result = evaluateCommandSafety(command);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/-m pytest/);
    expect(
      validatePlanAcceptance({
        commands: [{ command }],
        none_stated: false,
      }),
    ).toContain(result.reason);
  });

  it("runs command safety when the command is stamped (#4702)", () => {
    expect(evaluateStampAcceptanceSafety({ commands: [{ command: "python -m pytest" }] }).ok).toBe(
      true,
    );
    expect(
      evaluateStampAcceptanceSafety({ commands: [{ command: "python3 -m pytest tests/ -q" }] }).ok,
    ).toBe(true);
    expect(evaluateStampAcceptanceSafety({ commands: [{ command: "py -m pytest" }] }).ok).toBe(
      true,
    );
    expect(evaluateStampAcceptanceSafety({ commands: [{ command: "node --test" }] }).ok).toBe(true);
    for (const command of [
      "pytest",
      "uv run --with pytest python -m pytest",
      "go test",
      "node -e 1",
      "python -m http.server",
    ]) {
      const stamped = evaluateStampAcceptanceSafety({ commands: [{ command }] });
      expect(stamped.ok).toBe(false);
      expect(stamped.reason).toBe(evaluateCommandSafety(command).reason);
    }
    const noop = evaluateStampAcceptanceSafety({ commands: [{ command: "true" }] });
    expect(noop.ok).toBe(false);
    expect(noop.outcome).toBe(REJECTED_NOOP_OUTCOME);
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
