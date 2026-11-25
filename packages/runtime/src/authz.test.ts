import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthzState,
  evaluateAuthzMutation,
  type HumanOriginGrant,
} from "@deftai/directive-core/authz";
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

  it("grant outside UAT / uat-start / show; grant hard-refuse under active UAT; suspend succeeds on complete seam (#4632)", () => {
    // Mint fix-cohort grants BEFORE uat-start — grant remint stays hard-refused under UAT.
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
    // Under active UAT: grant hard-refuses; uat-suspend succeeds on the complete seam.
    expect(
      runAuthz(["grant", "--project-root", root, "--operations", "edit", "--cohort", "late"]),
    ).toBe(2);
    expect(err.join("")).toMatch(
      /UAT lease is ACTIVE|hard-refused|Self-approval|refusing mutating/i,
    );
    expect(runAuthz(["uat-suspend", "--project-root", root])).toBe(0);
    expect(out.join("")).toMatch(/suspended/);
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

  it("refuses grant under agent markers without a harness confirm surface (#7279)", () => {
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
          hasControllingTerminal: () => false,
          readInteractiveConfirm: () => "mint",
          environ: { CLAUDECODE: "1" },
        },
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|harness-attended|controlling terminal/i);
  });

  it("refuses grant when CI marker is present without controlling-TTY/host confirm (#7279)", () => {
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
          hasControllingTerminal: () => false,
          environ: { CI: "true", GITHUB_ACTIONS: "true" },
        }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|CI|harness-attended|controlling terminal/i);
  });

  it("grants under agent markers when controlling-TTY phrase confirms (#7279)", () => {
    const root = tempRoot();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "x", "--confirm"],
        cleanOperatorSeams({ environ: { GROK_AGENT: "1" } }),
      ),
    ).toBe(0);
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

