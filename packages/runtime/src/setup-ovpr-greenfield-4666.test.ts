/**
 * Red proofs for #4666 Locked disposition (OVPR greenfield retain).
 * First-time install must seed PD + lifecycle dirs, stage them with peers,
 * and must not deposit xbrief/schemas/*. Placeholder-only is not enough.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];
const LIFECYCLE_DIRS = ["proposed", "pending", "active", "completed", "cancelled"] as const;
const PD_REL = "xbrief/PROJECT-DEFINITION.xbrief.json";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-4666-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

function initGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "red@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Red"], { cwd: root });
}

function cachedNames(root: string): string[] {
  try {
    return execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .map((p) => p.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function porcelain(root: string): string {
  return execFileSync("git", ["status", "--porcelain", "-uall"], {
    cwd: root,
    encoding: "utf8",
  });
}

function hasCommit(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("OVPR greenfield #4666 — runSetup install seeds PD + lifecycle (red)", {
  timeout: 30_000,
}, () => {
  it("first-time install seeds minimal PROJECT-DEFINITION.xbrief.json", () => {
    const root = tempRoot();
    initGit(root);
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);

    const pdPath = join(root, PD_REL);
    expect(existsSync(pdPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(pdPath, "utf8")) as {
      plan?: { title?: string; items?: unknown[] };
      xBRIEFInfo?: { version?: string };
    };
    expect(parsed.plan?.title).toBe("PROJECT-DEFINITION");
    expect(Array.isArray(parsed.plan?.items)).toBe(true);
    expect(parsed.xBRIEFInfo?.version).toBeTruthy();
    expect(JSON.stringify(parsed)).not.toMatch(/DeftVersion|deft_version/);
  });

  it("install creates five lifecycle dirs with .gitkeeps", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });

    for (const sub of LIFECYCLE_DIRS) {
      expect(existsSync(join(root, "xbrief", sub))).toBe(true);
      expect(existsSync(join(root, "xbrief", sub, ".gitkeep"))).toBe(true);
    }
  });

  it("install does not deposit xbrief/schemas/* (pin is schema SoT)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    expect(existsSync(join(root, "xbrief", "schemas"))).toBe(false);
  });

  it("install seed is idempotent and never overwrites an existing PD", () => {
    const root = tempRoot();
    initGit(root);
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    const pdPath = join(root, PD_REL);
    const prior = {
      xBRIEFInfo: { version: "0.8", description: "keep me" },
      plan: {
        title: "PROJECT-DEFINITION",
        status: "running",
        narratives: { Overview: "operator identity" },
        items: [],
      },
    };
    writeFileSync(pdPath, `${JSON.stringify(prior, null, 2)}\n`, "utf8");

    runSetup({ operation: "install", from: "none", root });

    const after = JSON.parse(readFileSync(pdPath, "utf8")) as {
      plan?: { narratives?: { Overview?: string } };
      xBRIEFInfo?: { description?: string };
    };
    expect(after.plan?.narratives?.Overview).toBe("operator identity");
    expect(after.xBRIEFInfo?.description).toBe("keep me");
  });

  it("repair does not create missing PD or lifecycle seeds (AC8.4)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    rmSync(join(root, "xbrief"), { recursive: true, force: true });

    const repaired = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(repaired.conflicts).toEqual([]);
    expect(existsSync(join(root, PD_REL))).toBe(false);
    for (const sub of LIFECYCLE_DIRS) {
      expect(existsSync(join(root, "xbrief", sub, ".gitkeep"))).toBe(false);
    }
  });
});

describe("OVPR greenfield #4666 — staging PD + lifecycle with peers (red)", {
  timeout: 30_000,
}, () => {
  it("install stages PD + lifecycle gitkeeps with managed peers; no auto-commit", () => {
    const root = tempRoot();
    initGit(root);
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);

    const cached = cachedNames(root);
    expect(cached).toContain("AGENTS.md");
    expect(cached).toContain(PD_REL);
    for (const sub of LIFECYCLE_DIRS) {
      expect(cached).toContain(`xbrief/${sub}/.gitkeep`);
    }
    // Fix the 0.126 hole: PD must not stay untracked while peers are staged.
    const status = porcelain(root);
    expect(status).not.toMatch(/^\?\? xbrief\/PROJECT-DEFINITION\.xbrief\.json$/m);
    for (const sub of LIFECYCLE_DIRS) {
      expect(status).not.toMatch(new RegExp(`^\\?\\? xbrief/${sub}/\\.gitkeep$`, "m"));
    }
    expect(hasCommit(root)).toBe(false);
  });

  it("install does not stage unrelated files under .agents/ outside skills/", () => {
    const root = tempRoot();
    initGit(root);
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", "user-note.md"), "# mine\n", "utf8");
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);
    const cached = cachedNames(root);
    expect(cached).toContain(".agents/skills/deft/SKILL.md");
    expect(cached).not.toContain(".agents/user-note.md");
  });

  it("install stages exact skill paths, not the whole skills directory", () => {
    const root = tempRoot();
    initGit(root);
    mkdirSync(join(root, ".agents", "skills", "my-skill"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "my-skill", "SKILL.md"), "# mine\n", "utf8");
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);
    const cached = cachedNames(root);
    expect(cached).toContain(".agents/skills/deft/SKILL.md");
    expect(cached).not.toContain(".agents/skills");
    expect(cached).not.toContain(".agents/skills/my-skill/SKILL.md");
  });

  it("old-style conversion stages removed .deft/core deletion", () => {
    const root = tempRoot();
    initGit(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "legacy.txt"), "old\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "legacy core"], { cwd: root });
    const result = runSetup({ operation: "install", from: "old-style", root });
    expect(result.conflicts).toEqual([]);
    expect(result.removed).toContain(".deft/core");
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    const cached = cachedNames(root);
    expect(cached.some((p) => p === ".deft/core" || p.startsWith(".deft/core/"))).toBe(true);
    const status = porcelain(root);
    expect(status).toMatch(/^D\s+\.deft\/core(\/|$)/m);
  });

  it("install does not stage unrelated dirty package.json (this-run staging only)", () => {
    const root = tempRoot();
    initGit(root);
    // Commit the initial package.json so a later edit is a dirty tracked peer.
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "t", version: "9.9.9", private: true }, null, 2)}\n`,
    );
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);
    const cached = cachedNames(root);
    expect(cached).toContain(PD_REL);
    expect(cached).toContain("AGENTS.md");
    expect(cached).not.toContain("package.json");
    const status = porcelain(root);
    expect(status).toMatch(/package\.json/);
  });

  it("upgrade stages existing PD + lifecycle with managed peers; still no schemas copy", () => {
    const root = tempRoot();
    initGit(root);
    for (const sub of LIFECYCLE_DIRS) {
      mkdirSync(join(root, "xbrief", sub), { recursive: true });
      writeFileSync(join(root, "xbrief", sub, ".gitkeep"), "", "utf8");
    }
    writeFileSync(
      join(root, PD_REL),
      `${JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "prior" },
        plan: { title: "PROJECT-DEFINITION", status: "running", items: [] },
      })}\n`,
      "utf8",
    );

    const result = runSetup({ operation: "upgrade", from: "1.0.0", root });
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, "xbrief", "schemas"))).toBe(false);

    const cached = cachedNames(root);
    expect(cached).toContain("AGENTS.md");
    expect(cached).toContain(PD_REL);
    for (const sub of LIFECYCLE_DIRS) {
      expect(cached).toContain(`xbrief/${sub}/.gitkeep`);
    }
    const status = porcelain(root);
    expect(status).not.toMatch(/^\?\? xbrief\/PROJECT-DEFINITION\.xbrief\.json$/m);
    expect(hasCommit(root)).toBe(false);
  });
});
