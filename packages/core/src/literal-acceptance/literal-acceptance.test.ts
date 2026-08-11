/**
 * Tests for literal acceptance-command capture + verbatim run (#3267).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachLiteralAcceptanceCommands,
  captureAndAttachLiteralAcceptance,
  captureLiteralAcceptanceCommands,
  evaluateLiteralAcceptanceFromPath,
  evaluateLiteralAcceptanceFromPlan,
  isLiteralAcceptanceRequiredAtCeremonyDepth,
  readStoredLiteralAcceptanceCommands,
  runLiteralAcceptanceCommands,
} from "./index.js";

const FIXTURE_TASK = `
# feat: sample task

## Acceptance sketch

Intake captures stated commands; done-gate runs them verbatim.

\`\`\`bash
pnpm exec vitest run packages/core/src/literal-acceptance
task check
\`\`\`

Also run: verify: node -e "process.exit(0)"

Self-chosen \`echo hello\` is not enough — use the stated commands.
`;

describe("captureLiteralAcceptanceCommands", () => {
  it("captures fenced bash commands and labeled verify: lines without paraphrase", () => {
    const cmds = captureLiteralAcceptanceCommands(FIXTURE_TASK);
    const strings = cmds.map((c) => c.command);
    expect(strings).toContain("pnpm exec vitest run packages/core/src/literal-acceptance");
    expect(strings).toContain("task check");
    expect(strings).toContain('node -e "process.exit(0)"');
    // Must preserve exact flags/path — no paraphrase into "run the tests"
    for (const c of cmds) {
      expect(c.command).not.toMatch(/run the tests/i);
      expect(c.source).toBe("task_statement");
    }
  });

  it("returns empty when no shell commands are stated (does not invent)", () => {
    const cmds = captureLiteralAcceptanceCommands(
      "Ship a nicer UX. Make sure it feels right when you are done.",
    );
    expect(cmds).toEqual([]);
  });

  it("captures $ prompt lines", () => {
    const cmds = captureLiteralAcceptanceCommands("$ task verify:branch\n$ git status");
    expect(cmds.map((c) => c.command)).toEqual(["task verify:branch", "git status"]);
  });

  it("captures inline verify spans", () => {
    const cmds = captureLiteralAcceptanceCommands(
      "Before done, verify `pnpm test --filter ac` and claim nothing else.",
    );
    expect(cmds.map((c) => c.command)).toContain("pnpm test --filter ac");
  });
});

describe("attach / read stored commands", () => {
  it("stores exact commands on plan.metadata and swarm.verify_commands", () => {
    const captured = captureLiteralAcceptanceCommands(FIXTURE_TASK);
    const plan = attachLiteralAcceptanceCommands(
      { title: "t", status: "running", items: [] },
      captured,
    );
    const stored = readStoredLiteralAcceptanceCommands(plan);
    expect(stored.map((c) => c.command)).toContain("task check");
    const meta = plan.metadata as Record<string, unknown>;
    expect(Array.isArray(meta.literal_acceptance_commands)).toBe(true);
    const swarm = meta.swarm as Record<string, unknown>;
    expect(swarm.verify_commands).toContain("task check");
  });

  it("captureAndAttach is idempotent on re-run", () => {
    const once = captureAndAttachLiteralAcceptance({ title: "t", items: [] }, FIXTURE_TASK);
    const twice = captureAndAttachLiteralAcceptance(once.plan, FIXTURE_TASK);
    expect(twice.commands.length).toBe(once.commands.length);
  });

  it("reads plan item command fields", () => {
    const plan = {
      items: [{ title: "A", command: "task check", status: "pending" }],
    };
    const stored = readStoredLiteralAcceptanceCommands(plan);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.command).toBe("task check");
    expect(stored[0]?.source).toBe("plan_item");
  });
});

describe("runLiteralAcceptanceCommands", () => {
  it("runs commands verbatim via runner and fails closed on non-zero", () => {
    const seen: string[] = [];
    const runner = (input: { command: string; cwd: string }) => {
      seen.push(input.command);
      if (input.command === "task check") {
        return { exitCode: 1, stdout: "", stderr: "boom" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const result = runLiteralAcceptanceCommands(
      [
        { command: "pnpm test", source: "task_statement" },
        { command: "task check", source: "task_statement" },
      ],
      { projectRoot: process.cwd(), runner },
    );
    expect(seen).toEqual(["pnpm test", "task check"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/FAILED|#3267|task check/);
  });

  it("passes when all commands exit 0", () => {
    const result = runLiteralAcceptanceCommands([{ command: "true-cmd", source: "explicit" }], {
      projectRoot: process.cwd(),
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it("fails when expectedStdout is missing", () => {
    const result = runLiteralAcceptanceCommands(
      [
        {
          command: "echo hi",
          source: "explicit",
          expectedStdout: "EXPECTED_TOKEN",
        },
      ],
      {
        projectRoot: process.cwd(),
        runner: () => ({ exitCode: 0, stdout: "actual", stderr: "" }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.runs[0]?.detail).toMatch(/expected substring/);
  });

  it("empty command list is ok (nothing stated)", () => {
    const result = runLiteralAcceptanceCommands([], {
      projectRoot: process.cwd(),
      runner: () => {
        throw new Error("must not run");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it("uses stated cwd relative to project root", () => {
    const root = mkdtempSync(join(tmpdir(), "literal-ac-cwd-"));
    let usedCwd = "";
    runLiteralAcceptanceCommands([{ command: "echo", source: "explicit", cwd: "sub" }], {
      projectRoot: root,
      runner: (input) => {
        usedCwd = input.cwd;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(usedCwd).toBe(join(root, "sub"));
  });
});

describe("evaluateLiteralAcceptanceFromPlan / Path", () => {
  it("evaluates stored metadata commands", () => {
    const plan = attachLiteralAcceptanceCommands({ title: "t", items: [] }, [
      { command: "ok", source: "task_statement" },
    ]);
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.commands).toHaveLength(1);
  });

  it("re-captures from Overview narrative when metadata empty", () => {
    const plan = {
      title: "t",
      narratives: {
        Overview: "verify: pnpm exec vitest run packages/core/src",
      },
      items: [],
    };
    const result = evaluateLiteralAcceptanceFromPlan(plan, {
      projectRoot: process.cwd(),
      runner: (input) => {
        expect(input.command).toBe("pnpm exec vitest run packages/core/src");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.commands.map((c) => c.command)).toContain(
      "pnpm exec vitest run packages/core/src",
    );
  });

  it("loads xBRIEF from path", () => {
    const dir = mkdtempSync(join(tmpdir(), "literal-ac-xbrief-"));
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          metadata: {
            literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
          },
          items: [],
        },
      }),
      "utf8",
    );
    const result = evaluateLiteralAcceptanceFromPath(path, {
      projectRoot: dir,
      runner: (input) => {
        expect(input.command).toBe("task check");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.ok).toBe(true);
  });

  it("config-fails on missing path", () => {
    const result = evaluateLiteralAcceptanceFromPath(join(tmpdir(), "no-such-xbrief.json"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });
});

describe("ceremony dial rapid/minimal keeps check", () => {
  it("literal acceptance is required at every depth including rapid and minimal", () => {
    for (const depth of ["minimal", "rapid", "standard", "elevated", null, undefined]) {
      expect(isLiteralAcceptanceRequiredAtCeremonyDepth(depth)).toBe(true);
    }
  });
});
