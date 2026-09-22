import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInstallManifest } from "../doctor/manifest.js";
import * as containedWriteMod from "../fs/contained-write.js";
import {
  defaultVersionBackupRootDir,
  detectCanonicalVendoredManifest,
  isNpmManaged,
  migrateVersionBackupName,
  NPM_MANAGED_SENTINEL_KEY,
  NPM_MANAGED_SENTINEL_VALUE,
  printMigrateNudgeIfNeeded,
  runMigrate,
  runMigrateCli,
  shouldEmitMigrateNudge,
  stampManifestText,
} from "./migrate.js";

const tmpDirs: string[] = [];

function outsideBackupRoot(projectRoot: string): string {
  const slug = projectRoot.split(/[\\/]/).pop() ?? "bak";
  const dir = join(projectRoot, "..", `migrate-bak-${slug}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeProject(manifestBody: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-test-"));
  tmpDirs.push(root);
  if (manifestBody !== null) {
    const coreDir = join(root, ".deft", "core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "VERSION"), manifestBody, "utf8");
  }
  return root;
}

const VENDORED_MANIFEST = [
  "ref: 'v0.40.0'",
  "sha: 'deadbeefcafef00ddeadbeefcafef00ddeadbeef'",
  "tag: 'v0.40.0'",
  "install_root: '.deft/core'",
  "fetched_at: '2026-06-01T00:00:00Z'",
  "fetched_by: 'deft-install'",
  "",
].join("\n");

const enginePresent = () => "/usr/lib/node_modules/@deftai/directive-content";
const engineAbsent = () => null;

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectCanonicalVendoredManifest", () => {
  it("locates the canonical .deft/core/VERSION deposit", () => {
    const root = makeProject(VENDORED_MANIFEST);
    expect(detectCanonicalVendoredManifest(root)).toBe(join(root, ".deft", "core", "VERSION"));
  });

  it("returns null when no canonical deposit is present", () => {
    const root = makeProject(null);
    expect(detectCanonicalVendoredManifest(root)).toBeNull();
  });

  it("does not normalize a legacy .deft/VERSION layout", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-test-"));
    tmpDirs.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), VENDORED_MANIFEST, "utf8");
    expect(detectCanonicalVendoredManifest(root)).toBeNull();
  });
});

describe("stampManifestText / isNpmManaged", () => {
  it("appends the sentinel and is recognized by parseInstallManifest", () => {
    const stamped = stampManifestText(VENDORED_MANIFEST);
    const manifest = parseInstallManifest(stamped);
    expect(manifest[NPM_MANAGED_SENTINEL_KEY]).toBe(NPM_MANAGED_SENTINEL_VALUE);
    expect(isNpmManaged(manifest)).toBe(true);
  });

  it("adds a trailing newline before the sentinel when one is missing", () => {
    const stamped = stampManifestText("tag: 'v0.40.0'");
    expect(stamped).toBe(
      `tag: 'v0.40.0'\n${NPM_MANAGED_SENTINEL_KEY}: '${NPM_MANAGED_SENTINEL_VALUE}'\n`,
    );
  });
});

describe("runMigrate three-state", () => {
  it("migrates a canonical-vendored deposit: stamps sentinel + writes timestamped backup", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const backupRoot = outsideBackupRoot(root);
    const result = runMigrate(root, {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T21:20:43Z",
      backupRootDir: () => backupRoot,
    });

    expect(result.outcome).toBe("migrated");
    expect(result.exitCode).toBe(0);
    expect(result.sentinelKey).toBe(NPM_MANAGED_SENTINEL_KEY);

    const manifestPath = join(root, ".deft", "core", "VERSION");
    const manifest = parseInstallManifest(readFileSync(manifestPath, "utf8"));
    expect(isNpmManaged(manifest)).toBe(true);
    // existing provenance fields are preserved (shape unchanged, fields only added)
    expect(manifest.ref).toBe("v0.40.0");
    expect(manifest.sha).toBe("deadbeefcafef00ddeadbeefcafef00ddeadbeef");

    const backupFile = join(backupRoot, migrateVersionBackupName(root, "2026-06-24T21-20-43Z"));
    expect(result.backupPath).toBe(backupFile);
    expect(existsSync(backupFile)).toBe(true);
    expect(existsSync(join(root, ".deft", "core", "VERSION.bak.2026-06-24T21-20-43Z"))).toBe(false);
    expect(existsSync(join(root, ".deft", "backups"))).toBe(false);
    // backup captures the pre-stamp content
    expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(VENDORED_MANIFEST);
  });

  it("is idempotent: second run is already-hybrid no-op (exit 0, no new backup)", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const backupRoot = outsideBackupRoot(root);
    runMigrate(root, {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T21:20:43Z",
      backupRootDir: () => backupRoot,
    });

    const second = runMigrate(root, {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T22:00:00Z",
      backupRootDir: () => backupRoot,
    });
    expect(second.outcome).toBe("already-hybrid");
    expect(second.exitCode).toBe(0);
    expect(second.backupPath).toBeNull();
    // no backup at the second timestamp was created
    expect(existsSync(join(root, ".deft", "core", "VERSION.bak.2026-06-24T22-00-00Z"))).toBe(false);
    expect(existsSync(join(backupRoot, "VERSION.bak.2026-06-24T22-00-00Z"))).toBe(false);
  });

  it("engine-missing: signposts README and exits 1 without stamping or downloading", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const result = runMigrate(root, { resolveEngine: engineAbsent });

    expect(result.outcome).toBe("engine-missing");
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("npm i -g @deftai/directive");
    expect(result.backupPath).toBeNull();

    // manifest is untouched -- not stamped
    const manifest = parseInstallManifest(
      readFileSync(join(root, ".deft", "core", "VERSION"), "utf8"),
    );
    expect(isNpmManaged(manifest)).toBe(false);
  });

  it("config error: no canonical-vendored deposit found exits 2", () => {
    const root = makeProject(null);
    const result = runMigrate(root, { resolveEngine: enginePresent });
    expect(result.outcome).toBe("no-deposit");
    expect(result.exitCode).toBe(2);
    expect(result.manifestPath).toBeNull();
  });

  it("config error: unreadable/empty manifest exits 2", () => {
    const root = makeProject("");
    const result = runMigrate(root, { resolveEngine: enginePresent });
    expect(result.outcome).toBe("manifest-unreadable");
    expect(result.exitCode).toBe(2);
  });

  it("config error: a failed manifest read (readText null) exits 2", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const result = runMigrate(root, { resolveEngine: enginePresent, readText: () => null });
    expect(result.outcome).toBe("manifest-unreadable");
    expect(result.exitCode).toBe(2);
  });

  it("does not move/rename .deft/core content (shape unchanged)", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const skillPath = join(root, ".deft", "core", "skills", "marker.txt");
    mkdirSync(join(root, ".deft", "core", "skills"), { recursive: true });
    writeFileSync(skillPath, "content", "utf8");

    const backupRoot = outsideBackupRoot(root);
    runMigrate(root, {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T21:20:43Z",
      backupRootDir: () => backupRoot,
    });

    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toBe("content");
  });
});

describe("runMigrateCli", () => {
  it("prints success to stdout and returns 0 (human output)", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const out: string[] = [];
    const err: string[] = [];
    const code = runMigrateCli({
      projectDir: root,
      jsonOut: false,
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: {
        resolveEngine: enginePresent,
        nowIso: () => "2026-06-24T21:20:43Z",
        backupRootDir: () => outsideBackupRoot(root),
      },
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("stamped");
    expect(err.join("")).toBe("");
  });

  it("prints the README signpost to stderr and returns 1 on engine-missing", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const out: string[] = [];
    const err: string[] = [];
    const code = runMigrateCli({
      projectDir: root,
      jsonOut: false,
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: { resolveEngine: engineAbsent },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("npm i -g @deftai/directive");
  });

  it("emits structured JSON and returns the exit code on --json", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const out: string[] = [];
    const code = runMigrateCli({
      projectDir: root,
      jsonOut: true,
      writeOut: (t) => out.push(t),
      writeErr: () => {},
      seams: {
        resolveEngine: enginePresent,
        nowIso: () => "2026-06-24T21:20:43Z",
        backupRootDir: () => outsideBackupRoot(root),
      },
    });
    expect(code).toBe(0);
    const parsedUnknown: unknown = JSON.parse(out.join(""));
    expect(parsedUnknown).not.toBeNull();
    expect(typeof parsedUnknown).toBe("object");
    const parsed = parsedUnknown as Record<string, unknown>;
    expect(parsed.action).toBe("migrate");
    expect(parsed.outcome).toBe("migrated");
    expect(parsed.sentinel_key).toBe(NPM_MANAGED_SENTINEL_KEY);
    expect(parsed.sentinel_value).toBe(NPM_MANAGED_SENTINEL_VALUE);
  });
});

describe("shouldEmitMigrateNudge / printMigrateNudgeIfNeeded (#2059)", () => {
  it("returns true for canonical-vendored deposit without npm sentinel", () => {
    const root = makeProject(VENDORED_MANIFEST);
    expect(shouldEmitMigrateNudge(root)).toBe(true);
  });

  it("returns false when deposit is already npm-managed", () => {
    const root = makeProject(
      `${VENDORED_MANIFEST}${NPM_MANAGED_SENTINEL_KEY}: '${NPM_MANAGED_SENTINEL_VALUE}'\n`,
    );
    expect(shouldEmitMigrateNudge(root)).toBe(false);
  });

  it("returns false when no canonical deposit exists", () => {
    const root = makeProject(null);
    expect(shouldEmitMigrateNudge(root)).toBe(false);
  });

  it("returns false when manifest is empty or unreadable", () => {
    const emptyRoot = makeProject("");
    expect(shouldEmitMigrateNudge(emptyRoot)).toBe(false);

    const root = makeProject(VENDORED_MANIFEST);
    expect(shouldEmitMigrateNudge(root, { readText: () => null })).toBe(false);
  });

  it("printMigrateNudgeIfNeeded emits the one-line nudge when needed", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const lines: string[] = [];
    printMigrateNudgeIfNeeded(root, { printf: (text) => lines.push(text) });
    expect(lines.join("")).toContain("directive migrate");
    expect(lines.join("")).toContain("idempotent");
  });

  it("printMigrateNudgeIfNeeded is silent when already hybrid", () => {
    const root = makeProject(
      `${VENDORED_MANIFEST}${NPM_MANAGED_SENTINEL_KEY}: '${NPM_MANAGED_SENTINEL_VALUE}'\n`,
    );
    const lines: string[] = [];
    printMigrateNudgeIfNeeded(root, { printf: (text) => lines.push(text) });
    expect(lines.join("")).toBe("");
  });
});

describe("VERSION backup stays outside the deposit (#4812)", () => {
  it("uses the user-cache deft/backups root", () => {
    const winLocal = join("C:", "Users", "me", "AppData", "Local");
    expect(defaultVersionBackupRootDir({ LOCALAPPDATA: winLocal }, "win32")).toBe(
      join(winLocal, "deft", "backups"),
    );
    expect(defaultVersionBackupRootDir({ HOME: "/home/me" }, "linux")).toBe(
      join("/home/me", ".cache", "deft", "backups"),
    );
    expect(
      defaultVersionBackupRootDir({ XDG_CACHE_HOME: "/var/cache", HOME: "/home/me" }, "linux"),
    ).toBe(join("/var/cache", "deft", "backups"));
    expect(defaultVersionBackupRootDir({ HOME: "/Users/me" }, "darwin")).toBe(
      join("/Users/me", "Library", "Caches", "deft", "backups"),
    );
  });

  it("does not write VERSION.bak under the project or .deft/backups", () => {
    const project = makeProject(VENDORED_MANIFEST);
    const inTree = join(project, ".deft", "backups");
    const result = runMigrate(project, {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T21:20:43Z",
      backupRootDir: () => inTree,
    });
    const backup = result.backupPath ?? "";
    expect(backup.length).toBeGreaterThan(0);
    expect(relative(resolve(project), resolve(backup)).startsWith("..")).toBe(true);
    expect(existsSync(join(project, ".deft", "core", "VERSION.bak.2026-06-24T21-20-43Z"))).toBe(
      false,
    );
    expect(existsSync(join(inTree, "VERSION.bak.2026-06-24T21-20-43Z"))).toBe(false);
    expect(readFileSync(backup, "utf8")).toBe(VENDORED_MANIFEST);
  });

  it("keeps two projects in the same second from sharing one backup (#4812)", () => {
    const firstRoot = makeProject(VENDORED_MANIFEST);
    const secondRoot = makeProject(`${VENDORED_MANIFEST}note: 'other'\n`);
    const backupRoot = outsideBackupRoot(firstRoot);
    const suffix = "2026-06-24T21-20-43Z";
    const seams = {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T21:20:43Z",
      backupRootDir: () => backupRoot,
    };
    const first = runMigrate(firstRoot, seams);
    const second = runMigrate(secondRoot, seams);
    expect(first.backupPath).toBe(join(backupRoot, migrateVersionBackupName(firstRoot, suffix)));
    expect(second.backupPath).toBe(join(backupRoot, migrateVersionBackupName(secondRoot, suffix)));
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(readFileSync(first.backupPath ?? "", "utf8")).toBe(VENDORED_MANIFEST);
    expect(readFileSync(second.backupPath ?? "", "utf8")).toContain("note: 'other'");
  });

  it("does not overwrite an existing backup for the same project and second (#4812)", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const backupRoot = outsideBackupRoot(root);
    const existing = join(backupRoot, migrateVersionBackupName(root, "2026-06-24T21-20-43Z"));
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(existing, "KEEP\n", "utf8");
    const result = runMigrate(root, {
      resolveEngine: enginePresent,
      nowIso: () => "2026-06-24T21:20:43Z",
      backupRootDir: () => backupRoot,
    });
    expect(readFileSync(existing, "utf8")).toBe("KEEP\n");
    expect(result.backupPath).not.toBe(existing);
    expect(existsSync(result.backupPath ?? "")).toBe(true);
    expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(VENDORED_MANIFEST);
    expect(relative(resolve(root), resolve(result.backupPath ?? "")).startsWith("..")).toBe(true);
  });

  it("retries another name when the first exclusive create returns EXISTS (#4812)", () => {
    const root = makeProject(VENDORED_MANIFEST);
    const backupRoot = outsideBackupRoot(root);
    const suffix = "2026-06-24T21-20-43Z";
    const first = join(backupRoot, migrateVersionBackupName(root, suffix));
    const created: string[] = [];
    const realWrite = containedWriteMod.containedWrite;
    const spy = vi.spyOn(containedWriteMod, "containedWrite").mockImplementation((input) => {
      if (input.mode !== "create") return realWrite(input);
      created.push(String(input.target));
      if (created.length === 1) {
        throw new containedWriteMod.ContainedWriteError(
          `contained write refused: target ${String(input.target)} already exists (mode=create)`,
          {
            code: containedWriteMod.ContainedWriteErrorCode.EXISTS,
            root: String(input.root),
            target: String(input.target),
          },
        );
      }
      return realWrite(input);
    });
    try {
      const result = runMigrate(root, {
        resolveEngine: enginePresent,
        nowIso: () => "2026-06-24T21:20:43Z",
        backupRootDir: () => backupRoot,
      });
      expect(created).toHaveLength(2);
      expect(created[0]).toBe(first);
      expect(created[1]).not.toBe(first);
      expect(created[1]).toBe(
        join(backupRoot, `${migrateVersionBackupName(root, suffix)}.${process.pid}.1`),
      );
      expect(result.outcome).toBe("migrated");
      expect(result.exitCode).toBe(0);
      expect(result.backupPath).toBe(created[1]);
      expect(existsSync(first)).toBe(false);
      expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(VENDORED_MANIFEST);
      expect(relative(resolve(root), resolve(result.backupPath ?? "")).startsWith("..")).toBe(true);
      expect(result.backupPath ?? "").not.toContain(join(".deft", "core"));
      const stamped = readFileSync(join(root, ".deft", "core", "VERSION"), "utf8");
      expect(isNpmManaged(parseInstallManifest(stamped))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
