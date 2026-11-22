/**
 * #6897: every documented `deft <verb> -- <args>` form reaches the verb's real parser with the
 * same arguments as `deft <verb> <args>`.
 *
 * The case list is read from the docs at test time; each documented form needs a probe-table
 * entry, and a stale entry fails. Each probe stops at a check that returns before any work.
 * Nothing is stubbed and no probe uses `--help` / `-h`. Every run happens under one fixture
 * root with an empty `.git` marker (so project-root discovery stops there), redirected home
 * variables, an invalid GitHub token and no `DEFT_*` variables; the fixture root must be
 * unchanged after every run.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lifecycleMain } from "@deftai/directive-core/dist/scope/main.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { routeAndDispatch, routeArgv } from "./cli-router/index.js";
import { dispatch } from "./dispatch.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The docs whose `deft <verb> -- ` examples this test guards. */
const DOC_FILES = [
  "AGENTS.md",
  "content/templates/agents-entry.md",
  "content/templates/agent-prompt-preamble.md",
  "content/skills/deft-directive-swarm/SKILL.md",
  "content/skills/deft-directive-review-cycle/SKILL.md",
] as const;

/** A colon verb (`pr:watch`) or a two-word namespace form (`policy show`), then a lone `--`. */
const DOCUMENTED_FORM =
  /(?<![\w@/.:-])deft ([a-z][a-z0-9-]*:[a-z0-9:-]+|[a-z][a-z0-9-]* [a-z][a-z0-9-]*) -- /g;

interface DocumentedForm {
  readonly key: string;
  readonly tokens: readonly string[];
  readonly files: readonly string[];
}

