/** Generic cache-layer failure (subprocess, parse, IO). */
export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheError";
  }
}

/** Format like Python ``KeyError`` str() for golden parity with the oracle. */
export function keyErrorMessage(inner: string): string {
  return `"${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Cache miss for the requested (source, key). */
export class CacheNotFoundError extends Error {
  readonly innerMessage: string;

  constructor(inner: string) {
    super(keyErrorMessage(inner));
    this.innerMessage = inner;
    this.name = "CacheNotFoundError";
  }
}

/** meta.json failed schema validation on read or write. */
export class CacheValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheValidationError";
  }
}

/** Raised when caps cannot be honored even after eviction (CLI exit 3). */
export class CacheCapBreachedError extends Error {
  readonly reason: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly currentBytes: number;
  readonly currentEntries: number;
  readonly incomingBytes: number;

  constructor(options: {
    reason: string;
    maxBytes: number;
    maxEntries: number;
    currentBytes: number;
    currentEntries: number;
    incomingBytes: number;
  }) {
    const msg =
      `cache cap breached (${options.reason}): ` +
      `max_bytes=${options.maxBytes} max_entries=${options.maxEntries} ` +
      `current_bytes=${options.currentBytes} current_entries=${options.currentEntries} ` +
      `incoming_bytes=${options.incomingBytes}`;
    super(msg);
    this.name = "CacheCapBreachedError";
    this.reason = options.reason;
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries;
    this.currentBytes = options.currentBytes;
    this.currentEntries = options.currentEntries;
    this.incomingBytes = options.incomingBytes;
  }
}

/** Subprocess / parse failure during fetch-all orchestration. */
export class CacheFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheFetchError";
  }
}
