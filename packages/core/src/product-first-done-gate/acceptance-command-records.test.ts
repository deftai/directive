/**
 * One acceptance record list across scope:activate, xbrief:activate and
 * verify:ac (#6886). A web brief with a vitest command runs through both
 * activation verbs and verify:ac.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WRAPPER_SUBCOMMAND_REFUSAL } from "../literal-acceptance/safety.js";
import { runTransition } from "../scope/transition.js";
import { formatBriefJson } from "../scope/vbrief-json.js";
import { activate } from "../vbrief-activate/activate.js";
import {
  evaluateVerifyAcFromPlan,
  formatAcceptanceActivationWarnings,
  resolveAcceptanceCommandRecords,
} from "./evaluate.js";

const NAME = "2026-01-01-story.xbrief.json";
const VITEST = "npx vitest run src/app.test.ts";
const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ac-records-6886-"));
  ROOTS.push(root);
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  mkdirSync(join(root, "web"));
  return root;
}

type Command = string | { command: string; cwd?: string };

function acceptance(commands: readonly Command[]): Record<string, unknown> {
  return {
    commands,
    none_stated: commands.length === 0,
    source_rung: "derived",
    ambiguity_attestation: "none_found",
    clauses: [{ id: 1, text: "The web tests pass", artifact_path: null, ambiguous: false }],
  };
}

function plan(fields: {
  readonly commands?: readonly Command[];
  readonly metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    title: "web story",
    status: "pending",
    items: [],
    acceptance: acceptance(fields.commands ?? []),
    ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
  };
}

function writePending(root: string, planObj: Record<string, unknown>): string {
  const path = join(root, "xbrief", "pending", NAME);
  writeFileSync(
    path,
    formatBriefJson({ xBRIEFInfo: { version: "0.8" }, plan: structuredClone(planObj) }),
    "utf8",
  );
  return path;
}

/** scope:activate and xbrief:activate on separate roots; both messages. */
function activateBoth(planObj: Record<string, unknown>): {
  readonly scope: { ok: boolean; message: string };
  readonly xbrief: { ok: boolean; message: string };
} {
  const scope = runTransition("activate", writePending(makeRoot(), planObj));
  const xbriefResult = activate(writePending(makeRoot(), planObj), { now: new Date() });
  return {
    scope: { ok: scope.ok, message: scope.message },
    xbrief: { ok: xbriefResult.exitCode === 0, message: xbriefResult.message },
  };
}

function declaredLines(message: string): string[] {
  return message.split("\n").filter((line) => line.includes("deft gate acceptance-"));
}

