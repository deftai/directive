import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";
import { blockBody, iterTaskBlocks, readTaskfile } from "./_taskfile-helpers.js";

/** `task policy:set-one-pr-scope-proof` forwards to the `deft` verb (#6361). */
function policyBlock(name: string): string {
  const text = readTaskfile("policy.yml");
  const block = iterTaskBlocks(text).find((b) => b.name === name);
  if (block === undefined) throw new Error(`tasks/policy.yml has no ${name} task`);
  return blockBody(text, block.start, block.end);
}

/** Drop the task name, desc and verb so two aliases can be compared by shape. */
function shape(body: string, verb: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s{2}\S/.test(line) && !/^\s{4}desc:/.test(line))
    .join("\n")
    .replaceAll(verb, "<verb>")
    .trim();
}

describe("task policy:set-one-pr-scope-proof alias (#6361)", () => {
  it("runs the deft policy verb through engine:invoke with CLI_ARGS", () => {
    const body = policyBlock("set-one-pr-scope-proof");
    expect(body).toContain("- task: :engine:invoke");
    expect(body).toContain(
      `ENGINE_CMD: 'policy set-one-pr-scope-proof --project-root "{{.USER_WORKING_DIR}}" {{.CLI_ARGS}}'`,
    );
    expect(body).toMatch(/desc: ".*--set off\|mint --confirm"/);
  });

  it("has the same shape as set-spec-guard-enforcement", () => {
    expect(shape(policyBlock("set-one-pr-scope-proof"), "set-one-pr-scope-proof")).toBe(
      shape(policyBlock("set-spec-guard-enforcement"), "set-spec-guard-enforcement"),
    );
  });

  it("names a verb the runtime routes", () => {
    const routes = readText("packages/runtime/src/cli-router/route-argv.ts");
    expect(routes).toContain(
      '"policy:set-one-pr-scope-proof": ["policy", "set-one-pr-scope-proof"]',
    );
  });
});
