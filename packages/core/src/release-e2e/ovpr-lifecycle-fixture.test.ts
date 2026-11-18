import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../content-contracts/standards/_helpers.js";
import {
  binFileName,
  bumpRuntimePin,
  changedPaths,
  cleanFixtureEnv,
  expectAllowed,
  expectBlocked,
  FIXTURE_HOSTS,
  FIXTURE_STEPS,
  findStep,
  formatStepLine,
  globalBinDir,
  HOST_CONFIG_PATHS,
  OLD_LAYOUT_FIXTURES,
  OLD_PROJECT_TEXT,
  PROJECT_INSTALL_TEXT,
  preOvprGrokWrapperPath,
  prependPath,
  registeredHookCommand,
  runLifecycleFixture,
  runRegisteredHook,
  shellToolPayload,
  snapshotTree,
} from "./ovpr-lifecycle-fixture.js";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-fixture-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(dir: string, rel: string, value: unknown): void {
  const path = join(dir, ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

const INSTALL_TEXT = "Directive hooks: missing node_modules/x. Run npm install or pnpm install.";
const OLD_TEXT =
  "This project uses an older version of Directive that isn't installed. Run `npm install` (or `pnpm install`) to keep using it, or run `directive upgrade` to update.";

describe("step registry (#6614)", () => {
  it("lists steps 1-6 in order with stable ids", () => {
    expect(FIXTURE_STEPS.map((s) => s.id)).toEqual([
      "1-bump",
      "2-install",
      "3-refresh",
      "4-missing-packages",
      "5-upgrade-commit",
      "6-old-layout",
    ]);
  });

  it("reports skip for step 5 (added by P4-U1) without packing anything", () => {
    const pending = FIXTURE_STEPS.filter((s) => !s.needsPackages);
    expect(pending.map((s) => s.id)).toEqual(["5-upgrade-commit"]);
    const report = runLifecycleFixture("/nonexistent-repo", {
      steps: pending,
      seams: { which: () => null },
    });
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.status)).toEqual(["skip"]);
    expect(report.steps[0]?.detail).toContain("P4-U1");
    expect(report.setupMs).toBe(0);
  });

  it("fails the package steps, not the run's shape, when setup cannot start", () => {
    const report = runLifecycleFixture("/nonexistent-repo", { seams: { which: () => null } });
    expect(report.ok).toBe(false);
    expect(report.steps).toHaveLength(6);
    const byId = Object.fromEntries(report.steps.map((s) => [s.id, s]));
    expect(byId["4-missing-packages"]?.status).toBe("fail");
    expect(byId["4-missing-packages"]?.detail).toContain("npm not on PATH");
    expect(byId["6-old-layout"]?.status).toBe("fail");
    expect(byId["1-bump"]?.status).toBe("fail");
    expect(byId["5-upgrade-commit"]?.status).toBe("skip");
  });

  it("finds a step by number or full id", () => {
    expect(findStep("4")?.id).toBe("4-missing-packages");
    expect(findStep("6-old-layout")?.id).toBe("6-old-layout");
    expect(findStep("7")).toBeNull();
  });

  it("prints one line per step with status, id and duration", () => {
    const line = formatStepLine({
      id: "4-missing-packages",
      title: "t",
      status: "pass",
      detail: "ok",
      durationMs: 1500,
    });
    expect(line).toBe("PASS 4-missing-packages (1.5s): ok");
  });
});

