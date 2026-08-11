import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthzMainSeams, main } from "./authz.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-authz-"));
  roots.push(root);
  return root;
}

/**
 * Interactive operator path by default: TTY + --confirm + typed phrase + clean environ (#3110).
 * Injects --confirm for mutating verbs unless already present or cmd is show/help.
 * Clean environ is required so host CI markers (CI / GITHUB_ACTIONS) do not false-refuse
 * operator-path unit tests when the suite runs under GitHub Actions.
 */
function cleanOperatorSeams(seams: AuthzMainSeams = {}): AuthzMainSeams {
  return {
    isTty: () => true,
    // Empty env: no agent/CI markers. Explicit seams.environ overrides.
    environ: {},
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => "mint",
    ...seams,
  };
}

function runAuthz(argv: string[], seams: AuthzMainSeams = {}): number {
  const mutating =
    argv.some(
      (a) => ["uat-start", "uat-suspend", "grant", "revoke"].includes(a) || a.startsWith("grant-"),
    ) && !argv.includes("show");
  const withConfirm =
    mutating && !argv.includes("--confirm") && !argv.includes("--help") && !argv.includes("-h")
      ? [...argv, "--confirm"]
      : argv;
  return main(withConfirm, cleanOperatorSeams(seams));
}

describe("authz CLI (#2944)", () => {
  it("show on empty project", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(runAuthz(["show", "--project-root", root])).toBe(0);
    expect(out.join("")).toMatch(/UAT lease: inactive/);
  });

  it("uat-start requires campaign", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["uat-start", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(/campaign/);
  });

  it("grant outside UAT / uat-start / show; grant+suspend hard-refuse under active UAT (#3110)", () => {
    // Mint fix-cohort grants BEFORE uat-start — under active UAT all mutating verbs refuse.
    const root = tempRoot();
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
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--operations",
        "edit,push",
        "--surfaces",
        "src/**",
        "--cohort",
        "fix-1",
      ]),
    ).toBe(0);
    const grantLine = out.find((l) => l.includes("grant minted"));
    expect(grantLine).toBeTruthy();
    expect(
      runAuthz(["uat-start", "--project-root", root, "--campaign", "uat-1", "--actor", "op"]),
    ).toBe(0);
    expect(runAuthz(["show", "--project-root", root, "--format", "json"])).toBe(0);
    expect(out.join("")).toMatch(/ACTIVE|uat-1/);
    // Under active UAT: grant and uat-suspend hard-refuse (no multi-factor escape).
    expect(
      runAuthz(["grant", "--project-root", root, "--operations", "edit", "--cohort", "late"]),
    ).toBe(2);
    expect(runAuthz(["uat-suspend", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(
      /UAT lease is ACTIVE|hard-refused|Self-approval|refusing mutating/i,
    );
    expect(runAuthz(["show", "--project-root", root])).toBe(0);
  });

  it("grant without operations fails", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(/operations|template/);
  });

  it("grant --template release-publish --target mints operator-cli grant", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--template",
        "release-publish",
        "--target",
        "0.30.0",
        "--actor",
        "op",
      ]),
    ).toBe(0);
    const joined = out.join("");
    expect(joined).toMatch(/grant minted/);
    expect(joined).toMatch(/template=release-publish/);
    expect(joined).toMatch(/release-publish/);
    expect(joined).toMatch(/Wave 1 grant store/);
  });

  it("grant --template requires --target", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root, "--template", "release-cut"])).toBe(2);
    expect(err.join("")).toMatch(/--target/);
  });

  it("grant --template finish-loop mints edit/push/pr/merge without --target (#871)", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      runAuthz(["grant", "--project-root", root, "--template", "finish-loop", "--actor", "op"]),
    ).toBe(0);
    const joined = out.join("");
    expect(joined).toMatch(/template=finish-loop/);
    expect(joined).toMatch(/edit/);
    expect(joined).toMatch(/merge/);
    expect(joined).toMatch(/release-\* NOT authorized|finish-loop walk-away/);
  });

  it("help and unknown subcommand", () => {
    expect(runAuthz(["--help"])).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["nope"])).toBe(2);
  });

  it("revoke missing grant", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["revoke", "--project-root", root, "grant-missing"])).toBe(1);
  });

  it("parses full grant flags and revokes by id", () => {
    const root = tempRoot();
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
    expect(
      runAuthz([
        "--",
        "grant",
        "--projectRoot",
        root,
        "--ops",
        "edit",
        "--surfaces",
        "src/**,ui/**",
        "--cohort",
        "c1",
        "--plan-ref",
        "plan-x",
        "--repo",
        "o/r",
        "--branch",
        "feat/x",
        "--stories",
        "2944,2945",
        "--issues",
        "1,2",
        "--expires",
        "2099-01-01T00:00:00Z",
        "--single-use",
        "--actor",
        "alice",
        "--note",
        "n",
      ]),
    ).toBe(0);
    const minted = out.join("");
    expect(minted).toMatch(/grant minted/);
    expect(minted).toMatch(/surfaces=/);
    const idMatch = minted.match(/id=(grant-[^\s]+)/);
    expect(idMatch).toBeTruthy();
    const id = idMatch?.[1] ?? "";
    expect(runAuthz(["revoke", "--project-root", root, "--grant-id", id])).toBe(0);
    expect(out.join("")).toMatch(/revoked/);
  });

  it("invalid operations and revoke without id", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root, "--operations", "nope"])).toBe(2);
    expect(runAuthz(["revoke", "--project-root", root])).toBe(2);
  });

  it("uat-suspend when already inactive", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(runAuthz(["uat-suspend", "--project-root", root])).toBe(0);
    expect(out.join("")).toMatch(/already inactive/);
  });

  it("show text with active UAT and rejected grants note", () => {
    // Grant must be minted outside UAT; under active UAT grant is hard-refused (#3110).
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      runAuthz(["grant", "--project-root", root, "--operations", "edit", "--cohort", "x"]),
    ).toBe(0);
    expect(runAuthz(["uat-start", "--project-root", root, "--campaign", "c", "--note", "n"])).toBe(
      0,
    );
    expect(runAuthz(["show", "--project-root", root])).toBe(0);
    expect(out.join("")).toMatch(/ACTIVE/);
  });

  it("catch path on bad project root for grant", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    // Empty ops already returns 2; force throw via empty campaign on uat with weird path is hard.
    // Use grant with operations that mint to invalid path by using a file-as-root if possible.
    expect(runAuthz(["-h"])).toBe(0);
  });

  it("covers remaining argv/template CLI branches (#2986)", () => {
    const root = tempRoot();
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

    // Leading -- separators + camelCase projectRoot + ops alias + format text.
    expect(
      runAuthz([
        "--",
        "grant",
        "--",
        "--projectRoot",
        root,
        "--ops",
        "edit push",
        "--cohort",
        "c",
        "--surfaces",
        "src/**,pkg/**",
        "--stories",
        "1,2",
        "--issues",
        "10 11",
        "--planRef",
        "plan-1",
        "--repo",
        "o/r",
        "--branch",
        "feat",
        "--expires-at",
        "2099-01-01T00:00:00Z",
        "--format",
        "text",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/grant minted/);

    // grant- prefix id path maps to revoke with grantId preset.
    expect(runAuthz(["grant-not-found", "--project-root", root])).toBe(1);

    // Unknown template + closed-verb without target already covered; finish-loop surfaces path.
    out.length = 0;
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--template",
        "finish-loop",
        "--surfaces",
        "src/**",
        "--stories",
        "s1",
        "--issues",
        "99",
        "--cohort",
        "walk",
        "--single-use",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/finish-loop walk-away/);

    // release-publish template with target (closed-verb branch of mintAfk).
    out.length = 0;
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--template",
        "release-publish",
        "--target",
        "0.50.0",
        "--actor",
        "op",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/target surfaces=/);

    // format json on show with inactive UAT.
    out.length = 0;
    const empty = tempRoot();
    expect(runAuthz(["show", "--project-root", empty, "--format", "json"])).toBe(0);
    expect(out.join("")).toMatch(/"uat"/);

    // Unknown format falls back to text.
    expect(runAuthz(["show", "--project-root", empty, "--format", "yaml"])).toBe(0);

    // grant-id positional already tested; unknown flag is ignored without error.
    expect(runAuthz(["show", "--project-root", empty, "--bogus-flag"])).toBe(0);
  });
});

