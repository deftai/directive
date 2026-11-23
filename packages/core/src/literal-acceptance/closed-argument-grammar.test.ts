/**
 * Closed argument grammar for admitted literal-acceptance forms (GHSA-mq3j-2229-p7xx).
 *
 * One test per bypass class. Each case asserts a refusal marker only; option
 * values are inert placeholders.
 */
import { describe, expect, it } from "vitest";
import {
  CLOSED_ARGUMENT_GRAMMAR_REASON,
  evaluateCommandSafety,
  packageManagerPrefixOperand,
  WRAPPER_SUBCOMMAND_REFUSAL,
} from "./safety.js";

function refused(command: string): string {
  const result = evaluateCommandSafety(command);
  expect(result.ok, command).toBe(false);
  return result.reason ?? "";
}

function admitted(command: string): void {
  const result = evaluateCommandSafety(command);
  expect(result, command).toEqual({ ok: true, reason: null });
}

describe("closed argument grammar: package-manager options before --", () => {
  it.each([
    "npm test --node-options=x",
    "npm test --script-shell x",
    "npm run test --userconfig x",
    "npm run check --globalconfig=x",
    "pnpm test --config.node-options=x",
    "pnpm run check --dir x",
    "yarn test --cwd x",
    "bun test --preload x",
    "npm test --prefix web --prefix web",
  ])("refuses %s", (command) => {
    expect(refused(command)).toContain(CLOSED_ARGUMENT_GRAMMAR_REASON);
  });
});

describe("closed argument grammar: options after --", () => {
  it.each([
    "npm test -- --require x",
    "npm run test -- --import x",
    "pnpm test -- --config x",
    "npm run check -- --root x",
    "pnpm exec vitest run --config x",
    "npx vitest run --globalSetup x",
    "vitest run --setupFiles x",
    "npm test -- --run -- x",
  ])("refuses %s", (command) => {
    expect(refused(command)).toContain(CLOSED_ARGUMENT_GRAMMAR_REASON);
  });
});

describe("closed argument grammar: positional paths stay inside the repository", () => {
  it.each([
    "npm test -- ../x",
    "pnpm test /x",
    "npx vitest run C:x",
    "pnpm exec vitest run a/../../x",
    "npm test -- x=y",
  ])("refuses %s", (command) => {
    expect(refused(command)).toMatch(/not a plain relative path/);
  });

  it("refuses quotes that do not wrap a whole argument", () => {
    expect(refused('npm test -- "--re"quire')).toMatch(/quotes must wrap a whole argument/);
    expect(refused("npm test -- --run'")).toMatch(/quotes must wrap a whole argument/);
  });

  it("treats a quoted dash token as a positional, not a flag", () => {
    expect(refused('npm test -- "--require"')).toMatch(/not a plain relative path/);
  });

  it("refuses %NAME% expansion anywhere in the command", () => {
    expect(refused("npm test -- %X%")).toMatch(/shell metacharacter "%"/);
    expect(refused("node --test %X%")).toMatch(/shell metacharacter "%"/);
  });
});

