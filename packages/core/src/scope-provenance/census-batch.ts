/**
 * Merge-base lifecycle census with a batched reader (#5192 / #6378).
 *
 * The census lists each lifecycle folder with `git ls-tree -r --name-only` at
 * the selected base ref, keeps today's path decoding, trimming, normalising
 * and lifecycle filter, and makes one read request per listed entry, in
 * listing order, for `<ref>:<normalised path>` (the string `git show`
 * receives today). Two entries that normalise to the same path stay two
 * requests and two census entries.
 *
 * Batching is an accelerator only (#6378 items 2-5):
 * - Partition first: a request is batch-eligible only when it is printable
 *   ASCII with no control character. Every other request is read with
 *   today's single read and never reaches a batch call.
 * - One `git cat-file --batch-check` call takes the eligible requests. A
 *   record that is not a `blob` (missing, tree, commit, ...) goes to the
 *   single read.
 * - Blobs go to `git cat-file --batch` in chunks. A chunk's budget counts each
 *   record's content size plus its header line and trailing delimiter, and
 *   stays under the subprocess buffer limit. Output is parsed as bytes by each
 *   header's size; each object is decoded as UTF-8 by itself. A request whose
 *   own framed answer does not fit goes to the single read.
 * - If a batch call fails, or its records do not match the requests one for
 *   one in order with the id and size from the size call, every batch result
 *   is discarded and every entry is read with today's single read. Census
 *   errors, missing-versus-error and JSON handling come only from today's code.
 *
 * A call that reaches the per-call time limit is not a batch failure: in
 * enforce mode its error propagates; in warn mode the runner already ran it
 * again with no limit (#6378 item 8).
 */

import { type CensusBrief, isLifecycleXbriefPath, LIFECYCLE_FOLDERS } from "./continuity.js";
import { extractPlanId } from "./digest.js";
import type { ScopeProvenanceGit } from "./git-call.js";

/**
 * Normalize git --name-only paths (including C-quoted paths).
 * Decode C-quotes BEFORE converting remaining backslashes to `/` so escape
 * sequences are not destroyed. Consecutive octal escapes decode as UTF-8
 * bytes (e.g. \\303\\251 → é) so Unicode xBRIEF paths match filesystem names.
 */
export function unquoteGitPath(raw: string): string {
  const t = raw.replace(/\r$/, "").trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    let inner = t.slice(1, -1);
    // First: runs of octal bytes → UTF-8 (Git encodes non-ASCII this way)
    inner = inner.replace(/(?:\\[0-7]{1,3})+/g, (seq) => {
      const bytes: number[] = [];
      for (const m of seq.matchAll(/\\([0-7]{1,3})/g)) {
        bytes.push(parseInt(m[1] ?? "0", 8));
      }
      try {
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return String.fromCharCode(...bytes);
      }
    });
    // Then: standard single-char escapes
    inner = inner.replace(/\\([abtnvfr"'\\])/g, (_m, ch: string) => {
      const map: Record<string, string> = {
        a: "\x07",
        b: "\b",
        t: "\t",
        n: "\n",
        v: "\v",
        f: "\f",
        r: "\r",
        '"': '"',
        "'": "'",
        "\\": "\\",
      };
      return map[ch] ?? ch;
    });
    return inner.replace(/\\/g, "/");
  }
  return t.replace(/\\/g, "/");
}

/** Normalize repo-relative paths for exact set membership (always POSIX separators). */
export function normalizeRepoRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/** The path part of the `<ref>:<path>` string today's single `git show` receives. */
export function gitShowPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export type BaseBriefRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string };

export type LifecycleCensusResult =
  | { readonly kind: "ok"; readonly briefs: CensusBrief[] }
  | { readonly kind: "error"; readonly detail: string };

