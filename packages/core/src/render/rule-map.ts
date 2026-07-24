// Directive Rule Map generator — maintainer documentation of the rule taxonomy.
//
// Produces two artifacts from the repo's own source of truth (content/ + tasks/):
//   docs/RULE-MAP.md          committed, diff-friendly Markdown map (no timestamps)
//   docs/rule-map/index.html  gitignored, self-contained interactive explorer
//                             (zero runtime dependencies — data + source bodies
//                             inlined; opens straight from file://)
//
// Internal documentation for maintainers and rule/pack authors. It is not shipped
// in the npm/content payload (it lives under the maintainer-only top-level docs/).
//
// Node standard library only — no external dependencies, no CDN, no network.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATE } from "./rule-map-template.js";

const MARKER_RE = /^\s*[-*]\s*([!~⊗≉?])\s/;
const MARKER_LABEL: Record<string, string> = {
  "!": "MUST",
  "~": "SHOULD",
  "⊗": "MUST NOT",
  "≉": "SHOULD NOT",
  "?": "MAY",
};
const MAX_BODY = 300_000; // cap per-file body inlined into the HTML (content docs are small)
const EXCLUDE_GROUPS = new Set(["packs", "secrets"]);

const GROUP_PURPOSE: Record<string, string> = {
  coding:
    "Core software-development rules for agents: hygiene, testing, debugging, security, build output.",
  languages:
    "Per-language standards and idioms, loaded lazily when the task touches that language.",
  skills: "Packaged multi-step agent workflows (build, release, interview, triage, review…).",
  strategies:
    "Higher-order approaches: interviewing, decomposition, planning, research, refactoring.",
  deployments:
    "Provider-specific deployment playbooks (AWS, Azure, GCP, Cloudflare, Vercel, fly.io…).",
  vbrief: "The durable state format: project definition, specification, scopes, plans.",
  scm: "Source-control conventions and Git/GitHub workflow rules.",
  verification: "How agents prove work is done: gates, validators, coverage, review.",
  tools: "Tooling standards (telemetry, search, formatters, the Taskfile contract).",
  patterns: "Reusable design/interaction patterns for agent work.",
  conventions: "Cross-cutting naming, formatting, and repo conventions.",
  context: "How to feed agents context well: examples, deterministic splits, spec deltas.",
  contracts: "Interface/behavioral contracts the framework enforces.",
  events: "Event and signal definitions used across the framework.",
  interfaces: "Interface definitions and boundaries.",
  platforms: "Platform-specific guidance.",
  resilience: "Failure handling, recovery, and robustness rules.",
  incidents: "Incident handling and postmortem guidance.",
  secrets: "Secret-handling rules and storage conventions.",
  swarm: "Multi-agent (swarm) coordination guidance.",
  references: "External references and citations backing the guidance.",
  meta: "The framework's own philosophy, morals, and self-governance docs.",
  templates: "Reusable document/scaffold templates.",
  docs: "Explanatory docs and the framework glossary.",
};
const NS_PURPOSE: Record<string, string> = {
  scm: "Source-control / Git workflow tasks.",
  commit: "Commit-creation and message-discipline tasks.",
  change: "Change-set staging and review tasks.",
  install: "Installer / bootstrap tasks for consumer projects.",
  migrate: "Migration tasks for moving projects between framework versions.",
  roadmap: "Render and validate the ROADMAP from vBRIEF source.",
  spec: "Specification render/validate tasks (vBRIEF -> SPECIFICATION).",
  pr: "PR-level merge-discipline checks.",
  scope: "Scope lifecycle: promote / activate / complete / fail / cancel.",
  vbrief: "Validate and manage vBRIEF lifecycle state and structure.",
  verify: "Verification gates: stub scans, session ritual, story-ready, oracles.",
  eval: "Self-consistency and quality evaluation tasks.",
};

interface FileItem {
  kind: "file";
  name: string;
  title: string;
  summary: string;
  sections: string[];
  markers: Record<string, number>;
  generated: boolean;
  lines: number;
  path: string;
  body?: string;
  truncated?: boolean;
}
interface DirItem {
  kind: "dir";
  name: string;
  title: string;
  summary: string;
  readme: FileItem | null;
  files: FileItem[];
  count: number;
  path: string;
}
type Item = FileItem | DirItem;
interface Grouping {
  name: string;
  purpose: string;
  item_count: number;
  doc_count: number;
  markers: Record<string, number>;
  path: string;
  items: Item[];
}
interface TaskEntry {
  name: string;
  desc: string;
}
interface TaskNamespace {
  namespace: string;
  purpose: string;
  task_count: number;
  tasks: TaskEntry[];
  path: string;
  unlisted?: boolean;
}
interface Pack {
  path: string;
  name: string;
  version: string;
  rule_count?: number;
  tiers?: Record<string, number>;
  domains?: Record<string, number>;
}
interface Model {
  lifecycle: typeof LIFECYCLE;
  groupings: Grouping[];
  tasks: TaskNamespace[];
  packs: Pack[];
}