describe("expectBlocked (same table as #6201)", () => {
  it("Claude and Codex block with exit 2 and the reason on stderr", () => {
    for (const host of ["claude", "codex"] as const) {
      expect(
        expectBlocked(host, { status: 2, stdout: "", stderr: INSTALL_TEXT }, PROJECT_INSTALL_TEXT)
          .ok,
      ).toBe(true);
      // Exit 1 does not block on Claude/Codex (#6201).
      expect(expectBlocked(host, { status: 1, stdout: "", stderr: INSTALL_TEXT }).ok).toBe(false);
      expect(expectBlocked(host, { status: 0, stdout: "", stderr: "" }).ok).toBe(false);
    }
  });

  it("Cursor blocks with one permission deny object on exit 0, or exit 2", () => {
    const deny = JSON.stringify({
      permission: "deny",
      user_message: INSTALL_TEXT,
      agent_message: INSTALL_TEXT,
    });
    expect(
      expectBlocked("cursor", { status: 0, stdout: `${deny}\n`, stderr: "" }, PROJECT_INSTALL_TEXT)
        .ok,
    ).toBe(true);
    expect(
      expectBlocked("cursor", { status: 2, stdout: "", stderr: INSTALL_TEXT }, PROJECT_INSTALL_TEXT)
        .ok,
    ).toBe(true);
    expect(
      expectBlocked("cursor", { status: 0, stdout: `${deny}\n${deny}\n`, stderr: "" }).ok,
    ).toBe(false);
    expect(
      expectBlocked("cursor", { status: 0, stdout: '{"permission":"allow"}', stderr: "" }).ok,
    ).toBe(false);
    expect(expectBlocked("cursor", { status: 1, stdout: deny, stderr: "" }).ok).toBe(false);
  });

  it("Grok blocks with one decision deny object on exit 0", () => {
    const deny = JSON.stringify({ decision: "deny", reason: OLD_TEXT });
    expect(
      expectBlocked("grok", { status: 0, stdout: deny, stderr: "" }, OLD_PROJECT_TEXT).ok,
    ).toBe(true);
    expect(expectBlocked("grok", { status: 2, stdout: "", stderr: OLD_TEXT }).ok).toBe(false);
    expect(expectBlocked("grok", { status: 0, stdout: "", stderr: "" }).ok).toBe(false);
    expect(expectBlocked("grok", { status: 0, stdout: "not json", stderr: "" }).ok).toBe(false);
  });

  it("step 4 text must name the project install and never the global or repair command", () => {
    expect(
      expectBlocked("claude", { status: 2, stdout: "", stderr: "blocked" }, PROJECT_INSTALL_TEXT)
        .ok,
    ).toBe(false);
    const global = expectBlocked(
      "claude",
      { status: 2, stdout: "", stderr: "Run npm install, then npm i -g @deftai/directive" },
      PROJECT_INSTALL_TEXT,
    );
    expect(global.ok).toBe(false);
    expect(global.detail).toContain("npm i -g");
    const repair = expectBlocked(
      "codex",
      { status: 2, stdout: "", stderr: "Run pnpm install, then directive install --repair" },
      PROJECT_INSTALL_TEXT,
    );
    expect(repair.ok).toBe(false);
  });

  it("step 6 text must carry the old-project key phrases", () => {
    expect(
      expectBlocked("claude", { status: 2, stdout: "", stderr: OLD_TEXT }, OLD_PROJECT_TEXT).ok,
    ).toBe(true);
    expect(
      expectBlocked("claude", { status: 2, stdout: "", stderr: INSTALL_TEXT }, OLD_PROJECT_TEXT).ok,
    ).toBe(false);
  });
});

describe("expectAllowed (step 4 sanity)", () => {
  it("passes exit 0 with no deny and fails any block form", () => {
    for (const host of FIXTURE_HOSTS) {
      expect(expectAllowed(host, { status: 0, stdout: "", stderr: "" }).ok).toBe(true);
    }
    expect(expectAllowed("claude", { status: 2, stdout: "", stderr: "no" }).ok).toBe(false);
    expect(
      expectAllowed("claude", {
        status: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }),
        stderr: "",
      }).ok,
    ).toBe(false);
    expect(
      expectAllowed("cursor", { status: 0, stdout: '{"permission":"deny"}', stderr: "" }).ok,
    ).toBe(false);
    expect(expectAllowed("grok", { status: 0, stdout: '{"decision":"deny"}', stderr: "" }).ok).toBe(
      false,
    );
    expect(
      expectAllowed("grok", { status: 0, stdout: '{"decision":"allow"}', stderr: "" }).ok,
    ).toBe(true);
  });
});

