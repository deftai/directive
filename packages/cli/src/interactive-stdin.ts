/**
 * Blocking interactive stdin line reader (UX-INT-TTY / AC5.2).
 * Retries EAGAIN/EWOULDBLOCK/EINTR instead of treating them as cancel/EOF.
 */
import { readSync } from "node:fs";

export type InteractiveLine = { line: string; eof: boolean };

/** Sync read into buffer; may throw NodeJS.ErrnoException. */
export type InteractiveByteReader = (buffer: Buffer, offset: number, length: number) => number;

const RETRY_ERRNOS = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);

function defaultSyncWait(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function defaultRead(buffer: Buffer, offset: number, length: number): number {
  return readSync(0, buffer, offset, length, null);
}

/**
 * Read one line from stdin (or an injected reader).
 * - EAGAIN/EWOULDBLOCK/EINTR → short sync wait and retry (not EOF/cancel).
 * - n === 0 with no bytes collected → { line: "", eof: true }.
 * - Line ending or collected data → { line, eof: false } (empty Enter ⇒ line "" / eof false).
 */
export function readInteractiveLine(options?: {
  read?: InteractiveByteReader;
  wait?: (ms: number) => void;
  waitMs?: number;
}): InteractiveLine {
  const read = options?.read ?? defaultRead;
  const wait = options?.wait ?? defaultSyncWait;
  const waitMs = options?.waitMs ?? 15;
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(256);

  for (;;) {
    let n = 0;
    try {
      n = read(buf, 0, buf.length);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code && RETRY_ERRNOS.has(code)) {
        wait(waitMs);
        continue;
      }
      throw err;
    }
    if (n === 0) {
      if (chunks.length === 0) return { line: "", eof: true };
      break;
    }
    const slice = Buffer.from(buf.subarray(0, n));
    chunks.push(slice);
    if (slice.includes(0x0a)) break;
  }

  const line = Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  return { line, eof: false };
}
