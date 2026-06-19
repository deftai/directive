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
