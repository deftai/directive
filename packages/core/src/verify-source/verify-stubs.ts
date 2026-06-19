import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXCLUDE_DIRS = new Set([
  "tests",
  "vendor",
  ".git",
  "backup",
  "history",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  "scripts",
]);

export const EXTENSIONS = new Set([".py", ".go", ".sh"]);

export interface StubFinding {
  readonly path: string;
  readonly line: number;
  readonly label: string;
  readonly text: string;
}

function isWordChar(ch: string): boolean {
  if (ch.length === 0) {
    return false;
  }
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function hasWordBoundary(text: string, index: number): boolean {
  if (index > 0 && isWordChar(text.charAt(index - 1))) {
    return false;
  }
  return true;
}

function hasWordEnd(text: string, index: number, word: string): boolean {
  const after = index + word.length;
  if (after < text.length && isWordChar(text.charAt(after))) {
    return false;
  }
  return true;
}

function findWord(text: string, word: string): boolean {
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(word, from);
    if (idx < 0) {
      return false;
    }
    if (hasWordBoundary(text, idx) && hasWordEnd(text, idx, word)) {
      return true;
    }
    from = idx + 1;
  }
  return false;
}

function hasReturnNull(text: string): boolean {
  const needle = "return";
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) {
      return false;
    }
    if (!hasWordBoundary(text, idx)) {
      from = idx + 1;
      continue;
    }
    let i = idx + needle.length;
    while (i < text.length && /\s/.test(text.charAt(i))) {
      i += 1;
    }
    if (text.slice(i, i + 4) === "null" && hasWordEnd(text, i, "null")) {
      return true;
    }
    from = idx + 1;
  }
  return false;
}

/** Recursive sorted rglob mirroring `sorted(Path(".").rglob("*"))`. */
export function sortedRglob(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string, relPrefix: string): void {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, rel);
      } else {
        out.push(rel);
      }
    }
  }
  walk(root, "");
  return out;
}

export function scanFileForStubs(relPath: string, fullPath: string): StubFinding[] {
  const findings: StubFinding[] = [];
  const suffix = relPath.includes(".") ? relPath.slice(relPath.lastIndexOf(".")) : "";
  if (!EXTENSIONS.has(suffix)) {
    return findings;
  }
  const parts = relPath.split("/");
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) {
    return findings;
  }
  let text: string;
  try {
    text = readFileSync(fullPath, { encoding: "utf8" });
  } catch {
    return findings;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineno = i + 1;
    const stripped = line.trim();
    if (stripped === "pass" && suffix === ".py" && lineno >= 2) {
      const prev = (lines[i - 1] ?? "").trim();
      if (prev.endsWith(":") && !prev.startsWith("#")) {
        findings.push({
          path: relPath,
          line: lineno,
          label: "bare pass",
          text: line.replace(/\r$/, ""),
        });
      }
    }
    const patterns: Array<[boolean, string]> = [
      [findWord(line, "TODO"), "TODO"],
      [findWord(line, "FIXME"), "FIXME"],
      [findWord(line, "HACK"), "HACK"],
      [hasReturnNull(line), "return null"],
    ];
    for (const [hit, label] of patterns) {
      if (hit) {
        findings.push({ path: relPath, line: lineno, label, text: line.replace(/\r$/, "") });
      }
    }
  }
  return findings;
}

export interface VerifyStubsResult {
  readonly code: 0 | 1;
  readonly findings: readonly StubFinding[];
  readonly message: string;
  readonly stream: "stdout";
}

export function evaluateVerifyStubs(projectRoot = "."): VerifyStubsResult {
  const root = resolve(projectRoot);
  const allFindings: StubFinding[] = [];
  for (const rel of sortedRglob(root)) {
    const full = join(root, rel);
    try {
      if (!statSync(full).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    allFindings.push(...scanFileForStubs(rel, full));
  }

  if (allFindings.length > 0) {
    let body = `Found ${allFindings.length} stub(s):\n`;
    for (const f of allFindings.slice(0, 50)) {
      const ctx = f.text.length <= 120 ? f.text : f.text.slice(0, 120);
      body += `  ${f.path}:${f.line} [${f.label}] ${ctx}\n`;
    }
    if (allFindings.length > 50) {
      body += `  ... and ${allFindings.length - 50} more\n`;
    }
    return { code: 1, findings: allFindings, message: body.trimEnd(), stream: "stdout" };
  }
  return {
    code: 0,
    findings: [],
    message: "No stub patterns found in source files",
    stream: "stdout",
  };
}