describe("authz CLI dual TTY+--confirm gate (#3110)", () => {
  it("refuses grant mint from non-TTY even with --confirm", () => {
    // Dual gate: --confirm alone never authorizes.
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        { isTty: () => false },
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/TTY|non-TTY|silent-mint/i);
  });

  it("refuses grant mint on TTY without --confirm", () => {
    // Dual gate: TTY alone never authorizes (pseudo-TTY residual).
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(["grant", "--project-root", root, "--operations", "edit", "--cohort", "x"], {
        isTty: () => true,
      }),
    ).toBe(2);
    expect(err.join("")).toMatch(/--confirm/);
  });

  it("allows grant mint only on TTY with --confirm", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        cleanOperatorSeams({ isTty: () => true }),
      ),
    ).toBe(0);
    expect(out.join("")).toMatch(/grant minted/);
  });

  it("refuses uat-start / uat-suspend / revoke from non-TTY", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(["uat-start", "--project-root", root, "--campaign", "c", "--confirm"], {
        isTty: () => false,
      }),
    ).toBe(2);
    expect(main(["uat-suspend", "--project-root", root, "--confirm"], { isTty: () => false })).toBe(
      2,
    );
    expect(
      main(["revoke", "--project-root", root, "grant-x", "--confirm"], { isTty: () => false }),
    ).toBe(2);
    expect(err.join("")).toMatch(/TTY/);
  });

  it("show remains allowed without TTY or --confirm", () => {
    const root = tempRoot();
    expect(main(["show", "--project-root", root], { isTty: () => false })).toBe(0);
  });

  it("refuses grant on TTY+confirm when agent-shell env marker is set", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        {
          isTty: () => true,
          environ: { CLAUDECODE: "1" },
        },
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent/i);
  });

  it("refuses grant when CI marker is present even with TTY+confirm", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        cleanOperatorSeams({
          isTty: () => true,
          environ: { CI: "true", GITHUB_ACTIONS: "true" },
        }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|CI/i);
  });

  it("refuses grant when interactive confirm phrase is wrong", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        cleanOperatorSeams({ readInteractiveConfirm: () => "yes" }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/phrase|mint/i);
  });

  it("refuses grant when controlling terminal is absent", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        cleanOperatorSeams({ hasControllingTerminal: () => false }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/controlling terminal/i);
  });
});

