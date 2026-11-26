import { describe, expect, it } from "vitest";
import { HOST_TOOL_SURFACE_AUDIT } from "../tools.js";
import {
  AGY_ADMISSION_VERDICT,
  AGY_OBSERVED_BEHAVIORS,
  AGY_OBSERVED_HOST_VERSION,
  AGY_PRETOOLUSE_FIXTURES,
  AGY_SESSION_START_FIXTURE,
  agyAdmissionPasses,
} from "./agy-observation.js";
import { hookPayloadTopLevelKeys } from "./payload.js";
import { CLASSIFY_HOOK_HOSTS } from "./types.js";

describe("agy host observation and admission verdict (#7345)", () => {
  it("registers agy and backs HOST_TOOL_SURFACE_AUDIT.agy with the observation", () => {
    expect(CLASSIFY_HOOK_HOSTS).toContain("agy");
    const audit = HOST_TOOL_SURFACE_AUDIT.agy;
    expect(audit.source).toContain(AGY_OBSERVED_HOST_VERSION);
    expect(audit.unobservedReason ?? "").toMatch(/run_workflow/);
    const fixtureTools = new Set(
      Object.values(AGY_PRETOOLUSE_FIXTURES).map((f) => f.toolCall.name),
    );
    const named = [
      ...audit.mutation.directWrite,
      ...audit.mutation.shell,
      ...audit.mutation.spawn,
      ...Object.keys(audit.nonMutation),
    ];
    for (const name of named) expect(fixtureTools.has(name), `${name} was observed`).toBe(true);
  });

  it("commits a verdict that names every property and cites known scenarios", () => {
    const scenarios = new Set(Object.values(AGY_OBSERVED_BEHAVIORS).flatMap((b) => b.scenarios));
    const props = Object.keys(AGY_ADMISSION_VERDICT.properties).sort();
    expect(props).toEqual([
      "finalExecutedArgumentIntegrity",
      "nonWeakenableDenial",
      "runtimeFailureBoundary",
    ]);
    for (const verdict of Object.values(AGY_ADMISSION_VERDICT.properties)) {
      expect(["pass", "fail"]).toContain(verdict.status);
      expect(verdict.evidence.length).toBeGreaterThan(0);
      for (const id of verdict.evidence) expect(scenarios.has(id), id).toBe(true);
    }
    expect(AGY_ADMISSION_VERDICT.hostVersion).toBe(AGY_OBSERVED_HOST_VERSION);
    expect(AGY_ADMISSION_VERDICT.unobserved.length).toBeGreaterThan(0);
  });

  it("derives overall from the properties and never fabricates a pass", () => {
    const anyFail = Object.values(AGY_ADMISSION_VERDICT.properties).some(
      (p) => p.status === "fail",
    );
    expect(AGY_ADMISSION_VERDICT.overall).toBe(anyFail ? "fail" : "pass");
    expect(agyAdmissionPasses()).toBe(!anyFail);
    const props = Object.fromEntries(
      Object.entries(AGY_ADMISSION_VERDICT.properties).map(([k, v]) => [
        k,
        { ...v, status: "pass" as const },
      ]),
    ) as typeof AGY_ADMISSION_VERDICT.properties;
    const allPass = { ...AGY_ADMISSION_VERDICT, overall: "pass" as const, properties: props };
    expect(agyAdmissionPasses(allPass)).toBe(true);
    expect(agyAdmissionPasses({ ...allPass, overall: "fail" })).toBe(false);
  });
});

describe("agy observed hook payload shape (#7345)", () => {
  const COMMON = [
    "artifactDirectoryPath",
    "conversationId",
    "cwd",
    "hookEventName",
    "lastUserInput",
    "modelName",
    "transcriptPath",
    "workspacePaths",
  ];

  it("records camelCase PreToolUse stdin with a nested toolCall and no tool_name", () => {
    for (const [id, fixture] of Object.entries(AGY_PRETOOLUSE_FIXTURES)) {
      expect(hookPayloadTopLevelKeys(fixture), id).toEqual(
        [...COMMON, "stepIdx", "toolCall"].sort(),
      );
      expect(fixture.hookEventName, id).toBe("PreToolUse");
      expect(Object.keys(fixture.toolCall).sort(), id).toEqual(["args", "id", "name"]);
    }
  });

  it("records SessionStart stdin without a toolCall", () => {
    expect(hookPayloadTopLevelKeys(AGY_SESSION_START_FIXTURE)).toEqual([...COMMON].sort());
    expect(AGY_SESSION_START_FIXTURE.hookEventName).toBe("SessionStart");
  });

  it("keeps the observed capitalized argument keys and a distinct child conversationId", () => {
    const f = AGY_PRETOOLUSE_FIXTURES;
    expect(Object.keys(f.run_command.toolCall.args)).toContain("CommandLine");
    expect(Object.keys(f.write_file.toolCall.args)).toEqual(["Content", "Overwrite", "Path"]);
    expect(Object.keys(f.edit_file.toolCall.args)).toEqual(["Path", "Replacement", "Target"]);
    expect(f.child_run_command.conversationId).not.toBe(f.invoke_subagent.conversationId);
    expect(f.child_send_message.toolCall.args.Recipient).toBe(f.invoke_subagent.conversationId);
  });

  it("carries no local user or workspace paths", () => {
    const text = JSON.stringify([AGY_PRETOOLUSE_FIXTURES, AGY_SESSION_START_FIXTURE]);
    expect(text).not.toMatch(/AppData|scratchpad/);
  });
});
