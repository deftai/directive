/**
 * Kill record contract (#6740): the plain-line record, the exact whole-line
 * reader, the shared fixture cases (Node reader and shell reader agree), the
 * atomic write and the off removal.
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
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectDeftDirectiveDisable, resolveAbsoluteGitDir } from "./deft-directive-disable.js";
import {
  evaluateKillSwitchRecordText,
  formatKillSwitchRecord,
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_BARE_FLAG_WARNING,
  KILL_SWITCH_RECORD_REL,
  KILL_SWITCH_RECORD_SCHEMA_LINE,
  killSwitchRecordPath,
  killSwitchWarning,
  readKillSwitchRecord,
  removeKillSwitchRecord,
  trimGitOutput,
  writeKillSwitchRecord,
} from "./kill-switch-record.js";

interface KillCase {
  readonly name: string;
  readonly kind: "file" | "symlink" | "dir";
  readonly eol: "lf" | "crlf";
  readonly finalNewline?: boolean;
  readonly lines: readonly string[];
  readonly valid: boolean;
}

const CASES = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "kill-switch-record-cases.json"), "utf8"),
  ) as { cases: KillCase[] }
).cases;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gitRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

function gitDirOf(root: string): string {
  const dir = resolveAbsoluteGitDir(root);
  if (dir === null) throw new Error(`no git dir for ${root}`);
  return dir;
}

/** Write one shared case at the record path; false when links are unavailable. */
function materialize(root: string, c: KillCase, gitDir: string, otherGitDir: string): boolean {
  const rec = killSwitchRecordPath(root);
  mkdirSync(dirname(rec), { recursive: true });
  rmSync(rec, { recursive: true, force: true });
  const eol = c.eol === "crlf" ? "\r\n" : "\n";
  const lines = c.lines.map((l) =>
    l.replaceAll("{gitDir}", gitDir).replaceAll("{otherGitDir}", otherGitDir),
  );
  const body = lines.length === 0 ? "" : lines.join(eol) + (c.finalNewline === false ? "" : eol);
  if (c.kind === "dir") {
    mkdirSync(rec);
    return true;
  }
  if (c.kind === "symlink") {
    const target = join(dirname(rec), "link-target.txt");
    writeFileSync(target, body);
    try {
      symlinkSync(target, rec, "file");
    } catch {
      return false;
    }
    return true;
  }
  writeFileSync(rec, body);
  return true;
}