function verifyAc(
  planObj: Record<string, unknown>,
  root = makeRoot(),
): {
  readonly root: string;
  readonly result: ReturnType<typeof evaluateVerifyAcFromPlan>;
  readonly calls: { command: string; cwd: string }[];
} {
  const calls: { command: string; cwd: string }[] = [];
  const result = evaluateVerifyAcFromPlan(structuredClone(planObj), {
    projectRoot: root,
    captureFromNarratives: true,
    hasSuiteFloor: true,
    bankOnPass: false,
    reuseMode: "never",
    runner: (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { root, result, calls };
}

describe("web brief with a vitest acceptance command (#6886)", () => {
  it("activates with no warning and verify:ac runs it once in <root>/web", () => {
    const p = plan({ commands: [{ command: VITEST, cwd: "web" }] });
    const both = activateBoth(p);
    expect(both.scope.ok).toBe(true);
    expect(both.xbrief.ok).toBe(true);
    expect(declaredLines(both.scope.message)).toEqual([]);
    expect(declaredLines(both.xbrief.message)).toEqual([]);
    const { root, result, calls } = verifyAc(p);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ command: VITEST, cwd: join(root, "web") }]);
  });

  it("runs a record that is in both plan.acceptance.commands and metadata once", () => {
    const record = { command: VITEST, cwd: "web" };
    const { calls } = verifyAc(
      plan({
        commands: [record],
        metadata: { literal_acceptance_commands: [{ ...record, source: "explicit" }] },
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("runs a metadata command and a different plan command both", () => {
    const { result, calls } = verifyAc(
      plan({
        commands: [{ command: VITEST, cwd: "web" }],
        metadata: { literal_acceptance_commands: [{ command: "task check", source: "explicit" }] },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.command).sort()).toEqual(["task check", VITEST].sort());
  });

  it("runs nothing for an inline-mention copy or a not-command, and once with a promoted peer", () => {
    const inline = { command: "task check", source: "task_statement", sourceSpan: "inline@L3" };
    const mentionOnly = verifyAc(
      plan({ commands: ["task check"], metadata: { literal_acceptance_commands: [inline] } }),
    );
    expect(mentionOnly.calls).toEqual([]);
    const disposed = verifyAc(
      plan({
        commands: ["task check"],
        metadata: { literal_acceptance_not_commands: ["task check"] },
      }),
    );
    expect(disposed.calls).toEqual([]);
    const promoted = verifyAc(
      plan({
        commands: ["task check"],
        metadata: {
          literal_acceptance_commands: [inline],
          swarm: { verify_commands: ["task check"] },
        },
      }),
    );
    expect(promoted.calls).toHaveLength(1);
  });

  it("warns at both activations on an unpromoted capture and verify:ac refuses it before any run", () => {
    const capture = {
      command: VITEST,
      cwd: "web",
      source: "task_statement",
      sourceSpan: "fence@L1",
    };
    const unpromoted = plan({ metadata: { literal_acceptance_commands: [capture] } });
    const both = activateBoth(unpromoted);
    for (const side of [both.scope, both.xbrief]) {
      expect(side.ok).toBe(true);
      const lines = declaredLines(side.message);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("deft gate acceptance-record-activate ");
      expect(lines[0]).toContain("plan.metadata.swarm.verify_commands");
      expect(lines[0]).toContain("plan.metadata.literal_acceptance_not_commands");
    }
    const refused = verifyAc(unpromoted);
    expect(refused.result.ok).toBe(false);
    expect(refused.calls).toEqual([]);

    const peer = { command: VITEST, cwd: "web", source: "explicit" };
    const promoted = plan({ metadata: { literal_acceptance_commands: [capture, peer] } });
    expect(declaredLines(activateBoth(promoted).scope.message)).toEqual([]);
    expect(verifyAc(promoted).calls).toHaveLength(1);
  });

  it("admits task web:test with no cwd at both activations and verify:ac", () => {
    const p = plan({ commands: ["task web:test"] });
    const both = activateBoth(p);
    expect(declaredLines(both.scope.message)).toEqual([]);
    expect(declaredLines(both.xbrief.message)).toEqual([]);
    const { result, calls } = verifyAc(p);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.command)).toEqual(["task web:test"]);
  });

  it("warns at both activations on refused forms and verify:ac refuses before running anything", () => {
    for (const command of [
      "task web:test web:deploy",
      "task web:test --dir x",
      "task a:b:test",
      "task web:deploy",
    ]) {
      const p = plan({
        metadata: {
          literal_acceptance_commands: [
            { command, source: "explicit" },
            { command: "task check", source: "explicit" },
          ],
        },
      });
      const both = activateBoth(p);
      for (const side of [both.scope, both.xbrief]) {
        expect(side.ok, command).toBe(true);
        const lines = declaredLines(side.message);
        expect(lines, command).toHaveLength(1);
        expect(lines[0], command).toContain(WRAPPER_SUBCOMMAND_REFUSAL);
      }
      const { result, calls } = verifyAc(p);
      expect(result.ok, command).toBe(false);
      expect(calls, command).toEqual([]);
      expect(
        result.rejected?.map((r) => r.command),
        command,
      ).toEqual([command]);
    }
  });

  it("prints one cwd warning text at both activations and verify:ac without refusing on the grammar", () => {
    for (const cwd of ["/x", "C:x", "C:/x", "\\\\srv\\share", "web\\sub"]) {
      const p = plan({ commands: [{ command: VITEST, cwd }] });
      const expected = formatAcceptanceActivationWarnings(resolveAcceptanceCommandRecords(p));
      expect(expected, cwd).toHaveLength(1);
      expect(expected[0], cwd).toContain("deft gate acceptance-cwd-grammar ");
      const both = activateBoth(p);
      expect(both.scope.ok, cwd).toBe(true);
      expect(both.xbrief.ok, cwd).toBe(true);
      expect(declaredLines(both.scope.message), cwd).toEqual(expected);
      expect(declaredLines(both.xbrief.message), cwd).toEqual(expected);
      const { result } = verifyAc(p);
      expect(result.message, cwd).toContain(expected[0]);
      // Any refusal here is the run-time containment check, never the grammar.
      expect(result.rejected ?? [], cwd).toEqual([]);
    }
  });

  it("refuses a cwd outside the root or missing with exit 2 and never calls the runner", () => {
    for (const cwd of ["C:x", "missing"]) {
      const { result, calls } = verifyAc(plan({ commands: [{ command: VITEST, cwd }] }));
      expect(result.code, cwd).toBe(2);
      expect(result.message, cwd).toContain("refused: ");
      expect(calls, cwd).toEqual([]);
    }
    // #7223: a `..` or dependency segment is refused by the grammar before any run.
    for (const cwd of ["../x", "node_modules/pkg"]) {
      const { result, calls } = verifyAc(plan({ commands: [{ command: VITEST, cwd }] }));
      expect(result.code, cwd).toBe(1);
      expect(result.message, cwd).toContain("deft gate acceptance-cwd-dependency ");
      expect(calls, cwd).toEqual([]);
    }
    const outside = mkdtempSync(join(tmpdir(), "ac-records-outside-"));
    ROOTS.push(outside);
    const abs = verifyAc(plan({ commands: [{ command: VITEST, cwd: outside }] }));
    expect(abs.result.code).toBe(2);
    expect(abs.calls).toEqual([]);
  });

  it("warns and runs an absolute cwd inside the project root there", () => {
    const root = makeRoot();
    const p = plan({ commands: [{ command: VITEST, cwd: join(root, "web") }] });
    const { result, calls } = verifyAc(p, root);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("deft gate acceptance-cwd-grammar ");
    expect(calls).toEqual([{ command: VITEST, cwd: join(root, "web") }]);
  });

  it("refuses a record only in plan.acceptance.commands and runs nothing", () => {
    const { result, calls } = verifyAc(
      plan({
        commands: ["task web:deploy"],
        metadata: { literal_acceptance_commands: [{ command: "task check", source: "explicit" }] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(result.rejected?.[0]?.sourceSpan).toBe("plan.acceptance.commands");
  });
});
