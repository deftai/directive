/**
 * One-shot open-issue label migration for deftai/directive (#3128).
 * Applies #2609 twin renames + curated role/platform stamps.
 *
 * Usage:
 *   node .github/scripts/migrate-issue-labels-3128.mjs --dry-run
 *   node .github/scripts/migrate-issue-labels-3128.mjs --apply
 *
 * Requires: gh authenticated to deftai/directive.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "deftai/directive";
const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

function ghJson(args) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(out);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function searchOpenLabel(label) {
  const q = `repo:${REPO} is:issue is:open label:"${label}"`;
  const items = [];
  let page = 1;
  for (;;) {
    const j = ghJson([
      "api",
      `search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
    ]);
    items.push(...(j.items || []));
    if (!j.items?.length || items.length >= j.total_count) break;
    page += 1;
    if (page > 10) break;
    sleep(800);
  }
  return items.map((i) => ({
    number: i.number,
    title: i.title,
    labels: (i.labels || []).map((l) => l.name),
  }));
}

function issueLabels(n) {
  const j = ghJson(["api", `repos/${REPO}/issues/${n}`]);
  return {
    number: n,
    title: j.title,
    state: j.state,
    labels: (j.labels || []).map((l) => l.name),
  };
}

function setLabels(n, nextLabels) {
  const body = JSON.stringify({ labels: nextLabels });
  if (DRY) {
    return { ok: true, dry: true };
  }
  execFileSync(
    "gh",
    ["api", "-X", "PATCH", `repos/${REPO}/issues/${n}`, "--input", "-"],
    { input: body, encoding: "utf8" },
  );
  return { ok: true };
}

/** Twin: remove deprecated, ensure keep (preserve other labels). */
function twinPlan(issue, remove, add) {
  const set = new Set(issue.labels);
  if (!set.has(remove)) return null;
  set.delete(remove);
  set.add(add);
  return { number: issue.number, title: issue.title, from: remove, to: add, labels: [...set].sort() };
}

/** Ensure labels present; remove optional. */
function ensurePlan(issue, add = [], remove = []) {
  const set = new Set(issue.labels);
  let changed = false;
  for (const a of add) {
    if (!set.has(a)) {
      set.add(a);
      changed = true;
    }
  }
  for (const r of remove) {
    if (set.has(r)) {
      set.delete(r);
      changed = true;
    }
  }
  if (!changed) return null;
  return {
    number: issue.number,
    title: issue.title,
    add,
    remove,
    labels: [...set].sort(),
  };
}

// --- Twin inventory ---
const twins = [
  { remove: "docs", add: "documentation" },
  { remove: "skills", add: "area:skills" },
  { remove: "installer", add: "area:installer" },
];

const twinOps = [];
for (const t of twins) {
  const issues = searchOpenLabel(t.remove);
  for (const iss of issues) {
    const plan = twinPlan(iss, t.remove, t.add);
    if (plan) twinOps.push(plan);
  }
  sleep(500);
}

// --- Curated role / platform (graph-informed, skip rather than invent parents) ---
// Process board: tracker without epic
const rolePlans = [];

function load(n) {
  try {
    return issueLabels(n);
  } catch {
    return null;
  }
}

const ROLE_SCOPE = {
  // Process mega-review: tracker, not product epic
  886: { add: ["status:tracker"], remove: ["epic"] },
  // Product multi-ship roots → epic + status:tracker
  1423: { add: ["epic", "status:tracker", "status:child"], remove: [] }, // child of #886
  2741: { add: ["epic", "status:tracker"], remove: [] },
  2812: { add: ["epic", "status:tracker"], remove: [] },
  2603: { add: ["epic", "status:tracker"], remove: [] },
  1589: { add: ["epic", "status:tracker"], remove: [] },
  1545: { add: ["epic", "status:tracker"], remove: [] },
  635: { add: ["epic", "status:tracker"], remove: [] },
  3081: { add: ["epic", "status:tracker"], remove: [] },
  3082: { add: ["epic", "status:tracker"], remove: [] },
  3078: { add: ["epic", "status:tracker"], remove: [] },
  2769: { add: ["epic", "status:tracker"], remove: [] },
  1285: { add: ["epic", "status:tracker"], remove: [] },
  // Nested under taxonomy track / umbrella children
  3128: { add: ["status:child"], remove: [] }, // child of #2609 (closed parent still graph-valid)
  2611: { add: ["status:child"], remove: [] },
  3124: { add: ["status:child"], remove: [] },
  3129: { add: ["status:child"], remove: [] }, // plan entry under #886 triage track
  1789: { add: ["status:child"], remove: [] }, // area:* rollout, coordinate with taxonomy
  // Meta process trackers
  1119: { add: ["status:tracker"], remove: [] },
  1140: { add: ["status:tracker"], remove: [] },
  1094: { add: ["status:tracker"], remove: [] },
  2018: { add: ["status:tracker"], remove: [] },
  // Platform-intrinsic open seeds (#2609)
  412: { add: ["platform:windows"], remove: [] },
  1422: { add: ["platform:windows"], remove: [] },
};

