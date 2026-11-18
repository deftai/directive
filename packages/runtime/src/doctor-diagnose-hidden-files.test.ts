/**
 * #6618 / #6163: doctor warns when a Directive file that must be committed is
 * hidden from git. Real git fixtures; probes are read-only.
 *
 * #6617 / AC12.1: the whole `directive doctor` run (contract entry: install
 * sync + product suite) writes nothing; every file under the project,
 * `.git/config` and `.git/index` included, is byte-identical afterwards.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hostHookOuterSha8 } from "@deftai/directive-core/dist/init-deposit/host-hook-outer.js";
import { RUNTIME_PIN_PACKAGE } from "@deftai/directive-core/dist/install-health/constants.js";
import { envGitRunner } from "@deftai/directive-core/dist/session/git.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleContractEntrypoint } from "./contract-entry.js";
import {
  findHiddenDirectiveFiles,
  formatDoctorReport,
  formatHiddenDirectiveFileWarning,
  runDoctorDiagnosis,
} from "./doctor-diagnose.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];
afterEach(() => {
  while (TEMPS.length > 0) {
    const t = TEMPS.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

/** Isolated git config: no user/global excludes leak into the fixture. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function repo(): { root: string; home: string } {
  const root = temp("doctor-hidden-");
  const home = temp("doctor-hidden-home-");
  writeFileSync(join(home, ".gitconfig"), "");
  execFileSync("git", ["init", "-q"], { cwd: root, env: { ...process.env, ...isolatedEnv(home) } });
  return { root, home };
}

function write(root: string, rel: string, text = "{}\n"): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

function git(root: string, home: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, env: { ...process.env, ...isolatedEnv(home) } });
}

function hidden(root: string, home: string) {
  return findHiddenDirectiveFiles(root, envGitRunner(isolatedEnv(home)));
}

describe("doctor hidden Directive files (#6618)", () => {
  it("names the new .mjs outer hidden by a blanket .cursor/ rule in .git/info/exclude", () => {
    const { root, home } = repo();
    write(root, ".cursor/hooks.json");
    writeFileSync(join(root, ".git", "info", "exclude"), ".cursor/\n");
    const found = hidden(root, home) ?? [];
    const outer = `.cursor/hooks/deft-hook-${hostHookOuterSha8()}.mjs`;
    const hit = found.find((f) => f.path === outer);
    expect(hit).toBeDefined();
    expect(hit?.source).toBe(".git/info/exclude");
    expect(hit?.line).toBe(1);
    const text = formatHiddenDirectiveFileWarning(hit as NonNullable<typeof hit>);
    expect(text).toContain(`Directive file ${outer} is hidden from git by .git/info/exclude:1`);
    expect(text).toContain("('.cursor/')");
    expect(text).toContain("Remove or narrow that rule.");
    expect(text).not.toMatch(/repair|upgrade|npm i -g/);
  });

  it("names a global excludes file (core.excludesFile in a temporary HOME)", () => {
    const { root, home } = repo();
    // Forward slashes: git config treats `\` as an escape, so Windows paths need `/`.
    const globalExcludes = join(home, "global-excludes").replace(/\\/g, "/");
    writeFileSync(globalExcludes, "# comment\n.claude/\n");
    writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${globalExcludes}\n`);
    write(root, ".claude/settings.json");
    const found = hidden(root, home) ?? [];
    const hit = found.find((f) => f.path === ".claude/settings.json");
    expect(hit?.source.replace(/\\/g, "/")).toBe(`global excludes file (${globalExcludes})`);
    expect(hit?.line).toBe(2);
  });

  it("does not warn for a path a negation rule re-includes", () => {
    const { root, home } = repo();
    write(root, ".claude/settings.json");
    writeFileSync(join(root, ".gitignore"), ".claude/*\n!.claude/settings.json\n");
    const found = hidden(root, home) ?? [];
    expect(found.some((f) => f.path === ".claude/settings.json")).toBe(false);
  });

  it("warns for skip-worktree on .claude/settings.json", () => {
    const { root, home } = repo();
    write(root, ".claude/settings.json");
    git(root, home, ["add", ".claude/settings.json"]);
    git(root, home, ["update-index", "--skip-worktree", ".claude/settings.json"]);
    const found = hidden(root, home) ?? [];
    const hit = found.find((f) => f.path === ".claude/settings.json");
    expect(hit?.kind).toBe("skip-worktree");
    expect(formatHiddenDirectiveFileWarning(hit as NonNullable<typeof hit>)).toContain(
      "git update-index --no-skip-worktree -- .claude/settings.json",
    );
  });

  it("does not warn for an ignored readiness marker or node_modules", () => {
    const { root, home } = repo();
    write(root, ".deft/directive/wiring-ready.1.2.3.json");
    write(root, "node_modules/@deftai/directive-runtime/package.json");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.deft/directive/wiring-ready.*.json\n");
    write(root, ".deft/GENERATION.json");
    expect(hidden(root, home)).toEqual([]);
  });

  it("skips (null) outside a git checkout and leaves .git/index untouched", () => {
    const outside = temp("doctor-hidden-nogit-");
    expect(findHiddenDirectiveFiles(outside)).toBeNull();
    const { root, home } = repo();
    write(root, ".claude/settings.json");
    git(root, home, ["add", "-A"]);
    const before = readFileSync(join(root, ".git", "index"));
    hidden(root, home);
    expect(readFileSync(join(root, ".git", "index")).equals(before)).toBe(true);
  });

  it("prints the warning in the install-sync section without changing the exit code", () => {
    const { root } = repo();
    const withWarning = runDoctorDiagnosis(root, {
      probeHooks: false,
      findHiddenFiles: () => [
        {
          path: ".cursor/hooks/deft-hook-aaaaaaaa.mjs",
          kind: "ignored",
          source: ".git/info/exclude",
          line: 1,
          pattern: ".cursor/",
        },
      ],
    });
    const without = runDoctorDiagnosis(root, { probeHooks: false, findHiddenFiles: () => [] });
    expect(withWarning.exitCode).toBe(without.exitCode);
    expect(formatDoctorReport(withWarning)).toContain(
      "warning: Directive file .cursor/hooks/deft-hook-aaaaaaaa.mjs is hidden from git by .git/info/exclude:1",
    );
  });
});

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out.set(relative(root, full), readFileSync(full).toString("base64"));
      }
    }
  };
  walk(root);
  return out;
}

function setUpFixture(): string {
  const root = temp("doctor-ac12-1-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t", private: true })}\n`);
  const version = runSetup({ operation: "install", from: "none", root }).runtimeVersion;
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", private: true, devDependencies: { [RUNTIME_PIN_PACKAGE]: version } })}\n`,
  );
  const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(runtimePkg, { recursive: true });
  writeFileSync(
    join(runtimePkg, "package.json"),
    `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version })}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "t",
      lockfileVersion: 3,
      packages: { "": { name: "t" }, [`node_modules/${RUNTIME_PIN_PACKAGE}`]: { version } },
    })}\n`,
  );
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, DATA_SCHEMA_MARKER_REL),
    `${JSON.stringify({ schemaVersion: CURRENT_DATA_SCHEMA_VERSION })}\n`,
  );
  // Hide a hook config so the hidden-file probe runs too.
  writeFileSync(join(root, ".git", "info", "exclude"), ".cursor/\n");
  // Stage everything so .git/index exists and an index refresh would show.
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

async function quietly(fn: () => Promise<unknown>): Promise<void> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("directive doctor writes nothing (AC12.1, #6617)", () => {
  for (const argv of [["doctor"], ["doctor", "--full"], ["doctor", "--full", "--json"]]) {
    it(`${argv.join(" ")} leaves the project and .git byte-identical`, async () => {
      const root = setUpFixture();
      expect(existsSync(join(root, ".git", "index"))).toBe(true);
      const before = snapshot(root);
      await quietly(() => handleContractEntrypoint([...argv, "--root", root]));
      const after = snapshot(root);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [rel, bytes] of before) {
        expect(after.get(rel), rel).toBe(bytes);
      }
      expect(existsSync(join(root, "xbrief", ".triage-cache", "doctor-state.json"))).toBe(false);
    }, 60_000);
  }
});
