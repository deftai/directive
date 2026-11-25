import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scopeProvenance } from "@deftai/directive-core";
import { startUatLease } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHZ_AGENT_SHELL_ENV_MARKERS } from "./human-presence-mint.js";
import {
  isPathInsideRoot,
  normalizeAddPath,
  parseArgs,
  resolveApprovalXbriefRelPath,
  run,
} from "./scope-record-approved-scope.js";

function operatorSeams() {
  return {
    isTty: () => true,
    environ: {},
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => "mint",
  };
}

const taskAvailable = (() => {
  try {
    execSync("task --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("scope-record-approved-scope CLI (#3205)", () => {
  let root: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("parses required actor and path", () => {
    const a = parseArgs(["xbrief/active/s.xbrief.json", "--actor", "scott", "--kind", "human"]);
    expect(a.error).toBeUndefined();
    expect(a.actor).toBe("scott");
    expect(a.kind).toBe("human");
    expect(a.xbriefPath).toBe("xbrief/active/s.xbrief.json");
  });

  it("requires --repo value", () => {
    expect(parseArgs(["xbrief/active/s.xbrief.json", "--actor", "scott", "--repo"]).error).toMatch(
      /--repo/,
    );
  });

  it("parses --repo seed", () => {
    const a = parseArgs([
      "xbrief/active/s.xbrief.json",
      "--actor",
      "scott",
      "--repo",
      "deftai/directive",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.repo).toBe("deftai/directive");
  });

  it("requires --actor", () => {
    expect(parseArgs(["xbrief/active/s.xbrief.json"]).error).toMatch(/--actor/);
  });

  it("maps pending path to active binding", () => {
    expect(resolveApprovalXbriefRelPath("xbrief/pending/story.xbrief.json", ".")).toBe(
      "xbrief/active/story.xbrief.json",
    );
  });

  it("rejects absolute paths outside project root", () => {
    expect(resolveApprovalXbriefRelPath("C:/other/story.xbrief.json", "C:/proj")).toBeNull();
    expect(
      resolveApprovalXbriefRelPath("xbrief/active/s.xbrief.json", ".", "C:/abs/override.json"),
    ).toBeNull();
  });

  it("rejects in-root symlink whose target is outside project root", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-sym-"));
    const outside = mkdtempSync(join(tmpdir(), "scope-record-out-"));
    const outsideFile = join(outside, "evil.xbrief.json");
    writeFileSync(
      outsideFile,
      JSON.stringify({
        plan: { id: "evil", metadata: { swarm: { file_scope: ["src/x.ts"] } } },
      }),
      "utf8",
    );
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const linkPath = join(root, "xbrief/pending/story.xbrief.json");
    try {
      symlinkSync(outsideFile, linkPath);
    } catch {
      // Windows without symlink privilege: skip rather than fail the suite
      return;
    }
    expect(isPathInsideRoot(root, linkPath)).toBe(false);
    expect(resolveApprovalXbriefRelPath(linkPath, root)).toBeNull();
    const code = run([linkPath, "--project-root", root, "--actor", "scott"]);
    expect(code).toBe(2);
  });

  it("writes human approval digest and refuses agent stamps", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-1",
        status: "pending",
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
      },
    };
    const xb = join(root, "xbrief/pending/story.xbrief.json");
    writeFileSync(xb, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      printed.push(String(c));
      return true;
    });
    const code = run(
      ["xbrief/pending/story.xbrief.json", "--project-root", root, "--actor", "scott", "--confirm"],
      operatorSeams(),
    );
    expect(code).toBe(0);
    expect(printed.join("")).toMatch(/Read the preimage/);
    const out = join(root, ".deft/approved-scope/story-1.json");
    const rec = JSON.parse(readFileSync(out, "utf8")) as {
      xbriefRelPath: string;
      humanApproval: { actor: string; kind: string };
      fileScope: string[];
      xbriefBodyDigest?: string;
      intentDigest?: string;
      digestAlgo?: string;
    };
    expect(rec.xbriefRelPath).toBe("xbrief/active/story.xbrief.json");
    expect(rec.humanApproval.actor).toBe("scott");
    expect(rec.fileScope).toEqual(["src/a.ts"]);
    expect(rec.xbriefBodyDigest).toBeUndefined();
    expect(rec.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.digestAlgo).toBe("intent-extract-v1");
    const preimagePath = join(root, ".deft/approved-scope/story-1.intent.json");
    expect(existsSync(preimagePath)).toBe(true);
    const preimage = JSON.parse(readFileSync(preimagePath, "utf8")) as { algo: string };
    expect(preimage.algo).toBe("intent-extract-v1");
    expect(existsSync(join(root, ".deft/authz/grants"))).toBe(false);

    const agentCode = run(
      [
        "xbrief/pending/story.xbrief.json",
        "--project-root",
        root,
        "--actor",
        "agent:worker",
        "--kind",
        "agent",
        "--confirm",
      ],
      operatorSeams(),
    );
    expect(agentCode).toBe(1);
  });

  it("stamps authHashV1 of the bound brief path into the record (#6273)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-authhash-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-6273",
        status: "pending",
        items: [{ id: "a", title: "A", narrative: { Acceptance: "it works" } }],
        metadata: { swarm: { file_scope: ["src/a.ts", "src/a.test.ts"] } },
      },
    };
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      printed.push(String(c));
      return true;
    });
    const code = run(
      ["xbrief/pending/story.xbrief.json", "--project-root", root, "--actor", "scott", "--confirm"],
      operatorSeams(),
    );
    expect(code).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(root, ".deft/approved-scope/story-6273.json"), "utf8"),
    ) as { authHashV1?: string; xbriefRelPath: string };
    // Bound to the active path the record names, so the head brief must match it.
    const expected = scopeProvenance.computeAuthHashV1(payload, "xbrief/active/story.xbrief.json");
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rec.authHashV1).toBe(expected);
    expect(printed.join("")).toContain(`authHashV1: ${expected}`);
    // The one-PR hint no longer states a requireHumanMerge precondition (#6354).
    expect(printed.join("")).toContain(
      "At merge-base onePrScopeProof=mint, the pair may ride in the same PR",
    );
    expect(printed.join("")).not.toContain("with requireHumanMerge=true");
  });

  it("shared-gate refuse matrix for scope:record-approved-scope (#3384 / #7279)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-refuse-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const xb = join(root, "xbrief/pending/story.xbrief.json");
    writeFileSync(
      xb,
      `${JSON.stringify({
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      })}\n`,
      "utf8",
    );
    const argv = [
      "xbrief/pending/story.xbrief.json",
      "--project-root",
      root,
      "--actor",
      "Flynn",
      "--confirm",
    ];
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });

    // Under markers, harness-attended still refuses without an independent confirm surface.
    expect(
      run(argv, {
        ...operatorSeams(),
        environ: { CLAUDECODE: "1" },
        hasControllingTerminal: () => false,
      }),
    ).toBe(2);
    expect(
      run(argv, {
        ...operatorSeams(),
        environ: { CI: "true" },
        hasControllingTerminal: () => false,
      }),
    ).toBe(2);
    expect(run(argv, { ...operatorSeams(), isTty: () => false })).toBe(2);
    expect(run(argv, { ...operatorSeams(), hasControllingTerminal: () => false })).toBe(2);
    expect(run(argv, { ...operatorSeams(), readInteractiveConfirm: () => "yes" })).toBe(2);
    expect(
      run(
        ["xbrief/pending/story.xbrief.json", "--project-root", root, "--actor", "Flynn"],
        operatorSeams(),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(
      /agent|CI|TTY|--confirm|controlling terminal|phrase|mint|harness-attended/i,
    );
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
  });

  it("agent-shell markers with controlling-TTY phrase mint via harness-attended (#7279)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-ham-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      `${JSON.stringify({
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      })}\n`,
      "utf8",
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      run(
        [
          "xbrief/pending/story.xbrief.json",
          "--project-root",
          root,
          "--actor",
          "Flynn",
          "--confirm",
        ],
        { ...operatorSeams(), environ: { GROK_AGENT: "1" } },
      ),
    ).toBe(0);
    expect(existsSync(join(root, ".deft/approved-scope/story-1.json"))).toBe(true);
  });

  it("--actor Flynn from an agent shell without confirm surface cannot mint (#3384 / #7279)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-flynn-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      `${JSON.stringify({
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      })}\n`,
      "utf8",
    );
    for (const key of [
      "CLAUDECODE",
      "CI",
      "GITHUB_ACTIONS",
      "GROK_AGENT",
      "GROK_SESSION_ID",
    ] as const) {
      expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).toContain(key);
      expect(
        run(
          [
            "xbrief/pending/story.xbrief.json",
            "--project-root",
            root,
            "--actor",
            "Flynn",
            "--confirm",
          ],
          {
            ...operatorSeams(),
            environ: { [key]: "1" },
            hasControllingTerminal: () => false,
          },
        ),
      ).toBe(2);
    }
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
  });

  it("active UAT lease refuses mint with no TTY/confirm/phrase escape (#3384)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-uat-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      `${JSON.stringify({
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      })}\n`,
      "utf8",
    );
    startUatLease({ projectRoot: root, campaignId: "uat-3384", actor: "op" });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      run(
        [
          "xbrief/pending/story.xbrief.json",
          "--project-root",
          root,
          "--actor",
          "Flynn",
          "--confirm",
        ],
        operatorSeams(),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/UAT lease is ACTIVE/i);
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
    // Grant store may exist from UAT lease, but mint must not add a grant file.
    const grantsDir = join(root, ".deft/authz/grants");
    if (existsSync(grantsDir)) {
      expect(readdirSync(grantsDir).filter((n) => n.endsWith(".json"))).toEqual([]);
    }
  });

  it("swallows -- at any position on the help-advertised form (#4203)", () => {
    const advertised = ["--", "xbrief/active/s.xbrief.json", "--actor", "David", "--confirm"];
    const parsed = parseArgs(advertised);
    expect(parsed.error).toBeUndefined();
    expect(parsed.help).toBeUndefined();
    expect(parsed.xbriefPath).toBe("xbrief/active/s.xbrief.json");
    expect(parsed.actor).toBe("David");
    expect(parsed.confirm).toBe(true);
    expect(
      parseArgs(["xbrief/active/s.xbrief.json", "--", "--actor", "David", "--confirm"]),
    ).toEqual(parsed);
    expect(
      parseArgs(["xbrief/active/s.xbrief.json", "--actor", "David", "--confirm", "--"]),
    ).toEqual(parsed);
    expect(parseArgs(["xbrief/active/s.xbrief.json", "--actor", "David", "--confirm"])).toEqual(
      parsed,
    );
  });

  it("does not treat -- as an --actor or --kind value (#4203)", () => {
    const actorSep = parseArgs(["p.json", "--actor", "--", "David", "--confirm"]);
    expect(actorSep.error).toMatch(/--actor/);
    expect(actorSep.actor).not.toBe("--");
    expect(parseArgs(["p.json", "--actor=--", "--confirm"]).error).toMatch(/--actor/);
    const kindSep = parseArgs(["p.json", "--actor", "David", "--kind", "--"]);
    expect(kindSep.error).toMatch(/--kind/);
    expect(kindSep.kind).not.toBe("--");
    expect(parseArgs(["p.json", "--actor", "David", "--kind=--"]).error).toMatch(/--kind/);
  });

  it("unknown options still fail closed with or without -- (#4203)", () => {
    expect(parseArgs(["p.json", "--actor", "David", "--bogus"]).error).toMatch(
      /unrecognized argument: --bogus/,
    );
    expect(parseArgs(["--", "p.json", "--actor", "David", "--bogus"]).error).toMatch(
      /unrecognized argument: --bogus/,
    );
  });

  it("typed --help writes usage to stdout and exits 0 (#4203)", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(run(["--help"])).toBe(0);
    expect(run(["-h"])).toBe(0);
    expect(out.join("")).toMatch(/usage: scope:record-approved-scope -- /);
    expect(err.join("")).toBe("");
  });

  it("help-advertised refuse matrix and parse failure write no approval artifacts (#4203)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-sep-refuse-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const xb = join(root, "xbrief/pending/story.xbrief.json");
    writeFileSync(
      xb,
      `${JSON.stringify({
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      })}\n`,
      "utf8",
    );
    const advertised = [
      "--",
      "xbrief/pending/story.xbrief.json",
      "--project-root",
      root,
      "--actor",
      "Flynn",
      "--confirm",
    ];
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });

    expect(
      run(advertised, {
        ...operatorSeams(),
        environ: { CLAUDECODE: "1" },
        hasControllingTerminal: () => false,
      }),
    ).toBe(2);
    expect(
      run(advertised, {
        ...operatorSeams(),
        environ: { CI: "true" },
        hasControllingTerminal: () => false,
      }),
    ).toBe(2);
    expect(run(advertised, { ...operatorSeams(), isTty: () => false })).toBe(2);
    expect(run(advertised, { ...operatorSeams(), hasControllingTerminal: () => false })).toBe(2);
    expect(run(advertised, { ...operatorSeams(), readInteractiveConfirm: () => "yes" })).toBe(2);
    expect(
      run(
        ["--", "xbrief/pending/story.xbrief.json", "--project-root", root, "--actor", "Flynn"],
        operatorSeams(),
      ),
    ).toBe(2);
    expect(run(["--", "--bogus"], operatorSeams())).toBe(2);
    startUatLease({ projectRoot: root, campaignId: "uat-4203", actor: "op" });
    expect(run(advertised, operatorSeams())).toBe(2);
    expect(err.join("")).toMatch(
      /agent|CI|TTY|--confirm|controlling terminal|phrase|mint|harness-attended|unrecognized|UAT lease is ACTIVE/i,
    );
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
  });

  it("Taskfile ENGINE_CMD forwards CLI_ARGS without embedding -- (#4203)", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const scopeYml = readFileSync(join(repoRoot, "tasks/scope.yml"), "utf8");
    expect(scopeYml).toMatch(
      /ENGINE_CMD: 'scope:record-approved-scope \{\{\.CLI_ARGS\}\} --project-root/,
    );
    expect(scopeYml).not.toMatch(/scope:record-approved-scope -- \{\{\.CLI_ARGS\}\}/);
  });

  it.skipIf(!taskAvailable)("go-task strips -- before CLI_ARGS (#4203)", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-strip-4203-"));
    try {
      writeFileSync(
        join(dir, "echo-args.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
        "utf8",
      );
      writeFileSync(
        join(dir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  echo-args:",
          "    cmds:",
          "      - node echo-args.js {{.CLI_ARGS}}",
          "",
        ].join("\n"),
        "utf8",
      );
      const result = spawnSync(
        "task",
        ["--silent", "echo-args", "--", "a.json", "--actor", "David", "--confirm"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const line = result.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.startsWith("["));
      expect(line).toBeDefined();
      const forwarded = JSON.parse(line ?? "null") as string[];
      expect(forwarded).toEqual(["a.json", "--actor", "David", "--confirm"]);
      expect(forwarded).not.toContain("--");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses duplicate object keys at mint (#3385 F3)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-dup-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      '{"plan":{"id":"story-1","id":"other"}}\n',
      "utf8",
    );
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      run(
        [
          "xbrief/pending/story.xbrief.json",
          "--project-root",
          root,
          "--actor",
          "scott",
          "--confirm",
        ],
        operatorSeams(),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/duplicate key/);
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
  });
});

describe("scope-record-approved-scope --add-path widen (#6643)", () => {
  const BRIEF_REL = "xbrief/active/story.xbrief.json";
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(level?: "mint") {
    const bound = mkdtempSync(join(tmpdir(), "widen-bound-"));
    const checkout = mkdtempSync(join(tmpdir(), "widen-checkout-"));
    tmpDirs.push(bound, checkout);
    mkdirSync(join(bound, "xbrief", "active"), { recursive: true });
    const payload = {
      plan: {
        id: "github.issue.42",
        status: "running",
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
      },
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    writeFileSync(join(bound, BRIEF_REL), text, "utf8");
    const gitCalls: string[][] = [];
    const ghCalls: string[][] = [];
    const seams = {
      git: (cwd: string, args: string[]) => {
        gitCalls.push([cwd === bound ? "bound" : "tmp", ...args]);
        if (args[0] === "remote")
          return { status: 0, stdout: "https://example.test/o/r.git\n", stderr: "" };
        if (args[0] === "config") {
          const v = args[2] === "user.name" ? "Op Erator" : "op@example.test";
          return { status: 0, stdout: `${v}\n`, stderr: "" };
        }
        if (args[0] === "checkout" && args.includes("FETCH_HEAD")) {
          mkdirSync(join(checkout, "xbrief", "active"), { recursive: true });
          writeFileSync(join(checkout, BRIEF_REL), text, "utf8");
          if (level !== undefined) {
            writeFileSync(
              join(checkout, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
              JSON.stringify({ plan: { policy: { onePrScopeProof: level } } }),
              "utf8",
            );
          }
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      verifyBody: () => 0,
      gh: (_cwd: string, args: string[]) => {
        ghCalls.push(args);
        return { status: 0, stdout: "https://example.test/o/r/pull/9\n", stderr: "" };
      },
      makeTempDir: () => checkout,
      removeDir: (d: string) => rmSync(d, { recursive: true, force: true }),
    };
    return { bound, checkout, text, gitCalls, ghCalls, seams };
  }

  it("parses repeatable --add-path and rejects unsafe paths", () => {
    const a = parseArgs([BRIEF_REL, "--actor", "scott", "--add-path", "a/b.ts", "--add-path=c.ts"]);
    expect(a.addPaths).toEqual(["a/b.ts", "c.ts"]);
    expect(parseArgs([BRIEF_REL, "--actor", "s"]).addPaths).toEqual([]);
    expect(parseArgs([BRIEF_REL, "--actor", "s", "--add-path"]).error).toMatch(/--add-path/);
    expect(normalizeAddPath("../x")).toBeNull();
    expect(normalizeAddPath("/abs")).toBeNull();
    expect(normalizeAddPath("a\\b.ts")).toBe("a/b.ts");
  });

  it("opens a PR with the approval pair at mint level and leaves the bound worktree alone", () => {
    const { bound, checkout, text, gitCalls, ghCalls, seams } = setup("mint");
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    const code = run(
      [
        BRIEF_REL,
        "--project-root",
        bound,
        "--actor",
        "scott",
        "--confirm",
        "--add-path",
        "src/b.ts",
        "--add-path",
        "src/a.ts",
      ],
      operatorSeams(),
      seams,
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("https://example.test/o/r/pull/9");
    // Bound worktree: brief unchanged, no approval artifacts, no occupancy / binding.
    expect(readFileSync(join(bound, BRIEF_REL), "utf8")).toBe(text);
    expect(existsSync(join(bound, ".deft"))).toBe(false);
    // Commit holds only the brief, the record and the preimage.
    const add = gitCalls.find((c) => c[1] === "add");
    expect(add?.slice(-3)).toEqual([
      BRIEF_REL,
      ".deft/approved-scope/github.issue.42.json",
      ".deft/approved-scope/github.issue.42.intent.json",
    ]);
    expect(
      gitCalls.some(
        (c) =>
          c[1] === "push" && c.some((a) => a.startsWith("HEAD:refs/heads/widen/github.issue.42-")),
      ),
    ).toBe(true);
    expect(ghCalls[0]?.slice(0, 2)).toEqual(["pr", "create"]);
    // Temporary checkout removed.
    expect(existsSync(checkout)).toBe(false);
  });

  it("opens a brief-only PR at the default policy: no record, no preimage (#6643)", () => {
    const { bound, checkout, gitCalls, seams } = setup();
    let written = "";
    let hadDeft = true;
    const capture = {
      ...seams,
      git: (cwd: string, args: string[]) => {
        if (args[0] === "add") {
          written = readFileSync(join(checkout, BRIEF_REL), "utf8");
          hadDeft = existsSync(join(checkout, ".deft"));
        }
        return seams.git(cwd, args);
      },
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      run(
        [
          BRIEF_REL,
          "--project-root",
          bound,
          "--actor",
          "scott",
          "--confirm",
          "--add-path",
          "src/b.ts",
        ],
        operatorSeams(),
        capture,
      ),
    ).toBe(0);
    expect(gitCalls.find((c) => c[1] === "add")?.slice(2)).toEqual(["-f", "--", BRIEF_REL]);
    expect(hadDeft).toBe(false);
    const scope = (
      JSON.parse(written) as { plan: { metadata: { swarm: { file_scope: string[] } } } }
    ).plan.metadata.swarm.file_scope;
    expect(scope).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("fetches the fully qualified ref after --, uses a unique branch, and keeps git identity", () => {
    const { bound, gitCalls, seams } = setup();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const argv = [
      BRIEF_REL,
      "--project-root",
      bound,
      "--actor",
      "scott",
      "--confirm",
      "--add-path",
      "src/b.ts",
    ];
    expect(run(argv, operatorSeams(), seams)).toBe(0);
    const fetch = gitCalls.find((c) => c[1] === "fetch");
    expect(fetch?.slice(2)).toEqual(["--quiet", "--", "origin", "refs/heads/master"]);
    const commit = gitCalls.find((c) => c.includes("commit"));
    expect(commit?.slice(1, 5)).toEqual([
      "-c",
      "user.name=Op Erator",
      "-c",
      "user.email=op@example.test",
    ]);
    const branchOf = () =>
      gitCalls.filter((c) => c[1] === "checkout" && c[3] === "-b").map((c) => c[4]);
    const first = branchOf()[0];
    expect(first).toMatch(/^widen\/github\.issue\.42-[0-9a-z]+$/);
    for (const c of gitCalls.filter((x) => x[1] === "push")) {
      expect(c.slice(2, 4)).toEqual(["--quiet", "--"]);
    }
  });

  it("stops before gh pr create when the PR body check fails (#6643)", () => {
    const { bound, ghCalls, gitCalls, seams } = setup();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [
        BRIEF_REL,
        "--project-root",
        bound,
        "--actor",
        "scott",
        "--confirm",
        "--add-path",
        "src/b.ts",
      ],
      operatorSeams(),
      { ...seams, verifyBody: () => 1 },
    );
    expect(code).toBe(1);
    expect(ghCalls).toEqual([]);
    expect(gitCalls.some((c) => c[1] === "push")).toBe(false);
  });

  it("writes the widened file_scope once per path with existing entries kept", () => {
    const { bound, checkout, gitCalls, seams } = setup("mint");
    let written = "";
    const capture = {
      ...seams,
      git: (cwd: string, args: string[]) => {
        if (args[0] === "add") {
          written = readFileSync(join(checkout, BRIEF_REL), "utf8");
        }
        return seams.git(cwd, args);
      },
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      run(
        [
          BRIEF_REL,
          "--project-root",
          bound,
          "--actor",
          "scott",
          "--confirm",
          "--add-path",
          "src/b.ts",
          "--add-path",
          "src/a.ts",
        ],
        operatorSeams(),
        capture,
      ),
    ).toBe(0);
    const scope = (
      JSON.parse(written) as { plan: { metadata: { swarm: { file_scope: string[] } } } }
    ).plan.metadata.swarm.file_scope;
    expect(scope).toEqual([
      "src/a.ts",
      "src/b.ts",
      ".deft/approved-scope/github.issue.42.json",
      ".deft/approved-scope/github.issue.42.intent.json",
    ]);
    expect(gitCalls.length).toBeGreaterThan(0);
  });

  it("refuses from an agent shell without confirm surface before widen git/PR (#7279)", () => {
    const { bound, text, gitCalls, ghCalls, seams } = setup();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [
        BRIEF_REL,
        "--project-root",
        bound,
        "--actor",
        "scott",
        "--confirm",
        "--add-path",
        "src/b.ts",
      ],
      {
        ...operatorSeams(),
        environ: { CLAUDECODE: "1" },
        hasControllingTerminal: () => false,
      },
      seams,
    );
    expect(code).toBe(2);
    expect(gitCalls).toEqual([]);
    expect(ghCalls).toEqual([]);
    expect(readFileSync(join(bound, BRIEF_REL), "utf8")).toBe(text);
  });

  it("rejects an unsafe --add-path before any git call", () => {
    const { bound, gitCalls, seams } = setup();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [BRIEF_REL, "--project-root", bound, "--actor", "scott", "--confirm", "--add-path", "../x"],
      operatorSeams(),
      seams,
    );
    expect(code).toBe(2);
    expect(gitCalls).toEqual([]);
  });

  it("a real widen commit at mint is admitted by the real evaluateScopeProvenance (#6643)", () => {
    const base = mkdtempSync(join(tmpdir(), "widen-real-"));
    tmpDirs.push(base);
    const sh = (cwd: string, args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const remote = join(base, "remote.git");
    const work = join(base, "work");
    const verify = join(base, "verify");
    mkdirSync(remote);
    mkdirSync(work);
    sh(remote, ["init", "-q", "--bare", "-b", "master"]);
    sh(work, ["init", "-q", "-b", "master"]);
    sh(work, ["config", "user.name", "Op Erator"]);
    sh(work, ["config", "user.email", "op@example.test"]);
    const writeAt = (rel: string, body: string): void => {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), body, "utf8");
    };
    const projectDefinition = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        "x-directive/policy": { onePrScopeProof: "mint", requireHumanMerge: true },
      },
    };
    writeAt(
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      `${JSON.stringify(projectDefinition, null, 2)}\n`,
    );
    const brief = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "github.issue.42",
        title: "Story",
        status: "running",
        items: [{ id: "a", title: "A", status: "pending", narrative: { Acceptance: "it works" } }],
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
      },
    };
    writeAt(BRIEF_REL, `${JSON.stringify(brief, null, 2)}\n`);
    writeAt("src/a.ts", "export const a = 1;\n");
    sh(work, ["add", "-A"]);
    sh(work, ["commit", "-q", "-m", "base"]);
    sh(work, ["remote", "add", "origin", remote]);
    sh(work, ["push", "-q", "origin", "master"]);

    const ghArgs: string[][] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [
        BRIEF_REL,
        "--project-root",
        work,
        "--actor",
        "scott",
        "--confirm",
        "--add-path",
        "src/b.ts",
      ],
      operatorSeams(),
      {
        // Only gh is stubbed: the real git and the real PR body check both run.
        gh: (_cwd: string, args: string[]) => {
          ghArgs.push(args);
          return { status: 0, stdout: "https://example.test/pull/1\n", stderr: "" };
        },
      },
    );
    expect(code).toBe(0);
    expect(ghArgs[0]?.slice(0, 2)).toEqual(["pr", "create"]);

    const pushed = sh(remote, ["branch", "--list", "widen/*"])
      .trim()
      .replace(/^\*?\s*/, "");
    expect(pushed).toMatch(/^widen\/github\.issue\.42-/);
    sh(base, ["clone", "-q", remote, verify]);
    sh(verify, ["checkout", "-q", pushed]);
    const changed = sh(verify, ["diff", "--name-only", "origin/master...HEAD"])
      .split("\n")
      .filter((l) => l.length > 0)
      .sort();
    expect(changed).toEqual([
      ".deft/approved-scope/github.issue.42.intent.json",
      ".deft/approved-scope/github.issue.42.json",
      BRIEF_REL,
    ]);
    const result = scopeProvenance.evaluateScopeProvenance(verify, { baseRef: "origin/master" });
    expect(result.exitCode, result.message).toBe(0);
    expect(result.mintLevelAdmits ?? []).toHaveLength(1);
    // The bound worktree stays untouched.
    expect(sh(work, ["status", "--short"]).trim()).toBe("");
  }, 60_000);
});
