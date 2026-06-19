/** Match Python ``str.splitlines()`` (no trailing empty line from final ``\\n``). */
export function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

// Single-character whitespace probe. A regex without a quantifier is constant
// time, so these helpers replace ReDoS-prone anchored quantifiers like
// ``/\s+$/`` / ``/X+$/`` with linear character scans (CodeQL js/polynomial-redos).
const WS_CHAR = /\s/;

/** Equivalent of ``value.replace(/\s+$/, "")`` without backtracking. */
export function stripTrailingWhitespace(value: string): string {
  let end = value.length;
  while (end > 0 && WS_CHAR.test(value[end - 1] as string)) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Equivalent of ``value.replace(/^\s+/, "")`` without backtracking. */
export function stripLeadingWhitespace(value: string): string {
  let start = 0;
  while (start < value.length && WS_CHAR.test(value[start] as string)) {
    start += 1;
  }
  return value.slice(start);
}

/** Equivalent of ``value.replace(/^[chars]+|[chars]+$/g, "")`` without backtracking. */
export function stripEdgeChars(value: string, chars: string): string {
  const set = new Set(chars);
  let start = 0;
  let end = value.length;
  while (start < end && set.has(value[start] as string)) {
    start += 1;
  }
  while (end > start && set.has(value[end - 1] as string)) {
    end -= 1;
  }
  return value.slice(start, end);
}

/** Equivalent of ``value.replace(/[char]+$/, "")`` without backtracking. */
export function stripTrailingChar(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Replace absolute fixture paths with a stable token for parity payloads. */
export function normalizeFixturePaths(value: unknown, fixtureRoot: string): unknown {
  const token = "<FIXTURE>";
  const normalizedRoot = fixtureRoot.replace(/\\/g, "/");
  const normalizeString = (text: string): string => text.split(normalizedRoot).join(token);
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      return normalizeString(input);
    }
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        out[key] = walk(child);
      }
      return out;
    }
    return input;
  };
  return walk(value);
}

/** Sort validation diagnostics for deterministic parity payloads. */
export function sortedDiagnostics(
  errors: readonly string[],
  warnings: readonly string[],
): {
  errors: string[];
  warnings: string[];
} {
  return {
    errors: [...errors].sort(),
    warnings: [...warnings].sort(),
  };
}

/** Sort schema-validation diagnostic lines for deterministic parity payloads. */
export function sortFailureActions(actions: readonly string[]): string[] {
  const prefix: string[] = [];
  const errors: string[] = [];
  const suffix: string[] = [];
  let seenErrors = false;
  for (const line of actions) {
    if (line.startsWith("  ") && line.includes(".vbrief.json:")) {
      errors.push(line);
      seenErrors = true;
      continue;
    }
    if (seenErrors) {
      suffix.push(line);
    } else {
      prefix.push(line);
    }
  }
  return [...prefix, ...errors.sort(), ...suffix];
}

/** Sort stderr validation detail lines for deterministic parity payloads. */
export function sortFailureStderr(stderr: string): string {
  const lines = stderr.split("\n");
  const prefix: string[] = [];
  const errors: string[] = [];
  const suffix: string[] = [];
  let seenErrors = false;
  for (const line of lines) {
    if (line.startsWith("  ") && line.includes(".vbrief.json:")) {
      errors.push(line);
      seenErrors = true;
      continue;
    }
    if (seenErrors) {
      suffix.push(line);
    } else {
      prefix.push(line);
    }
  }
  return [...prefix, ...errors.sort(), ...suffix].join("\n");
}
