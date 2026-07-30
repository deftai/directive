/**
 * contained-write.ts — mandatory contained-write API for product sinks (#2951 Phase 1).
 *
 * Single primitive that resolves a path under an explicit root, refuses symlink
 * escape / out-of-root targets (via {@link assertWriteTargetSafe}), then writes
 * with an explicit mode: create | replace | append.
 *
 * Hard rules:
 * - Final write target must resolve **inside** `root` after normalization.
 * - Symlink escape (or leaf symlink on the write path) → fail closed with a
 *   stable error code.
 * - No silent fallback to raw write on failure.
 *
 * Prefer this API for all new product write sinks. Prefer migrating call sites
 * onto this API over bespoke per-sink checks when equivalent. See
 * `docs/reference/contained-write.md`.
 *
 * Refs #2951.
 */

import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { assertWriteTargetSafe, ProjectionContainmentError } from "./projection-containment.js";

/** Stable machine-readable error codes for contained-write refusals. */
export const ContainedWriteErrorCode = {
  /** Target path escapes the containment root (`..` or absolute outside root). */
  ESCAPE: "CONTAINED_WRITE_ESCAPE",
  /** Target or intermediate path is a symlink (leaf or escaping). */
  SYMLINK: "CONTAINED_WRITE_SYMLINK",
  /** `mode: "create"` but the target already exists. */
  EXISTS: "CONTAINED_WRITE_EXISTS",
  /** `mode: "append"` or replace semantics need an existing file that is missing (reserved). */
  NOT_FOUND: "CONTAINED_WRITE_NOT_FOUND",
  /** Containment root does not exist or cannot be realpath'd. */
  ROOT_MISSING: "CONTAINED_WRITE_ROOT_MISSING",
  /** Caller passed an unsupported mode value. */
  INVALID_MODE: "CONTAINED_WRITE_INVALID_MODE",
  /** Underlying filesystem I/O failure after containment passed. */
  IO: "CONTAINED_WRITE_IO",
} as const;

export type ContainedWriteErrorCode =
  (typeof ContainedWriteErrorCode)[keyof typeof ContainedWriteErrorCode];

/** Explicit write modes for {@link containedWrite}. */
export type ContainedWriteMode = "create" | "replace" | "append";

/** Thrown when a contained write is refused or fails after containment. */
export class ContainedWriteError extends Error {
  readonly code: ContainedWriteErrorCode;
  readonly root: string;
  readonly target: string;
  readonly offendingPath: string;

  constructor(
    message: string,
    details: {
      code: ContainedWriteErrorCode;
      root: string;
      target: string;
      offendingPath?: string;
    },
  ) {
    super(message);
    this.name = "ContainedWriteError";
    this.code = details.code;
    this.root = details.root;
    this.target = details.target;
    this.offendingPath = details.offendingPath ?? details.target;
  }
}

export interface ContainedWriteInput {
  /** Absolute containment root (project root, deposit root, or sandbox). */
  readonly root: string;
  /**
   * Write target. Relative paths are resolved under `root`. Absolute paths
   * must stay under `root` after normalization.
   */
  readonly target: string;
  /** Bytes or UTF-8 string payload. */
  readonly data: string | Buffer;
  /** create = fail if exists; replace = truncate/write; append = append. */
  readonly mode: ContainedWriteMode;
  /**
   * Encoding when `data` is a string. Default `"utf8"`.
   * Ignored when `data` is a Buffer.
   */
  readonly encoding?: BufferEncoding;
  /**
   * Create parent directories under `root` when missing. Default `true`.
   * Parents are still subject to containment (no escape via mkdir).
   */
  readonly mkdir?: boolean;
  /**
   * When true, follow symlinks that resolve inside root (not recommended).
   * Default `false` — leaf and path-component symlinks are refused via
   * {@link assertWriteTargetSafe}.
   */
  readonly followSymlinks?: boolean;
}