const LIFECYCLE = {
  summary:
    "Directive turns a coding agent into an auditable process: load only the guidance a task needs, enforce it with Taskfile gates, keep durable state in vBRIEF, and move work through a small reversible scope lifecycle.",
  rule_strength: [
    { level: "Deterministic checks", detail: "tests, scripts, hooks, CI" },
    { level: "Taskfile targets", detail: "task check, task verify:*, task vbrief:*" },
    { level: "vBRIEF policy", detail: "lifecycle metadata" },
    { level: "RFC2119 instructions", detail: "AGENTS.md, skills, standards" },
    { level: "Plain prose", detail: "rationale only" },
  ],
  scope_states: [
    { state: "proposed", via: "candidate" },
    { state: "pending", via: "scope:promote" },
    { state: "active", via: "scope:activate" },
    { state: "completed", via: "scope:complete" },
    { state: "cancelled", via: "scope:cancel / scope:fail" },
  ],
  vbrief_files: [
    { file: "PROJECT-DEFINITION.vbrief.json", role: "project identity, policy, scope registry" },
    { file: "specification.vbrief.json", role: "project specification source" },
    { file: "plan.vbrief.json", role: "tactical session plan" },
    { file: "continue.vbrief.json", role: "interruption recovery checkpoint" },
  ],
  gates: [
    "task check",
    "task check:framework-source",
    "task verify:session-ritual",
    "task vbrief:validate",
    "task codebase:validate-structure",
  ],
  source: "docs/CONCEPTS.md",
  key_docs: [
    { title: "Key Concepts", path: "docs/CONCEPTS.md" },
    { title: "Architecture", path: "docs/ARCHITECTURE.md" },
    { title: "Files", path: "docs/FILES.md" },
    { title: "README", path: "README.md" },
    { title: "AGENTS.md", path: "AGENTS.md" },
    { title: "main.md", path: "main.md" },
  ],
};

// --------------------------------------------------------------- text helpers
function read(repo: string, rel: string): string {
  try {
    return readFileSync(join(repo, rel), "utf8");
  } catch {
    return "";
  }
}
function h1(t: string): string {
  for (const line of t.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return "";
}
function clamp(p: string, hi: number): string {
  if (p.length <= hi) return p;
  const t = p.slice(0, hi - 3);
  const i = t.lastIndexOf(" ");
  return `${i > 0 ? t.slice(0, i) : t}…`;
}
function firstPara(t: string): string {
  const buf: string[] = [];
  const skip = ["#", ">", "<!--", "**⚠", "Legend", "- [", "|"];
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s) {
      if (buf.length) break;
      continue;
    }
    if (skip.some((p) => s.startsWith(p)) || MARKER_RE.test(line) || s.startsWith("- ")) {
      if (buf.length) break;
      continue;
    }
    buf.push(s);
    if (buf.join(" ").length > 220) break;
  }
  const p = buf.join(" ").replace(/\s+/g, " ").trim();
  return clamp(p, 240);
}
function sections(t: string): string[] {
  return t
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim())
    .slice(0, 12);
}
function isGenerated(t: string): boolean {
  return t.slice(0, 400).includes("AUTO-GENERATED");
}
function markers(t: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const line of t.split("\n")) {
    const m = line.match(MARKER_RE);
    if (m) c[m[1] as string] = (c[m[1] as string] ?? 0) + 1;
  }
  return c;
}
/** Normalize repo-relative paths to `/` so Markdown/HTML output is OS-stable. */
function normRel(p: string): string {
  return p.split("\\").join("/");
}
function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walkMd(full));
    else if (e.endsWith(".md")) out.push(full);
  }
  return out;
}
function walkJson(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walkJson(full));
    else if (e.endsWith(".json")) out.push(full);
  }
  return out;
}

