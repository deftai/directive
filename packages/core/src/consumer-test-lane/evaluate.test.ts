import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMER_CHECK_GATES, checkGateId, PRODUCT_FIRST_AC_GATE } from "../check/gate-lists.js";
import { PRODUCT_AC_GATE_ID } from "../product-first-done-gate/types.js";
import { CONSUMER_TEST_LANE_GATE_ID, evaluate, resolveDeclaredTestCommand } from "./evaluate.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-consumer-test-lane-"));
  temps.push(root);
  return root;
}

describe("resolveDeclaredTestCommand (#4386)", () => {
  it("does not invent a go test ./... default", () => {
    const root = seedRoot();
    writeFileSync(join(root, "go.mod"), "module example\n", "utf8");
    expect(resolveDeclaredTestCommand(root)).toBeNull();
  });

  it("splits string testCommand on whitespace only (argv grammar)", () => {
    const root = seedRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { testCommand: 'pnpm test --filter "my pkg"' } },
      }),
      "utf8",
    );
    expect(resolveDeclaredTestCommand(root)).toEqual({
      command: "pnpm",
      args: ["test", "--filter", '"my', 'pkg"'],
      source: "plan.policy.testCommand",
    });
  });

  it("uses plan.policy.testCommand when declared", () => {
    const root = seedRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { testCommand: ["go", "test", "./internal/..."] } },
      }),
      "utf8",
    );
    expect(resolveDeclaredTestCommand(root)).toEqual({
      command: "go",
      args: ["test", "./internal/..."],
      source: "plan.policy.testCommand",
    });
  });

  it("uses package.json scripts.test with the lockfile package manager", () => {
    const root = seedRoot();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    expect(resolveDeclaredTestCommand(root)).toEqual({
      command: "pnpm",
      args: ["test"],
      source: "package.json scripts.test",
    });
  });
});

describe("evaluate consumer-test-lane", () => {
  it("skips when nothing is declared", () => {
    const result = evaluate({ projectRoot: seedRoot() });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.message).toMatch(/no declared test command/);
    expect(result.message).toMatch(PRODUCT_AC_GATE_ID);
  });

  it("runs the declared command and passes on exit 0", () => {
    const root = seedRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { testCommand: "pnpm test" } },
      }),
      "utf8",
    );
    const result = evaluate({
      projectRoot: root,
      spawn: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBeUndefined();
    expect(result.message).toMatch(/declared test command passed/);
    expect(result.message).toMatch(/not replaced/);
  });

  it("fails when the declared command is red", () => {
    const root = seedRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf8",
    );
    const result = evaluate({
      projectRoot: root,
      spawn: () => ({ exitCode: 1, stdout: "", stderr: "failing suite" }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/failed/);
    expect(result.message).toMatch(/failing suite/);
  });
});

describe("consumer check composition (#4386)", () => {
  it("keeps PRODUCT_FIRST_AC_GATE first and appends the declared test lane last", () => {
    expect(checkGateId(PRODUCT_FIRST_AC_GATE)).toBe("verify:ac");
    const first = CONSUMER_CHECK_GATES[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("expected non-empty CONSUMER_CHECK_GATES");
    }
    expect(checkGateId(first)).toBe("verify:ac");
    const ids = CONSUMER_CHECK_GATES.map(checkGateId);
    expect(ids).toContain(CONSUMER_TEST_LANE_GATE_ID);
    expect(ids.indexOf("verify:ac")).toBe(0);
    expect(ids.indexOf(CONSUMER_TEST_LANE_GATE_ID)).toBe(ids.length - 1);
    expect(ids).toContain("verify:evaluator-surface");
  });
});
