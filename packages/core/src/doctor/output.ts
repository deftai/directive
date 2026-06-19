export interface OutputSink {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  header(text: string): void;
  blank(): void;
  raw(text: string): void;
  /** Final summary success -- shown even in --quiet mode (mirrors Python `success()` direct call). */
  finalSuccess(msg: string): void;
  finalError(msg: string): void;
  finalWarn(msg: string): void;
}

export function createPlainSink(
  options: { jsonMode?: boolean; quietMode?: boolean; write?: (text: string) => void } = {},
): OutputSink {
  const write = options.write ?? ((t: string) => process.stdout.write(t));
  const jsonMode = options.jsonMode ?? false;
  const quietMode = options.quietMode ?? false;
  return {
    info(msg) {
      if (!jsonMode) write(`ℹ ${msg}\n`);
    },
    success(msg) {
      if (!jsonMode && !quietMode) write(`✓ ${msg}\n`);
    },
    warn(msg) {
      if (!jsonMode) write(`⚠ ${msg}\n`);
    },
    error(msg) {
      if (!jsonMode) write(`✗ ${msg}\n`);
    },
    header(text) {
      if (!jsonMode) {
        write(`\n${"=".repeat(60)}\n  ${text}\n${"=".repeat(60)}\n`);
      }
    },
    blank() {
      if (!jsonMode) write("\n");
    },
    raw(text) {
      if (!jsonMode) write(text.endsWith("\n") ? text : `${text}\n`);
    },
    finalSuccess(msg) {
      if (!jsonMode) write(`✓ ${msg}\n`);
    },
    finalError(msg) {
      if (!jsonMode) write(`✗ ${msg}\n`);
    },
    finalWarn(msg) {
      if (!jsonMode) write(`⚠ ${msg}\n`);
    },
  };
}