// --------------------------------------------------------------- model build
function summarizeFile(repo: string, rel: string, withBody = true): FileItem {
  const path = normRel(rel);
  const t = read(repo, path);
  const d: FileItem = {
    kind: "file",
    name: basename(path),
    title: h1(t) || basename(path),
    summary: firstPara(t),
    sections: sections(t),
    markers: markers(t),
    generated: isGenerated(t),
    lines: t ? t.split("\n").length : 0,
    path,
  };
  if (withBody) {
    d.body = t.slice(0, MAX_BODY);
    d.truncated = t.length > MAX_BODY;
  }
  return d;
}
function summarizeDir(repo: string, reldir: string): DirItem {
  const dir = normRel(reldir);
  let readme: FileItem | null = null;
  const files: FileItem[] = [];
  for (const entry of readdirSync(join(repo, dir)).sort()) {
    const full = normRel(join(dir, entry));
    const ab = join(repo, full);
    if (statSync(ab).isDirectory()) {
      for (const sub of walkMd(ab)) files.push(summarizeFile(repo, normRel(relative(repo, sub))));
    } else if (entry.endsWith(".md")) {
      const fi = summarizeFile(repo, full);
      if (entry.toLowerCase() === "readme.md") readme = fi;
      else files.push(fi);
    }
  }
  return {
    kind: "dir",
    name: basename(dir),
    title: readme ? readme.title : basename(dir),
    summary: readme ? readme.summary : "",
    readme,
    files,
    count: files.length,
    path: dir,
  };
}
function addMarkers(totals: Record<string, number>, fi: FileItem): void {
  for (const [k, v] of Object.entries(fi.markers)) totals[k] = (totals[k] ?? 0) + v;
}
function buildGroupings(repo: string): Grouping[] {
  const groups: Grouping[] = [];
  const content = join(repo, "content");
  for (const name of readdirSync(content).sort()) {
    const gdir = join(content, name);
    if (!statSync(gdir).isDirectory() || name.startsWith(".") || EXCLUDE_GROUPS.has(name)) continue;
    const rel = normRel(join("content", name));
    const items: Item[] = [];
    for (const entry of readdirSync(gdir).sort()) {
      const full = normRel(join(rel, entry));
      const ab = join(repo, full);
      if (statSync(ab).isDirectory()) items.push(summarizeDir(repo, full));
      else if (entry.endsWith(".md")) items.push(summarizeFile(repo, full));
    }
    const totals: Record<string, number> = {};
    for (const it of items) {
      if (it.kind === "file") addMarkers(totals, it);
      else {
        if (it.readme) addMarkers(totals, it.readme);
        for (const f of it.files) addMarkers(totals, f);
      }
    }
    const groupMarkers: Record<string, number> = {};
    for (const [k, v] of Object.entries(totals)) {
      const label = MARKER_LABEL[k];
      if (label) groupMarkers[label] = v;
    }
    const docCount = items.reduce(
      (a, it) => a + (it.kind === "file" ? 1 : it.count + (it.readme ? 1 : 0)),
      0,
    );
    groups.push({
      name,
      purpose: GROUP_PURPOSE[name] ?? "",
      item_count: items.length,
      doc_count: docCount,
      markers: groupMarkers,
      path: rel,
      items,
    });
  }
  return groups;
}
function parseIncludes(repo: string): { namespace: string; file: string }[] {
  // Normalize CRLF -> LF so the `:\n` include pattern matches Taskfiles saved with
  // Windows line endings (or checked out with core.autocrlf=true).
  const text = read(repo, "Taskfile.yml").replace(/\r\n/g, "\n");
  const out: { namespace: string; file: string }[] = [];
  const re = /^ {2}([a-z][a-z0-9-]*):\n\s+taskfile:\s*\.\/tasks\/(\S+)/gm;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    out.push({ namespace: m[1] as string, file: m[2] as string });
    m = re.exec(text);
  }
  return out;
}
function parseTasks(repo: string, relfile: string): { purpose: string; tasks: TaskEntry[] } {
  const text = read(repo, relfile).replace(/\r\n/g, "\n");
  const tasks: TaskEntry[] = [];
  const lines = text.split("\n");
  let inTasks = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true;
      continue;
    }
    if (!inTasks) continue;
    const nameMatch = line.match(/^ {2}([a-zA-Z_][\w:-]*):\s*$/);
    if (nameMatch) {
      tasks.push({ name: nameMatch[1] as string, desc: "" });
      continue;
    }
    const descMatch = line.match(/^(\s+)desc:\s*["']?(.*?)["']?\s*$/);
    const last = tasks[tasks.length - 1];
    if (descMatch && last && !last.desc) {
      let value = descMatch[2] as string;
      // YAML block scalars (`desc: >-`, `>`, `|`, `|-`) carry their text on the
      // following more-indented lines; fold them into one line rather than
      // recording the literal indicator token (e.g. ">-").
      if (/^[>|][+-]?$/.test(value.trim())) {
        const indent = (descMatch[1] as string).length;
        const buf: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const bl = lines[j] as string;
          if (bl.trim() !== "") {
            const ind = bl.length - bl.replace(/^\s+/, "").length;
            if (ind <= indent) break;
            buf.push(bl.trim());
          }
          j += 1;
        }
        value = buf.join(" ").replace(/\s+/g, " ").trim();
        i = j - 1;
      }
      last.desc = value;
    }
  }
  const comments: string[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s.startsWith("#")) {
      const c = s.replace(/^#+\s*/, "").trim();
      if (c) comments.push(c);
    } else if (s.startsWith("tasks:")) break;
  }
  const bad = [
    "Per ",
    "joinPath",
    "IMPORTANT",
    "CLI_ARGS",
    "env:",
    "----",
    "====",
    "Keep ",
    "templating",
    "native-separator",
    "STUB",
    "PYTHONUTF8",
    "Windows",
    "pwsh",
  ];
  const clean = (c: string): string => {
    if (c.includes(" -- ")) return (c.split(" -- ")[1] ?? "").trim();
    if (c.includes(" — ")) return (c.split(" — ")[1] ?? "").trim();
    return c.trim();
  };
  let purpose = "";
  for (const c of comments) {
    if (bad.some((b) => c.includes(b)) || /^[-=# ]*$/.test(c)) continue;
    purpose = clean(c);
    if (purpose && purpose.length > 6) break;
  }
  if (
    !purpose ||
    (purpose[0] && purpose[0] === purpose[0].toLowerCase() && /[a-z]/.test(purpose[0]))
  ) {
    for (const t of tasks) {
      if (t.desc) {
        purpose = t.desc;
        break;
      }
    }
  }
  return { purpose: clamp(purpose, 140), tasks };
}
function buildTasks(repo: string): TaskNamespace[] {
  const out: TaskNamespace[] = [];
  const seen = new Set<string>();
  for (const inc of parseIncludes(repo)) {
    const rel = normRel(join("tasks", inc.file));
    if (!existsSync(join(repo, rel))) continue;
    const { purpose, tasks } = parseTasks(repo, rel);
    out.push({
      namespace: inc.namespace,
      purpose: NS_PURPOSE[inc.namespace] ?? purpose,
      task_count: tasks.length,
      tasks: tasks.filter((t) => !t.name.startsWith("_")).slice(0, 40),
      path: rel,
    });
    seen.add(inc.file);
  }
  const tasksDir = join(repo, "tasks");
  if (!existsSync(tasksDir)) {
    out.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
    return out;
  }
  for (const f of readdirSync(tasksDir).sort()) {
    if (!f.endsWith(".yml") || seen.has(f)) continue;
    const rel = normRel(join("tasks", f));
    const { purpose, tasks } = parseTasks(repo, rel);
    if (!tasks.length) continue;
    const ns = f.slice(0, -4);
    out.push({
      namespace: ns,
      purpose: NS_PURPOSE[ns] ?? purpose,
      task_count: tasks.length,
      tasks: tasks.filter((t) => !t.name.startsWith("_")).slice(0, 40),
      path: rel,
      unlisted: true,
    });
  }
  out.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
  return out;
}
function counter(values: (string | undefined)[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const v of values) {
    if (v === undefined) continue; // don't pollute with an "undefined" key
    c[v] = (c[v] ?? 0) + 1;
  }
  return c;
}
function buildPacks(repo: string): Pack[] {
  const packs: Pack[] = [];
  for (const pj of walkJson(join(repo, "content", "packs"))) {
    const rel = normRel(relative(repo, pj));
    let d: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(pj, "utf8"));
      // JSON.parse returns top-level null / primitives without throwing; only
      // objects have the fields we read below.
      if (parsed === null || typeof parsed !== "object") continue;
      d = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const info: Pack = {
      path: rel,
      name: (d.pack as string) ?? basename(pj),
      version: (d.version as string) ?? "",
    };
    const rules = d.rules;
    if (Array.isArray(rules)) {
      info.rule_count = rules.length;
      info.tiers = counter(rules.map((r) => (r as { tier?: string }).tier));
      info.domains = counter(rules.map((r) => (r as { domain?: string }).domain));
    }
    packs.push(info);
  }
  return packs;
}
function stripBody(fi: FileItem): void {
  fi.body = undefined;
  fi.truncated = undefined;
}
function buildModel(repo: string, withBodies: boolean): Model {
  const g = buildGroupings(repo);
  if (!withBodies) {
    for (const gr of g) {
      for (const it of gr.items) {
        if (it.kind === "file") stripBody(it);
        else {
          if (it.readme) stripBody(it.readme);
          for (const f of it.files) stripBody(f);
        }
      }
    }
  }
  return { lifecycle: LIFECYCLE, groupings: g, tasks: buildTasks(repo), packs: buildPacks(repo) };
}

