/**
 * Paired ROADMAP/CHANGELOG prepare + write through retained descriptors (#4318).
 *
 * Do not use containedWrite create|replace|append for these two sinks.
 * native-steps is not the ROADMAP writer on this path.
 */

import { execFileSync } from "node:child_process";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ContainedWriteError, containedOpenExclusive } from "../fs/contained-write.js";
import { resolveLifecycleFolder } from "../layout/resolve.js";
import { renderRoadmapToBufferResult } from "../render/roadmap-render.js";
import { promoteChangelog } from "./changelog.js";
import {
  type ChangelogSafetyFail,
  type ChangelogSafetyResult,
  changelogPathOf,
  classifyReleaseLeaf,
  roadmapPathOf,
  safetyFail,
  symlinkAncestorFloor,
} from "./changelog-read-safety.js";
import { EXIT_CONFIG_ERROR, EXIT_VIOLATION } from "./constants.js";

export type FileIdentity = { readonly dev: bigint; readonly ino: bigint };

export type PreparedArtifacts = {
  readonly projectRoot: string;
  readonly changelogPath: string;
  readonly roadmapPath: string;
  readonly changelogBytes: Buffer;
  readonly roadmapBytes: Buffer;
  readonly changelogFd: number | null;
  readonly roadmapFd: number | null;
  readonly missingRoadmapParent: FileIdentity | null;
  readonly missingRoadmapParentFd: number | null;
};

export type PrepareOk = { readonly ok: true; readonly prepared: PreparedArtifacts };
export type PrepareResult = PrepareOk | ChangelogSafetyFail;

export type WriteArtifactsOk = { readonly ok: true };
export type WriteArtifactsFail = ChangelogSafetyFail & {
  readonly changelogMutated: boolean;
};
export type WriteArtifactsResult = WriteArtifactsOk | WriteArtifactsFail;

export interface PrepareReleaseArtifactsInput {
  readonly projectRoot: string;
  readonly version: string;
  readonly repo: string;
  readonly today: string;
  readonly summary: string | null;
  readonly dryRun: boolean;
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed or invalid
  }
}

export function closePreparedArtifacts(prepared: PreparedArtifacts): void {
  if (prepared.changelogFd !== null) closeQuiet(prepared.changelogFd);
  if (prepared.roadmapFd !== null) closeQuiet(prepared.roadmapFd);
  if (prepared.missingRoadmapParentFd !== null) closeQuiet(prepared.missingRoadmapParentFd);
}

function bigintStatsOrFail(stats: BigIntStats, label: string): ChangelogSafetyFail | FileIdentity {
  if (
    typeof stats.nlink !== "bigint" ||
    typeof stats.dev !== "bigint" ||
    typeof stats.ino !== "bigint"
  ) {
    return safetyFail(
      EXIT_VIOLATION,
      "bigint-unavailable",
      `${label}: bigint nlink/dev/ino is required; refuse closed`,
    );
  }
  if (stats.nlink !== 1n) {
    return safetyFail(
      EXIT_VIOLATION,
      "nlink",
      `${label} is not singly linked (nlink=${stats.nlink.toString()})`,
    );
  }
  return { dev: stats.dev, ino: stats.ino };
}

type ExistingOk = { readonly kind: "ok"; readonly identity: FileIdentity };
type ExistingMissing = { readonly kind: "missing" };
type ExistingResult = ExistingOk | ExistingMissing | ChangelogSafetyFail;

function inspectExistingOutput(path: string, label: string): ExistingResult {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", `${label}: ${msg}`);
  }
  const leaf = classifyReleaseLeaf(stats);
  if (leaf !== null) {
    return safetyFail(
      EXIT_VIOLATION,
      leaf,
      `${label} is a ${leaf} node; destinations must be regular files`,
    );
  }
  const ident = bigintStatsOrFail(stats, label);
  if ("ok" in ident) return ident;
  return { kind: "ok", identity: ident };
}

