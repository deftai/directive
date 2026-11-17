/**
 * #6337: the setup repair path (self-complete → runSetup → ensureSlashCommands →
 * ensureManagedPathGitattributes) leaves `.gitattributes` alone in a linked
 * worktree of the framework source repository; a consumer still gets the pins.
 * #6507: setup plans AGENTS.md against the checkout's own agents-entry template.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractManagedSection,
  renderManagedSection,
  stripManagedSectionAttrs,
} from "@deftai/directive-core/dist/platform/agents-md.js";
import { DEFT_REPO_POSITIVE_MARKERS } from "@deftai/directive-core/doctor";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";
import {
  ensureAgentsManagedSection,
  ensureManagedPathGitattributes,
  resolveRuntimeAgentsEntryTemplatePath,
} from "./setup-wiring.js";

const TEMPS: string[] = [];

afterEach(() => {
  for (const dir of TEMPS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** Committed repository with a tracked .gitattributes; framework markers when asked. */
function committedRepo(prefix: string, framework: boolean): string {
  const root = temp(prefix);
  write(root, ".gitattributes", "* text=auto\n");
  if (framework) {
    write(root, "main.md", "# main\n");
    for (const marker of DEFT_REPO_POSITIVE_MARKERS) {
      write(root, marker, "marker\n");
    }
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  return root;
}

function linkedFrameworkWorktree(): string {
  const primary = committedRepo("deft-6337-setup-primary-", true);
  const worktree = join(temp("deft-6337-setup-wt-"), "linked");
  git(primary, ["worktree", "add", "--detach", "-q", worktree]);
  return worktree;
}

describe("setup repair path in a framework source worktree (#6337)", () => {
  it("ensureManagedPathGitattributes writes nothing in a linked worktree", () => {
    const worktree = linkedFrameworkWorktree();
    const before = readFileSync(join(worktree, ".gitattributes"), "utf8");

    expect(ensureManagedPathGitattributes(worktree)).toEqual({
      created: false,
      modified: false,
      wrote: false,
    });
    expect(readFileSync(join(worktree, ".gitattributes"), "utf8")).toBe(before);
  });

  it("runSetup repair leaves .gitattributes unchanged in a linked worktree", () => {
    const worktree = linkedFrameworkWorktree();
    const before = readFileSync(join(worktree, ".gitattributes"), "utf8");

    const result = runSetup({ operation: "repair", from: "0.0.0", root: worktree });

    expect(readFileSync(join(worktree, ".gitattributes"), "utf8")).toBe(before);
    expect(git(worktree, ["status", "--porcelain", "--", ".gitattributes"])).toBe("");
    expect(JSON.stringify(result)).not.toContain(".gitattributes");
  });

  it("a consumer repository still gets the managed-path pins", () => {
    const consumer = committedRepo("deft-6337-setup-consumer-", false);

    const out = ensureManagedPathGitattributes(consumer);

    expect(out.wrote).toBe(true);
    expect(readFileSync(join(consumer, ".gitattributes"), "utf8")).toContain(
      ".claude/commands/** text=auto eol=lf",
    );
  });
});

const CHECKOUT_TEMPLATE =
  "<!-- deft:managed-section v3 -->\n# Checkout rules (#6507 fixture)\n<!-- /deft:managed-section -->\n";

function runtimeRendered(): string {
  const path = resolveRuntimeAgentsEntryTemplatePath();
  expect(path).not.toBeNull();
  return renderManagedSection(readFileSync(path as string, "utf8")) ?? "";
}

function managedOf(root: string): string {
  return stripManagedSectionAttrs(
    extractManagedSection(readFileSync(join(root, "AGENTS.md"), "utf8")) ?? "",
  );
}

describe("setup AGENTS.md managed section in a framework source checkout (#6507)", () => {
  it("leaves a section that matches the checkout template alone while the runtime template differs", () => {
    const root = temp("deft-6507-setup-source-");
    write(root, "main.md", "# main\n");
    for (const marker of DEFT_REPO_POSITIVE_MARKERS) write(root, marker, "marker\n");
    write(root, "content/templates/agents-entry.md", CHECKOUT_TEMPLATE);
    const agents =
      "# Header\n\n<!-- deft:managed-section v3 sha=0.0.0 refreshed=2026-01-01T00:00:00Z session=abc123abc123 -->\n# Checkout rules (#6507 fixture)\n<!-- /deft:managed-section -->\n";
    write(root, "AGENTS.md", agents);
    expect(runtimeRendered()).not.toBe(renderManagedSection(CHECKOUT_TEMPLATE));

    const out = ensureAgentsManagedSection(root);

    expect(out).toEqual({ created: false, modified: false, conflict: false });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("a consumer project still gets the runtime template", () => {
    const root = temp("deft-6507-setup-consumer-");

    const out = ensureAgentsManagedSection(root);

    expect(out.created).toBe(true);
    expect(managedOf(root)).toBe(runtimeRendered());
  });
});