// --------------------------------------------------------------- MD rendering
function mdTable(headers: string[], rows: (string | number)[][]): string {
  // Collapse embedded newlines and escape `|` so cell values cannot break table structure
  // (e.g. option syntax like `--format=text|json` in task descriptions).
  // Escape backslashes first so a trailing `\` cannot neutralize the pipe escape (CodeQL js/incomplete-sanitization).
  const cell = (c: string | number): string =>
    String(c).replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const out = [
    `| ${headers.map(cell).join(" | ")} |`,
    `|${headers.map((_, i) => (i === 0 ? "---" : "--:")).join("|")}|`,
  ];
  for (const r of rows) out.push(`| ${r.map(cell).join(" | ")} |`);
  return out.join("\n");
}
function renderMd(model: Model): string {
  const { groupings: g, tasks: tk, packs } = model;
  const totalDocs = g.reduce((a, x) => a + x.doc_count, 0);
  const totalTasks = tk.reduce((a, t) => a + t.task_count, 0);
  const L: string[] = [];
  L.push(
    "<!-- AUTO-GENERATED by `task docs:rule-map` (rule-map CLI verb) — DO NOT EDIT MANUALLY -->",
  );
  L.push("<!-- Source of truth: content/ + tasks/ + Taskfile.yml -->");
  L.push(
    "<!-- Interactive explorer (gitignored): run `task docs:rule-map`, then open docs/rule-map/index.html -->",
  );
  L.push("");
  L.push("# Directive Rule Map");
  L.push("");
  L.push(
    "Maintainer-facing map of how Directive's rules are layered and grouped. This is a " +
      "*derived view* — the source of truth is `content/`, `tasks/`, and the packs. Regenerate " +
      "with `task docs:rule-map` after changing rules; do not hand-edit.",
  );
  L.push("");
  L.push("## Overview");
  L.push("");
  L.push(`- **Rules:** ${g.length} groupings, ${totalDocs} documents`);
  L.push(`- **Tasks:** ${tk.length} namespaces, ${totalTasks} tasks`);
  if (packs.length) {
    const compiled = packs.reduce((a, p) => a + (p.rule_count ?? 0), 0);
    L.push(`- **Packs:** ${packs.length} source-of-truth packs (${compiled} compiled rules)`);
  }
  L.push("");
  L.push(
    "Three layers: **Rules** (lazy-loaded guidance under `content/`), **Tasks** (the Taskfile " +
      "gates that enforce them), and the **Lifecycle** that ties them together.",
  );
  L.push("");
  L.push("## Rule groupings");
  L.push("");
  const grows: (string | number)[][] = g.map((x) => {
    const mk = x.markers;
    return [
      x.name,
      x.purpose || "—",
      x.doc_count,
      mk["MUST"] ?? 0,
      mk["SHOULD"] ?? 0,
      mk["MUST NOT"] ?? 0,
      mk["SHOULD NOT"] ?? 0,
      mk["MAY"] ?? 0,
    ];
  });
  L.push(
    mdTable(
      ["Grouping", "Purpose", "Docs", "MUST", "SHOULD", "MUST NOT", "SHOULD NOT", "MAY"],
      grows,
    ),
  );
  L.push("");
  for (const x of g) {
    L.push(`### ${x.name}`);
    L.push("");
    if (x.purpose) {
      L.push(`_${x.purpose}_`);
      L.push("");
    }
    for (const it of x.items) {
      if (it.kind === "file") {
        L.push(`- \`${it.name}\`${it.summary ? ` — ${it.summary}` : ""}`);
      } else {
        L.push(`- **${it.name}/** (${it.count} files)${it.summary ? ` — ${it.summary}` : ""}`);
      }
    }
    L.push("");
  }
  L.push("## Task namespaces");
  L.push("");
  L.push(
    mdTable(
      ["Namespace", "Purpose", "Tasks"],
      tk.map((t) => [t.namespace, t.purpose || "—", t.task_count]),
    ),
  );
  L.push("");
  const Lf = model.lifecycle;
  L.push("## Lifecycle");
  L.push("");
  L.push(Lf.summary);
  L.push("");
  L.push(
    "**Rule strength (prefer enforceable over remembered):** " +
      Lf.rule_strength.map((r) => `${r.level} (${r.detail})`).join(" → "),
  );
  L.push("");
  L.push(
    "**Scope lifecycle:** " + Lf.scope_states.map((s) => `${s.state} [\`${s.via}\`]`).join(" → "),
  );
  L.push("");
  L.push("**Quality gates:** " + Lf.gates.map((x) => `\`${x}\``).join(", "));
  L.push("");
  if (packs.length) {
    L.push("## Packs (source of truth)");
    L.push("");
    const prows: (string | number)[][] = packs.map((p) => {
      const t = p.tiers ?? {};
      return [
        `\`${p.path}\``,
        p.version || "—",
        p.rule_count ?? "—",
        t["MUST"] ?? 0,
        t["SHOULD"] ?? 0,
        t["MUST_NOT"] ?? 0,
      ];
    });
    L.push(mdTable(["Pack", "Version", "Rules", "MUST", "SHOULD", "MUST_NOT"], prows));
    L.push("");
  }
  return `${L.join("\n").replace(/\n+$/, "")}\n`;
}