/** Batch-eligible: non-empty printable ASCII (0x20-0x7e), so no control character. */
export function isBatchEligibleRequest(request: string): boolean {
  if (request.length === 0) return false;
  for (let i = 0; i < request.length; i += 1) {
    const c = request.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

interface BlobRecord {
  readonly index: number;
  readonly request: string;
  readonly oid: string;
  readonly size: number;
  readonly frame: number;
}

const SIZE_RECORD_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/;

function callFailed(result: {
  readonly error?: Error;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}): boolean {
  return result.error !== undefined || result.signal !== null || result.status !== 0;
}

/**
 * Read blobs for `paths` at `ref` through the batch calls.
 *
 * Returns texts keyed by request index for every request the batch answered
 * as a blob that fits; the caller reads every other index with today's
 * single read. Returns null when the batch results must be discarded (the
 * caller then reads every entry with today's single read).
 */
export function readBlobsInBatches(input: {
  readonly git: ScopeProvenanceGit;
  readonly projectRoot: string;
  readonly ref: string;
  readonly paths: readonly string[];
}): ReadonlyMap<number, string> | null {
  const { git, projectRoot, ref } = input;
  const eligible: Array<{ index: number; request: string }> = [];
  input.paths.forEach((p, index) => {
    const request = `${ref}:${gitShowPath(p)}`;
    if (isBatchEligibleRequest(request)) eligible.push({ index, request });
  });
  const texts = new Map<number, string>();
  if (eligible.length === 0) return texts;

  const check = git.runText(
    ["cat-file", "--batch-check"],
    projectRoot,
    eligible.map((e) => `${e.request}\n`).join(""),
  );
  if (callFailed(check)) return null;
  const lines = String(check.stdout ?? "").split("\n");
  if (lines.length !== eligible.length + 1 || lines[eligible.length] !== "") return null;

  const blobs: BlobRecord[] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    const e = eligible[i] as { index: number; request: string };
    const line = lines[i] ?? "";
    if (line === `${e.request} missing` || line === `${e.request} ambiguous`) continue;
    const m = SIZE_RECORD_RE.exec(line);
    if (m === null) return null;
    const oid = m[1] as string;
    const type = m[2] as string;
    const size = Number(m[3]);
    if (type !== "blob") continue;
    const header = `${oid} blob ${String(size)}\n`;
    blobs.push({
      index: e.index,
      request: e.request,
      oid,
      size,
      frame: Buffer.byteLength(header) + size + 1,
    });
  }

  // Budget chunks so each captured answer stays under the buffer limit.
  const chunks: BlobRecord[][] = [];
  let current: BlobRecord[] = [];
  let used = 0;
  for (const b of blobs) {
    if (b.frame >= git.maxBuffer) continue; // own framed answer does not fit: single read
    if (current.length > 0 && used + b.frame >= git.maxBuffer) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(b);
    used += b.frame;
  }
  if (current.length > 0) chunks.push(current);

  for (const chunk of chunks) {
    const out = git.runBytes(
      ["cat-file", "--batch"],
      projectRoot,
      chunk.map((b) => `${b.request}\n`).join(""),
    );
    if (callFailed(out)) return null;
    const buf = Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(String(out.stdout ?? ""));
    let pos = 0;
    for (const b of chunk) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) return null;
      if (buf.toString("latin1", pos, nl) !== `${b.oid} blob ${String(b.size)}`) return null;
      const start = nl + 1;
      const end = start + b.size;
      if (end >= buf.length || buf[end] !== 0x0a) return null;
      texts.set(b.index, buf.toString("utf8", start, end));
      pos = end + 1;
    }
    if (pos !== buf.length) return null;
  }
  return texts;
}

/**
 * Merge-base lifecycle census via git ls-tree + reads (#5192).
 * Fail closed on ls-tree / read / parse errors so duplicate plan.id identities
 * cannot hide behind a partial census.
 */
export function listLifecycleBriefsAtRef(input: {
  readonly git: ScopeProvenanceGit;
  readonly projectRoot: string;
  readonly baseRef: string;
  /** Today's single read (and any injected source). */
  readonly readAtBase: (rel: string) => BaseBriefRead;
  /** Use the batched reader (false: single reads only). */
  readonly batch: boolean;
  /** Called once after the listing with the number of listed briefs. */
  readonly onListed?: (count: number) => void;
  /** Called for every text the census read. */
  readonly keep?: (rel: string, text: string) => void;
}): LifecycleCensusResult {
  const { git, projectRoot, baseRef, readAtBase } = input;
  const listedRels: string[] = [];
  for (const folder of LIFECYCLE_FOLDERS) {
    const listed = git.runText(
      ["ls-tree", "-r", "--name-only", baseRef, `xbrief/${folder}`],
      projectRoot,
    );
    if (listed.error !== undefined || listed.signal !== null || listed.status !== 0) {
      return {
        kind: "error",
        detail:
          `merge-base lifecycle census ls-tree failed for xbrief/${folder} at ${baseRef} ` +
          `(exit ${String(listed.status ?? 1)}); refuse rather than hide duplicate identities (#5192)`,
      };
    }
    for (const line of String(listed.stdout ?? "").split("\n")) {
      const rel = normalizeRepoRelPath(unquoteGitPath(line));
      if (isLifecycleXbriefPath(rel)) listedRels.push(rel);
    }
  }
  input.onListed?.(listedRels.length);

  const batched = input.batch
    ? readBlobsInBatches({ git, projectRoot, ref: baseRef, paths: listedRels })
    : null;

  const out: CensusBrief[] = [];
  for (let i = 0; i < listedRels.length; i += 1) {
    const rel = listedRels[i] as string;
    const fromBatch = batched?.get(i);
    const read: BaseBriefRead =
      fromBatch !== undefined ? { kind: "text", text: fromBatch } : readAtBase(rel);
    if (read.kind === "missing") {
      return {
        kind: "error",
        detail:
          `merge-base lifecycle census missing ${rel} after ls-tree listed it; ` +
          "refuse rather than hide duplicate identities (#5192)",
      };
    }
    if (read.kind === "error") {
      return {
        kind: "error",
        detail:
          `merge-base lifecycle census read failed for ${rel}: ${read.message}; ` +
          "refuse rather than hide duplicate identities (#5192)",
      };
    }
    input.keep?.(rel, read.text);
    try {
      const payload = JSON.parse(read.text) as unknown;
      out.push({
        rel,
        planId: extractPlanId(payload),
        raw: read.text,
        payload,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        kind: "error",
        detail:
          `merge-base lifecycle census unreadable JSON at ${rel}: ${detail}; ` +
          "refuse rather than hide duplicate identities (#5192)",
      };
    }
  }
  return { kind: "ok", briefs: out };
}