function collectDocumentedForms(
  docs: ReadonlyArray<{ readonly file: string; readonly text: string }>,
): DocumentedForm[] {
  const byKey = new Map<string, Set<string>>();
  for (const { file, text } of docs) {
    for (const match of text.matchAll(DOCUMENTED_FORM)) {
      const key = match[1] ?? "";
      const files = byKey.get(key) ?? new Set<string>();
      files.add(file);
      byKey.set(key, files);
    }
  }
  return [...byKey.entries()]
    .map(([key, files]) => ({ key, tokens: key.split(" "), files: [...files].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Missing and stale probe-table entries, each naming the key (and, when missing, its files). */
function coverageProblems(
  documented: readonly DocumentedForm[],
  tableKeys: readonly string[],
): string[] {
  const keys = new Set(tableKeys);
  const documentedKeys = new Set(documented.map((form) => form.key));
  const problems: string[] = [];
  for (const form of documented) {
    if (!keys.has(form.key)) {
      problems.push(`missing probe entry for "deft ${form.key} --" (in ${form.files.join(", ")})`);
    }
  }
  for (const key of tableKeys) {
    if (!documentedKeys.has(key)) {
      problems.push(`stale probe entry "${key}": no doc shows "deft ${key} --"`);
    }
  }
  return problems;
}

interface ProbeEntry {
  /** Probe arguments; the default is one unknown flag. */
  readonly probe: readonly string[];
  readonly code: number;
  /** Exact text that must appear in the output of both runs. */
  readonly text: string;
  /** True when the verb's parser refuses a stray `--` (the result changes if it is kept). */
  readonly refusesDash: boolean;
  /** The check that returns before any work. */
  readonly note: string;
}

const UNKNOWN_FLAG = "--deft-6897-no-such-flag";

function unknownFlag(text: string, refusesDash: boolean, note: string, code = 2): ProbeEntry {
  return { probe: [UNKNOWN_FLAG], code, text, refusesDash, note };
}

const SCOPE_USAGE = "usage: deft scope:<action> [file]";

/** One entry per documented key. `scope:*` entries run the core parser in-process (see below). */
const PROBES: Readonly<Record<string, ProbeEntry>> = {
  "authz:grant": {
    probe: ["--generation", "invalid"],
    code: 2,
    text: "--generation requires a non-negative integer",
    refusesDash: false,
    note: "authz:grant parser value check; it ignores unknown flags",
  },
  "escalation:file": {
    probe: ["--type", "cmd_approval"],
    code: 2,
    text: "escalation:file requires --title <text>",
    refusesDash: false,
    note: "required-field check in main before fileEscalation; not a parser refusal",
  },
  "policy:allow-bot-merge": unknownFlag(
    "policy: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "policy parser; skips a lone --",
  ),
  "policy:allow-destructive-gh-verbs": unknownFlag(
    "policy: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "policy parser; skips a lone --",
  ),
  "policy:enable-value-feedback": unknownFlag(
    "policy: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "policy parser; skips a lone --",
  ),
  "policy:set-spec-guard-enforcement": unknownFlag(
    "policy: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "policy parser; skips a lone --",
  ),
  "pr:merge-ready": unknownFlag(
    "pr_merge_readiness: unrecognized arguments: --deft-6897-no-such-flag",
    true,
    "pr_merge_readiness parser",
  ),
  "pr:watch": unknownFlag(
    "pr_watch: unrecognized arguments: --deft-6897-no-such-flag",
    true,
    "pr_watch parser",
  ),
  "review-monitor:register": unknownFlag(
    "review_monitor_register: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "review_monitor_register parser",
  ),
  "scope:activate": unknownFlag(SCOPE_USAGE, false, "core scope parser (scope/main.ts)"),
  "scope:complete": unknownFlag(SCOPE_USAGE, false, "core scope parser (scope/main.ts)"),
  "scope:promote": unknownFlag(SCOPE_USAGE, false, "core scope parser (scope/main.ts)"),
  "session:start": unknownFlag(
    "session_start: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "session_start parser; skips a lone --",
  ),
  "swarm:finalize-cohort": unknownFlag(
    "unrecognized argument: --deft-6897-no-such-flag",
    true,
    "finalize-cohort parser",
  ),
  "swarm:pre-dispatch": {
    probe: ["--action", "invalid"],
    code: 2,
    text: "--action must be one of: begin, complete, cancel.",
    refusesDash: false,
    note: "pre-dispatch parser value check; it ignores unknown flags",
  },
  "verify:cohort-review-monitors": unknownFlag(
    "verify_cohort_review_monitors: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "verify_cohort_review_monitors parser",
  ),
  "verify:completed-tracked": unknownFlag(
    "verify_completed_tracked: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "verify_completed_tracked parser",
  ),
  "verify:docs-impact": unknownFlag(
    "docs-impact: unrecognized arguments: --deft-6897-no-such-flag",
    false,
    "docs-impact parser; skips a lone --",
  ),
  "verify:l4-owner": unknownFlag(
    "verify_l4_owner: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "verify_l4_owner parser",
  ),
  "verify:orphan-active": unknownFlag(
    "verify_orphan_active: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "verify_orphan_active parser",
  ),
  "verify:review-monitor": unknownFlag(
    "verify_review_monitor: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "verify_review_monitor parser",
  ),
  "verify:session-ritual": unknownFlag(
    "verify_session_ritual: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "verify_session_ritual parser; skips a lone --",
  ),
  "verify:spec-drift": unknownFlag(
    "unknown argument: --deft-6897-no-such-flag",
    true,
    "verify:spec-drift parser",
  ),
  "verify:subagent-alive": unknownFlag(
    "verify_subagent_alive: unrecognized argument: --deft-6897-no-such-flag",
    true,
    "verify_subagent_alive parser",
  ),
  "xbrief:activate": {
    probe: ["missing-6897-a.xbrief.json", "missing-6897-b.xbrief.json"],
    code: 2,
    text: "unrecognized arguments: missing-6897-b.xbrief.json",
    refusesDash: true,
    note: "activate parser takes one path; a second positional is refused before any read",
  },
  "xbrief:preflight": unknownFlag(
    "preflight_implementation: unrecognized argument: --deft-6897-no-such-flag",
    false,
    "preflight_implementation parser; skips a lone --",
  ),
};

function isScopeKey(key: string): boolean {
  return key.startsWith("scope:");
}

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

// --- isolation ----------------------------------------------------------------------------

const HOME_VARS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR",
] as const;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

let fixtureRoot = "";
let runDir = "";
let savedCwd = "";
let savedEnv: Record<string, string | undefined> = {};
let baseline: string[] = [];

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      out.push(relative(root, full).replace(/\\/g, "/") + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

beforeAll(() => {
  savedCwd = process.cwd();
  fixtureRoot = mkdtempSync(join(tmpdir(), "deft-6897-documented-forms-"));
  // Empty `.git` marker: scope project-root discovery (xbrief / vbrief / .git sentinels) stops
  // here instead of walking up into the temp directory's ancestors.
  mkdirSync(join(fixtureRoot, ".git"));
  runDir = join(fixtureRoot, "run");
  mkdirSync(runDir);
  const home = join(fixtureRoot, "home");
  mkdirSync(home);
  const homeDirs: Record<(typeof HOME_VARS)[number], string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    GH_CONFIG_DIR: join(home, ".config", "gh"),
  };
  for (const dir of Object.values(homeDirs)) mkdirSync(dir, { recursive: true });

  const deftVars = Object.keys(process.env).filter((name) => name.startsWith("DEFT_"));
  for (const name of [...HOME_VARS, ...TOKEN_VARS, ...deftVars]) {
    savedEnv[name] = process.env[name];
  }
  for (const name of HOME_VARS) process.env[name] = homeDirs[name];
  for (const name of TOKEN_VARS) process.env[name] = "deft-6897-invalid-token";
  for (const name of deftVars) delete process.env[name];

  process.chdir(runDir);
  baseline = listTree(fixtureRoot);
});

afterAll(() => {
  process.chdir(savedCwd);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv = {};
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function expectFixtureUnchanged(): void {
  expect(process.cwd()).toBe(runDir);
  expect(listTree(fixtureRoot)).toEqual(baseline);
}

async function capture(call: () => number | Promise<number>): Promise<RunResult> {
  let out = "";
  let err = "";
  const sink =
    (append: (text: string) => void) =>
    (chunk: string | Uint8Array): boolean => {
      append(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(
    sink((text) => {
      out += text;
    }) as typeof process.stdout.write,
  );
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(
    sink((text) => {
      err += text;
    }) as typeof process.stderr.write,
  );
  let code: number;
  try {
    code = await call();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  expectFixtureUnchanged();
  return { code, out, err };
}

const io = (result: { out: string; err: string }) => ({
  writeOut: (text: string) => {
    result.out += text;
  },
  writeErr: (text: string) => {
    result.err += text;
  },
});

async function runRouted(argv: readonly string[]): Promise<RunResult> {
  const extra = { out: "", err: "" };
  const result = await capture(() => routeAndDispatch(argv, io(extra)));
  return { code: result.code, out: result.out + extra.out, err: result.err + extra.err };
}

async function runDispatch(argv: string[]): Promise<RunResult> {
  const extra = { out: "", err: "" };
  const result = await capture(() => dispatch(argv, io(extra)));
  return { code: result.code, out: result.out + extra.out, err: result.err + extra.err };
}

function runScopeParser(argv: string[]): Promise<RunResult> {
  return capture(() => lifecycleMain(argv));
}

// --- cases --------------------------------------------------------------------------------

const DOCUMENTED = collectDocumentedForms(
  DOC_FILES.map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), "utf8") })),
);

describe("documented deft <verb> -- forms are covered (#6897)", () => {
  it("collects a non-empty set of documented forms as token lists", () => {
    expect(DOCUMENTED.length).toBeGreaterThan(0);
    for (const form of DOCUMENTED) {
      expect(form.tokens.join(" ")).toBe(form.key);
      expect(form.files.length).toBeGreaterThan(0);
    }
  });

  it("has a probe entry for every documented form and no stale entry", () => {
    expect(coverageProblems(DOCUMENTED, Object.keys(PROBES))).toEqual([]);
  });

  it("names a missing entry with its files, and a stale entry", () => {
    const docs = [
      { file: "a.md", text: "run `deft pr:watch -- 1` or `deft policy show -- --x`" },
      { file: "b.md", text: "deft pr:watch -- 2; not task deft:check -- x; not mydeft x:y -- " },
    ];
    const forms = collectDocumentedForms(docs);
    expect(forms).toEqual([
      { key: "policy show", tokens: ["policy", "show"], files: ["a.md"] },
      { key: "pr:watch", tokens: ["pr:watch"], files: ["a.md", "b.md"] },
    ]);
    expect(coverageProblems(forms, ["pr:watch", "verify:gone"])).toEqual([
      'missing probe entry for "deft policy show --" (in a.md)',
      'stale probe entry "verify:gone": no doc shows "deft verify:gone --"',
    ]);
  });

  it("uses no --help / -h probe and marks at least one parser as refusing --", () => {
    for (const entry of Object.values(PROBES)) {
      expect(entry.probe).not.toContain("--help");
      expect(entry.probe).not.toContain("-h");
      expect(entry.note.length).toBeGreaterThan(0);
    }
    expect(Object.values(PROBES).some((entry) => entry.refusesDash)).toBe(true);
  });
});

describe("each documented form gives the same result with and without -- (#6897)", () => {
  const routed = DOCUMENTED.filter((form) => !isScopeKey(form.key));
  const scoped = DOCUMENTED.filter((form) => isScopeKey(form.key));

  it.each(
    routed.map((form) => [form.key, form] as const),
  )("deft %s -- reaches the real parser", async (_key, form) => {
    const entry = PROBES[form.key];
    if (entry === undefined) throw new Error(`no probe entry for ${form.key}`);
    const plain = await runRouted([...form.tokens, ...entry.probe]);
    const dashed = await runRouted([...form.tokens, "--", ...entry.probe]);
    expect(plain.code).toBe(entry.code);
    expect(plain.out + plain.err).toContain(entry.text);
    expect(dashed.out + dashed.err).toContain(entry.text);
    expect(dashed).toEqual(plain);

    // Sensitivity: the argv `dispatch` would get if the router's boundary drop were bypassed.
    // This is not a run of an older tree.
    const routedPlain = routeArgv([...form.tokens, ...entry.probe]).argv;
    expect(routeArgv([...form.tokens, "--", ...entry.probe]).argv).toEqual(routedPlain);
    const head = routedPlain.slice(0, routedPlain.length - entry.probe.length);
    expect(head.length).toBeGreaterThan(0);
    expect(routedPlain.slice(head.length)).toEqual([...entry.probe]);
    const bypassed = [...head, "--", ...entry.probe];
    const kept = await runDispatch(bypassed);
    if (entry.refusesDash) {
      expect(kept).not.toEqual(plain);
    } else {
      expect(kept).toEqual(plain);
    }
  });

  // scope:* forms route to `scope-lifecycle`, which spawns the built core CLI that the
  // source-aliased suite does not provide. They are checked at the router and in the core
  // scope parser in-process; the spawn adapter is not run (named exception).
  it.each(
    scoped.map((form) => [form.key, form] as const),
  )("deft %s -- routes and parses the same (spawn adapter not run)", async (key, form) => {
    const entry = PROBES[form.key];
    if (entry === undefined) throw new Error(`no probe entry for ${form.key}`);
    const sub = key.slice("scope:".length);
    const expected = ["scope-lifecycle", sub, ...entry.probe];
    expect(routeArgv([...form.tokens, ...entry.probe]).argv).toEqual(expected);
    expect(routeArgv([...form.tokens, "--", ...entry.probe]).argv).toEqual(expected);

    const plain = await runScopeParser([sub, ...entry.probe]);
    const dashed = await runScopeParser([sub, "--", ...entry.probe]);
    expect(plain.code).toBe(2);
    expect(plain.err).toContain(entry.text);
    expect(dashed).toEqual(plain);
    expect(entry.refusesDash).toBe(false);
  });
});
