/**
 * #6912: `routeArgv` drops at most one lone `--` at the boundary between the routed verb
 * tokens and the user's arguments. Router only: no handler runs.
 */
import { describe, expect, it } from "vitest";
import { routeArgv, SCOPE_LIFECYCLE_VERBS, SUBCOMMAND_ROUTES } from "./route-argv.js";

function argvOf(input: readonly string[]): string[] {
  return routeArgv(input).argv;
}

/** Both spellings of every one-colon SUBCOMMAND_ROUTES key and every scope lifecycle verb. */
function sweepForms(): string[][] {
  const forms: string[][] = [];
  for (const key of Object.keys(SUBCOMMAND_ROUTES)) {
    const parts = key.split(":");
    if (parts.length !== 2) continue;
    forms.push([key], parts);
  }
  for (const verb of SCOPE_LIFECYCLE_VERBS) {
    forms.push([`scope:${verb}`], [`scope-${verb}`]);
  }
  return forms;
}

describe("routeArgv lone -- sweep over subcommand routes (#6912)", () => {
  const forms = sweepForms();

  it("covers every one-colon subcommand key and scope lifecycle verb in both spellings", () => {
    const oneColon = Object.keys(SUBCOMMAND_ROUTES).filter((k) => k.split(":").length === 2);
    expect(forms).toHaveLength(2 * oneColon.length + 2 * SCOPE_LIFECYCLE_VERBS.size);
  });

  it.each(
    forms.map((form) => [form.join(" "), form] as const),
  )("%s routes the same with and without a lone --", (_label, form) => {
    expect(argvOf([...form, "--", "--x"])).toEqual(argvOf([...form, "--x"]));
  });

  it.each(
    forms.map((form) => [form.join(" "), form] as const),
  )("%s keeps exactly one -- from -- --", (_label, form) => {
    const twice = argvOf([...form, "--", "--", "--x"]);
    expect(twice.filter((token) => token === "--")).toHaveLength(1);
    expect(twice).toEqual([...argvOf(form), "--", "--x"]);
  });
});

describe("routeArgv lone -- named forms (#6912)", () => {
  it.each([
    [
      ["cache:clear", "--", "--x"],
      ["cache", "clear", "--x"],
    ],
    [
      ["cache:clear", "--", "--project-root", "d"],
      ["cache", "clear", "--project-root", "d"],
    ],
    [
      ["vbrief", "reconcile", "graph", "--", "--x"],
      ["vbrief-reconcile", "graph", "--x"],
    ],
    [
      ["vbrief", "reconcile", "--", "--all"],
      ["vbrief-reconcile", "--all"],
    ],
    [
      ["vbrief", "reconcile", "parity", "--", "--all"],
      ["vbrief-reconcile", "parity", "--all"],
    ],
    [
      ["policy", "resolve", "--", "--project-root", "x"],
      ["policy", "resolve", "--project-root", "x"],
    ],
    [
      ["policy", "show", "--", "--x"],
      ["policy", "show", "--x"],
    ],
    [
      ["verify", "orphan-active", "--", "--issue", "7"],
      ["verify:orphan-active", "--issue", "7"],
    ],
    [
      ["policy:show", "--", "--x"],
      ["policy:show", "--x"],
    ],
    [
      ["scm:body:issue:fetch", "--", "--x"],
      ["github-body", "issue-fetch", "--x"],
    ],
    [
      ["review-monitor:register", "--", "--pr", "1"],
      ["review-monitor:register", "--pr", "1"],
    ],
    [
      ["occupancy:release", "--", "--session-id", "s"],
      ["occupancy:release", "--session-id", "s"],
    ],
    [
      ["scope:promote", "--", "p.json"],
      ["scope-lifecycle", "promote", "p.json"],
    ],
    [
      ["scope:activate", "--", "p.json"],
      ["scope-lifecycle", "activate", "p.json"],
    ],
    [
      ["scope:complete", "--", "p.json"],
      ["scope-lifecycle", "complete", "p.json"],
    ],
    [
      ["check", "--", "--x"],
      ["check", "--x"],
    ],
  ])("%j routes to %j", (input, expected) => {
    expect(argvOf(input)).toEqual(expected);
  });

  it("cache:clear gives the cache handler the same arguments with and without --", () => {
    expect(argvOf(["cache:clear", "--", "--project-root", "d"])).toEqual(
      argvOf(["cache:clear", "--project-root", "d"]),
    );
  });

  it("keeps a later --", () => {
    expect(argvOf(["cache:clear", "--x", "--", "y"])).toEqual(["cache", "clear", "--x", "--", "y"]);
  });
});

describe("routeArgv lone -- forms left unchanged (#6912)", () => {
  it("leaves scm issue pass-through unchanged", () => {
    expect(argvOf(["scm", "issue", "list", "--", "--limit", "1"])).toEqual([
      "scm",
      "issue",
      "list",
      "--",
      "--limit",
      "1",
    ]);
  });

  it("leaves policy set <field> -- unchanged (the field is data)", () => {
    expect(argvOf(["policy", "set", "f", "--", "--y"])).toEqual(["policy-set", "f", "--", "--y"]);
  });

  it("keeps a -- that is a flag value", () => {
    expect(argvOf(["triage-queue", "--limit", "--", "3"])).toEqual([
      "triage-queue",
      "--limit",
      "--",
      "3",
    ]);
  });

  it("leaves vbrief validate conformance unchanged (moved to #6944)", () => {
    expect(argvOf(["vbrief", "validate", "conformance", "--", "--x"])).toEqual([
      "vbrief:validate",
      "conformance",
      "--",
      "--x",
    ]);
  });

  it("leaves meta forms and stubs unchanged", () => {
    expect(argvOf(["--help"])).toEqual(["--help"]);
    expect(argvOf(["--help", "--", "x"])).toEqual(["--help", "--", "x"]);
    expect(argvOf(["help", "--", "x"])).toEqual(["help", "--", "x"]);
    expect(argvOf(["-V", "--", "x"])).toEqual(["-V", "--", "x"]);
    const stub = routeArgv(["migrate", "--", "x"]);
    expect(stub.kind).toBe("stub");
    expect(stub.argv).toEqual([]);
  });

  it("leaves empty argv unchanged", () => {
    expect(routeArgv([])).toEqual({ kind: "dispatch", argv: [] });
  });
});