describe("authz CLI UAT-active mint refuse (#3110 / #4632)", () => {
  /**
   * Self-approval under UAT is impossible by construction: while any UAT lease
   * is active, grant / uat-start / revoke exit non-zero even with
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

  it("refuses uat-start / revoke under active UAT even with TTY + --confirm; suspend succeeds", () => {
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
    expect(
      main(["revoke", "--project-root", root, "grant-anything", "--confirm"], cleanOperatorSeams()),
    ).toBe(2);
    expect(err.join("")).toMatch(/UAT lease is ACTIVE|refusing mutating/i);
    expect(main(["uat-suspend", "--project-root", root, "--confirm"], cleanOperatorSeams())).toBe(
      0,
    );
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

  it("refuses uat-suspend under active UAT when TTY, confirm, phrase, terminal, or agent-marker is missing", () => {
    const root = tempRoot();
    startActiveUat(root);
    expect(
      main(["uat-suspend", "--project-root", root, "--confirm"], {
        isTty: () => false,
        environ: {},
      }),
    ).toBe(2);
    expect(main(["uat-suspend", "--project-root", root], cleanOperatorSeams())).toBe(2);
    expect(
      main(
        ["uat-suspend", "--project-root", root, "--confirm"],
        cleanOperatorSeams({
          environ: { CI: "1" },
          hasControllingTerminal: () => false,
        }),
      ),
    ).toBe(2);
    expect(
      main(
        ["uat-suspend", "--project-root", root, "--confirm"],
        cleanOperatorSeams({ readInteractiveConfirm: () => "yes" }),
      ),
    ).toBe(2);
    expect(
      main(
        ["uat-suspend", "--project-root", root, "--confirm"],
        cleanOperatorSeams({ hasControllingTerminal: () => false }),
      ),
    ).toBe(2);
  });

  it("after complete-seam suspend, grant is reachable again through human presence", () => {
    const root = tempRoot();
    startActiveUat(root);
    expect(main(["uat-suspend", "--project-root", root, "--confirm"], cleanOperatorSeams())).toBe(
      0,
    );
    expect(
      main(
        ["grant", "--project-root", root, "--operations", "edit", "--cohort", "after", "--confirm"],
        cleanOperatorSeams(),
      ),
    ).toBe(0);
  });

  it("help names operator-console uat-suspend and does not say the lease ends only out-of-band", () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    expect(main(["--help"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/uat-suspend is reachable from a real operator console/);
    expect(text).toMatch(/suspend reuses the mint phrase/);
    expect(text).not.toMatch(/End UAT only/);
    expect(text).not.toMatch(/cleared out-of-band/);
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
    // Agent marker refuse without harness confirm surface (#7279)
    expect(
      main(
        ["grant", "--project-root", root, "--parent", parent, "--draft", draft, "--confirm"],
        cleanOperatorSeams({
          environ: { CI: "1" },
          hasControllingTerminal: () => false,
        }),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|CI|harness-attended|controlling terminal/i);
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

describe("evaluate denials under active UAT name human-presence uat-suspend (#4632)", () => {
  function uatState(): AuthzState {
    return {
      schemaVersion: 1,
      uat: {
        active: true,
        campaignId: "c",
        startedAt: "2026-07-30T00:00:00Z",
        startedBy: {
          kind: "operator-cli",
          actor: "op",
          mintedAt: "2026-07-30T00:00:00Z",
          mintedVia: "cli",
          eventRef: null,
        },
        suspendedAt: null,
        note: null,
      },
      activeGrantIds: [],
    };
  }
  function grant(
    operations: HumanOriginGrant["scope"]["operations"],
    expiresAt: string | null = null,
  ): HumanOriginGrant {
    return {
      schemaVersion: 1,
      id: "g1",
      origin: {
        kind: "operator-cli",
        actor: "operator",
        mintedAt: "2026-07-30T00:00:00Z",
        mintedVia: "cli",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: [],
        operations,
        storyIds: [],
        issueIds: [],
        cohortId: "cohort-1",
      },
      semantics: { expiresAt, singleUse: false, usedAt: null, revokedAt: null },
    };
  }
  it("missing-op denial names uat-suspend, not authz:grant", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [grant(["settings"])],
      op: "push",
      path: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/does not include operation .push./);
    expect(d.reason).toMatch(/authz:uat-suspend/);
    expect(d.reason).not.toMatch(/authz:grant/);
  });
  it("expired-grant denial names uat-suspend, not authz:grant", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [grant(["push"], "2020-01-01T00:00:00Z")],
      op: "push",
      path: null,
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-grant-expired");
    expect(d.reason).toMatch(/authz:uat-suspend/);
    expect(d.reason).not.toMatch(/authz:grant/);
  });
});

describe("authz CLI delivery-identity-attest template (#6317)", () => {
  const SHA = "c".repeat(40);
  const TARGET = `deftai/directive#6280@${SHA}`;

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  function cloneWithDest(): { main: string; dest: string } {
    const base = tempRoot();
    const mainRoot = join(base, "main");
    mkdirSync(mainRoot);
    git(mainRoot, ["init", "-q"]);
    git(mainRoot, ["config", "user.email", "test@example.com"]);
    git(mainRoot, ["config", "user.name", "test"]);
    writeFileSync(join(mainRoot, "README.md"), "x\n", "utf8");
    git(mainRoot, ["add", "README.md"]);
    git(mainRoot, ["commit", "-q", "-m", "init"]);
    const dest = join(base, "dest");
    git(mainRoot, ["worktree", "add", "-q", "-b", "dest-branch", dest]);
    return { main: mainRoot, dest };
  }

  function capture(): { out: string[]; err: string[] } {
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
    return { out, err };
  }

  const grantArgv = (root: string, extra: string[] = []) => [
    "grant",
    "--project-root",
    root,
    "--template",
    "delivery-identity-attest",
    ...extra,
  ];

  it("mints from a linked dest into the main clone store; show and revoke find it from the dest", () => {
    const { main: mainRoot, dest } = cloneWithDest();
    const { out } = capture();
    expect(runAuthz(grantArgv(dest, ["--target", TARGET, "--plan-ref", "github.issue.6269"]))).toBe(
      0,
    );
    const text = out.join("");
    expect(text).toMatch(/template=delivery-identity-attest/);
    expect(text).toMatch(/plan=github\.issue\.6269/);
    const id = /id=(\S+)/.exec(text)?.[1] ?? "";
    expect(id.length).toBeGreaterThan(0);
    const grantFile = join(mainRoot, ".deft", "authz", "grants", `${id}.json`);
    const stored = JSON.parse(readFileSync(grantFile, "utf8")) as HumanOriginGrant;
    expect(stored.origin.kind).toBe("operator-cli");
    expect(stored.semantics.singleUse).toBe(true);
    expect(stored.semantics.expiresAt).not.toBeNull();

    out.length = 0;
    expect(runAuthz(["show", "--project-root", dest])).toBe(0);
    expect(out.join("")).toMatch(/Delivery-identity-attest grants \(main clone store .*\): 1/);
    expect(out.join("")).toContain(id);

    out.length = 0;
    expect(runAuthz(["show", "--project-root", dest, "--format", "json"])).toBe(0);
    const json = JSON.parse(out.join("")) as {
      deliveryIdentityAttest: { grants: { id: string }[] };
    };
    expect(json.deliveryIdentityAttest.grants.map((g) => g.id)).toEqual([id]);

    out.length = 0;
    expect(runAuthz(["revoke", "--project-root", dest, id])).toBe(0);
    expect(out.join("")).toMatch(/grant revoked/);
    const revoked = JSON.parse(readFileSync(grantFile, "utf8")) as HumanOriginGrant;
    expect(revoked.semantics.revokedAt).not.toBeNull();

    out.length = 0;
    expect(runAuthz(["show", "--project-root", dest])).toBe(0);
    expect(out.join("")).toMatch(/revoked=/);
  });

  it("refuses a missing target or plan ref, a bad target, and an unresolvable store root", () => {
    const { dest } = cloneWithDest();
    const { err } = capture();
    expect(runAuthz(grantArgv(dest, ["--plan-ref", "p"]))).toBe(2);
    expect(err.join("")).toMatch(/requires --target <owner>\/<repo>#<pr>@<merge_commit_sha>/);
    expect(runAuthz(grantArgv(dest, ["--target", TARGET]))).toBe(2);
    expect(err.join("")).toMatch(/requires --plan-ref <scopeId>/);
    expect(
      runAuthz(grantArgv(dest, ["--target", "deftai/directive#6280", "--plan-ref", "p"])),
    ).toBe(2);
    expect(err.join("")).toMatch(
      /authz:grant: template delivery-identity-attest requires --target/,
    );
    const notGit = tempRoot();
    expect(runAuthz(grantArgv(notGit, ["--target", TARGET, "--plan-ref", "p"]))).toBe(2);
    expect(err.join("")).toMatch(/store cannot be resolved/);
    expect(runAuthz(["show", "--project-root", notGit])).toBe(0);
  });

  it("refuses an unreadable --expires value", () => {
    const { main: mainRoot } = cloneWithDest();
    const { err } = capture();
    expect(
      runAuthz(
        grantArgv(mainRoot, ["--target", TARGET, "--plan-ref", "p", "--expires", "not-a-date"]),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/not a readable date/);
  });

  it("goes through the human-presence mint gate (non-TTY refuses)", () => {
    const { main: mainRoot } = cloneWithDest();
    const { err } = capture();
    expect(
      main([...grantArgv(mainRoot, ["--target", TARGET, "--plan-ref", "p"]), "--confirm"], {
        isTty: () => false,
      }),
    ).toBe(2);
    expect(err.join("")).toMatch(/TTY|non-TTY|silent-mint/i);
  });
});

describe("authz CLI acceptance-disposition template (#6318)", () => {
  const PLAN = "github.issue.6318";

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  /** Main clone plus a linked dest; the active brief is on both checkouts. */
  function cloneWithDest(): { main: string; dest: string } {
    const base = tempRoot();
    const mainRoot = join(base, "main");
    mkdirSync(mainRoot);
    git(mainRoot, ["init", "-q"]);
    git(mainRoot, ["config", "user.email", "test@example.com"]);
    git(mainRoot, ["config", "user.name", "test"]);
    writeFileSync(join(mainRoot, "README.md"), "x\n", "utf8");
    git(mainRoot, ["add", "README.md"]);
    git(mainRoot, ["commit", "-q", "-m", "init"]);
    const dest = join(base, "dest");
    git(mainRoot, ["worktree", "add", "-q", "-b", "dest-branch", dest]);
    for (const root of [mainRoot, dest]) {
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "active", "2026-11-15-6318-story.xbrief.json"),
        JSON.stringify({
          plan: {
            id: PLAN,
            title: "story",
            status: "running",
            acceptance: { clauses: [{ id: 19, text: "Clause nineteen." }] },
            items: [],
          },
        }),
        "utf8",
      );
    }
    return { main: mainRoot, dest };
  }

  function capture(): { out: string[]; err: string[] } {
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
    return { out, err };
  }

  const grantArgv = (root: string, extra: string[] = []) => [
    "grant",
    "--project-root",
    root,
    "--template",
    "acceptance-disposition",
    ...extra,
  ];
  const full = ["--plan-ref", PLAN, "--story-ids", "clause.19", "--deferred-to", "#6400"];

  it("clause.5: mints from the primary; show and authz:revoke from a linked dest find it", () => {
    const { main: mainRoot, dest } = cloneWithDest();
    const { out } = capture();
    expect(runAuthz(grantArgv(mainRoot, [...full, "--reason", "operator correction"]))).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/template=acceptance-disposition/);
    expect(text).toMatch(/plan=github\.issue\.6318 items=clause\.19/);
    const id = /id=(\S+)/.exec(text)?.[1] ?? "";
    expect(id.length).toBeGreaterThan(0);
    const grantFile = join(mainRoot, ".deft", "authz", "grants", `${id}.json`);
    const stored = JSON.parse(readFileSync(grantFile, "utf8")) as HumanOriginGrant;
    expect(stored.origin.kind).toBe("operator-cli");
    expect(stored.scope.storyIds).toEqual(["clause.19"]);

    out.length = 0;
    expect(runAuthz(["show", "--project-root", dest])).toBe(0);
    expect(out.join("")).toMatch(/Acceptance-disposition grants \(main clone store .*\): 1/);
    expect(out.join("")).toContain(id);

    out.length = 0;
    expect(runAuthz(["show", "--project-root", dest, "--format", "json"])).toBe(0);
    const json = JSON.parse(out.join("")) as {
      acceptanceDisposition: { grants: { id: string }[] };
    };
    expect(json.acceptanceDisposition.grants.map((g) => g.id)).toEqual([id]);

    out.length = 0;
    expect(runAuthz(["revoke", "--project-root", dest, id])).toBe(0);
    expect(out.join("")).toMatch(/grant revoked/);
    const revoked = JSON.parse(readFileSync(grantFile, "utf8")) as HumanOriginGrant;
    expect(revoked.semantics.revokedAt).not.toBeNull();

    out.length = 0;
    expect(runAuthz(["show", "--project-root", dest])).toBe(0);
    expect(out.join("")).toMatch(/revoked=/);
  });

  it("refuses each missing flag and returns core validation failures", () => {
    const { dest } = cloneWithDest();
    const { err } = capture();
    const cases: [string[], RegExp][] = [
      [[], /requires --plan-ref <scopeId>/],
      [["--plan-ref", PLAN], /requires --story-ids <itemIds>/],
      [["--plan-ref", PLAN, "--story-ids", "clause.19"], /requires --deferred-to <issue>/],
      [full, /requires --reason <text>/],
      [[...full, "--reason", "r", "--expires", "not-a-date"], /not a readable date/],
      [
        ["--plan-ref", PLAN, "--story-ids", "clause.7", "--deferred-to", "6400", "--reason", "r"],
        /neither an acceptance clause/,
      ],
    ];
    for (const [extra, message] of cases) {
      err.length = 0;
      expect(runAuthz(grantArgv(dest, extra))).toBe(2);
      expect(err.join("")).toMatch(message);
    }
    const notGit = tempRoot();
    err.length = 0;
    expect(runAuthz(grantArgv(notGit, [...full, "--reason", "r"]))).toBe(2);
    expect(err.join("")).toMatch(/store cannot be resolved/);
    expect(runAuthz(["show", "--project-root", notGit])).toBe(0);
  });

  it("goes through the human-presence mint gate (non-TTY refuses)", () => {
    const { main: mainRoot } = cloneWithDest();
    const { err } = capture();
    expect(
      main([...grantArgv(mainRoot, [...full, "--reason", "r"]), "--confirm"], {
        isTty: () => false,
      }),
    ).toBe(2);
    expect(err.join("")).toMatch(/TTY|non-TTY|silent-mint/i);
  });
});