// --------------------------------------------------------------- HTML render
function renderHtml(model: Model): string {
  const token = "/*__DATA__*/ null";
  if (!TEMPLATE.includes(token)) {
    throw new Error(`rule-map template missing data injection token: ${token}`);
  }
  // Escape "<" so an embedded "</script>" or "<!--" in rule text can't terminate
  // the inline <script>. Inject via a replacer FUNCTION so that "$" sequences in
  // the JSON (shell/regex snippets contain $&, $1, $') are inserted verbatim
  // rather than being interpreted by String.prototype.replace.
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  return TEMPLATE.replace(token, () => data);
}

// --------------------------------------------------------------- main
function resolveFrameworkRoot(): string {
  const env = process.env.DEFT_ROOT;
  if (env) return env;
  // dist/render/rule-map.js -> repo root is 4 levels up (packages/core/dist/render)
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export function main(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "usage: rule-map [--project-root <dir>] [--check]\n" +
        "  builds docs/RULE-MAP.md (committed) and docs/rule-map/index.html (gitignored)\n",
    );
    return 0;
  }
  let projectRoot: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project-root") {
      projectRoot = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--check") {
      check = true;
    }
  }
  const repo = resolve(projectRoot ?? resolveFrameworkRoot());
  if (!existsSync(join(repo, "content"))) {
    process.stderr.write(`error: ${repo} is not a Directive repo (no content/)\n`);
    return 2;
  }

  const mdPath = join(repo, "docs", "RULE-MAP.md");
  const htmlDir = join(repo, "docs", "rule-map");
  const htmlPath = join(htmlDir, "index.html");

  const model = buildModel(repo, false);
  const md = renderMd(model);

  if (check) {
    const current = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    // Normalize CRLF so a Windows checkout (core.autocrlf=true) isn't reported STALE.
    if (current.replace(/\r\n/g, "\n") !== md) {
      process.stderr.write("STALE: docs/RULE-MAP.md is out of date — run `task docs:rule-map`\n");
      return 1;
    }
    process.stdout.write("ok: docs/RULE-MAP.md is up to date\n");
    return 0;
  }

  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, md, "utf8");
  mkdirSync(htmlDir, { recursive: true });
  const html = renderHtml(buildModel(repo, true));
  writeFileSync(htmlPath, html, "utf8");

  // Reuse the no-body model built above for the summary counts (no third scan).
  process.stdout.write(`✓ docs/RULE-MAP.md         (${md.split("\n").length} lines, committed)\n`);
  process.stdout.write(
    `✓ docs/rule-map/index.html (${Math.floor(html.length / 1024)} KB, gitignored, self-contained)\n`,
  );
  process.stdout.write(
    `  groupings=${model.groupings.length} tasks=${model.tasks.length} packs=${model.packs.length}\n`,
  );
  process.stdout.write(`\nOpen the interactive map:\n  ${htmlPath}\n`);
  return 0;
}

// run-as-main guard (also lets `tsx rule-map.ts` work for local verification)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
