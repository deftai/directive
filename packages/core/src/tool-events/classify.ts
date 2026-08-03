/**
 * Deterministic, rule-first tool-event classifier (#2967).
 *
 * Pure: no I/O, no LLM. Misclassification policy: prefer `unknown` over a
 * wrong `verify` (false-positive verify is worse than residual unknown).
 *
 * Distinct from packages/core/src/hooks/classify/ (#2950 write-intent/payload).
 */

import type { ClassifyToolEventResult, ToolEventBucket, ToolEventInput } from "./types.js";

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** O(n) whitespace tokenize — no nested-quantifier regex on untrusted input. */
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
  // O(n) character-class strip (quotes only) — avoid anchored `+` quantifiers
  // (CodeQL js/polynomial-redos). Path separators stay for stripPathNoise.
  return token.replace(/['"`]/g, "").toLowerCase();
}

function stripPathNoise(token: string): string {
  const n = normalizeToken(token);
  // basename-ish: last path segment, drop .exe
  const slash = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
  const base = slash >= 0 ? n.slice(slash + 1) : n;
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function isEnvAssign(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

function skipWrappers(tokens: readonly string[]): number {
  let i = 0;
  while (i < tokens.length && isEnvAssign(tokens[i] as string)) i++;
  const wrap = tokens[i] !== undefined ? stripPathNoise(tokens[i] as string) : "";
  if (wrap === "sudo" || wrap === "env" || wrap === "command" || wrap === "time") {
    i++;
    while (i < tokens.length && isEnvAssign(tokens[i] as string)) i++;
  }
  return i;
}

function fieldString(
  args: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | null {
  if (args == null) return null;
  const v = args[key];
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}

function resolveCommand(event: ToolEventInput): string | null {
  if (typeof event.command === "string" && event.command.trim().length > 0) {
    return event.command;
  }
  const fromArgs =
    fieldString(event.args, "command") ??
    fieldString(event.args, "cmd") ??
    fieldString(event.args, "script");
  return fromArgs;
}

// ---------------------------------------------------------------------------
// Name-only sets (normalized: lowercase, non-alnum stripped)
// ---------------------------------------------------------------------------

const EXPLORE_NAMES = new Set(
  [
    "read",
    "readfile",
    "read_file",
    "grep",
    "rg",
    "glob",
    "globfile",
    "listdir",
    "list_dir",
    "listfiles",
    "ls",
    "search",
    "semanticsearch",
    "codebase_search",
    "codebasesearch",
    "webfetch",
    "web_fetch",
    "websearch",
    "web_search",
    "openpage",
    "open_page",
    "browse",
    "fetch",
    "cat",
    "head",
    "tail",
    "find",
    "astgrep",
    "ast_grep",
    "getdiagnostics",
    "get_diagnostics",
    "readlints",
    "read_lints",
  ].map(normalizeName),
);

const COMMIT_NAMES = new Set(
  [
    "write",
    "writefile",
    "write_file",
    "createfile",
    "create_file",
    "edit",
    "streplace",
    "str_replace",
    "searchreplace",
    "search_replace",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit",
    "applypatch",
    "apply_patch",
    "delete",
    "deletefile",
    "delete_file",
    "editnotebook",
    "inserteditinto",
  ].map(normalizeName),
);

const COORDINATE_NAMES = new Set(
  [
    "task",
    "subagentstart",
    "subagent_start",
    "spawnsubagent",
    "spawn_subagent",
    "startagent",
    "start_agent",
    "createagent",
    "create_agent",
    "sessionspawn",
    "sessions_spawn",
    "askuserquestion",
    "ask_user_question",
    "askquestion",
    "todowrite",
    "todo_write",
    "todoread",
    "todo_read",
    "switchmode",
    "switch_mode",
    "sendmessage",
    "send_message",
    "message",
    "wait",
    "sleep",
  ].map(normalizeName),
);

/** Names that are always verify without needing args. */
const VERIFY_NAMES = new Set(
  ["runtests", "run_tests", "testrunner", "test_runner"].map(normalizeName),
);

const SHELL_NAMES = new Set(
  [
    "shell",
    "bash",
    "bashtool",
    "runterminalcommand",
    "run_terminal_command",
    "run_terminal_cmd",
  ].map(normalizeName),
);

// ---------------------------------------------------------------------------
// Shell command classification (strict verify — prefer unknown)
// ---------------------------------------------------------------------------

/** Bins that are verify when alone or with known verify subcommands. */
const VERIFY_BINS_ALONE = new Set([
  "vitest",
  "pytest",
  "jest",
  "mocha",
  "eslint",
  "biome",
  "prettier",
  "tsc",
  "mypy",
  "ruff",
  "golangci-lint",
  "golangci_lint",
]);

/** task / deft / directive verify-ish verbs (second token). */
const VERIFY_TASK_VERBS = new Set([
  "check",
  "test",
  "doctor",
  "lint",
  "typecheck",
  "verify",
  "verify:encoding",
  "verify:branch",
  "verify:tools",
  "verify:session-ritual",
  "verify:cache-fresh",
  "verify:forward-coverage",
  "verify:story-ready",
  "verify:review-monitor",
  "verify:l4-owner",
  "pr:watch",
  "pr:merge-ready",
  "coverage:hotspots",
]);

const VERIFY_NPM_SCRIPTS = new Set([
  "test",
  "lint",
  "typecheck",
  "type-check",
  "check",
  "ci",
  "verify",
]);

const EXPLORE_GIT_SUB = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "branch",
  "rev-parse",
  "rev_parse",
  "ls-files",
  "ls_files",
  "describe",
  "remote",
  "stash", // list-ish; stash push is commit — see below
  "cat-file",
  "cat_file",
  "shortlog",
  "whatchanged",
]);

const COMMIT_GIT_SUB = new Set([
  "add",
  "commit",
  "push",
  "pull", // mutates working tree / refs — treat as commit-class mutator
  "checkout",
  "switch",
  "merge",
  "rebase",
  "reset",
  "rm",
  "mv",
  "cherry-pick",
  "cherry_pick",
  "revert",
  "tag",
  "am",
  "apply",
  "clean",
]);

const EXPLORE_BINS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "dir",
  "find",
  "rg",
  "grep",
  "ag",
  "ack",
  "fd",
  "tree",
  "wc",
  "file",
  "stat",
  "which",
  "where",
  "type",
  "echo",
  "pwd",
  "printenv",
  "env",
  "jq",
  "yq",
  "bat",
  "sed", // read-ish pipes often explore; mutators hard to prove — leave alone only
  "awk",
  "sort",
  "uniq",
  "diff",
  "cmp",
  "hexdump",
  "od",
  "strings",
  "man",
  "help",
  "ghx", // cached read-only gh proxy
]);