function findSh(): string | null {
  if (process.platform !== "win32") return existsSync("/bin/sh") ? "/bin/sh" : null;
  for (const candidate of [
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files\\Git\\bin\\sh.exe",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HELPER = join(process.cwd(), ".githooks", "_directive-run.sh");
const SH = findSh();

/** Shell reader verdict: the git-hook helper's `_directive_kill_record`. */
function shellVerdict(root: string): string {
  const script = `. "$HELPER_PATH"\n_directive_kill_record\n`;
  const r = spawnSync(SH as string, ["-c", script], {
    env: { ...process.env, REPO_ROOT: root, HELPER_PATH: HELPER },
    encoding: "utf8",
  });
  return String(r.stdout).trim();
}

describe("kill record format (#6740)", () => {
  it("writes plain lines: schema, gitDir, mintedAt, mintedVia", () => {
    expect(
      formatKillSwitchRecord({
        gitDir: "/repo/.git",
        mintedAt: "2026-11-22T00:00:00Z",
        mintedVia: "kill-switch:on",
      }),
    ).toBe(
      "schema=deft.kill-switch.v1\ngitDir=/repo/.git\nmintedAt=2026-11-22T00:00:00Z\nmintedVia=kill-switch:on\n",
    );
    expect(KILL_SWITCH_RECORD_REL).toBe(".deft/authz/kill-switch.disable");
    expect(KILL_SWITCH_RECORD_SCHEMA_LINE).toBe("schema=deft.kill-switch.v1");
  });

  it("strips trailing newlines only from git output, as sh $(...) does", () => {
    expect(trimGitOutput("/repo/.git\n")).toBe("/repo/.git");
    expect(trimGitOutput("/repo/.git\n\n")).toBe("/repo/.git");
    expect(trimGitOutput("/repo/.git\r\n")).toBe("/repo/.git\r");
    expect(trimGitOutput(" /repo/.git \n")).toBe(" /repo/.git ");
  });

  it("judges exact whole lines only", () => {
    const ok = "schema=deft.kill-switch.v1\ngitDir=/r/.git\nmintedAt=t\nmintedVia=v\n";
    expect(evaluateKillSwitchRecordText(ok, "/r/.git")).toEqual({
      kind: "valid",
      mintedAt: "t",
      mintedVia: "v",
    });
    expect(evaluateKillSwitchRecordText(ok, "/other/.git")).toEqual({
      kind: "invalid",
      reason: "git-dir-mismatch",
    });
    expect(evaluateKillSwitchRecordText(ok, null)).toEqual({
      kind: "invalid",
      reason: "git-dir-unresolved",
    });
    expect(evaluateKillSwitchRecordText("gitDir=/r/.git\n", "/r/.git")).toEqual({
      kind: "invalid",
      reason: "missing-schema-line",
    });
  });
});

describe("shared kill record cases (#6740)", () => {
  // One checkout and one foreign checkout for every case; each case rewrites the record.
  let root = "";
  let other = "";
  let gitDir = "";
  let otherGitDir = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "w6740c1-rec-"));
    other = mkdtempSync(join(tmpdir(), "w6740c1-other-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["init", "-q"], { cwd: other, stdio: "ignore" });
    gitDir = gitDirOf(root);
    otherGitDir = gitDirOf(other);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it.for(CASES.map((c) => [c.name, c] as const))("Node reader: %s", ([, c], ctx) => {
    if (!materialize(root, c, gitDir, otherGitDir)) {
      ctx.skip();
      return;
    }
    const verdict = readKillSwitchRecord(root, resolveAbsoluteGitDir);
    expect(verdict.kind === "valid").toBe(c.valid);
    expect(detectDeftDirectiveDisable(root).active).toBe(c.valid);
    expect(killSwitchWarning(verdict, false) === null).toBe(c.valid);
  });

  it.skipIf(SH === null).for(CASES.map((c) => [c.name, c] as const))(
    "shell reader agrees with the Node reader: %s",
    ([, c], ctx) => {
      if (!materialize(root, c, gitDir, otherGitDir)) {
        ctx.skip();
        return;
      }
      const node = readKillSwitchRecord(root, resolveAbsoluteGitDir);
      const shell = shellVerdict(root);
      expect(shell === "valid").toBe(c.valid);
      expect(shell).toBe(node.kind === "invalid" ? node.reason : node.kind);
    },
  );
});

describe("kill record write and removal (#6740)", () => {
  it("publishes the record atomically and reads it back as valid", () => {
    const root = gitRepo("w6740c1-write-");
    const gitDir = gitDirOf(root);
    const result = writeKillSwitchRecord(root, {
      gitDir,
      mintedAt: "2026-11-22T00:00:00Z",
      mintedVia: "kill-switch:on",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(killSwitchRecordPath(root), "utf8")).toContain(`gitDir=${gitDir}\n`);
    expect(readKillSwitchRecord(root, resolveAbsoluteGitDir)).toEqual({
      kind: "valid",
      mintedAt: "2026-11-22T00:00:00Z",
      mintedVia: "kill-switch:on",
    });
  });

  it("removes only the record file and reports when there was none", () => {
    const root = gitRepo("w6740c1-remove-");
    writeKillSwitchRecord(root, { gitDir: gitDirOf(root), mintedAt: "t", mintedVia: "v" });
    const neighbour = join(dirname(killSwitchRecordPath(root)), "state.json");
    writeFileSync(neighbour, "{}\n");
    expect(removeKillSwitchRecord(root)).toMatchObject({ ok: true, changed: true });
    expect(existsSync(killSwitchRecordPath(root))).toBe(false);
    expect(existsSync(neighbour)).toBe(true);
    expect(removeKillSwitchRecord(root)).toMatchObject({ ok: true, changed: false });
  });

  it("a record copied into another checkout leaves enforcement on", () => {
    const first = gitRepo("w6740c1-first-");
    const second = gitRepo("w6740c1-second-");
    writeKillSwitchRecord(first, { gitDir: gitDirOf(first), mintedAt: "t", mintedVia: "v" });
    mkdirSync(dirname(killSwitchRecordPath(second)), { recursive: true });
    writeFileSync(killSwitchRecordPath(second), readFileSync(killSwitchRecordPath(first)));
    expect(detectDeftDirectiveDisable(second).active).toBe(false);
    expect(detectDeftDirectiveDisable(second).warning).toContain("git-dir-mismatch");
  });
});

describe("bare flag (#6740)", () => {
  it("turns nothing off and gives one warning naming the file and the on verb", () => {
    const root = gitRepo("w6740c1-flag-");
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    const state = detectDeftDirectiveDisable(root);
    expect(state.present).toBe(true);
    expect(state.active).toBe(false);
    expect(state.warning).toBe(KILL_SWITCH_BARE_FLAG_WARNING);
    expect(state.warning).toContain(KILL_SWITCH_BARE_FLAG_NAME);
    expect(state.warning).toContain("kill-switch:on");
  });

  it("a tracked flag still never disables", () => {
    const root = gitRepo("w6740c1-tracked-");
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    execFileSync("git", ["add", "--", KILL_SWITCH_BARE_FLAG_NAME], { cwd: root, stdio: "ignore" });
    const state = detectDeftDirectiveDisable(root, { skipTrackedCache: true });
    expect(state.trackedByGit).toBe(true);
    expect(state.active).toBe(false);
  });

  it("a valid record with the flag also present stands down without a warning", () => {
    const root = gitRepo("w6740c1-both-");
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    writeKillSwitchRecord(root, { gitDir: gitDirOf(root), mintedAt: "t", mintedVia: "v" });
    const state = detectDeftDirectiveDisable(root);
    expect(state.active).toBe(true);
    expect(state.warning).toBeNull();
  });
});