for (const [numStr, spec] of Object.entries(ROLE_SCOPE)) {
  const n = Number(numStr);
  const iss = load(n);
  if (!iss || iss.state !== "open") continue;
  const plan = ensurePlan(iss, spec.add, spec.remove);
  if (plan) rolePlans.push(plan);
  sleep(200);
}

const report = {
  generated_at: new Date().toISOString(),
  mode: DRY ? "dry-run" : "apply",
  repo: REPO,
  twin_ops: twinOps,
  twin_count: twinOps.length,
  role_ops: rolePlans,
  role_count: rolePlans.length,
  notes: [
    "Twins: docs→documentation, skills→area:skills, installer→area:installer (open only).",
    "Roles: curated set only — skip unknown parents rather than stamp status:child from titles.",
    "Machine mirror (triage:classify --mirror --apply) is optional and NOT run by this script.",
    "Closed history not rewritten.",
  ],
};

const reportPath = join(process.cwd(), ".github", "ISSUE_LABEL_MIGRATION_3128.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`Report: ${reportPath}`);
console.log(`Twin ops: ${twinOps.length}; Role ops: ${rolePlans.length}; mode=${report.mode}`);

const allOps = [
  ...twinOps.map((o) => ({ kind: "twin", ...o })),
  ...rolePlans.map((o) => ({ kind: "role", ...o })),
];

// Dedupe by issue number: merge label sets if both twin and role touch same issue
const byNum = new Map();
for (const o of allOps) {
  const prev = byNum.get(o.number);
  if (!prev) {
    byNum.set(o.number, { number: o.number, title: o.title, labels: new Set(o.labels) });
  } else {
    for (const l of o.labels) prev.labels.add(l);
    // twins already removed deprecated in o.labels; role uses full desired set after ensure
    // Prefer intersection of intent: start from latest labels array which is complete set
    prev.labels = new Set(o.labels);
  }
}

// Rebuild correctly: start from live labels, apply all transforms
function applyTransforms(issue) {
  const set = new Set(issue.labels);
  // twins
  for (const t of twins) {
    if (set.has(t.remove)) {
      set.delete(t.remove);
      set.add(t.add);
    }
  }
  // role
  const role = ROLE_SCOPE[issue.number];
  if (role) {
    for (const a of role.add) set.add(a);
    for (const r of role.remove) set.delete(r);
  }
  const next = [...set].sort();
  const same =
    next.length === issue.labels.length && next.every((l) => issue.labels.includes(l));
  return same ? null : next;
}

// Re-fetch and apply per unique number from twinOps + ROLE_SCOPE
const targets = new Set([
  ...twinOps.map((o) => o.number),
  ...Object.keys(ROLE_SCOPE).map(Number),
]);

let applied = 0;
let skipped = 0;
const results = [];
for (const n of [...targets].sort((a, b) => a - b)) {
  const iss = load(n);
  if (!iss || iss.state !== "open") {
    skipped += 1;
    continue;
  }
  const next = applyTransforms(iss);
  if (!next) {
    skipped += 1;
    continue;
  }
  console.log(`#${n}: ${iss.labels.join(",")} -> ${next.join(",")}`);
  setLabels(n, next);
  applied += 1;
  results.push({ number: n, before: iss.labels, after: next });
  if (!DRY) sleep(350);
}

report.applied = applied;
report.skipped = skipped;
report.results = results;
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`Done. applied=${applied} skipped=${skipped} mode=${report.mode}`);
if (DRY) {
  console.log("Re-run with --apply to mutate labels.");
}
