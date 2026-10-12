/**
 * UX-INT-TTY (AC5.2): blocking interactive stdin must retry EAGAIN, not auto-cancel.
 */
import { describe, expect, it, vi } from "vitest";
import { readInteractiveLine, type InteractiveByteReader } from "./interactive-stdin.js";

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  err.errno = code === "EAGAIN" ? -35 : -4;
  return err;
}

describe("readInteractiveLine (UX-INT-TTY / AC5.2)", () => {
  it("retries EAGAIN then returns data line (must not return early empty)", () => {
    let calls = 0;
    const read: InteractiveByteReader = (buffer) => {
      calls += 1;
      if (calls <= 3) throw errno("EAGAIN");
      const data = Buffer.from("y\n", "utf8");
      data.copy(buffer);
      return data.length;
    };
    const wait = vi.fn();
    const result = readInteractiveLine({ read, wait, waitMs: 15 });
    expect(result).toEqual({ line: "y", eof: false });
    expect(calls).toBeGreaterThan(3);
    expect(wait).toHaveBeenCalled();
  });

  it("retries EWOULDBLOCK and EINTR", () => {
    let calls = 0;
    const read: InteractiveByteReader = (buffer) => {
      calls += 1;
      if (calls === 1) throw errno("EWOULDBLOCK");
      if (calls === 2) throw errno("EINTR");
      const data = Buffer.from("yes\n", "utf8");
      data.copy(buffer);
      return data.length;
    };
    const result = readInteractiveLine({ read, wait: () => undefined, waitMs: 10 });
    expect(result).toEqual({ line: "yes", eof: false });
  });

  it("immediate n===0 → eof true", () => {
    const read: InteractiveByteReader = () => 0;
    expect(readInteractiveLine({ read })).toEqual({ line: "", eof: true });
  });

  it("EIO with no bytes → eof true (closed PTY hangup)", () => {
    const read: InteractiveByteReader = () => {
      throw errno("EIO");
    };
    expect(readInteractiveLine({ read })).toEqual({ line: "", eof: true });
  });

  it("lone newline → empty line, eof false (Default No / Cancelled)", () => {
    const read: InteractiveByteReader = (buffer) => {
      buffer[0] = 0x0a;
      return 1;
    };
    expect(readInteractiveLine({ read })).toEqual({ line: "", eof: false });
  });

  it("default waitMs retries EAGAIN without explicit waitMs override", () => {
    // Production path must retry even when callers omit waitMs (live TTY).
    let calls = 0;
    const read: InteractiveByteReader = (buffer) => {
      calls += 1;
      if (calls === 1) throw errno("EAGAIN");
      const data = Buffer.from("y\n", "utf8");
      data.copy(buffer);
      return data.length;
    };
    const wait = vi.fn();
    const result = readInteractiveLine({ read, wait });
    expect(result).toEqual({ line: "y", eof: false });
    expect(wait).toHaveBeenCalled();
  });
});