describe("closed argument grammar: exact script names", () => {
  it.each([
    "npm run testx",
    "npm run test-anything",
    "pnpm run checkout",
    "yarn run check.x",
  ])("refuses prefix-matched script %s", (command) => {
    expect(refused(command)).toMatch(/test, check, test:<name> or check:<name>/);
  });

  it.each([
    "npm run test:unit",
    "pnpm run check:types",
    "npm run test:e2e -- --run",
  ])("admits %s", (command) => admitted(command));

  it("refuses a nested or empty script suffix", () => {
    refused("npm run test:a:b");
    refused("npm run test:");
  });

  it("refuses --if-present on both sides of --", () => {
    expect(refused("npm run check --if-present")).toMatch(/--if-present" is denied/);
    expect(refused("npm test -- --if-present")).toMatch(/--if-present" is denied/);
  });
});

describe("closed argument grammar: --prefix spelling", () => {
  it("admits a relative --prefix and reports its operand", () => {
    admitted("npm test --prefix web -- --run");
    expect(packageManagerPrefixOperand("npm test --prefix web -- --run")).toBe("web");
    expect(packageManagerPrefixOperand("npm test --prefix=web")).toBe("web");
    expect(packageManagerPrefixOperand("npm test -- --prefix web")).toBeNull();
    expect(packageManagerPrefixOperand("pnpm test")).toBeNull();
  });

  it.each([
    "npm test --prefix ../x",
    "npm test --prefix /x",
    "npm test --prefix=C:x",
  ])("refuses %s", (command) => {
    expect(refused(command)).toMatch(/--prefix" has a value outside its grammar/);
  });
});

describe("closed argument grammar: wrappers (task/deft/directive)", () => {
  it.each([
    "task check other",
    "task test X=y",
    "deft verify:links extra",
    "task check --dir=x",
  ])("refuses %s", (command) => {
    expect(refused(command)).toContain(CLOSED_ARGUMENT_GRAMMAR_REASON);
  });

  it("refuses a task flag value that is not attached with =", () => {
    expect(refused("task verify:session-ritual --tier gated")).toMatch(/must attach its value/);
  });

  it("refuses wrapper runner options after --", () => {
    expect(refused("task test -- --config x")).toContain(CLOSED_ARGUMENT_GRAMMAR_REASON);
    expect(refused("task test -- ../x")).toMatch(/not a plain relative path/);
  });

  it("refuses verify names that are not plain names", () => {
    expect(refused("deft verify:*")).toBe(WRAPPER_SUBCOMMAND_REFUSAL);
    expect(refused("task verifyx")).toBe(WRAPPER_SUBCOMMAND_REFUSAL);
    expect(refused("deft verify ../x")).toBe(WRAPPER_SUBCOMMAND_REFUSAL);
  });

  it.each([
    "task check -- --filter pr-watch",
    "task check --allow-over-cap",
    "task test -- packages/core/src",
    "deft verify:session-ritual -- --tier=gated --json",
    "task verify:scope-provenance -- --base-ref origin/master",
    "task doctor -- --full",
    "deft verify links",
  ])("admits %s", (command) => admitted(command));
});

describe("closed argument grammar: python -m pytest", () => {
  it.each([
    "python -m pytest -p x",
    "python -m pytest -c x",
    "python3 -m pytest --rootdir x",
    "py -m pytest -o x=y",
    "python -m pytest --basetemp x",
    "python -m pytest ../x",
  ])("refuses %s", (command) => {
    expect(refused(command)).toContain(CLOSED_ARGUMENT_GRAMMAR_REASON);
  });

  it.each([
    "python -m pytest .github/scripts -q",
    "python -m pytest tests/cli/test_x.py::test_y -x --tb=short",
    'python -m pytest -k "a and not b" -n auto',
  ])("admits %s", (command) => admitted(command));
});

describe("closed argument grammar: node --test positionals", () => {
  it.each([
    "node --test ../x.js",
    "node --test /x.js",
    "node --test C:x.js",
  ])("refuses %s", (command) => {
    expect(refused(command)).toMatch(/not a plain relative path/);
  });

  it.each(["node --test tasks/", "node --test tasks/*.test.cjs"])("admits %s", (command) =>
    admitted(command));
});

describe("closed argument grammar: node --test flags are exact names", () => {
  it.each([
    "node --test --test-global_setup=x",
    "node --test --test-reporter_destination=x",
    "node --test --test-rerun_failures=x",
    "node --test --test-coverage-include=x",
    "node --test --experimental-test-module-mocks",
    "node --test --test-update-snapshots",
    "node --test --test-glo^bal-setup=x",
  ])("refuses %s", (command) => {
    expect(refused(command)).toMatch(/dash token .* is denied|shell metacharacter/);
  });

  it("refuses a quote inside a flag name", () => {
    expect(refused('node --test --test-"reporter"=x')).toMatch(/quotes must wrap a whole argument/);
  });

  it.each([
    "node --test --test-concurrency=x",
    "node --test --test-shard=x",
    "node --test --test-isolation=x",
    "node --test --test-only=1",
  ])("refuses a flag value outside its grammar: %s", (command) => {
    expect(refused(command)).toContain(CLOSED_ARGUMENT_GRAMMAR_REASON);
  });

  it.each([
    "node --test --test-name-pattern=foo tests/",
    'node --test --test-skip-pattern "slow case"',
    "node --test --test-only --test-force-exit",
    "node --test --test-concurrency=4 --test-timeout 60000",
    "node --test --test-shard=1/3 --test-isolation=process",
    "node --test --experimental-test-coverage --test-reporter dot",
  ])("admits %s", (command) => admitted(command));
});
