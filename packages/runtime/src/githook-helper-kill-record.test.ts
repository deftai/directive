/**
 * Git-hook helper kill record check (#6740): shell tests, git, tr and grep -qxF
 * before any runtime or node lookup; one warning per hook; the reader marker.
 */
import { execFileSync, spawnSync } from "node:child_process";
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
import { join } from "node:path";
import {
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_BARE_FLAG_WARNING,
  KILL_SWITCH_GITHOOK_MARKER,
} from "@deftai/directive-core/dist/policy/kill-switch-record.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DIRECTIVE_GIT_HOOK_BODIES } from "./setup-wiring.js";

const HELPER_REL = ".githooks/_directive-run.sh";
const HELPER = join(process.cwd(), HELPER_REL);

function findSh(): string | null {
  if (process.platform !== "win32") return existsSync("/bin/sh") ? "/bin/sh" : null;
  for (const c of [
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files\\Git\\bin\\sh.exe",
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const SH = findSh();

/** PATH with git, grep, tr and sh but no node. */
function noNodePath(): string {
  if (process.platform === "win32") {
    return ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\usr\\bin"].join(";");
  }
  const bin = mkdtempSync(join(tmpdir(), "w6740c1-hbin-"));
  for (const tool of ["git", "grep", "tr"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

function runHelper(root: string, pathEnv: string, body: string) {
  const env: NodeJS.ProcessEnv = { REPO_ROOT: root, HELPER_PATH: HELPER, PATH: pathEnv };
  if (process.platform === "win32") env.SYSTEMROOT = process.env.SYSTEMROOT;
  return spawnSync(SH as string, ["-c", `. "$HELPER_PATH"\n${body}`], { env, encoding: "utf8" });
}

describe("git-hook helper deposit (#6740)", () => {
  it("the committed helper equals the deposited body and carries the reader marker", () => {
    const body = DIRECTIVE_GIT_HOOK_BODIES[HELPER_REL];
    expect(readFileSync(HELPER, "utf8")).toBe(body);
    expect(body?.split("\n")).toContain(KILL_SWITCH_GITHOOK_MARKER);
  });

  it("checks the record before it looks for the runtime or node", () => {
    const body = DIRECTIVE_GIT_HOOK_BODIES[HELPER_REL] ?? "";
    const runDirective = body.slice(body.indexOf("run_directive() {"));
    const recordAt = runDirective.indexOf("_directive_kill_record");
    expect(recordAt).toBeGreaterThan(0);
    expect(recordAt).toBeLessThan(runDirective.indexOf("RUNTIME_BIN="));
    expect(recordAt).toBeLessThan(runDirective.indexOf('node "$RUNTIME_BIN"'));
    expect(body).toContain("grep -qxF");
    expect(body).not.toContain("ls-files");
  });
});

describe.skipIf(SH === null)("git-hook helper with no node on PATH (#6740)", () => {
  let root = "";
  let pathEnv = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "w6740c1-helper-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    pathEnv = noNodePath();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function gitDir(): string {
    return execFileSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).replace(/\n+$/, "");
  }

  it("stands down on a valid record with no node and no node_modules", () => {
    expect(runHelper(root, pathEnv, "command -v node").status).not.toBe(0);
    mkdirSync(join(root, ".deft", "authz"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "authz", "kill-switch.disable"),
      `schema=deft.kill-switch.v1\ngitDir=${gitDir()}\n`,
    );
    const r = runHelper(root, pathEnv, "run_directive verify:branch && echo STOOD_DOWN\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STOOD_DOWN");
    expect(r.stderr).toBe("");
    rmSync(join(root, ".deft"), { recursive: true, force: true });
  });

  it("a bare flag keeps the hook enforcing (runtime missing stops it)", () => {
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    const r = runHelper(root, pathEnv, "_directive_kill_record\nrun_directive verify:branch\n");
    rmSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), { force: true });
    expect(r.stdout.trim()).toBe("absent");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(KILL_SWITCH_BARE_FLAG_WARNING);
    expect(r.stderr).toContain("@deftai/directive-runtime is not installed");
  });

  it("a bare flag warns once per hook across several run_directive calls", () => {
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    // A runtime file is present, so each call reaches the runtime step (node is
    // not on PATH, so the call fails and the hook goes on to the next one).
    const dist = join(root, "node_modules", "@deftai", "directive-runtime", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "bin.js"), "\n");
    const r = runHelper(
      root,
      pathEnv,
      "run_directive verify:branch; run_directive verify:encoding; echo DONE\n",
    );
    rmSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), { force: true });
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    expect(r.stdout).toContain("DONE");
    const warnings = r.stderr.split("\n").filter((l) => l === KILL_SWITCH_BARE_FLAG_WARNING);
    expect(warnings).toHaveLength(1);
  });
});
