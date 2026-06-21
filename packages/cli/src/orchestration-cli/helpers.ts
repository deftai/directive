import type { DispatchIo } from "../dispatch.js";

/** Silent IO sinks for dispatcher / CLI wrapper tests. */
export function silentIo(): DispatchIo {
  return {
    writeOut: () => {},
    writeErr: () => {},
  };
}

/** Capture stderr while keeping stdout silent. */
export function captureStderrIo(): { io: DispatchIo; stderr: string[] } {
  const stderr: string[] = [];
  return {
    stderr,
    io: {
      writeOut: () => {},
      writeErr: (text) => {
        stderr.push(text);
      },
    },
  };
}

/** Run a CLI `run()` export without polluting the vitest console. */
export function muteProcessStreams<T>(fn: () => T): T {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}