export interface ContainedWriteResult {
  /** Absolute path written. */
  readonly path: string;
  /** Number of bytes written in this call (not total file size for append). */
  readonly bytesWritten: number;
  readonly mode: ContainedWriteMode;
}

const VALID_MODES: ReadonlySet<ContainedWriteMode> = new Set(["create", "replace", "append"]);

/**
 * Resolve `target` under `root`. Relative targets join root; absolute targets
 * must already be nested under root (path-segment containment).
 */
export function resolveContainedTarget(root: string, target: string): string {
  const rootAbs = resolve(root);
  if (target.length === 0) {
    throw new ContainedWriteError("contained write refused: empty target path", {
      code: ContainedWriteErrorCode.ESCAPE,
      root: rootAbs,
      target: "",
      offendingPath: rootAbs,
    });
  }
  const targetAbs = isAbsolute(target) ? resolve(target) : resolve(rootAbs, target);
  const rel = relative(rootAbs, targetAbs);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ContainedWriteError(
      `contained write refused: target ${targetAbs} is not nested under root ${rootAbs}`,
      {
        code: ContainedWriteErrorCode.ESCAPE,
        root: rootAbs,
        target: targetAbs,
        offendingPath: targetAbs,
      },
    );
  }
  return targetAbs;
}

function mapProjectionError(
  err: ProjectionContainmentError,
  rootAbs: string,
  targetAbs: string,
): ContainedWriteError {
  const msg = err.message;
  const isSymlink =
    /symlink/i.test(msg) ||
    /broken\/dangling symlink/i.test(msg) ||
    /is a symlink on the write path/i.test(msg);
  return new ContainedWriteError(
    msg.replace(/^projection write refused:/i, "contained write refused:"),
    {
      code: isSymlink ? ContainedWriteErrorCode.SYMLINK : ContainedWriteErrorCode.ESCAPE,
      root: rootAbs,
      target: targetAbs,
      offendingPath: err.offendingPath,
    },
  );
}

function ensureParents(rootAbs: string, targetAbs: string): void {
  const parent = dirname(targetAbs);
  if (parent === targetAbs || parent === rootAbs) {
    return;
  }
  // Contain parent before mkdir (mkdir recursive must not create outside root).
  const rel = relative(rootAbs, parent);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ContainedWriteError(
      `contained write refused: parent ${parent} is not nested under root ${rootAbs}`,
      {
        code: ContainedWriteErrorCode.ESCAPE,
        root: rootAbs,
        target: targetAbs,
        offendingPath: parent,
      },
    );
  }
  if (!existsSync(parent)) {
    try {
      assertWriteTargetSafe(rootAbs, parent);
    } catch (err) {
      if (err instanceof ProjectionContainmentError) {
        throw mapProjectionError(err, rootAbs, targetAbs);
      }
      throw err;
    }
    mkdirSync(parent, { recursive: true });
  } else {
    try {
      assertWriteTargetSafe(rootAbs, parent);
    } catch (err) {
      if (err instanceof ProjectionContainmentError) {
        throw mapProjectionError(err, rootAbs, targetAbs);
      }
      throw err;
    }
  }
}

function toBuffer(data: string | Buffer, encoding: BufferEncoding): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
}

function writeNoFollow(targetAbs: string, buf: Buffer, flags: number): number {
  const fd = openSync(targetAbs, flags, 0o644);
  try {
    let offset = 0;
    while (offset < buf.length) {
      const n = writeSync(fd, buf, offset, buf.length - offset, null);
      if (n <= 0) {
        throw new Error(`short write: wrote ${offset} of ${buf.length} bytes to ${targetAbs}`);
      }
      offset += n;
    }
    return offset;
  } finally {
    closeSync(fd);
  }
}

/**
 * Contained write: resolve under root, refuse symlink escape / out-of-root,
 * then write with the requested mode.
 *
 * @throws {ContainedWriteError} on containment refusal or mode violation
 */