const COMMIT_BINS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "tee",
  "install",
  "chmod",
  "chown",
  "ln",
  "sed", // when not clearly a pure pipe — we only match standalone sed as unknown; see rules
]);

function result(bucket: ToolEventBucket, reason: string): ClassifyToolEventResult {
  return { bucket, reason };
}

/**
 * Classify a shell command into a bucket.
 * Verify is intentionally narrow (prefer unknown over wrong verify).
 */
function classifyShellCommand(command: string): ClassifyToolEventResult {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return result("unknown", "shell-empty-command");
  }

  const tokens = shellTokens(trimmed);
  const i = skipWrappers(tokens);
  const binRaw = tokens[i];
  if (binRaw === undefined) {
    return result("unknown", "shell-no-bin");
  }
  const bin = stripPathNoise(binRaw);
  const rest = tokens.slice(i + 1);
  const second = rest[0] !== undefined ? normalizeToken(rest[0]) : "";
  const secondBare = stripPathNoise(rest[0] ?? "");

  // --- verify (strict) ---
  if (VERIFY_BINS_ALONE.has(bin)) {
    return result("verify", `shell-verify-bin:${bin}`);
  }
  if (bin === "go" && secondBare === "test") {
    return result("verify", "shell-verify-go-test");
  }
  if (
    bin === "cargo" &&
    (secondBare === "test" || secondBare === "clippy" || secondBare === "check")
  ) {
    return result("verify", `shell-verify-cargo-${secondBare}`);
  }
  if (
    (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") &&
    (secondBare === "test" ||
      secondBare === "run" ||
      secondBare === "exec" ||
      secondBare === "dlx" ||
      secondBare === "x")
  ) {
    // npm test / pnpm test
    if (secondBare === "test") {
      return result("verify", `shell-verify-pm-test:${bin}`);
    }
    // npm run <script> — only known verify scripts
    const script = rest[1] !== undefined ? stripPathNoise(rest[1]) : "";
    if (script.length > 0 && VERIFY_NPM_SCRIPTS.has(script)) {
      return result("verify", `shell-verify-pm-script:${bin}:${script}`);
    }
    // vitest / eslint invoked via pnpm exec
    if (script.length > 0 && VERIFY_BINS_ALONE.has(script)) {
      return result("verify", `shell-verify-pm-exec:${bin}:${script}`);
    }
    // secondBare is run|exec|dlx|x here (test returned above) — residual unknown
    return result("unknown", `shell-pm-unknown-script:${bin}:${script || "?"}`);
  }
  if (bin === "npx" || bin === "pnpx") {
    const tool = secondBare;
    if (tool.length > 0 && VERIFY_BINS_ALONE.has(tool)) {
      return result("verify", `shell-verify-npx:${tool}`);
    }
    return result("unknown", `shell-npx-unknown:${tool || "?"}`);
  }
  if (bin === "task" || bin === "deft" || bin === "directive") {
    // task check / task verify:encoding / deft doctor / task pr:watch
    if (second.length > 0) {
      const verb = second.replace(/^--+/, "");
      if (VERIFY_TASK_VERBS.has(verb)) {
        return result("verify", `shell-verify-task:${bin}:${verb}`);
      }
      // task verify:* / check:* namespaces
      if (verb.startsWith("verify:") || verb.startsWith("check:") || verb === "doctor") {
        return result("verify", `shell-verify-task-ns:${bin}:${verb}`);
      }
      // task test → verify
      if (verb === "test" || verb.startsWith("test:")) {
        return result("verify", `shell-verify-task-test:${bin}:${verb}`);
      }
    }
    // Other task verbs → not auto-verify (could be mutate)
    // Fall through to commit/explore heuristics for known mutators
  }
  if (bin === "python" || bin === "python3" || bin === "py") {
    // python -m pytest only
    for (let j = 0; j < rest.length - 1; j++) {
      if (
        normalizeToken(rest[j] as string) === "-m" &&
        stripPathNoise(rest[j + 1] as string) === "pytest"
      ) {
        return result("verify", "shell-verify-python-pytest");
      }
    }
    return result("unknown", "shell-python-unknown");
  }
  if (bin === "node") {
    // node --test is verify; bare node scripts are unknown
    if (rest.some((t) => normalizeToken(t) === "--test")) {
      return result("verify", "shell-verify-node-test");
    }
    return result("unknown", "shell-node-unknown");
  }
  if (bin === "make") {
    // make test / make check / make lint only
    if (
      secondBare === "test" ||
      secondBare === "check" ||
      secondBare === "lint" ||
      secondBare === "typecheck" ||
      secondBare === "verify"
    ) {
      return result("verify", `shell-verify-make:${secondBare}`);
    }
    return result("unknown", `shell-make-unknown:${secondBare || "?"}`);
  }

  // --- git ---
  if (bin === "git") {
    const sub = secondBare;
    if (sub === "stash") {
      // git stash (list) vs git stash push/pop/apply
      const third = rest[1] !== undefined ? stripPathNoise(rest[1]) : "";
      if (
        third === "push" ||
        third === "pop" ||
        third === "apply" ||
        third === "drop" ||
        third === "clear" ||
        third === "create" ||
        third === "store"
      ) {
        return result("commit", `shell-git-mutator:stash-${third}`);
      }
      // bare stash / stash list / stash show → explore
      return result("explore", "shell-git-explore:stash");
    }
    if (COMMIT_GIT_SUB.has(sub)) {
      return result("commit", `shell-git-mutator:${sub}`);
    }
    if (EXPLORE_GIT_SUB.has(sub) || sub === "") {
      return result("explore", `shell-git-explore:${sub || "default"}`);
    }
    // Unknown git subcommand → unknown (not verify)
    return result("unknown", `shell-git-unknown:${sub || "?"}`);
  }

  // --- gh / ghx (read vs mutate) ---
  if (bin === "gh" || bin === "gh.exe") {
    // gh api GET-ish: treat as explore unless method is clearly write
    const sub = secondBare;
    if (sub === "api") {
      const joined = rest.map((t) => normalizeToken(t)).join(" ");
      if (
        joined.includes("-x post") ||
        joined.includes("-x put") ||
        joined.includes("-x patch") ||
        joined.includes("-x delete") ||
        joined.includes("--method post") ||
        joined.includes("--method put") ||
        joined.includes("--method patch") ||
        joined.includes("--method delete")
      ) {
        return result("commit", "shell-gh-api-mutate");
      }
      return result("explore", "shell-gh-api-read");
    }
    if (
      sub === "pr" ||
      sub === "issue" ||
      sub === "repo" ||
      sub === "release" ||
      sub === "workflow"
    ) {
      const verb = rest[1] !== undefined ? stripPathNoise(rest[1]) : "";
      const readVerbs = new Set([
        "view",
        "list",
        "status",
        "checks",
        "diff",
        "files",
        "log",
        "browse",
      ]);
      if (readVerbs.has(verb)) {
        return result("explore", `shell-gh-read:${sub}:${verb}`);
      }
      if (verb.length > 0) {
        // create, edit, merge, close, comment, … → commit-class mutator
        return result("commit", `shell-gh-mutate:${sub}:${verb}`);
      }
      return result("unknown", `shell-gh-incomplete:${sub}`);
    }
    if (sub === "auth" || sub === "config" || sub === "help" || sub === "version") {
      return result("explore", `shell-gh-meta:${sub}`);
    }
    return result("unknown", `shell-gh-unknown:${sub || "?"}`);
  }
  if (bin === "ghx") {
    return result("explore", "shell-ghx-read");
  }

  // --- explore bins ---
  if (EXPLORE_BINS.has(bin)) {
    // sed/awk often in pipes for explore; standalone sed -i would be commit — detect -i
    if (bin === "sed") {
      if (rest.some((t) => normalizeToken(t) === "-i" || normalizeToken(t).startsWith("-i"))) {
        return result("commit", "shell-sed-inplace");
      }
      return result("explore", "shell-explore-sed");
    }
    return result("explore", `shell-explore-bin:${bin}`);
  }

  // --- filesystem mutators ---
  if (bin === "rm" || bin === "mv" || bin === "cp" || bin === "mkdir" || bin === "touch") {
    return result("commit", `shell-fs-mutate:${bin}`);
  }
  if (COMMIT_BINS.has(bin) && bin !== "sed") {
    return result("commit", `shell-commit-bin:${bin}`);
  }

  // --- coordinate-ish shell (swarm launch etc.) ---
  if (bin === "task" || bin === "deft" || bin === "directive") {
    const verb = second.replace(/^--+/, "");
    if (
      verb.startsWith("swarm:") ||
      verb.startsWith("scope:") ||
      verb.startsWith("session:") ||
      verb === "swarm" ||
      verb === "scope"
    ) {
      return result("coordinate", `shell-coordinate-task:${verb}`);
    }
    // residual task verbs
    return result("unknown", `shell-task-unknown:${verb || "?"}`);
  }

  // Prefer unknown over inventing verify/commit
  return result("unknown", `shell-unknown-bin:${bin}`);
}

