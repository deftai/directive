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
import { join } from "node:path";
import { startUatLease } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHZ_AGENT_SHELL_ENV_MARKERS } from "./human-presence-mint.js";
import {
  isPathInsideRoot,
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

  it("shared-gate refuse matrix for scope:record-approved-scope (#3384)", () => {
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

    expect(run(argv, { ...operatorSeams(), environ: { CLAUDECODE: "1" } })).toBe(2);
    expect(run(argv, { ...operatorSeams(), environ: { CI: "true" } })).toBe(2);
    expect(run(argv, { ...operatorSeams(), isTty: () => false })).toBe(2);
    expect(run(argv, { ...operatorSeams(), hasControllingTerminal: () => false })).toBe(2);
    expect(run(argv, { ...operatorSeams(), readInteractiveConfirm: () => "yes" })).toBe(2);
    expect(
      run(
        ["xbrief/pending/story.xbrief.json", "--project-root", root, "--actor", "Flynn"],
        operatorSeams(),
      ),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|CI|TTY|--confirm|controlling terminal|phrase|mint/i);
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
  });

  it("--actor Flynn from an agent/CI shell cannot mint (#3384)", () => {
    root = mkdtempSync(join(tmpdir(), "scope-record-flynn-"));
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      `${JSON.stringify({
        plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } },
      })}\n`,
      "utf8",
    );
    for (const key of ["CLAUDECODE", "CI", "GITHUB_ACTIONS"] as const) {
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
          { ...operatorSeams(), environ: { [key]: "1" } },
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
