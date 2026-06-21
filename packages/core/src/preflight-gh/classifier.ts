/**
 * preflight-gh/classifier.ts -- Detection-bound gate for destructive gh verbs (#1019).
 *
 * TypeScript port of scripts/preflight_gh.py. Faithfully mirrors the Python
 * classifier: classify_command, evaluate_command, run_self_test, and the
 * self-test fixture table. Three-state exit:
 *   0 -- command is allowed (not destructive) or bypass is active
 *   1 -- command is destructive and no bypass
 *   2 -- config error / self-test disagreement
 */

import * as os from "node:os";

/** Environment variable that enables the per-shell bypass (mirrors Python). */
export const ENV_BYPASS = "DEFT_ALLOW_DESTRUCTIVE_GH_VERBS";

/** Default branch refs treated as protected against force-push. */
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["master", "main"]);

/** Classification result. `category` is null when the command is allowed. */
export interface Verdict {
  readonly allowed: boolean;
  readonly category: string | null;
  readonly detail: string;
  readonly recovery: string;
}

const OK_VERDICT: Verdict = {
  allowed: true,
  category: null,
  detail: "not destructive",
  recovery: "",
};

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

/**
 * Split a command string into argv-like tokens (POSIX shlex-equivalent).
 *
 * Mirrors Python's `shlex.split(command, posix=True)` but falls back to
 * whitespace splitting on malformed quotes, same as the Python version.
 */
