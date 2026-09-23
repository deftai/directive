import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MINIMAL_TASKFILE } from "../init-deposit/scaffold.js";
import { classifyRootCheckDirective } from "./root-check-invoke.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "root-check-invoke-"));
  temps.push(root);
  return root;
}

const INCLUDE_ONLY = `version: '3'

includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
`;

function withCheck(taskBody: string): string {
  return `${INCLUDE_ONLY}
tasks:
  check:
${taskBody}
`;
}

function kind(text: string, root = "/proj"): string {
  return classifyRootCheckDirective(root, text).kind;
}

describe("classifyRootCheckDirective (#4947)", () => {
  it("does not call evaluateConsumerCheckContract", () => {
    const src = readFileSync(new URL("./root-check-invoke.ts", import.meta.url), "utf8");
    expect(src).not.toContain("evaluateConsumerCheckContract");
    expect(src).toContain("stripTaskBodyComments");
  });

  it("is absent when the root check task is missing", () => {
    expect(kind(INCLUDE_ONLY)).toBe("absent");
    expect(kind(`${INCLUDE_ONLY}\ntasks:\n  check:lint:\n    cmds:\n      - echo no\n`)).toBe(
      "absent",
    );
  });

  it("counts command-position deft check and directive check that are not masked", () => {
    expect(kind(withCheck("    cmds:\n      - deft check\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - directive check --json\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - sudo deft check\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - FOO=1 deft check\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - |\n        deft check\n"))).toBe("invokes");
  });

  it("counts the whole task deft:check token, including consumer and framework-source", () => {
    expect(kind(withCheck("    cmds:\n      - task deft:check\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - task deft:check:consumer\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - task deft:check:framework-source --dry\n"))).toBe(
      "invokes",
    );
    expect(kind(withCheck("    cmds:\n      - task: deft:check\n"))).toBe("invokes");
    expect(kind(withCheck("    cmds:\n      - task: deft:check:consumer\n"))).toBe("invokes");
    expect(kind(withCheck('    deps:\n      - "deft:check:framework-source"\n'))).toBe("invokes");
    expect(kind(withCheck("    deps:\n      - task: deft:check\n"))).toBe("invokes");
  });

  it("does not count bare task check, a suffix, comments, echo, or a masked status", () => {
    expect(kind(withCheck("    cmds:\n      - task check\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - task check:lint\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - task check:consumer\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - task deft:check:lint\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - echo run deft check\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - deft check || true\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - directive check | tee out\n"))).toBe(
      "does-not-invoke",
    );
    expect(kind(withCheck("    cmds:\n      - '# deft check'\n"))).toBe("does-not-invoke");
    expect(kind(withCheck("    cmds:\n      - echo only\n    # task: deft:check\n"))).toBe(
      "does-not-invoke",
    );
  });

  it("does not count a consumer-owned engine:invoke paired with ENGINE_CMD check", () => {
    const text = `${withCheck(`    cmds:
      - task: engine:invoke
        vars:
          ENGINE_CMD: check
`)}  engine:invoke:
    cmds:
      - echo consumer-only
`;
    expect(kind(text)).toBe("does-not-invoke");
  });

  it("counts engine:invoke only when that task is the deposited dispatcher", () => {
    const root = tempRoot();
    const deposit = join(root, ".deft", "core");
    mkdirSync(join(deposit, "tasks"), { recursive: true });
    writeFileSync(join(deposit, "Taskfile.yml"), "version: '3'\n", "utf8");
    writeFileSync(
      join(deposit, "tasks", "engine.yml"),
      "version: '3'\n\ntasks:\n  invoke:\n    cmds:\n      - echo directive\n",
      "utf8",
    );
    const wired = `version: '3'

includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
  engine:
    taskfile: ./.deft/core/tasks/engine.yml

tasks:
  check:
    cmds:
      - task: engine:invoke
        vars:
          ENGINE_CMD: 'check --framework-root x'
`;
    expect(classifyRootCheckDirective(root, wired).kind).toBe("invokes");

    const foreign = wired.replace(
      "taskfile: ./.deft/core/tasks/engine.yml",
      "taskfile: ./tasks/engine.yml",
    );
    expect(classifyRootCheckDirective(root, foreign).kind).toBe("does-not-invoke");

    const checkout = wired.replace(
      "ENGINE_CMD: 'check --framework-root x'",
      "ENGINE_CMD: checkout",
    );
    expect(classifyRootCheckDirective(root, checkout).kind).toBe("does-not-invoke");
  });
});

describe("setup Quality sentence (#4947)", () => {
  const pair =
    "Prefer `deft check`; else `task deft:check` on an include-only consumer. One gate, not two runs";

  it("keeps coverage and secrets, and does not add a root check task", () => {
    const content = join(import.meta.dirname, "..", "..", "..", "..", "content");
    const skill = readFileSync(join(content, "skills", "deft-directive-setup", "SKILL.md"), "utf8");
    const pack = readFileSync(join(content, "packs", "skills", "skills-pack-0.1.json"), "utf8");
    const template = readFileSync(join(content, "templates", "PULL_REQUEST_TEMPLATE.md"), "utf8");
    expect(skill).toContain(`${pair}.`);
    expect(skill).toContain("Achieve >= {coverage}% coverage overall + per-module.");
    expect(skill).toContain("Store secrets in secrets/ dir.");
    expect(skill).not.toContain("Run task check before every commit.");
    expect(pack).toContain(`${pair}.`);
    expect(template).toContain(pair);
    expect(template).not.toContain("`task check` passes locally");
    expect(MINIMAL_TASKFILE).not.toMatch(/^ {2}check\s*:/m);
    expect(MINIMAL_TASKFILE).not.toContain("\ntasks:\n");
  });
});