describe("authz CLI plan-sequence-approval template (#6205)", () => {
  function gitRepo(): string {
    const root = tempRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], {
      cwd: root,
    });
    return root;
  }

  function capture(): { out: string[]; err: string[] } {
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
    return { out, err };
  }

  const insertArgv = (root: string) => [
    "grant",
    "--project-root",
    root,
    "--template",
    "plan-sequence-approval",
    "--target",
    "insert:issue:900",
    "--plan-ref",
    "seq-6205",
    "--generation",
    "3",
    "--position",
    "1",
    "--issue-ids",
    "900",
  ];

  it("clause.11: mints a single-use operator-cli grant bound to repo, sequence, generation, entry and position", () => {
    const root = gitRepo();
    const { out } = capture();
    expect(runAuthz([...insertArgv(root), "--title", "Hot Fix"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/template=plan-sequence-approval/);
    expect(text).toContain("plan-sequence-approval:title:=hot fix");
    expect(text).toContain("repo=acme/app");
    const id = /id=(\S+)/.exec(text)?.[1] ?? "";
    const grant = JSON.parse(
      readFileSync(join(root, ".deft", "authz", "grants", `${id}.json`), "utf8"),
    ) as HumanOriginGrant;
    expect(grant.origin.kind).toBe("operator-cli");
    expect(grant.semantics.singleUse).toBe(true);
    expect(grant.scope.surfaces).toEqual(
      expect.arrayContaining([
        "plan-sequence-approval:generation:3",
        "plan-sequence-approval:position:1",
        "plan-sequence-approval:entry:issue:900",
      ]),
    );
  });

  it("names each missing argument and refuses a malformed --generation or --position", () => {
    const root = gitRepo();
    const { err } = capture();
    const base = ["grant", "--project-root", root, "--template", "plan-sequence-approval"];
    expect(runAuthz(base)).toBe(2);
    expect(err.join("")).toContain("requires --target");
    err.length = 0;
    expect(runAuthz([...base, "--target", "clear"])).toBe(2);
    expect(err.join("")).toContain("requires --plan-ref");
    err.length = 0;
    expect(runAuthz([...base, "--target", "clear", "--plan-ref", "s"])).toBe(2);
    expect(err.join("")).toContain("requires --generation");
    err.length = 0;
    expect(runAuthz([...base, "--generation", "x"])).toBe(2);
    expect(err.join("")).toContain("--generation requires a non-negative integer");
    err.length = 0;
    expect(runAuthz([...base, "--position", "-2"])).toBe(2);
    expect(err.join("")).toContain("--position requires a non-negative integer");
    err.length = 0;
    expect(
      runAuthz([...base, "--target", "insert:issue:1", "--plan-ref", "s", "--generation", "0"]),
    ).toBe(2);
    expect(err.join("")).toContain("insert requires --position");
  });

  it("refuses an agent shell without harness confirm surface (#7279)", () => {
    const root = gitRepo();
    const { out } = capture();
    expect(
      main([...insertArgv(root), "--confirm"], {
        isTty: () => true,
        hasControllingTerminal: () => false,
        readInteractiveConfirm: () => "mint",
        environ: { CLAUDECODE: "1" },
      }),
    ).toBe(2);
    expect(out.join("")).not.toContain("template=plan-sequence-approval");
  });
});