/**
 * Classify one tool event into explore | commit | verify | coordinate | unknown.
 *
 * Pure and deterministic. When verify cannot be proven honestly, returns unknown.
 */
export function classifyToolEvent(event: ToolEventInput): ClassifyToolEventResult {
  const rawName = typeof event.name === "string" ? event.name : "";
  if (rawName.trim().length === 0) {
    return result("unknown", "missing-name");
  }
  const name = normalizeName(rawName);

  if (EXPLORE_NAMES.has(name)) {
    return result("explore", `name-explore:${name}`);
  }
  if (COMMIT_NAMES.has(name)) {
    return result("commit", `name-commit:${name}`);
  }
  if (COORDINATE_NAMES.has(name)) {
    return result("coordinate", `name-coordinate:${name}`);
  }
  if (VERIFY_NAMES.has(name)) {
    return result("verify", `name-verify:${name}`);
  }

  // Shell-class tools: classify from command when present
  if (
    SHELL_NAMES.has(name) ||
    name.includes("shell") ||
    name.includes("bash") ||
    name.includes("terminal")
  ) {
    const cmd = resolveCommand(event);
    if (cmd === null) {
      // Shell without command cannot prove verify (or anything else)
      return result("unknown", "shell-missing-command");
    }
    return classifyShellCommand(cmd);
  }

  // MCP-style names: server__tool — try last segment as name
  if (rawName.includes("__") || rawName.includes("/")) {
    const parts = rawName.split(/__|\//);
    const last = parts[parts.length - 1] ?? "";
    const lastNorm = normalizeName(last);
    if (lastNorm.length > 0 && lastNorm !== name) {
      const nested = classifyToolEvent({ name: last, args: event.args, command: event.command });
      if (nested.bucket !== "unknown") {
        return result(nested.bucket, `mcp-nested:${nested.reason}`);
      }
    }
    // MCP without nested match
    return result("unknown", `mcp-unknown:${name}`);
  }

  // Coarse name heuristics (still prefer unknown for verify).
  // Coordinate before commit: "dispatch" contains "patch" as a substring.
  if (
    name.includes("read") ||
    name.includes("grep") ||
    name.includes("search") ||
    name.includes("list") ||
    name.includes("glob") ||
    name.includes("fetch") ||
    name.includes("browse")
  ) {
    return result("explore", `heuristic-explore:${name}`);
  }
  if (
    name.includes("spawn") ||
    name.includes("subagent") ||
    name.includes("agent") ||
    name.includes("todo") ||
    name.includes("message") ||
    name.includes("dispatch")
  ) {
    return result("coordinate", `heuristic-coordinate:${name}`);
  }
  if (
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("patch") ||
    name.includes("delete") ||
    name.includes("create") ||
    name.includes("apply")
  ) {
    // createagent / startagent already handled in COORDINATE_NAMES and above
    return result("commit", `heuristic-commit:${name}`);
  }

  // ⊗ Do not heuristic-match "test"/"check"/"verify" in bare names alone —
  // that is the false-positive verify class we forbid.
  if (name.includes("test") || name.includes("lint") || name.includes("typecheck")) {
    return result("unknown", `ambiguous-verify-name:${name}`);
  }

  return result("unknown", `residual:${name}`);
}

/** Classify many events; order preserved. */
export function classifyToolEvents(events: readonly ToolEventInput[]): ClassifyToolEventResult[] {
  return events.map((e) => classifyToolEvent(e));
}

/** Exported for unit tests of the shell path without wrapping Shell tool names. */
export function classifyShellCommandForTest(command: string): ClassifyToolEventResult {
  return classifyShellCommand(command);
}