function identitiesMatch(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function parentDirectoryIdentity(
  childPath: string,
  label: string,
): FileIdentity | ChangelogSafetyFail {
  const parent = dirname(childPath);
  let stats: BigIntStats;
  try {
    stats = lstatSync(parent, { bigint: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", `${label} parent: ${msg}`);
  }
  if (stats.isSymbolicLink()) {
    return safetyFail(EXIT_VIOLATION, "symlink", `${label} parent is a symlink`);
  }
  if (!stats.isDirectory()) {
    return safetyFail(EXIT_VIOLATION, "not-file", `${label} parent is not a directory`);
  }
  if (typeof stats.dev !== "bigint" || typeof stats.ino !== "bigint") {
    return safetyFail(
      EXIT_VIOLATION,
      "bigint-unavailable",
      `${label} parent: bigint dev/ino is required; refuse closed`,
    );
  }
  return { dev: stats.dev, ino: stats.ino };
}

function parentDirOpenFlags(): number {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_DIRECTORY === "number") flags |= constants.O_DIRECTORY;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  return flags;
}

function inodePathOfDirFd(dirFd: number): string | null {
  if (process.platform === "linux") {
    return `/proc/self/fd/${String(dirFd)}`;
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-w", "-p", String(process.pid), "-d", String(dirFd), "-Fn"],
        { encoding: "utf8", timeout: 5000 },
      );
      const line = out.split("\n").find((row) => row.startsWith("n"));
      return line === undefined ? null : line.slice(1);
    } catch {
      return null;
    }
  }
  return null;
}