export function containedWrite(input: ContainedWriteInput): ContainedWriteResult {
  if (!VALID_MODES.has(input.mode)) {
    throw new ContainedWriteError(
      `contained write refused: invalid mode ${String(input.mode)} (expected create|replace|append)`,
      {
        code: ContainedWriteErrorCode.INVALID_MODE,
        root: resolve(input.root),
        target: String(input.target),
      },
    );
  }

  if (input.followSymlinks === true) {
    throw new ContainedWriteError(
      "contained write refused: followSymlinks=true is not supported in Phase 1 (always refuse symlinks)",
      {
        code: ContainedWriteErrorCode.INVALID_MODE,
        root: resolve(input.root),
        target: String(input.target),
      },
    );
  }

  const rootAbs = resolve(input.root);
  try {
    realpathSync(rootAbs);
  } catch {
    throw new ContainedWriteError(`contained write refused: root ${rootAbs} does not exist`, {
      code: ContainedWriteErrorCode.ROOT_MISSING,
      root: rootAbs,
      target: String(input.target),
      offendingPath: rootAbs,
    });
  }

  const targetAbs = resolveContainedTarget(rootAbs, input.target);

  try {
    assertWriteTargetSafe(rootAbs, targetAbs);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      throw mapProjectionError(err, rootAbs, targetAbs);
    }
    throw err;
  }

  const doMkdir = input.mkdir !== false;
  if (doMkdir) {
    ensureParents(rootAbs, targetAbs);
  }

  // Re-check after mkdir (parent path could have been created as unexpected type).
  try {
    assertWriteTargetSafe(rootAbs, targetAbs);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      throw mapProjectionError(err, rootAbs, targetAbs);
    }
    throw err;
  }

  const encoding = input.encoding ?? "utf8";
  const buf = toBuffer(input.data, encoding);
  let exists = false;
  try {
    lstatSync(targetAbs);
    exists = true;
  } catch {
    exists = false;
  }

  if (input.mode === "create" && exists) {
    throw new ContainedWriteError(
      `contained write refused: target ${targetAbs} already exists (mode=create)`,
      {
        code: ContainedWriteErrorCode.EXISTS,
        root: rootAbs,
        target: targetAbs,
        offendingPath: targetAbs,
      },
    );
  }

  try {
    let bytesWritten: number;
    if (input.mode === "append") {
      bytesWritten = writeNoFollow(
        targetAbs,
        buf,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      );
    } else if (input.mode === "create") {
      // O_EXCL refuses replace-if-exists; O_NOFOLLOW refuses symlink leaf.
      bytesWritten = writeNoFollow(
        targetAbs,
        buf,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      );
    } else {
      // replace
      bytesWritten = writeNoFollow(
        targetAbs,
        buf,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
    }
    return { path: targetAbs, bytesWritten, mode: input.mode };
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // EEXIST from O_EXCL
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new ContainedWriteError(
        `contained write refused: target ${targetAbs} already exists (mode=create)`,
        {
          code: ContainedWriteErrorCode.EXISTS,
          root: rootAbs,
          target: targetAbs,
          offendingPath: targetAbs,
        },
      );
    }
    // ELOOP / EMLINK style symlink refusals from O_NOFOLLOW
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      ((err as NodeJS.ErrnoException).code === "ELOOP" ||
        (err as NodeJS.ErrnoException).code === "EPERM")
    ) {
      throw new ContainedWriteError(
        `contained write refused: ${targetAbs} is a symlink on the write path (O_NOFOLLOW)`,
        {
          code: ContainedWriteErrorCode.SYMLINK,
          root: rootAbs,
          target: targetAbs,
          offendingPath: targetAbs,
        },
      );
    }
    throw new ContainedWriteError(`contained write I/O failed: ${msg}`, {
      code: ContainedWriteErrorCode.IO,
      root: rootAbs,
      target: targetAbs,
      offendingPath: targetAbs,
    });
  }
}
