/**
 * Safety filters for literal acceptance commands (#3267 Greptile P1).
 *
 * Stored commands may originate from issue text. Before shell execution they
 * MUST pass an allowlist of argv-shaped CLI invocations without shell metacharacters.
 */

/** Characters that imply shell composition / expansion (refuse closed). */
const SHELL_META_CHARS = new Set([
  ";",
  "|",
  "&",
  "`",
  "\n",
  "\r",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "$",
  "\0",
]);

/** First-token allowlist for executable acceptance commands. */
const ALLOWED_FIRST_TOKENS = new Set([
  "task",
  "deft",
  "directive",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "node",
  "python",
  "python3",
  "py",
  "pytest",
  "vitest",
  "cargo",
  "go",
  "dotnet",
  "make",
  "curl",
  "gh",
  "git",
  "uv",
  "pip",
  "poetry",
  "rg",
  "echo",
  "true",
  "false",
]);

export interface CommandSafetyResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * Linear-time scan: refuse shell metacharacters and non-allowlisted first tokens.
 * Intentionally does not parse full shell grammar — fail closed on ambiguity.
 */
export function evaluateCommandSafety(command: string): CommandSafetyResult {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, reason: "empty command" };
  }
  const trimmed = command.trim();
  if (trimmed.length > 500) {
    return { ok: false, reason: "command exceeds 500 characters" };
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] as string;
    if (SHELL_META_CHARS.has(ch)) {
      return {
        ok: false,
        reason: `shell metacharacter ${JSON.stringify(ch)} is not allowed in literal AC commands`,
      };
    }
  }
  // First token: skip leading whitespace already trimmed; split on space only.
  let end = 0;
  while (end < trimmed.length && trimmed[end] !== " " && trimmed[end] !== "\t") {
    end += 1;
  }
  const first = trimmed.slice(0, end).toLowerCase();
  // Windows path / absolute path first tokens are refused (only bare allowlisted tools).
  if (first.includes("/") || first.includes("\\") || first.includes(":")) {
    return { ok: false, reason: "path-like first token is not allowlisted" };
  }
  if (!ALLOWED_FIRST_TOKENS.has(first)) {
    return {
      ok: false,
      reason: `first token ${JSON.stringify(first)} is not in the literal-AC allowlist`,
    };
  }
  return { ok: true, reason: null };
}