function createdBelongsToParent(
  createdFd: number,
  parentFd: number,
  inodePath: string | null,
  childName: string,
): { ok: true } | ChangelogSafetyFail {
  let created: BigIntStats;
  let parent: BigIntStats;
  try {
    created = fstatSync(createdFd, { bigint: true });
    parent = fstatSync(parentFd, { bigint: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", `created ROADMAP.md identity check failed: ${msg}`);
  }
  const createdIdent = bigintStatsOrFail(created, "ROADMAP.md created descriptor");
  if ("ok" in createdIdent) return createdIdent;
  if (!parent.isDirectory()) {
    return safetyFail(
      EXIT_VIOLATION,
      "not-file",
      "ROADMAP.md parent descriptor is not a directory",
    );
  }
  if (inodePath === null) {
    return { ok: true };
  }
  try {
    const parentNow = lstatSync(inodePath, { bigint: true });
    const procFdParent = inodePath.startsWith("/proc/self/fd/");
    if (!procFdParent && parentNow.isSymbolicLink()) {
      return safetyFail(
        EXIT_VIOLATION,
        "symlink",
        "ROADMAP.md parent path is a symlink after create",
      );
    }
    if (typeof parentNow.dev !== "bigint" || typeof parentNow.ino !== "bigint") {
      return safetyFail(
        EXIT_VIOLATION,
        "bigint-unavailable",
        "ROADMAP.md parent path bigint identity required",
      );
    }
    if (
      !procFdParent &&
      !identitiesMatch(
        { dev: parentNow.dev, ino: parentNow.ino },
        { dev: parent.dev, ino: parent.ino },
      )
    ) {
      return safetyFail(
        EXIT_VIOLATION,
        "pair-identity",
        "created ROADMAP.md parent path is not the retained directory",
      );
    }
    const childNow = lstatSync(join(inodePath, childName), { bigint: true });
    if (typeof childNow.dev !== "bigint" || typeof childNow.ino !== "bigint") {
      return safetyFail(
        EXIT_VIOLATION,
        "bigint-unavailable",
        "created ROADMAP.md path bigint identity required",
      );
    }
    if (!identitiesMatch({ dev: childNow.dev, ino: childNow.ino }, createdIdent)) {
      return safetyFail(
        EXIT_VIOLATION,
        "pair-identity",
        "created ROADMAP.md descriptor is not the file in the retained parent",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(
      EXIT_VIOLATION,
      "pair-identity",
      `created ROADMAP.md is not in the retained parent: ${msg}`,
    );
  }
  return { ok: true };
}

function openExclusiveAtParentFd(
  parentFd: number,
  childName: string,
  projectRoot: string,
): { ok: true; fd: number } | ChangelogSafetyFail {
  if (childName !== "ROADMAP.md") {
    return safetyFail(EXIT_VIOLATION, "unsafe", `refusing create of ${childName}`);
  }
  try {
    const pst = fstatSync(parentFd, { bigint: true });
    if (!pst.isDirectory()) {
      return safetyFail(
        EXIT_VIOLATION,
        "not-file",
        "ROADMAP.md parent descriptor is not a directory",
      );
    }
    const inodePath = inodePathOfDirFd(parentFd);
    let fd: number;
    if (inodePath !== null) {
      fd = openSync(join(inodePath, childName), createOpenFlags());
    } else {
      fd = containedOpenExclusive({
        root: projectRoot,
        target: childName,
        mkdir: false,
      }).fd;
    }
    const owned = createdBelongsToParent(fd, parentFd, inodePath, childName);
    if (!owned.ok) {
      closeQuiet(fd);
      return owned;
    }
    return { ok: true, fd };
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      const code = err.code === "CONTAINED_WRITE_SYMLINK" ? "symlink" : "roadmap-create";
      return safetyFail(EXIT_VIOLATION, code, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "roadmap-create", `ROADMAP.md create failed: ${msg}`);
  }
}

function nontruncOpenFlags(): number {
  let flags = constants.O_RDWR;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  return flags;
}

function readonlyOpenFlags(): number {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  return flags;
}

function createOpenFlags(): number {
  let flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  return flags;
}

function inspectFd(fd: number, expected: FileIdentity, label: string): ChangelogSafetyResult {
  let stats: BigIntStats;
  try {
    stats = fstatSync(fd, { bigint: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", `${label} fstat failed: ${msg}`);
  }
  if (!stats.isFile()) {
    return safetyFail(
      EXIT_VIOLATION,
      "not-file",
      `${label} retained descriptor is not a regular file`,
    );
  }
  const ident = bigintStatsOrFail(stats, `${label} retained descriptor`);
  if ("ok" in ident) return ident;
  if (!identitiesMatch(ident, expected)) {
    return safetyFail(
      EXIT_VIOLATION,
      "pair-identity",
      `${label} retained descriptor identity drifted before write`,
    );
  }
  return { ok: true };
}

function openExisting(path: string): { ok: true; fd: number } | ChangelogSafetyFail {
  try {
    return { ok: true, fd: openSync(path, nontruncOpenFlags()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "open", `failed to open ${path}: ${msg}`);
  }
}

export function prepareReleaseArtifacts(input: PrepareReleaseArtifactsInput): PrepareResult {
  const changelogPath = changelogPathOf(input.projectRoot);
  const roadmapPath = roadmapPathOf(input.projectRoot);

  const clFloor = symlinkAncestorFloor(input.projectRoot, changelogPath);
  if (!clFloor.ok) return clFloor;
  const rmFloor = symlinkAncestorFloor(input.projectRoot, roadmapPath);
  if (!rmFloor.ok) return rmFloor;

  const cl = inspectExistingOutput(changelogPath, "CHANGELOG.md");
  if (!("kind" in cl)) return cl;
  if (cl.kind === "missing") {
    return safetyFail(EXIT_CONFIG_ERROR, "missing", `CHANGELOG.md not found at ${changelogPath}`);
  }

  const rm = inspectExistingOutput(roadmapPath, "ROADMAP.md");
  if (!("kind" in rm)) return rm;

  let missingRoadmapParent: FileIdentity | null = null;
  if (rm.kind === "missing") {
    const parent = parentDirectoryIdentity(roadmapPath, "ROADMAP.md");
    if ("ok" in parent) return parent;
    missingRoadmapParent = parent;
  }

  if (cl.kind === "ok" && rm.kind === "ok" && identitiesMatch(cl.identity, rm.identity)) {
    return safetyFail(
      EXIT_VIOLATION,
      "pair-identity",
      "CHANGELOG.md and ROADMAP.md resolve to the same file",
    );
  }

  if (input.dryRun) {
    let readFd: number;
    try {
      readFd = openSync(changelogPath, readonlyOpenFlags());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return safetyFail(EXIT_VIOLATION, "open", `failed to open CHANGELOG.md: ${msg}`);
    }
    const checked = inspectFd(readFd, cl.identity, "CHANGELOG.md");
    if (!checked.ok) {
      closeQuiet(readFd);
      return checked;
    }
    let changelogText: string;
    try {
      changelogText = readFileSync(readFd, "utf8");
    } catch (err) {
      closeQuiet(readFd);
      const msg = err instanceof Error ? err.message : String(err);
      return safetyFail(EXIT_CONFIG_ERROR, "read", `CHANGELOG.md read failed: ${msg}`);
    }
    closeQuiet(readFd);
    const dry = buffersFromChangelogText(input, changelogPath, changelogText);
    if (!dry.ok) return dry;
    return {
      ok: true,
      prepared: {
        projectRoot: input.projectRoot,
        changelogPath,
        roadmapPath,
        changelogBytes: dry.changelogBytes,
        roadmapBytes: dry.roadmapBytes,
        changelogFd: null,
        roadmapFd: null,
        missingRoadmapParent: null,
        missingRoadmapParentFd: null,
      },
    };
  }

  let missingRoadmapParentFd: number | null = null;
  if (rm.kind === "missing" && missingRoadmapParent !== null) {
    try {
      missingRoadmapParentFd = openSync(dirname(roadmapPath), parentDirOpenFlags());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return safetyFail(EXIT_VIOLATION, "open", `ROADMAP.md parent open failed: ${msg}`);
    }
    try {
      const pst = fstatSync(missingRoadmapParentFd, { bigint: true });
      if (!pst.isDirectory()) {
        closeQuiet(missingRoadmapParentFd);
        return safetyFail(
          EXIT_VIOLATION,
          "not-file",
          "ROADMAP.md parent descriptor is not a directory",
        );
      }
      if (typeof pst.dev !== "bigint" || typeof pst.ino !== "bigint") {
        closeQuiet(missingRoadmapParentFd);
        return safetyFail(
          EXIT_VIOLATION,
          "bigint-unavailable",
          "ROADMAP.md parent fd bigint identity required",
        );
      }
      if (!identitiesMatch({ dev: pst.dev, ino: pst.ino }, missingRoadmapParent)) {
        closeQuiet(missingRoadmapParentFd);
        return safetyFail(
          EXIT_VIOLATION,
          "pair-identity",
          "ROADMAP.md parent fd identity mismatch",
        );
      }
    } catch (err) {
      closeQuiet(missingRoadmapParentFd);
      const msg = err instanceof Error ? err.message : String(err);
      return safetyFail(EXIT_VIOLATION, "unsafe", `ROADMAP.md parent fstat failed: ${msg}`);
    }
  }

  const openedCl = openExisting(changelogPath);
  if (!openedCl.ok) {
    if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
    return openedCl;
  }
  let roadmapFd: number | null = null;
  if (rm.kind === "ok") {
    const openedRm = openExisting(roadmapPath);
    if (!openedRm.ok) {
      closeQuiet(openedCl.fd);
      if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
      return openedRm;
    }
    roadmapFd = openedRm.fd;
  }

  const clFdCheck = inspectFd(openedCl.fd, cl.identity, "CHANGELOG.md");
  if (!clFdCheck.ok) {
    closeQuiet(openedCl.fd);
    if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
    if (roadmapFd !== null) closeQuiet(roadmapFd);
    return clFdCheck;
  }
  if (rm.kind === "ok" && roadmapFd !== null) {
    const rmFdCheck = inspectFd(roadmapFd, rm.identity, "ROADMAP.md");
    if (!rmFdCheck.ok) {
      closeQuiet(openedCl.fd);
      if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
      closeQuiet(roadmapFd);
      return rmFdCheck;
    }
    let clFdStats: BigIntStats;
    let rmFdStats: BigIntStats;
    try {
      clFdStats = fstatSync(openedCl.fd, { bigint: true });
      rmFdStats = fstatSync(roadmapFd, { bigint: true });
    } catch (err) {
      closeQuiet(openedCl.fd);
      if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
      closeQuiet(roadmapFd);
      const msg = err instanceof Error ? err.message : String(err);
      return safetyFail(EXIT_VIOLATION, "unsafe", `retained descriptor fstat failed: ${msg}`);
    }
    const clFdIdent = bigintStatsOrFail(clFdStats, "CHANGELOG.md retained descriptor");
    const rmFdIdent = bigintStatsOrFail(rmFdStats, "ROADMAP.md retained descriptor");
    if ("ok" in clFdIdent) {
      closeQuiet(openedCl.fd);
      if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
      closeQuiet(roadmapFd);
      return clFdIdent;
    }
    if ("ok" in rmFdIdent) {
      closeQuiet(openedCl.fd);
      if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
      closeQuiet(roadmapFd);
      return rmFdIdent;
    }
    if (identitiesMatch(clFdIdent, rmFdIdent)) {
      closeQuiet(openedCl.fd);
      if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
      closeQuiet(roadmapFd);
      return safetyFail(
        EXIT_VIOLATION,
        "pair-identity",
        "retained CHANGELOG.md and ROADMAP.md descriptors share identity",
      );
    }
  }

  let changelogText: string;
  try {
    changelogText = readFileSync(openedCl.fd, "utf8");
  } catch (err) {
    closeQuiet(openedCl.fd);
    if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
    if (roadmapFd !== null) closeQuiet(roadmapFd);
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_CONFIG_ERROR, "read", `CHANGELOG.md read failed: ${msg}`);
  }

  const buffers = buffersFromChangelogText(input, changelogPath, changelogText);
  if (!buffers.ok) {
    closeQuiet(openedCl.fd);
    if (missingRoadmapParentFd !== null) closeQuiet(missingRoadmapParentFd);
    if (roadmapFd !== null) closeQuiet(roadmapFd);
    return buffers;
  }

  return {
    ok: true,
    prepared: {
      projectRoot: input.projectRoot,
      changelogPath,
      roadmapPath,
      changelogBytes: buffers.changelogBytes,
      roadmapBytes: buffers.roadmapBytes,
      changelogFd: openedCl.fd,
      roadmapFd,
      missingRoadmapParent,
      missingRoadmapParentFd,
    },
  };
}

function buffersFromChangelogText(
  input: PrepareReleaseArtifactsInput,
  changelogPath: string,
  changelogText?: string,
):
  | { readonly ok: true; readonly changelogBytes: Buffer; readonly roadmapBytes: Buffer }
  | ChangelogSafetyFail {
  let text = changelogText;
  if (text === undefined) {
    try {
      text = readFileSync(changelogPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return safetyFail(EXIT_CONFIG_ERROR, "read", `CHANGELOG.md read failed: ${msg}`);
    }
  }
  let promoted: string;
  try {
    promoted = promoteChangelog(text, input.version, input.repo, input.today, input.summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_CONFIG_ERROR, "promote", msg);
  }
  let roadmapText: string;
  try {
    const pending = resolveLifecycleFolder(input.projectRoot, "pending");
    const completed = resolveLifecycleFolder(input.projectRoot, "completed");
    const [ok, value] = renderRoadmapToBufferResult(pending, completed);
    if (!ok) return safetyFail(EXIT_VIOLATION, "roadmap-render", value);
    roadmapText = value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "roadmap-render", msg);
  }
  return {
    ok: true,
    changelogBytes: Buffer.from(promoted, "utf8"),
    roadmapBytes: Buffer.from(roadmapText, "utf8"),
  };
}

function writeFd(
  fd: number,
  buf: Buffer,
  path: string,
): { ok: true } | { ok: false; offset: number; message: string } {
  let offset = 0;
  try {
    while (offset < buf.length) {
      const n = writeSync(fd, buf, offset, buf.length - offset, offset);
      if (n <= 0) {
        return {
          ok: false,
          offset,
          message: `partial write to ${path}: ${String(offset)} of ${String(buf.length)} bytes; not retry-safe`,
        };
      }
      offset += n;
    }
    ftruncateSync(fd, buf.length);
    fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (offset > 0) {
      return {
        ok: false,
        offset,
        message: `partial write to ${path}: ${String(offset)} of ${String(buf.length)} bytes (${msg}); not retry-safe`,
      };
    }
    return { ok: false, offset, message: `write failed for ${path}: ${msg}` };
  }
}

function writeFail(code: string, message: string, changelogMutated: boolean): WriteArtifactsFail {
  return {
    ok: false,
    exitCode: EXIT_VIOLATION,
    code,
    message,
    changelogMutated,
  };
}

export function writeReleaseArtifacts(prepared: PreparedArtifacts): WriteArtifactsResult {
  if (prepared.changelogFd === null) {
    return writeFail("dry-run", "write-open was not performed (dry-run)", false);
  }

  let roadmapFd = prepared.roadmapFd;
  let createdRoadmap = false;
  if (roadmapFd === null) {
    const floor = symlinkAncestorFloor(prepared.projectRoot, prepared.roadmapPath);
    if (!floor.ok) {
      closePreparedArtifacts(prepared);
      return writeFail(floor.code, floor.message, false);
    }
    const parentNow = parentDirectoryIdentity(prepared.roadmapPath, "ROADMAP.md");
    if ("ok" in parentNow) {
      closePreparedArtifacts(prepared);
      return writeFail(parentNow.code, parentNow.message, false);
    }
    if (
      prepared.missingRoadmapParent !== null &&
      !identitiesMatch(parentNow, prepared.missingRoadmapParent)
    ) {
      closePreparedArtifacts(prepared);
      return writeFail(
        "pair-identity",
        "ROADMAP.md parent directory identity drifted before create",
        false,
      );
    }
    if (prepared.missingRoadmapParentFd === null) {
      closePreparedArtifacts(prepared);
      return writeFail("open", "ROADMAP.md parent descriptor was not retained", false);
    }
    const opened = openExclusiveAtParentFd(
      prepared.missingRoadmapParentFd,
      basename(prepared.roadmapPath),
      prepared.projectRoot,
    );
    if (!opened.ok) {
      closePreparedArtifacts(prepared);
      return writeFail(opened.code, opened.message, false);
    }
    roadmapFd = opened.fd;
    createdRoadmap = true;
    if (prepared.missingRoadmapParentFd !== null) {
      closeQuiet(prepared.missingRoadmapParentFd);
    }
    try {
      const created = fstatSync(roadmapFd, { bigint: true });
      const createdIdent = bigintStatsOrFail(created, "ROADMAP.md created descriptor");
      if ("ok" in createdIdent) {
        closeQuiet(roadmapFd);
        closePreparedArtifacts(prepared);
        return writeFail(createdIdent.code, createdIdent.message, false);
      }
    } catch (err) {
      closeQuiet(roadmapFd);
      closePreparedArtifacts(prepared);
      const msg = err instanceof Error ? err.message : String(err);
      return writeFail("unsafe", `ROADMAP.md created descriptor fstat failed: ${msg}`, false);
    }
  }

  const rmWrite = writeFd(roadmapFd, prepared.roadmapBytes, prepared.roadmapPath);
  if (!rmWrite.ok) {
    closeQuiet(roadmapFd);
    closeQuiet(prepared.changelogFd);
    const prefix = createdRoadmap ? "ROADMAP.md create/write failed" : "ROADMAP.md write failed";
    return writeFail(
      "roadmap-write",
      `${prefix}: ${rmWrite.message}. CHANGELOG.md is byte-identical.`,
      false,
    );
  }

  const clWrite = writeFd(prepared.changelogFd, prepared.changelogBytes, prepared.changelogPath);
  closeQuiet(roadmapFd);
  closeQuiet(prepared.changelogFd);
  if (!clWrite.ok) {
    return writeFail("changelog-write", clWrite.message, true);
  }
  return { ok: true };
}
