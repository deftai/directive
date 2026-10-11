import { mainEntry as githubBodyMainEntry } from "@deftai/directive-core/dist/intake/github-body-cli.js";
import { describe, expect, it } from "vitest";
import {
  RETIRED_TOP_LEVEL_INSTALL_VERBS,
  routeArgv,
  SCM_BODY_COLON_VERBS,
  TOP_LEVEL_UX_VERBS,
} from "./route-argv.js";

describe("route-argv: retired install verbs (AC13.6 / #5490 wave 2h)", () => {
  it("does not list migrate/bootstrap in the top-level UX vocabulary", () => {
    expect(TOP_LEVEL_UX_VERBS).not.toContain("migrate");
    expect(TOP_LEVEL_UX_VERBS).not.toContain("bootstrap");
  });

  it.each(["migrate", "bootstrap", "sync", "install-upgrade", "install-uninstall"] as const)(
    "retired verb %s stubs as unknown-command",
    (verb) => {
      expect(RETIRED_TOP_LEVEL_INSTALL_VERBS.has(verb)).toBe(true);
      const routed = routeArgv([verb]);
      expect(routed.kind).toBe("stub");
      expect(routed.stubMessage ?? "").toMatch(/Unknown command/i);
      expect(routed.stubMessage ?? "").toMatch(/install, upgrade, uninstall, doctor/);
    },
  );

  it("init and update still route (launcher aliases; legacy runtime paths)", () => {
    expect(routeArgv(["init"]).argv).toEqual(["init"]);
    expect(routeArgv(["update"]).argv).toEqual(["update"]);
  });

  it("every curated top-level UX verb routes as dispatch or stub", () => {
    for (const verb of TOP_LEVEL_UX_VERBS) {
      expect(["dispatch", "stub"]).toContain(routeArgv([verb]).kind);
    }
  });
});

describe("route-argv: setup branch-policy colon verbs (#3609)", () => {
  it("routes the exact setup writer argv without a task-wrapper separator", () => {
    expect(
      routeArgv(["policy:enforce-branches", "--actor", "agent:deft-directive-setup"]).argv,
    ).toEqual(["policy:enforce-branches", "--actor", "agent:deft-directive-setup"]);
    expect(
      routeArgv([
        "policy:allow-direct-commits",
        "--confirm",
        "--actor",
        "agent:deft-directive-setup",
      ]).argv,
    ).toEqual([
      "policy:allow-direct-commits",
      "--confirm",
      "--actor",
      "agent:deft-directive-setup",
    ]);
  });

  it("routes the exact setup read-back and conformance argv", () => {
    expect(
      routeArgv(["policy:show", "--field=plan.policy.allowDirectCommitsToMaster"]).argv,
    ).toEqual(["policy:show", "--field=plan.policy.allowDirectCommitsToMaster"]);
    expect(routeArgv(["verify:vbrief-conformance", "--project-root", "."]).argv).toEqual([
      "verify:vbrief-conformance",
      "--project-root",
      ".",
    ]);
  });
});

describe("route-argv: scm:body:* colon aliases (#5521)", () => {
  const cases: ReadonlyArray<{
    readonly alias: string;
    readonly subcommand: string;
  }> = [
    { alias: "scm:body:issue:create", subcommand: "issue-create" },
    { alias: "scm:body:issue:edit", subcommand: "issue-edit" },
    { alias: "scm:body:issue:fetch", subcommand: "issue-fetch" },
    { alias: "scm:body:issue:lint", subcommand: "issue-lint" },
    { alias: "scm:body:comment:create", subcommand: "comment-create" },
    { alias: "scm:body:comment:edit", subcommand: "comment-edit" },
    { alias: "scm:body:pr:edit", subcommand: "pr-edit" },
    { alias: "scm:body:pr:lint", subcommand: "pr-lint" },
  ];

  it("inserts github-body subcommand for every scm:body:* alias (argv parity)", () => {
    for (const { alias, subcommand } of cases) {
      expect(routeArgv([alias, "--repo", "o/r", "--issue", "1"]).argv).toEqual([
        "github-body",
        subcommand,
        "--repo",
        "o/r",
        "--issue",
        "1",
      ]);
    }
  });

  it("matches existing github-body:* routes for the same engine argv", () => {
    expect(routeArgv(["scm:body:issue:fetch", "--out-file", "b.md"]).argv).toEqual(
      routeArgv(["github-body:issue-fetch", "--out-file", "b.md"]).argv,
    );
    expect(routeArgv(["scm:body:pr:edit", "--pr", "9", "--body-file", "p.md"]).argv).toEqual(
      routeArgv(["github-body:pr-edit", "--pr", "9", "--body-file", "p.md"]).argv,
    );
  });

  it("does not hand the engine --repo as its command (subcommand insertion)", () => {
    const routed = routeArgv(["scm:body:issue:edit", "--repo", "o/r", "--body-file", "x.md"]);
    expect(routed.argv[0]).toBe("github-body");
    expect(routed.argv[1]).toBe("issue-edit");
    expect(routed.argv[1]?.startsWith("--")).toBe(false);
  });

  it("exports the eight dual-invoke names matching SUBCOMMAND_ROUTES", () => {
    expect(SCM_BODY_COLON_VERBS).toHaveLength(8);
  });

  it("fetch/write failure path stays on github-body engine via alias argv (#5521)", () => {
    const fetchRouted = routeArgv(["scm:body:issue:fetch", "--repo", "o/r"]);
    expect(fetchRouted.argv[0]).toBe("github-body");
    // Peel verb the way dispatch does; parse via mainEntry (string argv → GitHubBodyCliArgs).
    expect(githubBodyMainEntry(fetchRouted.argv.slice(1))).toBe(1);

    const writeRouted = routeArgv(["scm:body:issue:edit", "--repo", "o/r", "--issue", "1"]);
    expect(writeRouted.argv[0]).toBe("github-body");
    expect(githubBodyMainEntry(writeRouted.argv.slice(1))).toBe(1);
  });
});