describe("registeredHookCommand (host config parsing)", () => {
  it("reads each host's tool.before command from the current deposit shapes", () => {
    const dir = tempDir();
    const nested = (host: string) => ({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: `node x.mjs --host ${host} --event session.start` },
            ],
          },
        ],
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "wrong" }] },
          {
            matcher: "Shell|Bash|BashTool|shell|bash",
            hooks: [{ type: "command", command: `node x.mjs --host ${host} --event tool.before` }],
          },
        ],
      },
    });
    writeConfig(dir, HOST_CONFIG_PATHS.claude, nested("claude"));
    writeConfig(dir, HOST_CONFIG_PATHS.codex, nested("codex"));
    writeConfig(dir, HOST_CONFIG_PATHS.grok, nested("grok"));
    writeConfig(dir, HOST_CONFIG_PATHS.cursor, {
      version: 1,
      hooks: {
        preToolUse: [
          { command: "wrong", matcher: "Edit|Write", failClosed: true },
          {
            command: "node x.mjs --host cursor --event tool.before",
            matcher: "Shell|Bash",
            failClosed: true,
          },
        ],
      },
    });
    for (const host of FIXTURE_HOSTS) {
      const toolName = shellToolPayload(host, dir).tool_name as string;
      const found = registeredHookCommand(dir, host, "tool.before", toolName);
      expect(found).toEqual({ ok: true, command: `node x.mjs --host ${host} --event tool.before` });
    }
  });

  it("reads the v0.126.2 fixture configs, resolving Grok's wrapper beside its config", () => {
    const dir = tempDir();
    const old = OLD_LAYOUT_FIXTURES.find((f) => f.id === "6a");
    old?.build(repoRoot(), dir);
    for (const host of ["claude", "codex", "cursor"] as const) {
      const toolName = shellToolPayload(host, dir).tool_name as string;
      expect(registeredHookCommand(dir, host, "tool.before", toolName)).toEqual({
        ok: true,
        command: `deft-hook --host ${host} --event tool.before`,
      });
    }
    expect(registeredHookCommand(dir, "grok", "tool.before", "Bash")).toEqual({
      ok: true,
      command: join(dir, ".grok", "hooks", "deft-pretooluse-wrapper.sh").replaceAll("\\", "/"),
    });
  });

  it("fails when a host config or its tool.before entry is missing", () => {
    const dir = tempDir();
    const missing = registeredHookCommand(dir, "claude", "tool.before", "Bash");
    expect(missing).toMatchObject({ ok: false });
    writeConfig(dir, HOST_CONFIG_PATHS.claude, { hooks: { SessionStart: [] } });
    const noEntry = registeredHookCommand(dir, "claude", "tool.before", "Bash");
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) expect(noEntry.reason).toContain("PreToolUse");
  });
});

describe("runRegisteredHook", () => {
  it("runs the registered command through sh -c in the fixture with the payload on stdin", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "hook.js"),
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{" +
        "const p=JSON.parse(s);process.stderr.write(process.cwd()+'|'+p.tool_input.command);process.exit(2)});",
      "utf8",
    );
    writeConfig(dir, HOST_CONFIG_PATHS.claude, {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node hook.js" }] }],
      },
    });
    const ran = runRegisteredHook(dir, "claude", "tool.before", shellToolPayload("claude", dir));
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.run.status).toBe(2);
    expect(ran.run.stderr).toContain("|echo hi");
    expect(ran.run.stderr.split("|")[0]).toMatch(/lifecycle-fixture-test-/);
  });
});

