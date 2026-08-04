/**
 * Map hook tool invocations to authz operation classes (#2944).
 * Reuses #2711 push/merge shell classification; adds PR create/advance detection
 * for UAT denials without re-owning runtimeAuthority Shell matchers.
 *
 * Token walks are O(n) — no nested-quantifier regex on untrusted shell input
 * (CodeQL js/polynomial-redos).
 */

import {
  classifyMcpTool,
  classifyShellCommand,
  listShellOps,
  type RuntimeAuthorityShellOp,
} from "../policy/runtime-authority.js";
import type { AuthzOperation } from "./types.js";

export type AuthzClassifiedOp = AuthzOperation | "test" | "evidence" | "unknown";

/** Split on whitespace without nested quantifiers (O(n)). */
function shellTokens(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function normalizeToken(token: string): string {
  return token.replace(/['"\\]/g, "").toLowerCase();
}

function isEnvAssign(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

/**
 * Walk tokens looking for `gh [opts] <resource> <verb>` patterns (O(n)).
 * Returns the resource+verb pair when found.
 */
/** gh global flags that take a separate value token. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-a", "--app", "-h", "--hostname", "-p", "--jq"]);

function findGhResourceVerb(tokens: readonly string[]): { resource: string; verb: string } | null {
  let i = 0;
  while (i < tokens.length && isEnvAssign(tokens[i] as string)) i++;
  const wrap = tokens[i] !== undefined ? normalizeToken(tokens[i] as string) : "";
  if (wrap === "sudo" || wrap === "env" || wrap === "command") {
    i++;
    while (i < tokens.length && isEnvAssign(tokens[i] as string)) i++;
  }
  const bin = tokens[i] !== undefined ? normalizeToken(tokens[i] as string) : "";
  if (bin !== "gh" && bin !== "gh.exe") return null;
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    const n = normalizeToken(t);
    if (!n.startsWith("-")) break;
    // --flag=value form consumes one token.
    if (n.startsWith("--") && n.includes("=")) {
      i++;
      continue;
    }
    // Value-taking short/long flags: -R owner/repo, --repo owner/repo
    if (GH_VALUE_FLAGS.has(t) || GH_VALUE_FLAGS.has(n)) {
      i += 2;
      continue;
    }
    i++;
  }
  const resource = tokens[i] !== undefined ? normalizeToken(tokens[i] as string) : "";
  const verb = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
  if (resource.length === 0 || verb.length === 0) return null;
  return { resource, verb };
}

const TEST_BINS = new Set(["vitest", "pytest", "cargo", "npm", "pnpm", "yarn", "task"]);
const TEST_SECOND = new Set(["test"]);
const DEPLOY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["terraform", "apply"],
  ["helm", "upgrade"],
  ["kubectl", "apply"],
  ["fly", "deploy"],
  ["vercel", "deploy"],
];

function hasGoTest(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (
      normalizeToken(tokens[i] as string) === "go" &&
      normalizeToken(tokens[i + 1] as string) === "test"
    ) {
      return true;
    }
  }
  return false;
}

function hasTestRunner(tokens: readonly string[]): boolean {
  if (hasGoTest(tokens)) return true;
  for (let i = 0; i < tokens.length; i++) {
    const t = normalizeToken(tokens[i] as string);
    if (TEST_BINS.has(t)) {
      // vitest/pytest alone, or npm/pnpm/yarn/task/cargo + test
      if (t === "vitest" || t === "pytest") return true;
      const next = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
      if (TEST_SECOND.has(next)) return true;
    }
  }
  return false;
}

function hasDeploy(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = normalizeToken(tokens[i] as string);
    const b = normalizeToken(tokens[i + 1] as string);
    for (const [bin, verb] of DEPLOY_PAIRS) {
      if (a === bin && b === verb) return true;
    }
  }
  return false;
}

function hasGhApiPath(tokens: readonly string[], needle: string): boolean {
  let sawGh = false;
  let sawApi = false;
  for (const raw of tokens) {
    const t = normalizeToken(raw);
    if (t === "gh" || t === "gh.exe") {
      sawGh = true;
      continue;
    }
    if (sawGh && t === "api") {
      sawApi = true;
      continue;
    }
    if (sawApi && t.includes(needle)) return true;
  }
  return false;
}

/**
 * Authz authority-mutating CLI verbs (#3110). Classified as **settings** so under
 * active UAT they deny without a prior human grant — never empty → shell-op-unclassifiable fail-open.
 */
const AUTHZ_MUTATING_SUBCOMMANDS = new Set(["grant", "uat-start", "uat-suspend", "revoke"]);

function authzSubcommandFromToken(token: string): string | null {
  const t = normalizeToken(token);
  if (t.startsWith("authz:")) {
    const sub = t.slice("authz:".length);
    return AUTHZ_MUTATING_SUBCOMMANDS.has(sub) ? sub : null;
  }
  return AUTHZ_MUTATING_SUBCOMMANDS.has(t) ? t : null;
}

/**
 * Detect `deft|task|directive authz:grant` / `authz grant` (and wrappers) in shell tokens.
 * O(n) token walk — no nested-quantifier regex on untrusted input.
 */
function hasAuthzMutatingCli(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw === undefined) break;
    const t = normalizeToken(raw);
    // Combined form anywhere: authz:grant / authz:uat-suspend / …
    if (authzSubcommandFromToken(t) !== null && t.startsWith("authz:")) {
      return true;
    }
    // Separated form: … authz grant|uat-start|uat-suspend|revoke
    // Also path-ish bins ending in /authz or \authz (node …/authz.js grant).
    const isAuthzBin =
      t === "authz" ||
      t.endsWith("/authz") ||
      t.endsWith("\\authz") ||
      t.endsWith("/authz.js") ||
      t.endsWith("\\authz.js") ||
      t.endsWith("/authz.ts") ||
      t.endsWith("\\authz.ts");
    if (!isAuthzBin) continue;
    const next = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
    if (authzSubcommandFromToken(next) !== null) return true;
  }
  return false;
}

/** Write bins that may target a destination path (shell FS mutation). */
const SHELL_WRITE_BINS = new Set([
  "cp",
  "mv",
  "tee",
  "rsync",
  "install",
  "copy",
  "copy-item",
  "move-item",
  "set-content",
  "add-content",
  "out-file",
  "new-item",
  "ni",
  "sc",
  "mi",
]);

/**
 * Shell write (or redirect) targeting `.deft/authz/` (#3110 AC-3).
 * Containment: under UAT these classify as settings and deny without a prior human grant.
 */
/** Path-ish token normalize: keep separators (do not strip `\` like normalizeToken). */
function pathishToken(token: string): string {
  return token.replace(/['"]/g, "").toLowerCase().replace(/\\/g, "/");
}

function hasAuthzDirShellWrite(command: string, tokens: readonly string[]): boolean {
  const lower = command.toLowerCase().replace(/\\/g, "/");
  if (!lower.includes(".deft/authz")) return false;

  // Redirect forms: `… > .deft/authz/…` / `… >> .deft/authz/…` (also `1>` / `2>&1` nearby).
  // Scan for `>` not part of comparison tokens is imperfect; presence of both is enough.
  if (lower.includes(">") && lower.includes(".deft/authz")) {
    return true;
  }

  for (let i = 0; i < tokens.length; i++) {
    const bin = normalizeToken(tokens[i] as string);
    if (!SHELL_WRITE_BINS.has(bin)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      // pathishToken preserves path separators (normalizeToken strips `\`).
      if (pathishToken(tokens[j] as string).includes(".deft/authz")) return true;
    }
  }
  return false;
}

/** Best-effort shell classification for UAT-sensitive ops beyond push/merge. */
export function classifyShellAuthzOps(command: string): AuthzClassifiedOp[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];

  const found = new Set<AuthzClassifiedOp>();
  for (const op of listShellOps(cmd)) {
    found.add(op);
  }

  const tokens = shellTokens(cmd);
  const gh = findGhResourceVerb(tokens);
  if (gh !== null) {
    if (
      gh.resource === "pr" &&
      (gh.verb === "create" || gh.verb === "edit" || gh.verb === "ready" || gh.verb === "reopen")
    ) {
      found.add("pr");
    }
    // Surface merge when listShellOps misses global flags like --repo (#2711 compose).
    if (gh.resource === "pr" && gh.verb === "merge") {
      found.add("merge");
    }
    if (gh.resource === "issue" && gh.verb === "create") {
      found.add("issue_mutation");
    }
    if (gh.resource === "repo" && gh.verb === "edit") {
      found.add("settings");
    }
  }
  if (hasGhApiPath(tokens, "/issues")) found.add("issue_mutation");
  if (hasGhApiPath(tokens, "/settings")) found.add("settings");
  if (hasTestRunner(tokens)) found.add("test");
  if (hasDeploy(tokens)) found.add("deployment");
  // #3110: authz authority CLI + .deft/authz shell writes are settings (deny under UAT).
  if (hasAuthzMutatingCli(tokens)) found.add("settings");
  if (hasAuthzDirShellWrite(cmd, tokens)) found.add("settings");

  return [...found];
}

/** Map a PreToolUse tool name + optional shell command to authz ops. */
export function classifyHookAuthzOps(input: {
  readonly toolName: string;
  readonly shellCommand: string | null;
  readonly isDirectWrite: boolean;
  readonly mcpArgsText?: string | null;
}): AuthzClassifiedOp[] {
  const { toolName, shellCommand, isDirectWrite } = input;
  if (isDirectWrite) return ["edit"];

  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower === "run_terminal_cmd") {
    // Missing command string: fail open (host gap) — same posture as #2711.
    if (shellCommand === null) return [];
    // Empty classification (git status, tests without product verbs, …) is not gated.
    return classifyShellAuthzOps(shellCommand);
  }

  // MCP / bare names via #2711 classifier + PR heuristics (token-ish name checks).
  const mcpOp: RuntimeAuthorityShellOp | null = classifyMcpTool(
    toolName,
    input.mcpArgsText ?? null,
  );
  if (mcpOp !== null) return [mcpOp];

  const name = lower.replace(/[^a-z0-9_]/g, "_");
  if (
    name.includes("create_pull_request") ||
    name.includes("pull_request_create") ||
    name.includes("pr_create") ||
    name === "create_pull_request"
  ) {
    return ["pr"];
  }
  if (name.includes("create_issue") || name.includes("issue_create")) {
    return ["issue_mutation"];
  }

  // Unrelated tools — not gated by Wave 1 authz (prefer fail-open over false deny).
  return [];
}

/** Re-export #2711 classifiers for composition docs/tests. */
export { classifyMcpTool, classifyShellCommand, listShellOps };
