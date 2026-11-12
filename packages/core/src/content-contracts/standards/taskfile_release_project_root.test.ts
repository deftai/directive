import { describe, expect, it } from "vitest";
import { blockBody, iterTaskBlocks, nonCommentLines, readRoot } from "./_taskfile-helpers.js";

/**
 * Release-family ENGINE_CMD project-root contract (#5805 / #5942).
 *
 * The pin's default project root is its own package dir. Each engine-invoking
 * release task must pass `--project-root "{{.USER_WORKING_DIR}}"` before
 * `{{.CLI_ARGS}}`, so the engine acts on the operator checkout and an operator
 * `--project-root` in CLI_ARGS still wins (the flag parsers are last-wins).
 *
 * The list is explicit on purpose. `release:wait-npm` is a known follow-up and
 * `release:local-update` has no `engine:invoke`.
 */
const RELEASE_TASKS = [
  { task: "release", verb: "release" },
  { task: "release:e2e", verb: "release-e2e" },
  { task: "release:publish", verb: "release-publish" },
  { task: "release:rollback", verb: "release-rollback" },
] as const;

const PROJECT_ROOT_FRAGMENT = '--project-root "{{.USER_WORKING_DIR}}" {{.CLI_ARGS}}';

function expectedEngineCmd(verb: string): string {
  return `ENGINE_CMD: '${verb} ${PROJECT_ROOT_FRAGMENT}'`;
}

function engineCmdLines(block: string): string[] {
  return nonCommentLines(block)
    .map((ln) => ln.trim())
    .filter((ln) => ln.startsWith("ENGINE_CMD:"));
}

function releaseBlock(task: string): string {
  const text = readRoot("Taskfile.yml");
  const block = iterTaskBlocks(text).find((b) => b.name === task);
  expect(block, `Taskfile.yml defines ${task}`).toBeDefined();
  if (!block) return "";
  return blockBody(text, block.start, block.end);
}

describe("release-family ENGINE_CMD passes the operator project root (#5805 / #5942)", () => {
  for (const { task, verb } of RELEASE_TASKS) {
    it(`${task} ENGINE_CMD passes --project-root "{{.USER_WORKING_DIR}}" before CLI_ARGS`, () => {
      const lines = engineCmdLines(releaseBlock(task));
      expect(lines).toEqual([expectedEngineCmd(verb)]);
    });
  }

  it("matcher rejects an ENGINE_CMD without the project-root fragment (self-test)", () => {
    const stripped = [
      "  release:e2e:",
      "    cmds:",
      "      - task: engine:invoke",
      "        vars:",
      "          # #5805: --project-root \"{{.USER_WORKING_DIR}}\" in a comment does not count",
      "          ENGINE_CMD: 'release-e2e {{.CLI_ARGS}}'",
    ].join("\n");
    expect(engineCmdLines(stripped)).not.toEqual([expectedEngineCmd("release-e2e")]);
  });

  it("matcher rejects the fragment placed after CLI_ARGS (operator override must win)", () => {
    const reordered =
      "          ENGINE_CMD: 'release-e2e {{.CLI_ARGS}} --project-root \"{{.USER_WORKING_DIR}}\"'";
    expect(engineCmdLines(reordered)).not.toEqual([expectedEngineCmd("release-e2e")]);
  });
});