describe("old-layout fixtures (static, no download)", () => {
  it("covers 6a-6e and the RC-12 project-copy case, each with all four host configs", () => {
    expect(OLD_LAYOUT_FIXTURES.map((f) => f.id)).toEqual(["6a", "6b", "6c", "6d", "6e", "6g"]);
    for (const fixture of OLD_LAYOUT_FIXTURES) {
      const dir = tempDir();
      fixture.build(repoRoot(), dir);
      for (const host of FIXTURE_HOSTS) {
        expect(
          existsSync(join(dir, ...HOST_CONFIG_PATHS[host].split("/"))),
          `${fixture.id} ${host}`,
        ).toBe(true);
      }
      expect(existsSync(join(dir, ".grok", "hooks", "deft-pretooluse-wrapper.sh"))).toBe(true);
    }
  });

  it("6e registers deft hook:dispatch for Claude only", () => {
    const dir = tempDir();
    OLD_LAYOUT_FIXTURES.find((f) => f.id === "6e")?.build(repoRoot(), dir);
    expect(registeredHookCommand(dir, "claude", "tool.before", "Bash")).toEqual({
      ok: true,
      command: "deft hook:dispatch --host claude --event tool.before",
    });
    expect(registeredHookCommand(dir, "codex", "tool.before", "Bash")).toMatchObject({
      command: "deft-hook --host codex --event tool.before",
    });
  });

  it("uses the v0.126.2 Grok wrapper bytes that call the new deft-hook", () => {
    const wrapper = readFileSync(preOvprGrokWrapperPath(repoRoot()), "utf8");
    expect(wrapper).toContain('"$HOOK_BIN" --host grok --event tool.before');
  });
});

describe("cleanFixtureEnv", () => {
  it("drops Directive and agent-host variables and keeps the rest", () => {
    const env = cleanFixtureEnv({
      PATH: "/bin",
      HOME: "/h",
      DEFT_SESSION_ID: "x",
      DIRECTIVE_PROJECT_ROOT: "y",
      CLAUDECODE: "1",
      CURSOR_AGENT: "1",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("platform helpers (Windows leg, #6621)", () => {
  it("finds npm's global bins where npm puts them", () => {
    expect(globalBinDir("/p", "linux")).toBe(join("/p", "bin"));
    expect(globalBinDir("C:/p", "win32")).toBe("C:/p");
    expect(binFileName("deft-hook", "darwin")).toBe("deft-hook");
    expect(binFileName("deft-hook", "win32")).toBe("deft-hook.cmd");
  });

  it("puts the launcher bin first on PATH with the platform's key and separator", () => {
    expect(prependPath({ PATH: "/usr/bin" }, "/x", "linux")).toEqual({ PATH: "/x:/usr/bin" });
    expect(prependPath({ Path: "C:\\w" }, "C:\\x", "win32")).toEqual({ Path: "C:\\x;C:\\w" });
    expect(prependPath({}, "/x", "linux")).toEqual({ PATH: "/x" });
  });
});

describe("pin-only bump helpers (steps 1-3)", () => {
  it("bumpRuntimePin changes only the runtime pin and its lockfile entry", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        devDependencies: { "@deftai/directive-runtime": "1.0.0", other: "2.0.0" },
      }),
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": { devDependencies: { "@deftai/directive-runtime": "1.0.0", other: "2.0.0" } },
          "node_modules/@deftai/directive-runtime": { version: "1.0.0", resolved: "file:old.tgz" },
          "node_modules/other": { version: "2.0.0" },
        },
      }),
    );
    const tgz = join(dir, "w.tgz");
    writeFileSync(tgz, "bytes");
    const before = snapshotTree(dir);
    bumpRuntimePin(dir, "1.0.1", tgz);
    expect(changedPaths(before, snapshotTree(dir))).toEqual(["package-lock.json", "package.json"]);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.devDependencies).toEqual({ "@deftai/directive-runtime": "1.0.1", other: "2.0.0" });
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    expect(lock.packages[""].devDependencies["@deftai/directive-runtime"]).toBe("1.0.1");
    const entry = lock.packages["node_modules/@deftai/directive-runtime"];
    expect(entry.version).toBe("1.0.1");
    expect(entry.resolved).toBe("file:w.tgz");
    expect(entry.integrity).toMatch(/^sha512-/);
    expect(lock.packages["node_modules/other"]).toEqual({ version: "2.0.0" });
  });

  it("snapshotTree skips node_modules and .git; changedPaths lists adds, removals and edits", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "i");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "h");
    const before = snapshotTree(dir);
    expect([...before.keys()].sort()).toEqual(["a.txt", "b.txt"]);
    writeFileSync(join(dir, "a.txt"), "changed");
    rmSync(join(dir, "b.txt"));
    writeFileSync(join(dir, "c.txt"), "c");
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "changed");
    expect(changedPaths(before, snapshotTree(dir))).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});