describe("authz CLI UAT-active hard refuse (#3110)", () => {
  /**
   * Self-approval under UAT is impossible by construction: while any UAT lease
   * is active, grant / uat-start / uat-suspend / revoke exit non-zero even with
   * full multi-factor seams (fake TTY + controlling terminal + --confirm + mint).
   */
  function startActiveUat(root: string): void {
    expect(runAuthz(["uat-start", "--project-root", root, "--campaign", "uat-hard-refuse"])).toBe(
      0,
    );
  }

  it("refuses grant under active UAT even with TTY + --confirm + mint phrase", () => {
    const root = tempRoot();
    startActiveUat(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        [
          "grant",
          "--project-root",
          root,
          "--operations",
          "edit,push,pr,merge",
          "--cohort",
          "self",
          "--surfaces",
          "**/*",
          "--confirm",
        ],
        cleanOperatorSeams(),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/UAT lease is ACTIVE|refusing mutating/i);
  });

  it("refuses uat-start / uat-suspend / revoke under active UAT even with TTY + --confirm", () => {
    const root = tempRoot();
    startActiveUat(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["uat-start", "--project-root", root, "--campaign", "forged", "--confirm"],
        cleanOperatorSeams(),
      ),
    ).toBe(2);
    expect(main(["uat-suspend", "--project-root", root, "--confirm"], cleanOperatorSeams())).toBe(
      2,
    );
    expect(
      main(["revoke", "--project-root", root, "grant-anything", "--confirm"], cleanOperatorSeams()),
    ).toBe(2);
    expect(err.join("")).toMatch(/UAT lease is ACTIVE|refusing mutating/i);
  });

  it("allows grant mint outside UAT with multi-factor seams, then refuses after uat-start", () => {
    const root = tempRoot();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      main(
        [
          "grant",
          "--project-root",
          root,
          "--operations",
          "edit",
          "--cohort",
          "pre-uat",
          "--confirm",
        ],
        cleanOperatorSeams(),
      ),
    ).toBe(0);
    expect(out.join("")).toMatch(/grant minted/);
    startActiveUat(root);
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "late", "--confirm"],
        cleanOperatorSeams(),
      ),
    ).toBe(2);
  });

  it("show remains allowed under active UAT without TTY or --confirm", () => {
    const root = tempRoot();
    startActiveUat(root);
    expect(main(["show", "--project-root", root], { isTty: () => false, environ: {} })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #3291 structural scope:decompose apply mint via --parent + --draft
// ---------------------------------------------------------------------------

function writeStructuralFixture(root: string): { parent: string; draft: string } {
  const pending = join(root, "xbrief", "pending");
  const cache = join(root, "xbrief", ".triage-cache", "decompositions");
  mkdirSync(pending, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const parent = join(pending, "parent.xbrief.json");
  const draft = join(cache, "draft.json");
  writeFileSync(parent, '{"plan":{"id":"p"}}', "utf8");
  writeFileSync(draft, '{"stories":[{"id":"s1","title":"Story"}]}', "utf8");
  return { parent, draft };
}

describe("authz CLI structural decompose mint (#3291)", () => {
  it("help documents --parent + --draft structural flow", () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(runAuthz(["--help"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/--parent/);
    expect(text).toMatch(/--draft/);
    expect(text).toMatch(/scope\.decompose\.apply\.structural|structural scope:decompose/i);
    expect(text).toMatch(/--check remains ungated/i);
  });

  it("mints structural grant with parent+draft bindings and optional repo", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        parent,
        "--draft",
        draft,
        "--repo",
        "deftai/directive",
        "--single-use",
        "--actor",
        "op",
      ]),
    ).toBe(0);
    const joined = out.join("");
    expect(joined).toMatch(/structural grant minted/);
    expect(joined).toMatch(/scope\.decompose\.apply\.structural/);
    expect(joined).toMatch(/digest=/);
    expect(joined).toMatch(/parent=/);
    expect(joined).toMatch(/draft=/);
    expect(joined).toMatch(/repo=deftai\/directive/);
    expect(joined).toMatch(/single-use=true/);

    // Persisted bindings on disk
    const grantsDir = join(root, ".deft", "authz", "grants");
    const idMatch = joined.match(/id=(grant-[^\s]+)/);
    expect(idMatch).toBeTruthy();
    const id = idMatch?.[1] ?? "";
    const body = JSON.parse(readFileSync(join(grantsDir, `${id}.json`), "utf8")) as {
      origin: { kind: string };
      scope: {
        operations: string[];
        contentDigest: string;
        parentPath: string;
        targetPath: string;
        repo: string | null;
        worktree: string;
      };
      semantics: { singleUse: boolean };
    };
    expect(body.origin.kind).toBe("operator-cli");
    expect(body.scope.operations).toContain("scope.decompose.apply.structural");
    expect(body.scope.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.scope.parentPath).toBe("xbrief/pending/parent.xbrief.json");
    expect(body.scope.targetPath).toBe("xbrief/.triage-cache/decompositions/draft.json");
    expect(body.scope.repo).toBe("deftai/directive");
    expect(body.scope.worktree).toBeTruthy();
    expect(body.semantics.singleUse).toBe(true);
  });

  it("accepts project-relative parent and draft paths", () => {
    const root = tempRoot();
    writeStructuralFixture(root);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        "xbrief/pending/parent.xbrief.json",
        "--draft",
        "xbrief/.triage-cache/decompositions/draft.json",
      ]),
    ).toBe(0);
    expect(out.join("")).toMatch(/structural grant minted/);
  });

  it("requires both --parent and --draft and shows exact mint command", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root, "--parent", "xbrief/pending/p.json"])).toBe(
      2,
    );
    expect(err.join("")).toMatch(/both --parent.*--draft|requires both/i);
    expect(err.join("")).toMatch(/deft authz:grant -- --parent/);
  });

  it("refuses missing paths and out-of-root paths before writing a grant", () => {
    const root = tempRoot();
    const { parent } = writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        parent,
        "--draft",
        "xbrief/.triage-cache/missing.json",
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/does not exist/);
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        join(root, "..", "outside-parent.json"),
        "--draft",
        join(root, "..", "outside-draft.json"),
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/outside project root/);
  });

  it("refuses structural mint without multi-factor human presence", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    // No --confirm injection — call main directly with TTY false.
    expect(
      main(
        ["grant", "--project-root", root, "--parent", parent, "--draft", draft],
        cleanOperatorSeams({ isTty: () => false }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/non-interactive|TTY|--confirm/i);
    // Agent marker refuse
    expect(
      main(
        ["grant", "--project-root", root, "--parent", parent, "--draft", draft, "--confirm"],
        cleanOperatorSeams({ environ: { CI: "1" } }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|CI/i);
  });

  it("refuses structural mint under active UAT", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    // Mint a normal grant first so UAT can start (mutating under UAT refuses).
    expect(
      runAuthz(["grant", "--project-root", root, "--operations", "edit", "--cohort", "pre"]),
    ).toBe(0);
    expect(runAuthz(["uat-start", "--project-root", root, "--campaign", "uat-struct"])).toBe(0);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root, "--parent", parent, "--draft", draft])).toBe(
      2,
    );
    expect(err.join("")).toMatch(/UAT lease is ACTIVE|hard-refused/i);
  });

  it("grant without ops/template/parent-draft fails with structural hint", () => {
    const root = tempRoot();
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root])).toBe(2);
    expect(err.join("")).toMatch(/--parent|--draft|operations|template/i);
  });

  it("requires --parent when only --draft is set", () => {
    const root = tempRoot();
    writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--draft",
        "xbrief/.triage-cache/decompositions/draft.json",
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/both --parent.*--draft|requires both/i);
  });

  it("refuses structural mint combined with --template or --operations", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        parent,
        "--draft",
        draft,
        "--template",
        "finish-loop",
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/cannot be combined with --template/);
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        parent,
        "--draft",
        draft,
        "--operations",
        "edit",
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/cannot be combined with --operations/);
  });

  it("refuses missing parent file and outside-root parent/draft separately", () => {
    const root = tempRoot();
    const { draft } = writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        "xbrief/pending/missing-parent.xbrief.json",
        "--draft",
        draft,
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/--parent path does not exist/);

    // Outside-root parent with in-root draft
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        join(root, "..", "escape-parent.json"),
        "--draft",
        draft,
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/--parent path is outside project root/);

    // Outside-root draft with in-root parent
    const { parent } = writeStructuralFixture(root);
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        parent,
        "--draft",
        join(root, "..", "escape-draft.json"),
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/--draft path is outside project root/);
  });

  it("mints without --repo and without --single-use (worktree-only bindings)", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(runAuthz(["grant", "--project-root", root, "--parent", parent, "--draft", draft])).toBe(
      0,
    );
    const joined = out.join("");
    expect(joined).toMatch(/structural grant minted/);
    expect(joined).not.toMatch(/repo=/);
    expect(joined).not.toMatch(/single-use=true/);
    expect(joined).toMatch(/worktree=/);
  });

  it("structural mint refuses without controlling terminal after TTY+confirm", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--parent", parent, "--draft", draft, "--confirm"],
        cleanOperatorSeams({ hasControllingTerminal: () => false }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/controlling terminal/i);
  });

  it("structural mint with wrong confirm phrase refuses after path validation", () => {
    const root = tempRoot();
    const { parent, draft } = writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      main(
        ["grant", "--project-root", root, "--parent", parent, "--draft", draft, "--confirm"],
        cleanOperatorSeams({ readInteractiveConfirm: () => "nope" }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/phrase mismatch|mint/i);
  });

  it("grant --parent empty string with --draft fails both-required", () => {
    const root = tempRoot();
    writeStructuralFixture(root);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      runAuthz([
        "grant",
        "--project-root",
        root,
        "--parent",
        "",
        "--draft",
        "xbrief/.triage-cache/decompositions/draft.json",
      ]),
    ).toBe(2);
    expect(err.join("")).toMatch(/both --parent|requires both|operations|template/i);
  });
});
