/**
 * #6337: the pack-migrate verbs read and write the invoking checkout when it is
 * a framework source checkout (a linked worktree included); any other project
 * resolves as before, and explicit flags still win.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFT_REPO_POSITIVE_MARKERS } from "@deftai/directive-core/doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./dispatch.js";

const SKILLS_OUT = join("content", "packs", "skills", "skills-pack-0.1.json");

function references(trigger: string): string {
  return `# References\n\n## Skills Index\n\n| Skill | Description | Triggers |\n|---|---|---|\n| [beta](./content/skills/beta/SKILL.md) | Beta skill. | \`${trigger}\` |\n`;
}

const SKILL_ALPHA =
  "---\nname: alpha\ndescription: Alpha skill.\ntriggers:\n  - alpha\n---\n\n# Alpha\n\nOriginal body.\n";
const SKILL_BETA = "---\nname: beta\ndescription: Beta skill.\n---\n\n# Beta\n\nBeta body.\n";

const FILES: Record<string, string> = {
  "main.md": "# main\n\n- ! Always do the main thing\n",
  "AGENTS.md": "# AGENTS\n\n- ! Always do the agents thing\n",
  "REFERENCES.md": references("primary-trigger"),
  "content/skills/alpha/SKILL.md": SKILL_ALPHA,
  "content/skills/beta/SKILL.md": SKILL_BETA,
  "content/coding/sample.md": "# Sample\n\n- ! Must do this\n",
  "content/strategies/good.md": "# Good Strategy\n\nA strategy.\n",
  "content/patterns/multi-agent.md": "# Multi-Agent Pattern\n\nA pattern.\n",
  "content/swarm/swarm.md": "# Swarm Spec\n\nA spec.\n",
};

const temps: string[] = [];
let savedCwd: string;
let savedDeftRoot: string | undefined;

beforeEach(() => {
  savedCwd = process.cwd();
  savedDeftRoot = process.env.DEFT_ROOT;
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedDeftRoot === undefined) {
    delete process.env.DEFT_ROOT;
  } else {
    process.env.DEFT_ROOT = savedDeftRoot;
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** Framework-source primary checkout (committed) and a linked worktree of it. */
function primaryAndWorktree(): { primary: string; worktree: string } {
  const primary = temp("deft-6337-pack-primary-");
  for (const [rel, body] of Object.entries(FILES)) {
    write(primary, rel, body);
  }
  for (const marker of DEFT_REPO_POSITIVE_MARKERS) {
    write(primary, marker, "marker\n");
  }
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "t@t.dev"]);
  git(primary, ["config", "user.name", "t"]);
  git(primary, ["add", "-A"]);
  git(primary, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  const worktree = join(temp("deft-6337-pack-wt-"), "linked");
  git(primary, ["worktree", "add", "--detach", "-q", worktree]);
  return { primary, worktree };
}

async function runVerb(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await dispatch(argv, {
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("pack-migrate roots follow the invoking framework checkout (#6337)", () => {
  it("renders an edited SKILL.md into the pack written in the linked worktree", async () => {
    const { primary, worktree } = primaryAndWorktree();
    write(
      worktree,
      "content/skills/alpha/SKILL.md",
      SKILL_ALPHA.replace("Original", "Worktree-edited"),
    );
    // A DEFT_ROOT that points elsewhere does not pull the defaults away from the invoking checkout.
    process.env.DEFT_ROOT = primary;
    process.chdir(worktree);

    const result = await runVerb(["pack-migrate-skills"]);

    expect(result.code, result.err).toBe(0);
    const pack = readFileSync(join(worktree, SKILLS_OUT), "utf8");
    expect(pack).toContain("Worktree-edited body.");
    expect(existsSync(join(primary, SKILLS_OUT))).toBe(false);
  });

  it("reads REFERENCES.md from the same worktree and writes the output there", async () => {
    const { primary, worktree } = primaryAndWorktree();
    write(worktree, "REFERENCES.md", references("worktree-trigger"));
    process.env.DEFT_ROOT = primary;
    process.chdir(worktree);

    const result = await runVerb(["pack-migrate-skills"]);

    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(primary, SKILLS_OUT))).toBe(false);
    const pack = readFileSync(join(worktree, SKILLS_OUT), "utf8");
    expect(pack).toContain("worktree-trigger");
    expect(pack).not.toContain("primary-trigger");
  });

  it("every pack-migrate verb writes its default output in the invoking worktree", async () => {
    const { worktree } = primaryAndWorktree();
    write(worktree, "main.md", "# main\n\n- ! Always do the worktree main thing\n");
    delete process.env.DEFT_ROOT;
    process.chdir(worktree);

    const outputs: Array<[string, string]> = [
      ["pack-migrate-rules", "content/packs/rules/rules-pack-0.1.json"],
      ["pack-migrate-strategies", "content/packs/strategies/strategies-pack-0.1.json"],
      ["pack-migrate-patterns", "content/packs/patterns/patterns-pack-0.1.json"],
      ["pack-migrate-swarm-spec", "content/packs/swarm-spec/swarm-spec-pack-0.1.json"],
    ];
    for (const [verb, rel] of outputs) {
      const result = await runVerb([verb]);
      expect(result.code, `${verb}: ${result.err}`).toBe(0);
      expect(existsSync(join(worktree, rel)), verb).toBe(true);
    }
    // Rules take AGENTS.md / main.md from the same checkout.
    const rules = readFileSync(join(worktree, outputs[0]?.[1] ?? ""), "utf8");
    expect(rules).toContain("Always do the worktree main thing");
  });

  it("explicit --skills-dir, --references-md and --out still win", async () => {
    const { worktree } = primaryAndWorktree();
    const elsewhere = temp("deft-6337-pack-flags-");
    write(elsewhere, "skills/gamma/SKILL.md", SKILL_ALPHA.replaceAll("alpha", "gamma"));
    write(elsewhere, "REFERENCES.md", references("flag-trigger"));
    const out = join(elsewhere, "out.json");
    process.chdir(worktree);

    const result = await runVerb([
      "pack-migrate-skills",
      "--skills-dir",
      join(elsewhere, "skills"),
      "--references-md",
      join(elsewhere, "REFERENCES.md"),
      "--out",
      out,
    ]);

    expect(result.code, result.err).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('"id": "gamma"');
    expect(existsSync(join(worktree, SKILLS_OUT))).toBe(false);
  });

  it("a consumer project resolves its inputs as today (DEFT_ROOT)", async () => {
    const { primary } = primaryAndWorktree();
    const consumer = temp("deft-6337-pack-consumer-");
    write(consumer, "main.md", "# consumer readme\n");
    process.env.DEFT_ROOT = primary;
    process.chdir(consumer);

    const result = await runVerb(["pack-migrate-skills"]);

    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(primary, SKILLS_OUT))).toBe(true);
    expect(existsSync(join(consumer, SKILLS_OUT))).toBe(false);
    expect(readFileSync(join(primary, SKILLS_OUT), "utf8")).toContain("primary-trigger");
  });
});
