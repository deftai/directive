import type { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { engineInfo } from "@deftai/directive-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { routeAndDispatch, routeArgv } from "./cli-router/index.js";
import { SUBCOMMAND_ROUTES } from "./cli-router/route-argv.js";
import {
  CLI_MODULE_VERBS,
  CORE_MODULE_VERBS,
  dispatch,
  fetchAndVerifyGhxInstaller,
  fetchAndVerifyGhxInstallerAsset,
  GHX_COMMIT_SHA,
  GHX_INSTALL_PS1_SHA256,
  GHX_INSTALL_SH_SHA256,
  GHX_VERSION,
  type GhxInstallerAsset,
  helpVersionLabel,
  INSTALL_PS1_URL,
  INSTALL_SH_URL,
  installVerifiedGhxAsset,
  POLICY_ACTION_ALIAS_SUBCOMMANDS,
  parseDirectiveBootstrapArgs,
  preferredCommandNames,
  printCommandsList,
  printHelp,
  registeredVerbs,
  resetHandlerCacheForTests,
  resolveCanonicalVerb,
  runDirectiveBootstrap,
  runSetupGhx,
  SETUP_SKILL_REL_PATH,
  TRIAGE_ACTION_ALIAS_SUBCOMMANDS,
  VERB_ALIASES,
  verifyGhxSha256,
} from "./dispatch.js";

const engineVersion = engineInfo().version;
const VERSION_BANNER = `@deftai/directive (engine: @deftai/directive-core@${engineVersion})\n`;

afterEach(() => {
  resetHandlerCacheForTests();
  vi.restoreAllMocks();
});

describe("registeredVerbs", () => {
  it("includes every CLI module verb, core verb, and alias", () => {
    const verbs = registeredVerbs();
    for (const name of CLI_MODULE_VERBS) {
      expect(verbs).toContain(name);
    }
    for (const name of CORE_MODULE_VERBS) {
      expect(verbs).toContain(name);
    }
    for (const alias of Object.keys(VERB_ALIASES)) {
      expect(verbs).toContain(alias);
    }
    expect(verbs.length).toBe(
      new Set([...CLI_MODULE_VERBS, ...CORE_MODULE_VERBS, ...Object.keys(VERB_ALIASES)]).size,
    );
  });
});

describe("printHelp", () => {
  function renderHelp(): string {
    const lines: string[] = [];
    printHelp({
      writeOut: (text) => {
        lines.push(text);
      },
      writeErr: () => {},
    });
    return lines.join("");
  }

  function renderCommands(): string {
    const lines: string[] = [];
    printCommandsList({
      writeOut: (text) => {
        lines.push(text);
      },
      writeErr: () => {},
    });
    return lines.join("");
  }

  it("prints structured curated help instead of dumping every registered verb (#2172)", () => {
    const body = renderHelp();
    expect(body).toContain(`Directive ${helpVersionLabel()}`);
    expect(body).toContain("Usage:");
    expect(body).toContain("directive <command> [options]");
    expect(body).toContain("directive commands");
    expect(body).toContain("Options:");
    expect(body).toContain("-h, --help");
    expect(body).toContain("-V, --version");
    expect(body).toContain("Getting started:");
    expect(body).toContain("Session & ritual:");
    expect(body).toContain("Quality & gates:");
    expect(body).toContain("Work queue & triage:");
    expect(body).toContain("Scope lifecycle:");
    expect(body).toContain("Project artifacts:");
    expect(body).toContain("Run `directive commands` for the full registered-command list.");
    expect(body).not.toContain("Registered verbs:");
    for (const verb of registeredVerbs()) {
      expect(body).not.toContain(`  ${verb}\n`);
    }
  });

  it("lists deduplicated preferred names via directive commands (#2172)", () => {
    const body = renderCommands();
    expect(body).toContain("Registered commands:");
    for (const name of preferredCommandNames()) {
      expect(body).toContain(`  ${name}\n`);
    }
    expect(body).toContain("  verify:encoding\n");
    expect(body).not.toContain("  verify-encoding\n");
    expect(body).toContain("  triage:welcome\n");
    expect(body).not.toContain("  triage-welcome\n");
    expect(body).toContain("  build\n");
    expect(body).not.toContain("  framework-commands\n");
  });

  // #2273: no-arg `directive` leads with the three-command model + first-run
  // guidance, printed BEFORE the exhaustive verb list.
  it("prints the three-command model and first-run guidance before the verb list (#2273)", () => {
    const body = renderHelp();
    for (const line of ["init", "update", "doctor", "First run?", "npm i -g @deftai/directive"]) {
      expect(body).toContain(line);
    }
    // Cold-start recovery pointer is payload-independent (points at README.md).
    expect(body).toContain("README.md");

    const modelIdx = body.indexOf("Getting started:");
    const commandsPointerIdx = body.indexOf("Run `directive commands`");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(commandsPointerIdx);
  });

  // #2274: the top-level help snapshot is the source the README / BROWNFIELD /
  // UPGRADING docs mirror. Lock the "Getting started" grouping, the init->update->
  // doctor ordering, and each command's by-situation one-liner so the docs and
  // the CLI can never drift out of agreement on the three-command model.
  it("routes users by situation: init sets up, update refreshes, doctor diagnoses (#2274)", () => {
    const body = renderHelp();
    expect(body).toContain("Getting started:");

    const initIdx = body.indexOf("init");
    const updateIdx = body.indexOf("update");
    const doctorIdx = body.indexOf("doctor");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(initIdx);
    expect(doctorIdx).toBeGreaterThan(updateIdx);

    for (const line of [
      "  init                  Set up Directive in the current project (first-time setup)",
      "  update                Refresh an existing install and self-heal the engine",
      "  doctor                Diagnose the install and print the one next step",
    ]) {
      expect(body).toContain(line);
    }
  });
});

describe("dispatch", () => {
  it("returns 0 for --version and prints the engine banner", async () => {
    const out: string[] = [];
    const code = await dispatch(["--version"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe(VERSION_BANNER);
  });

  it("returns 0 for -V and prints the engine banner", async () => {
    const out: string[] = [];
    const code = await dispatch(["-V"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe(VERSION_BANNER);
  });

  it("returns 0 for empty argv and prints help", async () => {
    const out: string[] = [];
    const code = await dispatch([], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("directive <command> [options]");
  });

  it("returns 0 for -h and prints curated help", async () => {
    const out: string[] = [];
    const code = await dispatch(["-h"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("directive commands");
    expect(out.join("")).not.toContain("Registered verbs:");
  });

  it("returns 0 for help and prints curated help", async () => {
    const out: string[] = [];
    const code = await dispatch(["help"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Getting started:");
    expect(out.join("")).not.toContain("Registered verbs:");
  });

  it("coerces non-number handler return to exit code 0", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => "not-a-number",
    }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
  });

  it("coerces async void handler return to exit code 0", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: async () => undefined,
    }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
  });

  it("coerces a void handler return to exit code 0", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => undefined,
    }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
  });

  it("returns exit code 2 when a handler throws", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => {
        throw new Error("boom");
      },
    }));
    resetHandlerCacheForTests();

    const err: string[] = [];
    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(2);
    expect(err.join("")).toBe("directive: boom\n");
  });

  it("stringifies non-Error handler throws", async () => {
    vi.doMock("./verify-encoding.js", () => ({
      run: () => {
        throw "plain";
      },
    }));
    resetHandlerCacheForTests();

    const err: string[] = [];
    const code = await dispatch(["verify-encoding"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(2);
    expect(err.join("")).toBe("directive: plain\n");
  });

  it("returns 0 for --help and prints curated help", async () => {
    const out: string[] = [];
    const code = await dispatch(["--help"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Options:");
    expect(out.join("")).not.toContain("Registered verbs:");
  });

  it("returns 0 for commands and prints the full registered-command list", async () => {
    const out: string[] = [];
    const code = await dispatch(["commands"], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Registered commands:");
    expect(out.join("")).toContain("  verify:encoding\n");
  });

  it("prints an error naming an unknown verb and exits non-zero", async () => {
    const err: string[] = [];
    const code = await dispatch(["not-a-real-verb"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe("directive: unknown verb 'not-a-real-verb'\n");
  });

  it("hints task/hyphen stem when an unknown colon verb is used (#2652)", async () => {
    const err: string[] = [];
    const code = await dispatch(["notreal:verb"], {
      writeOut: () => {},
      writeErr: (text) => {
        err.push(text);
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("unknown verb 'notreal:verb'");
    expect(err.join("")).toContain("task notreal:verb");
  });

  it("resolves pr:watch colon alias to pr-watch (#2652)", () => {
    expect(resolveCanonicalVerb("pr:watch")).toBe("pr-watch");
  });

  it("routes a known verb through its handler and propagates the exit code", async () => {
    const handler = vi.fn(async (argv: string[]) => {
      expect(argv).toEqual(["--quiet", "--project-root", "/tmp/x"]);
      return 7;
    });
    vi.doMock("./verify-encoding.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const code = await dispatch(["verify-encoding", "--quiet", "--project-root", "/tmp/x"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(7);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("resolves task-style aliases to the canonical handler", async () => {
    expect(resolveCanonicalVerb("verify:encoding")).toBe("verify-encoding");
    const handler = vi.fn(() => 0);
    vi.doMock("./verify-encoding.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    await dispatch(["verify:encoding", "--help"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("routes wrapper CLI modules through core helpers", async () => {
    const runCapacityShowCli = vi.fn(() => ({
      exitCode: 3,
      stdout: "ok\n",
      stderr: "",
    }));
    vi.doMock("@deftai/directive-core/capacity", () => ({ runCapacityShowCli }));
    resetHandlerCacheForTests();

    const out: string[] = [];
    const code = await dispatch(["capacity-show", "--project-root", "."], {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: () => {},
    });
    expect(code).toBe(3);
    expect(out.join("")).toBe("ok\n");
    expect(runCapacityShowCli).toHaveBeenCalledWith(["--project-root", "."]);
  });

  it("routes core-only verbs such as scm", async () => {
    const main = vi.fn(() => 5);
    vi.doMock("@deftai/directive-core/dist/scm/main.js", () => ({ main }));
    resetHandlerCacheForTests();

    const code = await dispatch(["scm", "issue", "list"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(5);
    expect(main).toHaveBeenCalledWith(["issue", "list"]);
  });

  it("resolveCanonicalVerb returns null for unknown verbs", () => {
    expect(resolveCanonicalVerb("nope")).toBeNull();
    expect(resolveCanonicalVerb("verify-encoding")).toBe("verify-encoding");
    expect(resolveCanonicalVerb("scm")).toBe("scm");
  });

  it("loads review-monitor colon aliases to native CLI modules (#2814)", async () => {
    const reviewMonitorVerbs = [
      ["review-monitor:register", "review-monitor-register"],
      ["review-monitor:release", "review-monitor-release"],
      ["verify:review-monitor", "verify-review-monitor"],
      ["verify:l4-owner", "verify-l4-owner"],
    ] as const;
    for (const [alias, canonical] of reviewMonitorVerbs) {
      expect(resolveCanonicalVerb(alias)).toBe(canonical);
      expect(CLI_MODULE_VERBS).toContain(canonical);
      const code = await dispatch([alias, "--help"], {
        writeOut: () => {},
        writeErr: () => {},
      });
      expect(code, alias).toBe(0);
    }
  });

  it("resolves every task-style alias in VERB_ALIASES", () => {
    for (const [alias, canonical] of Object.entries(VERB_ALIASES)) {
      expect(resolveCanonicalVerb(alias)).toBe(canonical);
    }
  });

  it("registers all triage-actions colon aliases (#1888)", () => {
    for (const alias of Object.keys(TRIAGE_ACTION_ALIAS_SUBCOMMANDS)) {
      expect(resolveCanonicalVerb(alias)).toBe("triage-actions");
    }
    expect(resolveCanonicalVerb("triage:reset")).toBe("triage-actions");
    expect(resolveCanonicalVerb("triage:needs-ac")).toBe("triage-actions");
  });

  it("injects triage-actions subcommand for colon aliases (#1888)", async () => {
    const run = vi.fn(() => 0);
    vi.doMock("./triage-actions.js", () => ({ run }));
    resetHandlerCacheForTests();

    await dispatch(["triage:reset", "--issue", "1", "--repo", "deftai/directive"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(run).toHaveBeenCalledWith(["reset", "--issue", "1", "--repo", "deftai/directive"]);

    resetHandlerCacheForTests();
    vi.doMock("./triage-actions.js", () => ({ run }));

    await dispatch(["triage:needs-ac", "--issue", "2", "--repo", "deftai/directive"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(run).toHaveBeenCalledWith(["needs-ac", "--issue", "2", "--repo", "deftai/directive"]);

    resetHandlerCacheForTests();
    vi.doMock("./triage-actions.js", () => ({ run }));

    await dispatch(["triage:mark-duplicate", "--issue", "3", "--repo", "deftai/directive"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(run).toHaveBeenCalledWith([
      "mark-duplicate",
      "--issue",
      "3",
      "--repo",
      "deftai/directive",
    ]);
  });

  it("registers all policy colon aliases (#2367)", () => {
    for (const alias of Object.keys(POLICY_ACTION_ALIAS_SUBCOMMANDS)) {
      expect(resolveCanonicalVerb(alias)).toBe("policy");
    }
    expect(resolveCanonicalVerb("policy:show")).toBe("policy");
    expect(resolveCanonicalVerb("policy:enable-value-feedback")).toBe("policy");
  });

  it("injects policy subcommand for colon aliases (#2367)", async () => {
    const run = vi.fn(() => 0);
    vi.doMock("./policy.js", () => ({ run }));
    resetHandlerCacheForTests();

    await dispatch(["policy:show", "--field", "wipCap", "--project-root", "."], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(run).toHaveBeenCalledWith(["show", "--field", "wipCap", "--project-root", "."]);

    resetHandlerCacheForTests();
    vi.doMock("./policy.js", () => ({ run }));

    await dispatch(["policy:enable-value-feedback", "--project-root", "."], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(run).toHaveBeenCalledWith(["enable-value-feedback", "--project-root", "."]);
  });

  it("keeps policy colon aliases in sync with cli-router SUBCOMMAND_ROUTES (#2367)", () => {
    for (const [alias, subcommand] of Object.entries(POLICY_ACTION_ALIAS_SUBCOMMANDS)) {
      const routed = SUBCOMMAND_ROUTES[alias];
      expect(routed).toEqual(["policy", subcommand]);
    }
  });

  it("passes policy:show colon argv through routeArgv (#2367)", () => {
    const routed = routeArgv(["policy:show", "--field", "valueFeedback"]);
    expect(routed).toEqual({
      kind: "dispatch",
      argv: ["policy:show", "--field", "valueFeedback"],
    });
  });
});

// ---------------------------------------------------------------------------
// Native pack-migrate handlers (#2022 Phase 1).
//
// Fixture inputs + expected outputs below are byte-faithful captures of the
// prior scripts/pack_migrate_*.py contract for the same input (the expected
// strings were produced by running those scripts on these fixtures). The
// handlers must reproduce them exactly, including Python's
// json.dumps(..., indent=2, ensure_ascii=True) + "\n" serialization
// (note the \uXXXX-escaped em dash / RFC2119 glyphs in the bodies).
// ---------------------------------------------------------------------------

const AGENTS_MD =
  '# Fixture AGENTS\n\nIntro line.\n\n## Skill Routing\n\n- "alpha" / "first skill" \u2192 `content/skills/alpha/SKILL.md`\n- "task only" \u2192 run `task something`\n\n## Next Section\n\nDone.\n';
// REFERENCES.md Skills Index fixture (#2152). The alpha row lists index-only
// triggers so the frontmatter-preferred precedence is observable: alpha carries
// its own `triggers:` frontmatter list, so the pack keeps the frontmatter
// values, not these index values.
const REFERENCES_MD =
  "# Fixture References\n\n## \ud83e\udded Skills Index\n\n| Skill | Description | Triggers |\n|---|---|---|\n| [alpha](./content/skills/alpha/SKILL.md) | Alpha fixture skill. | `index-only`, `should-be-overridden` |\n\n## Next Section\n\nDone.\n";
const MAIN_MD =
  "# Fixture main\n\n- ! Always do the framework thing\n- regular bullet with no tier\n";
const SKILL_ALPHA =
  '---\nname: alpha\ndescription: >\n  First fixture skill.\n  Folded across two lines.\ntriggers:\n  - alpha\n  - first skill\nmetadata:\n  clawdbot:\n    requires:\n      bins: ["gh"]\n---\n\n# Alpha Skill\n\nBody with an em dash \u2014 and a \u2297 glyph.\n';
const SKILL_BETA =
  "This is a deprecated redirect stub with no YAML frontmatter.\n\nSee the other skill.\n";
const CODING_SAMPLE =
  "<!-- AUTO-GENERATED by task packs:render -- do not edit -->\n\n# Sample Coding Doc\n\n- ! Must do this\n- ~ Should do that\n- \u2297 Must not do the bad thing\n- \u2249 Should not do the other thing\n- ? May do this optionally\n- This bullet MUST be recognized by prose\n- plain bullet with no keyword\n";
const STRAT_GOOD =
  "# Good Strategy\n\nA normal strategy description paragraph.\n\n## Details\n\nMore content here.\n";
const STRAT_OLD =
  "# Old Strategy\n\n> This strategy has been superseded by Good Strategy.\n\nLegacy content.\n";
const PAT_MULTI =
  "# Multi-Agent Pattern\n\nThe proof pattern description.\n\n## Body\n\nCaptured body content.\n";
const PAT_OTHER = "# Other Pattern\n\nMetadata-only pattern (no captured body).\n";
const SWARM_DOC =
  "# Swarm Spec\n\nThe swarm specification description.\n\n## Section\n\nSpec body.\n";

const EXPECT_SKILLS =
  '{\n  "pack": "skills-pack-0.1",\n  "version": "0.1",\n  "generated_from": "skills/*/SKILL.md frontmatter triggers + REFERENCES.md (Skills Index)",\n  "skills": [\n    {\n      "id": "alpha",\n      "description": "First fixture skill. Folded across two lines.",\n      "triggers": [\n        "alpha",\n        "first skill"\n      ],\n      "path": "skills/alpha/SKILL.md",\n      "version": "0.1",\n      "body": "# Alpha Skill\\n\\nBody with an em dash \\u2014 and a \\u2297 glyph.\\n",\n      "frontmatter_extra": "triggers:\\n  - alpha\\n  - first skill\\nmetadata:\\n  clawdbot:\\n    requires:\\n      bins: [\\"gh\\"]"\n    }\n  ]\n}\n';
const EXPECT_RULES =
  '{\n  "pack": "rules-pack-0.1",\n  "version": "0.1",\n  "generated_from": "coding/*.md + AGENTS.md + main.md (marker-prefixed RFC2119 directives; AGENTS.md managed-section excluded; coding bodies rendered, AGENTS.md/main.md metadata-only)",\n  "rules": [\n    {\n      "id": "sample-001",\n      "tier": "MUST",\n      "domain": "sample",\n      "text": "Must do this",\n      "path": "coding/sample.md",\n      "body": "# Sample Coding Doc\\n\\n- ! Must do this\\n- ~ Should do that\\n- \\u2297 Must not do the bad thing\\n- \\u2249 Should not do the other thing\\n- ? May do this optionally\\n- This bullet MUST be recognized by prose\\n- plain bullet with no keyword\\n"\n    },\n    {\n      "id": "sample-002",\n      "tier": "SHOULD",\n      "domain": "sample",\n      "text": "Should do that",\n      "path": "coding/sample.md",\n      "body": null\n    },\n    {\n      "id": "sample-003",\n      "tier": "MUST_NOT",\n      "domain": "sample",\n      "text": "Must not do the bad thing",\n      "path": "coding/sample.md",\n      "body": null\n    },\n    {\n      "id": "sample-004",\n      "tier": "SHOULD_NOT",\n      "domain": "sample",\n      "text": "Should not do the other thing",\n      "path": "coding/sample.md",\n      "body": null\n    },\n    {\n      "id": "sample-005",\n      "tier": "MAY",\n      "domain": "sample",\n      "text": "May do this optionally",\n      "path": "coding/sample.md",\n      "body": null\n    },\n    {\n      "id": "sample-006",\n      "tier": "MUST",\n      "domain": "sample",\n      "text": "This bullet MUST be recognized by prose",\n      "path": "coding/sample.md",\n      "body": null\n    },\n    {\n      "id": "main-001",\n      "tier": "MUST",\n      "domain": "main",\n      "text": "Always do the framework thing",\n      "path": "main.md",\n      "body": null\n    }\n  ]\n}\n';
const EXPECT_STRATEGIES =
  '{\n  "pack": "strategies-pack-0.1",\n  "version": "0.1",\n  "generated_from": "strategies/*.md",\n  "strategies": [\n    {\n      "id": "good",\n      "title": "Good Strategy",\n      "description": "A normal strategy description paragraph.",\n      "triggers": [\n        "good"\n      ],\n      "path": "strategies/good.md",\n      "body": "# Good Strategy\\n\\nA normal strategy description paragraph.\\n\\n## Details\\n\\nMore content here.\\n"\n    },\n    {\n      "id": "old",\n      "title": "Old Strategy",\n      "description": "This strategy has been superseded by Good Strategy.",\n      "triggers": [\n        "old"\n      ],\n      "path": "strategies/old.md",\n      "body": null\n    }\n  ]\n}\n';
const EXPECT_PATTERNS =
  '{\n  "pack": "patterns-pack-0.1",\n  "version": "0.1",\n  "generated_from": "patterns/*.md",\n  "patterns": [\n    {\n      "id": "multi-agent",\n      "title": "Multi-Agent Pattern",\n      "description": "The proof pattern description.",\n      "triggers": [\n        "multi-agent"\n      ],\n      "path": "patterns/multi-agent.md",\n      "body": "# Multi-Agent Pattern\\n\\nThe proof pattern description.\\n\\n## Body\\n\\nCaptured body content.\\n"\n    },\n    {\n      "id": "other",\n      "title": "Other Pattern",\n      "description": "Metadata-only pattern (no captured body).",\n      "triggers": [\n        "other"\n      ],\n      "path": "patterns/other.md",\n      "body": null\n    }\n  ]\n}\n';
const EXPECT_SWARM =
  '{\n  "pack": "swarm-spec-pack-0.1",\n  "version": "0.1",\n  "generated_from": "swarm/*.md",\n  "entries": [\n    {\n      "id": "swarm",\n      "title": "Swarm Spec",\n      "description": "The swarm specification description.",\n      "triggers": [\n        "swarm"\n      ],\n      "path": "swarm/swarm.md",\n      "body": "# Swarm Spec\\n\\nThe swarm specification description.\\n\\n## Section\\n\\nSpec body.\\n"\n    }\n  ]\n}\n';

const PACK_MIGRATE_VERBS = [
  "pack-migrate-skills",
  "pack-migrate-rules",
  "pack-migrate-strategies",
  "pack-migrate-patterns",
  "pack-migrate-swarm-spec",
] as const;

describe("native pack-migrate handlers (#2022)", () => {
  let root: string;
  let skillsDir: string;
  let codingDir: string;
  let strategiesDir: string;
  let patternsDir: string;
  let swarmDir: string;
  let agentsMd: string;
  let referencesMd: string;
  let mainMd: string;

  function writeFixture(rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "deft-pack-migrate-"));
    writeFixture("AGENTS.md", AGENTS_MD);
    writeFixture("REFERENCES.md", REFERENCES_MD);
    writeFixture("main.md", MAIN_MD);
    writeFixture("content/skills/alpha/SKILL.md", SKILL_ALPHA);
    writeFixture("content/skills/beta/SKILL.md", SKILL_BETA);
    writeFixture("content/coding/sample.md", CODING_SAMPLE);
    writeFixture("content/strategies/good.md", STRAT_GOOD);
    writeFixture("content/strategies/old.md", STRAT_OLD);
    writeFixture("content/patterns/multi-agent.md", PAT_MULTI);
    writeFixture("content/patterns/other.md", PAT_OTHER);
    writeFixture("content/swarm/swarm.md", SWARM_DOC);
    skillsDir = join(root, "content/skills");
    codingDir = join(root, "content/coding");
    strategiesDir = join(root, "content/strategies");
    patternsDir = join(root, "content/patterns");
    swarmDir = join(root, "content/swarm");
    agentsMd = join(root, "AGENTS.md");
    referencesMd = join(root, "REFERENCES.md");
    mainMd = join(root, "main.md");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function runVerb(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(argv, {
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
    });
    return { code, out: out.join(""), err: err.join("") };
  }

  function argsFor(verb: (typeof PACK_MIGRATE_VERBS)[number], out: string): string[] {
    switch (verb) {
      case "pack-migrate-skills":
        return [verb, "--skills-dir", skillsDir, "--references-md", referencesMd, "--out", out];
      case "pack-migrate-rules":
        return [
          verb,
          "--coding-dir",
          codingDir,
          "--extra-source",
          agentsMd,
          "--extra-source",
          mainMd,
          "--out",
          out,
        ];
      case "pack-migrate-strategies":
        return [verb, "--strategies-dir", strategiesDir, "--out", out];
      case "pack-migrate-patterns":
        return [verb, "--patterns-dir", patternsDir, "--out", out];
      case "pack-migrate-swarm-spec":
        return [verb, "--swarm-dir", swarmDir, "--out", out];
    }
  }

  // a3: every pack-migrate verb is a registered core (TypeScript) handler.
  it("registers all five pack-migrate verbs as native core handlers", () => {
    for (const verb of PACK_MIGRATE_VERBS) {
      expect(CORE_MODULE_VERBS).toContain(verb);
      expect(resolveCanonicalVerb(verb)).toBe(verb);
    }
  });

  // a1 + a3: each verb dispatches to a native handler. The native handler emits
  // its summary through DispatchIo; the removed loadPythonScriptHandler route
  // used stdio:"inherit" and would never populate io.writeOut.
  it("routes every pack-migrate verb to a native handler (summary via DispatchIo)", async () => {
    for (const verb of PACK_MIGRATE_VERBS) {
      const out = join(root, `native-${verb}.json`);
      const result = await runVerb(argsFor(verb, out));
      expect(result.code, verb).toBe(0);
      expect(result.out, verb).toMatch(/^Migrated \d+ /);
      expect(result.err, verb).toBe("");
    }
  });

  // a2: emitted output matches the prior pack_migrate_*.py contract.
  it("pack-migrate-skills reproduces the python contract", async () => {
    const out = join(root, "skills.json");
    const result = await runVerb(argsFor("pack-migrate-skills", out));
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Migrated 1 skills (1 with body) -> ${out}\n`);
    expect(readFileSync(out, "utf8")).toBe(EXPECT_SKILLS);
  });

  it("pack-migrate-rules reproduces the python contract", async () => {
    const out = join(root, "rules.json");
    const result = await runVerb(argsFor("pack-migrate-rules", out));
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Migrated 7 rules (1 with body) -> ${out}\n`);
    expect(readFileSync(out, "utf8")).toBe(EXPECT_RULES);
  });

  it("pack-migrate-strategies reproduces the python contract", async () => {
    const out = join(root, "strategies.json");
    const result = await runVerb(argsFor("pack-migrate-strategies", out));
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Migrated 2 strategies (1 with body) -> ${out}\n`);
    expect(readFileSync(out, "utf8")).toBe(EXPECT_STRATEGIES);
  });

  it("pack-migrate-patterns reproduces the python contract", async () => {
    const out = join(root, "patterns.json");
    const result = await runVerb(argsFor("pack-migrate-patterns", out));
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Migrated 2 patterns (1 with body) -> ${out}\n`);
    expect(readFileSync(out, "utf8")).toBe(EXPECT_PATTERNS);
  });

  it("pack-migrate-swarm-spec reproduces the python contract", async () => {
    const out = join(root, "swarm-spec.json");
    const result = await runVerb(argsFor("pack-migrate-swarm-spec", out));
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Migrated 1 swarm-spec entries (1 with body) -> ${out}\n`);
    expect(readFileSync(out, "utf8")).toBe(EXPECT_SWARM);
  });

  it("reports a missing input directory with a non-zero exit", async () => {
    const out = join(root, "missing.json");
    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      join(root, "does-not-exist"),
      "--references-md",
      referencesMd,
      "--out",
      out,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("skills directory not found");
  });

  it("rejects an unrecognized argument with exit code 2", async () => {
    const result = await runVerb(["pack-migrate-patterns", "--nope", "x"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unrecognized argument");
  });

  it("reports a flag given without a value with exit code 2", async () => {
    const result = await runVerb(["pack-migrate-patterns", "--patterns-dir"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("expected one argument");
  });

  // Each non-skills verb has its own missing-directory guard.
  it("reports a missing input directory for every non-skills verb", async () => {
    const out = join(root, "missing-each.json");
    const cases: Array<[string, string, string]> = [
      ["pack-migrate-rules", "--coding-dir", "coding directory not found"],
      ["pack-migrate-strategies", "--strategies-dir", "strategies directory not found"],
      ["pack-migrate-patterns", "--patterns-dir", "patterns directory not found"],
      ["pack-migrate-swarm-spec", "--swarm-dir", "swarm directory not found"],
    ];
    for (const [verb, dirFlag, message] of cases) {
      const result = await runVerb([verb, dirFlag, join(root, "nope"), "--out", out]);
      expect(result.code, verb).toBe(1);
      expect(result.err, verb).toContain(message);
    }
  });

  it("reports a missing REFERENCES.md for pack-migrate-skills", async () => {
    const out = join(root, "missing-references.json");
    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      skillsDir,
      "--references-md",
      join(root, "no-references.md"),
      "--out",
      out,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("REFERENCES.md not found");
  });

  // Empty input directories produce an empty pack, which is an error for every verb.
  it("reports an empty pack with a non-zero exit for every verb", async () => {
    const emptySkills = join(root, "empty/skills");
    const emptyCoding = join(root, "empty/coding");
    const emptyStrategies = join(root, "empty/strategies");
    const emptyPatterns = join(root, "empty/patterns");
    const emptySwarm = join(root, "empty/swarm");
    for (const dir of [emptySkills, emptyCoding, emptyStrategies, emptyPatterns, emptySwarm]) {
      mkdirSync(dir, { recursive: true });
    }
    // A directive-free extra source keeps the rules verb hermetic (no default repo sources).
    writeFixture("empty/plain.md", "# Plain\n\nNo directives here.\n");
    const plain = join(root, "empty/plain.md");
    const out = join(root, "empty/out.json");

    const skills = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      emptySkills,
      "--references-md",
      referencesMd,
      "--out",
      out,
    ]);
    expect(skills.code).toBe(1);
    expect(skills.err).toContain("no skills with frontmatter");

    const rules = await runVerb([
      "pack-migrate-rules",
      "--coding-dir",
      emptyCoding,
      "--extra-source",
      plain,
      "--out",
      out,
    ]);
    expect(rules.code).toBe(1);
    expect(rules.err).toContain("no directives discovered");

    const strategies = await runVerb([
      "pack-migrate-strategies",
      "--strategies-dir",
      emptyStrategies,
      "--out",
      out,
    ]);
    expect(strategies.code).toBe(1);
    expect(strategies.err).toContain("no strategies discovered");

    const patterns = await runVerb([
      "pack-migrate-patterns",
      "--patterns-dir",
      emptyPatterns,
      "--out",
      out,
    ]);
    expect(patterns.code).toBe(1);
    expect(patterns.err).toContain("no patterns discovered");

    const swarm = await runVerb([
      "pack-migrate-swarm-spec",
      "--swarm-dir",
      emptySwarm,
      "--out",
      out,
    ]);
    expect(swarm.code).toBe(1);
    expect(swarm.err).toContain("no swarm-spec docs discovered");
  });

  // The argparse-compatible reader also accepts the `--flag=value` inline form.
  it("accepts the --flag=value inline form (skills)", async () => {
    const out = join(root, "inline-skills.json");
    const result = await runVerb([
      "pack-migrate-skills",
      `--skills-dir=${skillsDir}`,
      `--references-md=${referencesMd}`,
      `--out=${out}`,
    ]);
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(EXPECT_SKILLS);
  });

  // Parse a written pack and map entry id -> body, guarding against a non-object
  // / null JSON payload before any property access (JSON.parse can return null).
  function bodyById(jsonText: string, key: "skills" | "strategies"): Record<string, unknown> {
    const parsed: unknown = JSON.parse(jsonText);
    expect(parsed === null || typeof parsed !== "object").toBe(false);
    const entries = (parsed as Record<string, unknown>)[key];
    expect(Array.isArray(entries)).toBe(true);
    const rows = entries as Array<{ id: string; body: unknown }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.body]));
  }

  // Guard against a non-object / null JSON payload before any property access
  // (JSON.parse can return top-level null without throwing).
  function readSkillsPack(jsonText: string): {
    generated_from: string;
    skills: Array<{ id: string; triggers: string[] }>;
  } {
    const parsed: unknown = JSON.parse(jsonText);
    expect(parsed === null || typeof parsed !== "object").toBe(false);
    return parsed as { generated_from: string; skills: Array<{ id: string; triggers: string[] }> };
  }

  // --proof-skill captures only the named skill's body; the others are metadata-only.
  it("captures only the named proof skill body", async () => {
    writeFixture(
      "proof/skills/one/SKILL.md",
      "---\nname: one\ndescription: First.\n---\n\n# One\n\nBody one.\n",
    );
    writeFixture(
      "proof/skills/two/SKILL.md",
      "---\nname: two\ndescription: Second.\n---\n\n# Two\n\nBody two.\n",
    );
    const proofSkillsDir = join(root, "proof/skills");
    const out = join(root, "proof/skills.json");
    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      proofSkillsDir,
      "--references-md",
      referencesMd,
      "--proof-skill",
      "one",
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const byId = bodyById(readFileSync(out, "utf8"), "skills");
    expect(byId.one).not.toBeNull();
    expect(byId.two).toBeNull();
  });

  // #2152: the alpha fixture carries its own frontmatter `triggers:` list AND is
  // listed in the REFERENCES.md Skills Index with different (index-only) values.
  // The frontmatter contract wins, proving the two-tier precedence.
  it("prefers SKILL.md frontmatter triggers over the REFERENCES.md index (#2152)", async () => {
    const out = join(root, "precedence-skills.json");
    const result = await runVerb(argsFor("pack-migrate-skills", out));
    expect(result.code).toBe(0);
    const parsed = readSkillsPack(readFileSync(out, "utf8"));
    const alpha = parsed.skills.find((skill) => skill.id === "alpha");
    expect(alpha?.triggers).toEqual(["alpha", "first skill"]);
    expect(alpha?.triggers).not.toContain("index-only");
  });

  // #2152: a skill with no frontmatter triggers falls back to the REFERENCES.md
  // Skills Index. The builder never consults an AGENTS.md "## Skill Routing"
  // heading, so its removal by #838 cannot empty the trigger map.
  it("sources triggers from the REFERENCES.md Skills Index without a '## Skill Routing' heading (#2152)", async () => {
    const base = join(root, "src2152");
    writeFixture(
      "src2152/content/skills/gamma/SKILL.md",
      "---\nname: gamma\ndescription: Gamma skill with no frontmatter triggers.\n---\n\n# Gamma\n\nBody.\n",
    );
    writeFixture(
      "src2152/REFERENCES.md",
      "# Refs\n\n## Skills Index\n\n| Skill | Description | Triggers |\n|---|---|---|\n| [gamma](./content/skills/gamma/SKILL.md) | Gamma. | `gamma`, `route gamma` |\n\n## Next\n\nDone.\n",
    );
    const out = join(base, "out.json");
    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      join(base, "content/skills"),
      "--references-md",
      join(base, "REFERENCES.md"),
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const parsed = readSkillsPack(readFileSync(out, "utf8"));
    expect(parsed.generated_from).not.toContain("Skill Routing");
    expect(parsed.generated_from).not.toContain("AGENTS.md");
    const gamma = parsed.skills.find((skill) => skill.id === "gamma");
    expect(gamma?.triggers).toEqual(["gamma", "route gamma"]);
  });

  // #2152: an inline YAML flow-list `triggers:` field is parsed quote-aware, so
  // a quoted trigger containing a comma is one token, not two.
  it("parses inline flow-list frontmatter triggers with a comma inside quotes (#2152)", async () => {
    const base = join(root, "flowlist");
    writeFixture(
      "flowlist/content/skills/delta/SKILL.md",
      '---\nname: delta\ndescription: Delta with inline flow-list triggers.\ntriggers: ["what\'s next, please", plain]\n---\n\n# Delta\n\nBody.\n',
    );
    writeFixture(
      "flowlist/REFERENCES.md",
      "# Refs\n\n## Skills Index\n\n| Skill | Description | Triggers |\n|---|---|---|\n\n## Next\n\nDone.\n",
    );
    const out = join(base, "out.json");
    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      join(base, "content/skills"),
      "--references-md",
      join(base, "REFERENCES.md"),
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const parsed = readSkillsPack(readFileSync(out, "utf8"));
    const delta = parsed.skills.find((skill) => skill.id === "delta");
    expect(delta?.triggers).toEqual(["what's next, please", "plain"]);
  });

  // #2152 regression guard: building the skills pack from the *real* shipped
  // content must yield a non-empty trigger map for every skill. Before the fix
  // this silently returned empty triggers post-#838 (the "wired but
  // non-functional" failure the issue describes).
  it("yields a non-empty trigger map for every shipped skill from real content (#2152)", async () => {
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
    const out = join(root, "real-skills-pack.json");
    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      join(repoRoot, "content", "skills"),
      "--references-md",
      join(repoRoot, "REFERENCES.md"),
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const parsed = readSkillsPack(readFileSync(out, "utf8"));
    expect(parsed.skills.length).toBeGreaterThan(10);
    for (const skill of parsed.skills) {
      expect(skill.triggers.length, `skill ${skill.id} has empty triggers`).toBeGreaterThan(0);
    }
    expect(parsed.generated_from).not.toContain("Skill Routing");
  });

  // --proof-strategy switches body capture from "all non-redirect" to a single match.
  it("captures only the named proof strategy body", async () => {
    writeFixture(
      "ps/strategies/a.md",
      "# Alpha S\n\nAlpha description.\n\n## More\n\nAlpha body.\n",
    );
    writeFixture("ps/strategies/b.md", "# Beta S\n\nBeta description.\n\n## More\n\nBeta body.\n");
    const proofStrategiesDir = join(root, "ps/strategies");
    const out = join(root, "ps/strategies.json");
    const result = await runVerb([
      "pack-migrate-strategies",
      "--strategies-dir",
      proofStrategiesDir,
      "--proof-strategy",
      "strategies/a.md",
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const byId = bodyById(readFileSync(out, "utf8"), "strategies");
    expect(byId.a).not.toBeNull();
    expect(byId.b).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Native policy-set handler (#2022 Phase 1).
//
// Verifies the typed-policy write path (formerly scripts/policy_set.py shelled
// in via loadPythonScriptHandler) now routes to a native TypeScript handler:
// the typed field updates and an audit row is appended to
// meta/policy-changes.log, with output parity preserved.
// ---------------------------------------------------------------------------

describe("native policy-set handler (#2022)", () => {
  const itSymlink = it.skipIf(process.platform === "win32");
  let root: string;

  function projectDefPath(): string {
    return join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  }

  function auditLogPath(): string {
    return join(root, "meta", "policy-changes.log");
  }

  function readPolicyBlock(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readFileSync(projectDefPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("PROJECT-DEFINITION did not parse to an object");
    }
    const plan = (parsed as Record<string, unknown>).plan as Record<string, unknown> | undefined;
    // Assert ONLY the namespaced key: a regression that wrote the legacy bare
    // `plan.policy` must surface as an empty block here, not be masked (#1650).
    return (plan?.["x-directive/policy"] ?? {}) as Record<string, unknown>;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deft-policy-set-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [] },
    };
    writeFileSync(projectDefPath(), JSON.stringify(payload), "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function runPolicy(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(["policy-set", ...argv], {
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
    });
    return { code, out: out.join(""), err: err.join("") };
  }

  // a1: policy-set is a registered core (TypeScript) verb that routes to a
  // native handler -- the removed loadPythonScriptHandler route used
  // stdio:"inherit" and would never populate io.writeOut.
  it("registers policy-set as a native core handler", () => {
    expect(CORE_MODULE_VERBS).toContain("policy-set");
    expect(resolveCanonicalVerb("policy-set")).toBe("policy-set");
  });

  it("routes subagent-backends through the native handler (output via DispatchIo)", async () => {
    const result = await runPolicy(["subagent-backends", "--project-root", root]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("composer");
    expect(result.out).toContain("grok-build");
    expect(result.out).toContain("cursor-cloud");
    expect(result.out).toContain("leaf-implementation");
    expect(result.err).toBe("");
  });

  // a2 + a3: a typed field write updates the field AND appends an audit row.
  it("wip-cap writes the typed field and appends an audit row", async () => {
    const result = await runPolicy(["wip-cap", "--set", "5", "--confirm", "--project-root", root]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "\u2713 plan.policy.wipCap=5.\n" +
        "  audit: meta/policy-changes.log :: actor=deft policy set wip-cap wipCap=5 previous=None changed=true\n" +
        "[deft policy] plan.policy.wipCap=5 (source: typed).\n",
    );
    expect(readPolicyBlock().wipCap).toBe(5);
    expect(existsSync(auditLogPath())).toBe(true);
    expect(readFileSync(auditLogPath(), "utf8")).toContain("wipCap=5 previous=None");
  });

  it("wip-cap no-op does not append the audit log (#3528)", async () => {
    await runPolicy(["wip-cap", "--set", "5", "--confirm", "--project-root", root]);
    resetHandlerCacheForTests();
    const before = readFileSync(auditLogPath(), "utf8");
    const result = await runPolicy(["wip-cap", "--set", "5", "--confirm", "--project-root", root]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ledger unchanged");
    expect(readFileSync(auditLogPath(), "utf8")).toBe(before);
  });

  it("wip-cap honors --actor / --note in the audit row", async () => {
    const result = await runPolicy([
      "wip-cap",
      "--set",
      "3",
      "--confirm",
      "--actor",
      "tester",
      "--note",
      "freeze window",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    const log = readFileSync(auditLogPath(), "utf8");
    expect(log).toContain("actor=tester wipCap=3 previous=None note=freeze window");
  });

  it("wip-cap without --confirm refuses with the capability-cost disclosure", async () => {
    const result = await runPolicy(["wip-cap", "--set", "5", "--project-root", root]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Capability-cost disclosure");
    expect(result.out).toContain(
      "Re-run with --confirm to apply: deft policy set wip-cap -- --set 5",
    );
    // No write happened.
    expect("wipCap" in readPolicyBlock()).toBe(false);
    expect(existsSync(auditLogPath())).toBe(false);
  });

  it("wip-cap rejects a negative cap on stderr", async () => {
    const result = await runPolicy(["wip-cap", "--set", "-1", "--confirm", "--project-root", root]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--set must be >= 0; got -1.");
  });

  it("wip-cap accepts a whitespace-padded value (Python int() parity)", async () => {
    const result = await runPolicy([
      "wip-cap",
      "--set",
      " 7 ",
      "--confirm",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    expect(readPolicyBlock().wipCap).toBe(7);
  });

  it("subagent-backend writes the typed field and appends an audit row", async () => {
    const result = await runPolicy([
      "subagent-backend",
      "--set",
      "composer",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      "\u2713 plan.policy.swarmSubagentBackend=composer.\n" +
        "  audit: meta/policy-changes.log :: actor=deft policy set subagent-backend " +
        "swarmSubagentBackend=composer previous=None changed=true\n" +
        "[deft policy] plan.policy.swarmSubagentBackend='composer' (source: typed).\n",
    );
    expect(readPolicyBlock().swarmSubagentBackend).toBe("composer");
    expect(readFileSync(auditLogPath(), "utf8")).toContain("swarmSubagentBackend=composer");
  });

  it("subagent-backend rerun updates the stored value (changed audit row)", async () => {
    await runPolicy(["subagent-backend", "--set", "grok-build", "--project-root", root]);
    // dispatch caches the handler (bound to the first call's DispatchIo); reset so
    // the second invocation writes to a fresh capture buffer.
    resetHandlerCacheForTests();
    const result = await runPolicy([
      "subagent-backend",
      "--set",
      "composer",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    expect(readPolicyBlock().swarmSubagentBackend).toBe("composer");
    expect(result.out).toContain("swarmSubagentBackend=composer previous='grok-build'");
  });

  it("enforce-branches writes the typed flag false and audits", async () => {
    const result = await runPolicy([
      "enforce-branches",
      "--actor",
      "tester",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("branch-protection ON");
    expect(readPolicyBlock().allowDirectCommitsToMaster).toBe(false);
    expect(readFileSync(auditLogPath(), "utf8")).toContain("allowDirectCommitsToMaster=false");
  });

  it("allow-direct-commits with --confirm writes true and audits the note", async () => {
    const result = await runPolicy([
      "allow-direct-commits",
      "--confirm",
      "--note",
      "solo project",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("branch-protection OFF");
    expect(readPolicyBlock().allowDirectCommitsToMaster).toBe(true);
    expect(readFileSync(auditLogPath(), "utf8")).toContain("note=solo project");
  });

  it("allow-direct-commits without --confirm refuses", async () => {
    const result = await runPolicy(["allow-direct-commits", "--project-root", root]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Capability-cost disclosure");
    expect(result.out).toContain("--confirm");
    expect("allowDirectCommitsToMaster" in readPolicyBlock()).toBe(false);
  });

  it("subagent-backends --format json emits the catalog envelope", async () => {
    const result = await runPolicy([
      "subagent-backends",
      "--format",
      "json",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(result.out);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("subagent-backends --format json did not emit an object");
    }
    const payload = parsed as { backends: Array<Record<string, unknown>> };
    expect(payload.backends).toHaveLength(3);
    expect(payload.backends.every((row) => "id" in row && "roles" in row)).toBe(true);
    expect(payload.backends.map((row) => row.id).sort()).toEqual([
      "composer",
      "cursor-cloud",
      "grok-build",
    ]);
  });

  it("reports a missing PROJECT-DEFINITION as a config error with recovery", async () => {
    const empty = mkdtempSync(join(tmpdir(), "deft-policy-set-empty-"));
    try {
      const result = await runPolicy(["enforce-branches", "--project-root", empty]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("not found");
      expect(result.err).toContain("task setup");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reports a missing PROJECT-DEFINITION on the wip-cap write path", async () => {
    const empty = mkdtempSync(join(tmpdir(), "deft-policy-set-empty-"));
    try {
      const result = await runPolicy([
        "wip-cap",
        "--set",
        "2",
        "--confirm",
        "--project-root",
        empty,
      ]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("not found");
      expect(result.err).toContain("task setup");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("rejects a missing subcommand with exit code 2", async () => {
    const result = await runPolicy([]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("required: cmd");
  });

  it("rejects an unknown subcommand with exit code 2", async () => {
    const result = await runPolicy(["bogus", "--project-root", root]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("invalid choice: 'bogus'");
  });

  it("rejects an unrecognized flag with exit code 2", async () => {
    const result = await runPolicy(["wip-cap", "--nope", "x", "--project-root", root]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unrecognized arguments");
  });

  it("rejects a non-integer wip-cap value with exit code 2", async () => {
    const result = await runPolicy([
      "wip-cap",
      "--set",
      "abc",
      "--confirm",
      "--project-root",
      root,
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("invalid int value: 'abc'");
  });

  it("rejects an invalid subagent backend choice with exit code 2", async () => {
    const result = await runPolicy(["subagent-backend", "--set", "bogus", "--project-root", root]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("invalid choice: 'bogus'");
  });

  it("rejects a flag missing its value with exit code 2", async () => {
    const result = await runPolicy(["wip-cap", "--set"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("expected one argument");
  });

  it("requires --set for wip-cap with exit code 2", async () => {
    const result = await runPolicy(["wip-cap", "--confirm", "--project-root", root]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("required: --set");
  });

  itSymlink(
    "wip-cap refuses when PROJECT-DEFINITION is a symlink outside the project (#2847)",
    async () => {
      const escapeDir = mkdtempSync(join(tmpdir(), "deft-policy-wip-cap-victim-"));
      const victim = join(escapeDir, "PROJECT-DEFINITION.xbrief.json");
      writeFileSync(victim, readFileSync(projectDefPath(), "utf8"), "utf8");
      rmSync(projectDefPath());
      symlinkSync(victim, projectDefPath());

      const result = await runPolicy([
        "wip-cap",
        "--set",
        "5",
        "--confirm",
        "--project-root",
        root,
      ]);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/Config error:.*symlink/);
      expect(readPolicyBlock().wipCap).toBeUndefined();
      expect(readFileSync(victim, "utf8")).not.toContain('"wipCap": 5');
      rmSync(escapeDir, { recursive: true, force: true });
    },
  );

  itSymlink(
    "subagent-backend refuses when PROJECT-DEFINITION is a symlink outside the project (#2847)",
    async () => {
      const escapeDir = mkdtempSync(join(tmpdir(), "deft-policy-backend-victim-"));
      const victim = join(escapeDir, "PROJECT-DEFINITION.xbrief.json");
      writeFileSync(victim, readFileSync(projectDefPath(), "utf8"), "utf8");
      rmSync(projectDefPath());
      symlinkSync(victim, projectDefPath());

      const result = await runPolicy([
        "subagent-backend",
        "--set",
        "composer",
        "--project-root",
        root,
      ]);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/Config error:.*symlink/);
      expect(readPolicyBlock().swarmSubagentBackend).toBeUndefined();
      expect(readFileSync(victim, "utf8")).not.toContain('"swarmSubagentBackend"');
      rmSync(escapeDir, { recursive: true, force: true });
    },
  );
});

// ---------------------------------------------------------------------------
// Native setup:ghx handler (#2022 Phase 1).
//
// Verifies the consent-gated ghx installer (formerly scripts/setup_ghx.py)
// routes to a native TypeScript handler with default-deny consent.
// ---------------------------------------------------------------------------

describe("native setup:ghx handler (#2022)", () => {
  function captureIo(): {
    io: { writeOut: (t: string) => void; writeErr: (t: string) => void };
    out: string[];
    err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        writeOut: (t) => out.push(t),
        writeErr: (t) => err.push(t),
      },
      out,
      err,
    };
  }

  async function runSetup(argv: string[]): Promise<{
    code: number;
    out: string;
    err: string;
  }> {
    const { io, out, err } = captureIo();
    const code = await dispatch(["setup:ghx", ...argv], io);
    return { code, out: out.join(""), err: err.join("") };
  }

  it("registers setup:ghx as a native core handler", () => {
    expect(CORE_MODULE_VERBS).toContain("setup-ghx");
    expect(resolveCanonicalVerb("setup:ghx")).toBe("setup-ghx");
    expect(VERB_ALIASES["setup:ghx"]).toBe("setup-ghx");
  });

  it("skips install when ghx is already on PATH", async () => {
    const { io, out } = captureIo();
    const code = await runSetupGhx([], io, {
      whichFn: (name) => (name === "ghx" ? "/usr/local/bin/ghx" : null),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("ghx already on PATH");
  });

  it("--check nudges directive setup:ghx when gh is present but ghx is missing", async () => {
    const { io, out } = captureIo();
    const code = await runSetupGhx(["--check"], io, {
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("gh is on PATH but ghx is not");
    expect(out.join("")).toContain("directive setup:ghx");
  });

  it("declines install by default when consent is empty (default deny)", async () => {
    const { io, out } = captureIo();
    const code = await runSetupGhx([], io, {
      whichFn: () => null,
      readConsentLine: () => "\n",
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Skipping ghx install");
  });

  it("installs only when consent is explicitly yes", async () => {
    const { io, out } = captureIo();
    let installed = false;
    const code = await runSetupGhx([], io, {
      whichFn: () => null,
      readConsentLine: () => "yes\n",
      runInstall: () => {
        installed = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(installed).toBe(true);
    expect(out.join("")).toContain("ghx installed");
  });

  it("rejects --yes and --check together with exit code 2", async () => {
    const result = await runSetup(["--yes", "--check"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("mutually exclusive");
  });

  it("pins installer URLs to the immutable GHX_COMMIT_SHA, not a mutable tag", () => {
    expect(INSTALL_PS1_URL).toContain(`/${GHX_COMMIT_SHA}/`);
    expect(INSTALL_SH_URL).toContain(`/${GHX_COMMIT_SHA}/`);
    expect(GHX_COMMIT_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(INSTALL_PS1_URL).not.toContain(`/${GHX_VERSION}/`);
    expect(INSTALL_SH_URL).not.toContain(`/${GHX_VERSION}/`);
    expect(INSTALL_PS1_URL).not.toContain("/main/");
  });

  it("vendors 64-hex-char SHA-256 hashes for both installer scripts", () => {
    expect(GHX_INSTALL_SH_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(GHX_INSTALL_PS1_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // #2178: download-verify-execute pipeline -- no live `curl | bash` /
  // `irm | iex` pipe, no ExecutionPolicy Bypass, hash mismatch aborts before
  // any execution.
  // -------------------------------------------------------------------------

  describe("verifyGhxSha256", () => {
    it("matches case- and whitespace-insensitively", () => {
      const buf = Buffer.from("hello world");
      const expected = createHash("sha256").update(buf).digest("hex");
      expect(verifyGhxSha256(buf, expected.toUpperCase())).toBe(true);
      expect(verifyGhxSha256(buf, `  ${expected}\n`)).toBe(true);
    });

    it("rejects a mismatched hash", () => {
      const buf = Buffer.from("hello world");
      expect(verifyGhxSha256(buf, "0".repeat(64))).toBe(false);
    });
  });

  describe("fetchAndVerifyGhxInstaller / fetchAndVerifyGhxInstallerAsset", () => {
    it("hash mismatch aborts without writing or executing anything", async () => {
      const downloadFn = vi.fn(async () => Buffer.from("tampered content"));
      await expect(fetchAndVerifyGhxInstaller("linux", downloadFn)).rejects.toThrow(
        /SHA-256 mismatch/,
      );
      expect(downloadFn).toHaveBeenCalledWith(INSTALL_SH_URL);
    });

    it("happy path downloads, verifies against a matching hash, and writes a local temp file", async () => {
      const fixture = Buffer.from("#!/usr/bin/env bash\necho fixture installer\n");
      const fixtureHash = createHash("sha256").update(fixture).digest("hex");
      const downloadFn = vi.fn(async () => fixture);
      const asset: GhxInstallerAsset = {
        url: "https://example.invalid/install.sh",
        sha256: fixtureHash,
        fileExt: "sh",
      };
      const installerPath = await fetchAndVerifyGhxInstallerAsset(asset, downloadFn);
      try {
        expect(existsSync(installerPath)).toBe(true);
        expect(readFileSync(installerPath)).toEqual(fixture);
      } finally {
        rmSync(dirname(installerPath), { recursive: true, force: true });
      }
    });
  });

  describe("installVerifiedGhxAsset / installSetupGhx (download -> verify -> execute)", () => {
    it("executes the verified local temp file directly -- no pipe, no ExecutionPolicy Bypass", async () => {
      const fixture = Buffer.from("#!/usr/bin/env bash\necho fixture installer\n");
      const fixtureHash = createHash("sha256").update(fixture).digest("hex");
      const downloadFn = vi.fn(async () => fixture);
      const asset: GhxInstallerAsset = {
        url: "https://example.invalid/install.sh",
        sha256: fixtureHash,
        fileExt: "sh",
      };
      let capturedCmd: string | undefined;
      let capturedArgs: readonly string[] | undefined;
      let capturedPath: string | undefined;
      const runner = ((cmd: string, args: readonly string[]) => {
        capturedCmd = cmd;
        capturedArgs = args;
        capturedPath = args[args.length - 1];
        expect(capturedPath).toBeDefined();
        expect(existsSync(capturedPath as string)).toBe(true);
        return { status: 0 } as ReturnType<typeof spawnSync>;
      }) as typeof spawnSync;

      const code = await installVerifiedGhxAsset(asset, "linux", () => null, runner, downloadFn);

      expect(code).toBe(0);
      expect(capturedCmd).toBe("bash");
      expect(capturedArgs).toHaveLength(1);
      expect(capturedPath).not.toContain("|");
      // Temp file is cleaned up after execution.
      expect(existsSync(capturedPath as string)).toBe(false);
    });

    it("builds a Windows command with RemoteSigned, not Bypass, and no pipe", async () => {
      const fixture = Buffer.from("Write-Host 'fixture installer'\n");
      const fixtureHash = createHash("sha256").update(fixture).digest("hex");
      const downloadFn = vi.fn(async () => fixture);
      const asset: GhxInstallerAsset = {
        url: "https://example.invalid/install.ps1",
        sha256: fixtureHash,
        fileExt: "ps1",
      };
      let capturedArgs: readonly string[] | undefined;
      const runner = ((_cmd: string, args: readonly string[]) => {
        capturedArgs = args;
        return { status: 0 } as ReturnType<typeof spawnSync>;
      }) as typeof spawnSync;

      const code = await installVerifiedGhxAsset(asset, "windows", () => null, runner, downloadFn);

      expect(code).toBe(0);
      expect(capturedArgs).toContain("RemoteSigned");
      expect(capturedArgs).not.toContain("Bypass");
      expect(capturedArgs).toContain("-File");
      expect(capturedArgs?.join(" ")).not.toMatch(/irm|iex|Invoke-Expression/);
    });

    it("propagates a hash mismatch without invoking the runner", async () => {
      const downloadFn = vi.fn(async () => Buffer.from("tampered"));
      const runner = vi.fn();
      const asset: GhxInstallerAsset = {
        url: "https://example.invalid/install.sh",
        sha256: "0".repeat(64),
        fileExt: "sh",
      };
      await expect(
        installVerifiedGhxAsset(
          asset,
          "linux",
          () => null,
          runner as unknown as typeof spawnSync,
          downloadFn,
        ),
      ).rejects.toThrow(/SHA-256 mismatch/);
      expect(runner).not.toHaveBeenCalled();
    });
  });

  it("consent gate is checked before any download or execution", async () => {
    const { io, out } = captureIo();
    const downloadFn = vi.fn();
    const code = await runSetupGhx([], io, {
      whichFn: () => null,
      readConsentLine: () => "n\n",
      downloadFn,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Skipping ghx install");
    expect(downloadFn).not.toHaveBeenCalled();
  });
});

describe("directive bootstrap (#2022 Phase 4)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deft-bootstrap-"));
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function captureIo(): {
    io: { writeOut: (t: string) => void; writeErr: (t: string) => void };
    out: string[];
    err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        writeOut: (t) => out.push(t),
        writeErr: (t) => err.push(t),
      },
      out,
      err,
    };
  }

  it("deposits when .deft/core is absent and hands off to setup skill", async () => {
    rmSync(join(root, ".deft"), { recursive: true, force: true });
    const { io, out } = captureIo();
    let deposited = false;

    const code = await runDirectiveBootstrap(["--project-root", root], io, {
      deftCorePresent: () => false,
      userMdPresent: () => false,
      projectDefPresent: () => false,
      runInitDeposit: async () => {
        deposited = true;
        mkdirSync(join(root, ".deft", "core"), { recursive: true });
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(deposited).toBe(true);
    expect(out.join("")).toContain("hand off to deft-directive-setup");
    expect(out.join("")).toContain(SETUP_SKILL_REL_PATH);
    expect(out.join("")).toContain("phase: 1 (user)");
    expect(out.join("")).toContain("re_entry: none");
  });

  it("skips deposit when .deft/core already exists", async () => {
    const { io, out } = captureIo();
    let initCalled = false;

    const code = await runDirectiveBootstrap(["--project-root", root], io, {
      deftCorePresent: () => true,
      userMdPresent: () => false,
      projectDefPresent: () => false,
      runInitDeposit: async () => {
        initCalled = true;
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(initCalled).toBe(false);
    expect(out.join("")).toContain("deposited: false");
  });

  it("carries --project phase intent and reconfigure re-entry signal", async () => {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}\n", "utf8");
    const { io, out } = captureIo();

    const code = await runDirectiveBootstrap(
      ["--project-root", root, "--project", "--reconfigure"],
      io,
      {
        deftCorePresent: () => true,
        userMdPresent: () => true,
        projectDefPresent: () => true,
        runInitDeposit: async () => 0,
      },
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: 2 (project)");
    expect(out.join("")).toContain("re_entry: reconfigure");
  });

  it("carries --strategy phase intent and --force re-entry signal", async () => {
    const { io, out } = captureIo();

    const code = await runDirectiveBootstrap(
      ["--project-root", root, "--strategy", "interview", "--force"],
      io,
      {
        deftCorePresent: () => true,
        userMdPresent: () => true,
        projectDefPresent: () => true,
        runInitDeposit: async () => 0,
      },
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: 3 (spec)");
    expect(out.join("")).toContain("strategy: interview");
    expect(out.join("")).toContain("re_entry: force");
  });

  it("emits structured JSON handoff with --json", async () => {
    const { io, out } = captureIo();

    const code = await runDirectiveBootstrap(["--project-root", root, "--json"], io, {
      deftCorePresent: () => true,
      userMdPresent: () => false,
      projectDefPresent: () => false,
      runInitDeposit: async () => 0,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(out.join("")) as {
      handoff: string;
      skill_path: string;
      phase: number;
      re_entry: string;
    };
    expect(payload.handoff).toBe("deft-directive-setup");
    expect(payload.skill_path).toBe(SETUP_SKILL_REL_PATH);
    expect(payload.phase).toBe(1);
    expect(payload.re_entry).toBe("none");
  });

  it("parseDirectiveBootstrapArgs rejects unknown flags", () => {
    const parsed = parseDirectiveBootstrapArgs(["--nope"]);
    expect(parsed.error).toContain("unrecognized argument");
  });

  it("prints help and exits 0 for --help", async () => {
    const { io, out } = captureIo();
    const code = await runDirectiveBootstrap(["--help"], io, {
      deftCorePresent: () => true,
      userMdPresent: () => false,
      projectDefPresent: () => false,
      runInitDeposit: async () => 0,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Usage: directive bootstrap");
  });

  it("emits re_entry prompt when USER.md already exists at phase 1", async () => {
    const { io, out } = captureIo();
    const code = await runDirectiveBootstrap(["--project-root", root], io, {
      deftCorePresent: () => true,
      userMdPresent: () => true,
      projectDefPresent: () => true,
      runInitDeposit: async () => 0,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: 3 (spec)");
    expect(out.join("")).toContain("re_entry: prompt");
  });

  it("emits re_entry prompt when returning to an existing USER.md", async () => {
    const { io, out } = captureIo();
    const code = await runDirectiveBootstrap(["--project-root", root], io, {
      deftCorePresent: () => true,
      userMdPresent: () => true,
      projectDefPresent: () => false,
      runInitDeposit: async () => 0,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: 2 (project)");
    expect(out.join("")).toContain("re_entry: none");
  });

  it("returns exit code 2 when init deposit fails", async () => {
    rmSync(join(root, ".deft"), { recursive: true, force: true });
    const { io, err } = captureIo();
    const code = await runDirectiveBootstrap(["--project-root", root], io, {
      deftCorePresent: () => false,
      userMdPresent: () => false,
      projectDefPresent: () => false,
      runInitDeposit: async () => 1,
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe("");
  });

  it("routeAndDispatch routes top-level bootstrap without stub error", async () => {
    const { io, out, err } = captureIo();

    const code = await routeAndDispatch(["bootstrap", "--project-root", root], io);

    expect(code).toBe(0);
    expect(err.join("")).not.toContain("not yet implemented");
    expect(out.join("")).toContain(SETUP_SKILL_REL_PATH);
  });
});

describe("bootstrap USER.md resolution delegates to shared resolver (#2271)", () => {
  let root: string;
  let priorUserPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deft-bootstrap-usermd-"));
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    priorUserPath = process.env.DEFT_USER_PATH;
    delete process.env.DEFT_USER_PATH;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (priorUserPath === undefined) {
      delete process.env.DEFT_USER_PATH;
    } else {
      process.env.DEFT_USER_PATH = priorUserPath;
    }
  });

  function captureOut(): {
    io: { writeOut: (t: string) => void; writeErr: (t: string) => void };
    out: string[];
  } {
    const out: string[] = [];
    return {
      io: { writeOut: (t) => out.push(t), writeErr: () => {} },
      out,
    };
  }

  // Only override the non-USER.md deps so the DEFAULT userMdPresent (which
  // delegates to the shared resolver) is exercised end-to-end.
  const stubDeps = {
    deftCorePresent: () => true,
    projectDefPresent: () => false,
    runInitDeposit: async () => 0,
  };

  it("resolves a workspace-local .deft/USER.md with zero manual DEFT_USER_PATH (#2124 gap)", async () => {
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "USER.md"), "# prefs\n", "utf8");
    const { io, out } = captureOut();

    const code = await runDirectiveBootstrap(["--project-root", root], io, stubDeps);

    expect(code).toBe(0);
    // USER.md present + project definition absent -> phase 2 (project).
    expect(out.join("")).toContain("phase: 2 (project)");
  });

  it("honors DEFT_USER_PATH precedence when the override file exists", async () => {
    const override = join(root, "custom-USER.md");
    writeFileSync(override, "# prefs\n", "utf8");
    process.env.DEFT_USER_PATH = override;
    const { io, out } = captureOut();

    const code = await runDirectiveBootstrap(["--project-root", root], io, stubDeps);

    expect(code).toBe(0);
    expect(out.join("")).toContain("phase: 2 (project)");
  });

  it("treats a non-existent DEFT_USER_PATH override as absent (phase 1)", async () => {
    process.env.DEFT_USER_PATH = join(root, "does", "not", "exist", "USER.md");
    const { io, out } = captureOut();

    const code = await runDirectiveBootstrap(["--project-root", root], io, stubDeps);

    expect(code).toBe(0);
    // Override wins as the resolved path but the file is absent -> phase 1 (user).
    expect(out.join("")).toContain("phase: 1 (user)");
  });
});