export function tokensFromString(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\") {
        const next = command[i + 1];
        if (next !== undefined && (next === '"' || next === "\\")) {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Classifier helpers
// ---------------------------------------------------------------------------

function envBypassActive(): boolean {
  const raw = (process.env[ENV_BYPASS] ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function isGhHead(token: string): boolean {
  return token.toLowerCase() === "gh" || token.toLowerCase() === "ghx";
}

function apiInvocationIsDelete(tokens: readonly string[]): boolean {
  const valueTaking = new Set([
    "-x",
    "--method",
    "-h",
    "--header",
    "-f",
    "--field",
    "-F",
    "--raw-field",
    "--input",
    "--jq",
    "-q",
    "--template",
    "-t",
    "--hostname",
    "--cache",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    const low = tok.toLowerCase();
    if (
      (low === "-x" || low === "--method") &&
      i + 1 < tokens.length &&
      tokens[i + 1]?.toUpperCase() === "DELETE"
    ) {
      return true;
    }
    if (low.startsWith("-x=") || low.startsWith("--method=")) {
      const value = tok.split("=", 2)[1] ?? "";
      if (value.toUpperCase() === "DELETE") return true;
    }
    // -XDELETE combined form
    if (low.startsWith("-x") && low.length > 2 && low.slice(2).toUpperCase() === "DELETE") {
      return true;
    }
    // Skip value-taking flags (skip the value token that follows)
    if (valueTaking.has(low) && !tok.includes("=")) {
      i++; // skip value
    }
  }
  return false;
}

function apiEndpoint(tokens: readonly string[]): string | null {
  const valueTaking = new Set([
    "-x",
    "--method",
    "-h",
    "--header",
    "-f",
    "--field",
    "-F",
    "--raw-field",
    "--input",
    "--jq",
    "-q",
    "--template",
    "-t",
    "--hostname",
    "--cache",
  ]);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i] ?? "";
    if (!tok.startsWith("-")) {
      return tok;
    }
    if (tok.includes("=")) {
      i++;
      continue;
    }
    // -XDELETE combined
    if (tok.toLowerCase().startsWith("-x") && tok.length > 2) {
      i++;
      continue;
    }
    if (valueTaking.has(tok.toLowerCase()) && i + 1 < tokens.length) {
      i += 2;
      continue;
    }
    i++;
  }
  return null;
}

function endpointIsRepoRoot(endpoint: string): boolean {
  const lower = endpoint.toLowerCase();
  // repos/<owner>/<repo> -- but not repos/.../issues/... etc.
  // Matches: repos/owner/repo or repos/owner/repo/contents/...
  // The Python checks: endpoint matches `repos/<owner>/<repo>` (allow sub-paths too)
  if (!lower.startsWith("repos/")) return false;
  const parts = endpoint.split("/");
  // repos / owner / repo [/ ...]
  return parts.length >= 3 && (parts[1]?.length ?? 0) > 0 && (parts[2]?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Destructive category detectors
// ---------------------------------------------------------------------------

function detectDeleteRepo(tokens: readonly string[]): Verdict | null {
  if (tokens.length < 2) return null;
  const head = tokens[0] ?? "";
  if (!isGhHead(head)) return null;

  // gh repo delete <target>
  if (
    tokens[1]?.toLowerCase() === "repo" &&
    tokens.length >= 3 &&
    tokens[2]?.toLowerCase() === "delete"
  ) {
    const target = tokens[3] ?? "<unspecified>";
    return {
      allowed: false,
      category: "delete_repo",
      detail: `gh repo delete ${target}`,
      recovery: [
        "  Repo deletion is irreversible. If this is intentional:",
        `    • set the env-var bypass for this shell:  ${ENV_BYPASS}=1`,
        "    • or run the deletion via the GitHub web UI so the",
        "      reversible-archive prompt fires (preferred).",
      ].join(os.EOL),
    };
  }

  // gh api ... DELETE repos/<owner>/<repo>...
  if (tokens[1]?.toLowerCase() === "api" && apiInvocationIsDelete(tokens.slice(2))) {
    const endpoint = apiEndpoint(tokens.slice(2));
    if (endpoint !== null && endpointIsRepoRoot(endpoint)) {
      return {
        allowed: false,
        category: "delete_repo",
        detail: `gh api -X DELETE ${endpoint}`,
        recovery: [
          "  Repo / repo-subresource deletion via the API is",
          "  irreversible. If this is intentional:",
          `    • set the env-var bypass for this shell:  ${ENV_BYPASS}=1`,
        ].join(os.EOL),
      };
    }
  }

  return null;
}

function detectAdminMerge(tokens: readonly string[]): Verdict | null {
  if (tokens.length < 2) return null;
  const head = tokens[0] ?? "";
  if (!isGhHead(head)) return null;
  if (tokens[1]?.toLowerCase() !== "pr") return null;
  const hasAdmin = tokens.some((t) => t.toLowerCase() === "--admin");
  const hasMerge = tokens.some((t) => t.toLowerCase() === "merge");
  if (!hasMerge || !hasAdmin) return null;
  return {
    allowed: false,
    category: "admin_merge",
    detail: "gh pr merge --admin",
    recovery: [
      "  `gh pr merge --admin` bypasses required branch-protection reviews.",
      "  Document the rationale before using. If genuinely required:",
      `    • set the env-var bypass for this shell:  ${ENV_BYPASS}=1`,
    ].join(os.EOL),
  };
}

function detectForcePushDefault(
  tokens: readonly string[],
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
): Verdict | null {
  if (tokens.length < 2) return null;
  const head = tokens[0] ?? "";
  if (head.toLowerCase() !== "git") return null;

  const allTokens = tokens.slice(1);

  // detect push sub-command
  if (!allTokens.some((t) => t.toLowerCase() === "push")) return null;

  // detect force flags or refspec shorthand (+branch)
  const hasForce =
    allTokens.some((t) => t === "--force" || t === "-f") ||
    allTokens.some((t) => t === "--force-with-lease");
  const hasPlus = allTokens.some((t) => t.startsWith("+") && !t.startsWith("+-"));

  if (!hasForce && !hasPlus) return null;

  // check if targeting a default branch
  const branchesLower = new Set([...defaultBranches].map((b) => b.toLowerCase()));
  const targetsBranch = allTokens.some((t) => {
    if (t.startsWith("-")) return false;
    if (t.startsWith("+")) {
      // +master or +refs/heads/master or HEAD:master
      const ref = t.slice(1);
      const parts = ref.split(":");
      const dest = parts[parts.length - 1] ?? "";
      return (
        branchesLower.has(dest.toLowerCase()) ||
        branchesLower.has(dest.replace(/^refs\/heads\//, "").toLowerCase())
      );
    }
    // HEAD:master or origin/master notation
    if (t.includes(":")) {
      const dest = t.split(":")[1] ?? "";
      return (
        branchesLower.has(dest.toLowerCase()) ||
        branchesLower.has(dest.replace(/^refs\/heads\//, "").toLowerCase())
      );
    }
    return (
      branchesLower.has(t.toLowerCase()) ||
      branchesLower.has(t.replace(/^refs\/heads\//, "").toLowerCase())
    );
  });

  if (!targetsBranch) return null;

  const forceKind = allTokens.some((t) => t === "--force-with-lease")
    ? "--force-with-lease"
    : allTokens.some((t) => t.startsWith("+") && !t.startsWith("+-"))
      ? "refspec +"
      : "--force";

  return {
    allowed: false,
    category: "force_push_default",
    detail: `git push ${forceKind} to default branch`,
    recovery: [
      "  Force-pushing to the default branch is irreversible and rewrites",
      "  public history. If genuinely required:",
      `    • set the env-var bypass for this shell:  ${ENV_BYPASS}=1`,
      "    • or push to a feature branch and use a PR.",
    ].join(os.EOL),
  };
}

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

/**
 * Classify a candidate command string.
 *
 * Mirrors `preflight_gh.py::classify_command`. Returns a Verdict with
 * `allowed=false` and a destructive category name, or `{allowed:true,
 * category:null}` when the command is benign.
 */
export function classifyCommand(
  command: string,
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
): Verdict {
  const tokens = tokensFromString(command);
  return (
    detectDeleteRepo(tokens) ??
    detectAdminMerge(tokens) ??
    detectForcePushDefault(tokens, defaultBranches) ??
    OK_VERDICT
  );
}

/**
 * Evaluate a single candidate command; respects the env-var bypass.
 *
 * Returns `[exitCode, message]` -- mirrors `preflight_gh.py::evaluate_command`.
 */
export function evaluateCommand(
  command: string,
  defaultBranches: ReadonlySet<string> = DEFAULT_BRANCHES,
): [number, string] {
  if (envBypassActive()) {
    return [
      0,
      `⚠ deft destructive-gh-verb gate: ${ENV_BYPASS}=1 is set -- policy bypassed for this invocation.`,
    ];
  }
  const verdict = classifyCommand(command, defaultBranches);
  if (verdict.allowed) {
    return [0, `✓ deft destructive-gh-verb gate: '${command}' -- not destructive.`];
  }
  const msg = [
    `❌ deft destructive-gh-verb gate: refusing '${command}'.`,
    `  Category: ${verdict.category}`,
    `  Detail: ${verdict.detail}`,
    verdict.recovery,
  ]
    .filter((l) => l.length > 0)
    .join(os.EOL);
  return [1, msg];
}

// ---------------------------------------------------------------------------
// Self-test fixture table (mirrors _SELF_TEST_CASES in preflight_gh.py)
// ---------------------------------------------------------------------------

type Fixture = readonly [command: string, expectedCategory: string | null];

export const SELF_TEST_CASES: readonly Fixture[] = [
  // delete_repo positives
  ["gh repo delete deftai/directive", "delete_repo"],
  ["gh repo delete deftai/directive --yes", "delete_repo"],
  ["gh api -X DELETE repos/deftai/directive", "delete_repo"],
  ["gh api --method DELETE repos/deftai/directive/contents/README.md", "delete_repo"],
  ["gh api -XDELETE repos/deftai/directive", "delete_repo"],
  // admin_merge positives
  ["gh pr merge 123 --admin", "admin_merge"],
  ["gh pr merge --admin --squash 123", "admin_merge"],
  // force_push_default positives
  ["git push --force origin master", "force_push_default"],
  ["git push origin --force-with-lease main", "force_push_default"],
  ["git push origin +master", "force_push_default"],
  ["git push --force origin HEAD:master", "force_push_default"],
  // Negatives -- benign commands MUST classify as allowed.
  ["gh pr merge 123 --squash", null],
  ["gh repo view deftai/directive", null],
  ["gh api repos/deftai/directive", null],
  ["gh api -X PATCH repos/deftai/directive/issues/1", null],
  ["git push origin feat/my-branch", null],
  ["git push --force origin feat/my-branch", null],
  ["git push --force-with-lease origin feat/my-branch", null],
  ["git push", null],
  ["gh pr create --title Test --body foo", null],
] as const;

/**
 * Run every self-test fixture through the classifier.
 *
 * @param fixtures - Optional override fixture table (defaults to SELF_TEST_CASES).
 *   Inject a contrived table in tests to exercise the failure-path branch.
 *
 * Returns `[exitCode, message]`. Exit 0 = all pass; exit 2 = disagreement
 * (config error / classifier drift) -- mirrors `preflight_gh.py::run_self_test`.
 */
export function runSelfTest(fixtures?: readonly Fixture[]): [number, string] {
  const cases = fixtures ?? SELF_TEST_CASES;
  const failures: string[] = [];
  for (const [command, expected] of cases) {
    const verdict = classifyCommand(command);
    const observed = verdict.allowed ? null : verdict.category;
    if (observed !== expected) {
      failures.push(
        `  ✗ ${JSON.stringify(command)} -- expected category=${JSON.stringify(expected)} but got category=${JSON.stringify(observed)} (detail=${JSON.stringify(verdict.detail)})`,
      );
    }
  }
  if (failures.length > 0) {
    return [
      2,
      [
        `❌ deft destructive-gh-verb gate (self-test): classifier disagreement on ${failures.length}/${cases.length} fixture(s).`,
        ...failures,
      ].join(os.EOL),
    ];
  }
  return [
    0,
    `✓ deft destructive-gh-verb gate (self-test): ${cases.length}/${cases.length} fixtures classified as expected.`,
  ];
}
