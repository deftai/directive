import { readFileSync } from "node:fs";

export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, { encoding: "utf8" });
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: failed to read ${path}: ${message}\n`);
    return null;
  }
}

export function readCommitsFile(path: string): string[] | null {
  const text = readTextFile(path);
  if (text === null) {
    return null;
  }
  return text
    .split("\n--END--\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
