#!/usr/bin/env node
/**
 * Golden-output parity harness (#1782 s4): runs BOTH the frozen Python oracles
 * and the ported TS vbrief-reconcile CLI over shared fixtures (fake gh on PATH,
 * cache-off), then diffs exit codes and byte-identical stdout/stderr.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PARITY_SCENARIO_NAMES } from "@deftai/core/vbrief-reconcile";

const FAKE_GH_PY = `import json
import os
import sys

STATE = {"labels": {}, "comments": {}, "next_id": 1000}

def classify(cmd):
    joined = " ".join(cmd)
    if "issue" in cmd and "view" in cmd and "--json" in cmd and "labels" in joined:
        return "issue-labels"
    if "issue" in cmd and "edit" in cmd:
        return "issue-edit"
    if "/issues/" in joined and "/comments" in joined and "-X" not in cmd:
        return "list-comments"
    if "-X" in cmd and "PATCH" in cmd and "/issues/comments/" in joined:
        return "patch-comment"
    if "-X" in cmd and "POST" in joined and "/issues/" in joined and "/comments" in joined:
        return "post-comment"
    return "unknown"

def handle(label, cmd):
    responses = json.loads(os.environ.get("DEFT_FAKE_GH_RESPONSES", "{}"))
    if label in responses:
        return responses[label]
    if label == "issue-labels":
        repo = cmd[cmd.index("--repo") + 1]
        num = int(cmd[cmd.index("view") + 1])
        labels = STATE["labels"].get((repo, num), [])
        return {"returncode": 0, "stdout": json.dumps({"labels": [{"name": n} for n in labels]})}
    if label == "issue-edit":
        repo = cmd[cmd.index("--repo") + 1]
        num = int(cmd[cmd.index("edit") + 1])
        key = (repo, num)
        cur = set(STATE["labels"].get(key, []))
        i = 0
        while i < len(cmd):
            if cmd[i] == "--add-label":
                cur.add(cmd[i + 1]); i += 2
            elif cmd[i] == "--remove-label":
                cur.discard(cmd[i + 1]); i += 2
            else:
                i += 1
        STATE["labels"][key] = sorted(cur)
        return {"returncode": 0, "stdout": ""}
    if label == "list-comments":
        parts = [p for p in cmd[-1].split("/") if p]
        repo = "/".join(parts[1:3])
        num = int(parts[3])
        comments = STATE["comments"].get((repo, num), [])
        return {"returncode": 0, "stdout": json.dumps(comments)}
    if label == "post-comment":
        parts = [p for p in cmd if "/issues/" in p][0].split("/")
        repo = "/".join(parts[1:3])
        num = int(parts[3])
        body = json.loads(sys.stdin.read())["body"]
        cid = STATE["next_id"]; STATE["next_id"] += 1
        STATE["comments"].setdefault((repo, num), []).append({"id": cid, "body": body})
        return {"returncode": 0, "stdout": json.dumps({"id": cid})}
    if label == "patch-comment":
        cid = int([p for p in cmd if "/issues/comments/" in p][0].split("/")[-1])
        body = json.loads(sys.stdin.read())["body"]
        for bucket in STATE["comments"].values():
            for c in bucket:
                if c["id"] == cid:
                    c["body"] = body
        return {"returncode": 0, "stdout": ""}
    return {"returncode": 1, "stderr": f"unexpected gh call: {label}", "stdout": ""}

label = classify(sys.argv[1:])
resp = handle(label, sys.argv[1:])
stdout = resp.get("stdout", "")
stderr = resp.get("stderr", "")
if stdout:
    sys.stdout.write(stdout if stdout.endswith("\\n") else stdout)
if stderr:
    sys.stderr.write(stderr)
sys.exit(int(resp.get("returncode", 0)))
`;

const PYTHON_DRIVER = `import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ["DEFT_ROOT"])
sys.path.insert(0, str(ROOT / "scripts"))

from _vbrief_reconciliation import (
    build_spec_task_index,
    format_reconciliation_markdown,
    parse_overrides_yaml,
    reconcile_scope_items,
)
from vbrief_reconcile_umbrellas import parse_current_shape
import _vbrief_reconciliation as _vr_mod

FIXED_REPORT_NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)

OVERRIDES_SAMPLE = """overrides:
  t2.4.1:
    status: completed
    body_source: spec
  roadmap-9:
    drop: true
"""

PARSE_SHAPE_BODY = (
    "## Current shape (as of pass-4)\\n"
    "Last updated:    2026-06-19T00:00:00Z   \\n"
    "Last pass type:\\tverify\\t\\n"
    "Child-count history:   pass-1: 2, pass-2: 3,  pass-3: 5\\n"
    "Trailing field with empty value:      \\n"
    "Child-count history: pass-9: 9"
)

def spec_with(items):
    return {
        "vBRIEFInfo": {"version": "0.5", "description": "spec"},
        "plan": {"title": "Spec", "status": "approved", "narratives": {}, "items": items},
    }

def run_scenario(name):
    if name == "reconcile-overrides":
        return {"scenario": name, "ok": True, "payload": parse_overrides_yaml(OVERRIDES_SAMPLE)}
    if name == "reconcile-spec-index":
        spec = spec_with([
            {"id": "t1.1", "title": "One", "status": "pending"},
            {
                "id": "phase-1",
                "title": "Phase 1: Foundation",
                "status": "pending",
                "subItems": [{"id": "t1.1.1", "title": "Deep task", "status": "pending"}],
            },
        ])
        index = build_spec_task_index(spec)
        return {
            "scenario": name,
            "ok": True,
            "payload": {"keys": sorted(index.keys()), "deepPhase": index["t1.1.1"].spec_phase},
        }
    if name == "reconcile-scope-clean":
        spec = spec_with([{"id": "t1", "title": "Task one", "status": "pending"}])
        items, report = reconcile_scope_items(
            roadmap_active=[{"number": "", "task_id": "t1", "title": "Task one", "phase": "Phase 1"}],
            roadmap_completed=[],
            spec_vbrief=spec,
        )
        return {"scenario": name, "ok": True, "payload": {"items": items, "hasDisagreement": report.has_disagreement()}}
    if name == "reconcile-scope-orphan":
        spec = spec_with([{"id": "t1", "title": "One", "status": "pending"}])
        items, report = reconcile_scope_items(
            roadmap_active=[{"number": "9", "title": "Orphan task", "phase": "Phase 1", "synthetic_id": "roadmap-9"}],
            roadmap_completed=[],
            spec_vbrief=spec,
        )
        return {"scenario": name, "ok": True, "payload": {"items": items, "orphans": report.orphans}}
    if name == "reconcile-report":
        spec = spec_with([{"id": "t2.4.1", "title": "Repo indexer", "status": "pending"}])
        _, report = reconcile_scope_items(
            roadmap_active=[],
            roadmap_completed=[{"number": "", "task_id": "t2.4.1", "title": "Repo indexer", "phase": "Completed"}],
            spec_vbrief=spec,
        )
        class _FixedDatetime:
            UTC = timezone.utc

            @staticmethod
            def now(tz=None):
                return FIXED_REPORT_NOW

        prior = _vr_mod.datetime
        _vr_mod.datetime = _FixedDatetime
        try:
            payload = format_reconciliation_markdown(report)
        finally:
            _vr_mod.datetime = prior
        return {"scenario": name, "ok": True, "payload": payload}
    if name == "reconcile-parse-shape":
        shape = parse_current_shape(PARSE_SHAPE_BODY)
        return {
            "scenario": name,
            "ok": True,
            "payload": {
                "passN": shape.pass_n,
                "history": [[n, c] for n, c in shape.history],
                "lastUpdated": shape.last_updated,
                "lastPassType": shape.last_pass_type,
            },
        }
    raise SystemExit(f"unknown library scenario: {name}")

if __name__ == "__main__":
    name = sys.argv[sys.argv.index("--scenario") + 1] if "--scenario" in sys.argv else None
    if not name:
        raise SystemExit("usage: driver --scenario NAME")
    print(json.dumps(run_scenario(name), indent=2))
`;

export interface ScenarioResult {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly scenarios: Array<{
    readonly name: string;
    readonly exitMismatch: boolean;
    readonly pythonExit: number;
    readonly tsExit: number;
    readonly outputMismatch: boolean;
    readonly pythonOutput: string;
    readonly tsOutput: string;
  }>;
}

const LIBRARY_SCENARIOS = new Set([
  "reconcile-overrides",
  "reconcile-spec-index",
  "reconcile-scope-clean",
  "reconcile-scope-orphan",
  "reconcile-report",
  "reconcile-parse-shape",
]);

function installFakeGh(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-fake-gh-"));
  for (const name of ["gh", "ghx"]) {
    const bin = join(binDir, name);
    writeFileSync(bin, `#!/usr/bin/env python3\n${FAKE_GH_PY}`, "utf8");
    chmodSync(bin, 0o755);
  }
  return { binDir, cleanup: () => rmSync(binDir, { recursive: true, force: true }) };
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ScenarioResult {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    name: "",
    exitCode: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT) return resolve(process.env.DEFT_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function installPythonDriver(): { driverPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-driver-"));
  const driverPath = join(dir, "vbrief_reconcile_parity_driver.py");
  writeFileSync(driverPath, PYTHON_DRIVER, "utf8");
  chmodSync(driverPath, 0o755);
  return { driverPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeGhResponsesForScenario(
  name: string,
): Record<string, { returncode: number; stdout?: string; stderr?: string }> {
  if (name === "labels-blocked-dry-run" || name === "labels-utf8-dry-run") {
    return {
      "issue-labels": { returncode: 0, stdout: "[]\n" },
    };
  }
  if (name === "umbrellas-create-dry-run") {
    return { "list-comments": { returncode: 0, stdout: "[]\n" } };
  }
  if (name === "umbrellas-unchanged") {
    return { "list-comments": { returncode: 0, stdout: "[]\n" } };
  }
  return {};
}

function writeGraphFixtures(root: string, name: string): void {
  const writeBrief = (storyId: string, folder: string, dependsOn: string[] = []) => {
    const dir = join(root, "vbrief", folder);
    mkdirSync(dir, { recursive: true });
    const statusMap: Record<string, string> = {
      proposed: "proposed",
      completed: "completed",
    };
    writeFileSync(
      join(dir, `2026-05-21-${storyId}.vbrief.json`),
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            id: storyId,
            title: storyId,
            status: statusMap[folder] ?? "pending",
            narratives: {
              Description: `${storyId} description.`,
              ImplementationPlan: `1. Do ${storyId}.`,
              UserStory: `As a user, I want ${storyId}.`,
              Traces: "FR-1",
            },
            items: [
              {
                id: `${storyId}-a1`,
                title: "Acceptance item 1",
                status: "pending",
                narrative: { Acceptance: `Given X when ${storyId} then Y.` },
              },
            ],
            metadata: {
              kind: "story",
              swarm: {
                readiness: "ready",
                parallel_safe: true,
                file_scope: [`src/${storyId}.py`],
                verify_commands: [`pytest ${storyId}`],
                expected_outputs: ["tests pass"],
                depends_on: dependsOn,
                conflict_group: "reconcile-suite",
                size: "small",
                file_scope_confidence: "high",
                model_tier: "standard",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  if (name === "graph-dry-run") {
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeBrief("dep-done", "completed");
    writeBrief("child", "proposed", ["dep-done"]);
  } else if (name === "graph-cycle") {
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeBrief("a", "proposed", ["b"]);
    writeBrief("b", "proposed", ["a"]);
  } else if (name === "graph-missing-proposed") {
    mkdirSync(join(root, "vbrief"), { recursive: true });
  }
}

function runGraphCliParity(
  deftRoot: string,
  name: string,
  fixture: string,
  env: Record<string, string>,
): { python: ScenarioResult; ts: ScenarioResult } {
  writeGraphFixtures(fixture, name);
  const py = runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "vbrief_reconcile_graph.py"),
      "--project-root",
      fixture,
      "--dry-run",
    ],
    deftRoot,
    env,
  );
  const ts = runCapture(
    "node",
    [
      join(deftRoot, "packages", "cli", "dist", "vbrief-reconcile.js"),
      "graph",
      "--project-root",
      fixture,
      "--dry-run",
    ],
    deftRoot,
    env,
  );
  return {
    python: { name, exitCode: py.exitCode, stdout: py.stdout, stderr: py.stderr },
    ts: { name, exitCode: ts.exitCode, stdout: ts.stdout, stderr: ts.stderr },
  };
}

function writeLabelsUmbrellasFixtures(root: string, name: string): void {
  const writeBrief = (storyId: string, folder: string, extra: Record<string, unknown> = {}) => {
    const dir = join(root, "vbrief", folder);
    mkdirSync(dir, { recursive: true });
    const statusMap: Record<string, string> = {
      proposed: "proposed",
      pending: "pending",
      active: "running",
      completed: "completed",
      cancelled: "cancelled",
    };
    writeFileSync(
      join(dir, `2026-05-21-${storyId}.vbrief.json`),
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            id: storyId,
            title: storyId,
            status: statusMap[folder] ?? "pending",
            narratives: {
              Description: `${storyId} description.`,
              ImplementationPlan: `1. Do ${storyId}.`,
              UserStory: `As a user, I want ${storyId}.`,
              Traces: "FR-1",
            },
            items: [
              {
                id: `${storyId}-a1`,
                title: "Acceptance item 1",
                status: "pending",
                narrative: { Acceptance: `Given X when ${storyId} then Y.` },
              },
            ],
            metadata: {
              kind: "story",
              swarm: {
                readiness: "ready",
                parallel_safe: true,
                file_scope: [`src/${storyId}.py`],
                verify_commands: [`pytest ${storyId}`],
                expected_outputs: ["tests pass"],
                depends_on: [],
                conflict_group: "reconcile-suite",
                size: "small",
                file_scope_confidence: "high",
                model_tier: "standard",
              },
            },
            references: [],
            ...extra,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  if (name === "labels-blocked-dry-run") {
    writeBrief("blk", "active", {
      status: "blocked",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/10",
          type: "x-vbrief/github-issue",
          title: "Issue #10",
        },
      ],
    });
  } else if (name === "labels-utf8-dry-run") {
    writeBrief("utf8", "active", {
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/11",
          type: "x-vbrief/github-issue",
          title: "Issue #11 — smart “quotes”",
        },
      ],
    });
  } else if (name === "umbrellas-create-dry-run") {
    writeBrief("child-a", "active", { metadata: { kind: "story", swarm: { depends_on: [] } } });
    writeBrief("epic-1", "active", {
      metadata: { kind: "epic", swarm: { depends_on: [] } },
      references: [
        { uri: "active/2026-05-21-child-a.vbrief.json", type: "x-vbrief/plan", title: "child-a" },
        {
          uri: "https://github.com/deftai/directive/issues/1284",
          type: "x-vbrief/github-issue",
          title: "Issue #1284",
        },
      ],
    });
  } else if (name === "umbrellas-unchanged") {
    writeBrief("child-b", "active", { metadata: { kind: "story", swarm: { depends_on: [] } } });
    writeBrief("epic-2", "active", {
      metadata: { kind: "epic", swarm: { depends_on: [] } },
      references: [
        { uri: "active/2026-05-21-child-b.vbrief.json", type: "x-vbrief/plan", title: "child-b" },
        {
          uri: "https://github.com/deftai/directive/issues/1285",
          type: "x-vbrief/github-issue",
          title: "Issue #1285",
        },
      ],
    });
  }
}

function runLabelsUmbrellasParity(
  deftRoot: string,
  name: string,
  env: Record<string, string>,
): { python: ScenarioResult; ts: ScenarioResult } {
  const pyFixture = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-py-"));
  const tsFixture = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-ts-"));
  const script = name.startsWith("labels-")
    ? "vbrief_reconcile_labels.py"
    : "vbrief_reconcile_umbrellas.py";
  const verb = name.startsWith("labels-") ? "labels" : "umbrellas";
  try {
    writeLabelsUmbrellasFixtures(pyFixture, name);
    writeLabelsUmbrellasFixtures(tsFixture, name);

    if (name === "umbrellas-unchanged") {
      runCapture(
        "uv",
        ["run", "python", join(deftRoot, "scripts", script), "--project-root", pyFixture],
        deftRoot,
        env,
      );
      runCapture(
        "node",
        [
          join(deftRoot, "packages", "cli", "dist", "vbrief-reconcile.js"),
          verb,
          "--project-root",
          tsFixture,
        ],
        deftRoot,
        env,
      );
    }

    const pyArgs = [
      "run",
      "python",
      join(deftRoot, "scripts", script),
      "--project-root",
      pyFixture,
      "--dry-run",
    ];
    const tsArgs = [
      join(deftRoot, "packages", "cli", "dist", "vbrief-reconcile.js"),
      verb,
      "--project-root",
      tsFixture,
      "--dry-run",
    ];
    const py = runCapture("uv", pyArgs, deftRoot, env);
    const ts = runCapture("node", tsArgs, deftRoot, env);
    return {
      python: { name, exitCode: py.exitCode, stdout: py.stdout, stderr: py.stderr },
      ts: { name, exitCode: ts.exitCode, stdout: ts.stdout, stderr: ts.stderr },
    };
  } finally {
    rmSync(pyFixture, { recursive: true, force: true });
    rmSync(tsFixture, { recursive: true, force: true });
  }
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const driver = installPythonDriver();
  const fake = installFakeGh();
  const scenarios: ParityResult["scenarios"] = [];

  try {
    for (const name of PARITY_SCENARIO_NAMES) {
      const env = {
        DEFT_CACHE_DISABLE: "1",
        PYTHONUTF8: "1",
        PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
        DEFT_ROOT: deftRoot,
        DEFT_FAKE_GH_RESPONSES: JSON.stringify(fakeGhResponsesForScenario(name)),
      };

      let ran: { python: ScenarioResult; ts: ScenarioResult };
      if (LIBRARY_SCENARIOS.has(name)) {
        const pyFixture = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-lib-py-"));
        const tsFixture = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-lib-ts-"));
        try {
          const py = runCapture(
            "uv",
            ["run", "python", driver.driverPath, "--scenario", name],
            deftRoot,
            env,
          );
          const ts = runCapture(
            "node",
            [
              join(deftRoot, "packages", "cli", "dist", "vbrief-reconcile.js"),
              "parity",
              "--scenario",
              name,
              "--fixture-root",
              tsFixture,
            ],
            deftRoot,
            env,
          );
          ran = {
            python: { name, exitCode: py.exitCode, stdout: py.stdout, stderr: py.stderr },
            ts: { name, exitCode: ts.exitCode, stdout: ts.stdout, stderr: ts.stderr },
          };
        } finally {
          rmSync(pyFixture, { recursive: true, force: true });
          rmSync(tsFixture, { recursive: true, force: true });
        }
      } else if (name.startsWith("graph-")) {
        const fixture = mkdtempSync(join(tmpdir(), "deft-vbrief-reconcile-graph-"));
        try {
          ran = runGraphCliParity(deftRoot, name, fixture, env);
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      } else {
        ran = runLabelsUmbrellasParity(deftRoot, name, env);
      }

      scenarios.push({
        name,
        pythonExit: ran.python.exitCode,
        tsExit: ran.ts.exitCode,
        exitMismatch: ran.python.exitCode !== ran.ts.exitCode,
        outputMismatch: ran.python.stdout !== ran.ts.stdout || ran.python.stderr !== ran.ts.stderr,
        pythonOutput: ran.python.stdout || ran.python.stderr,
        tsOutput: ran.ts.stdout || ran.ts.stderr,
      });
    }
  } finally {
    driver.cleanup();
    fake.cleanup();
  }

  const ok = scenarios.every((s) => !s.exitMismatch && !s.outputMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `vbrief_reconcile parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["vbrief_reconcile parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.outputMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      if (s.outputMismatch) {
        lines.push(`    python (${s.pythonOutput.length} bytes):`);
        lines.push(s.pythonOutput.slice(0, 500));
        lines.push(`    ts (${s.tsOutput.length} bytes):`);
        lines.push(s.tsOutput.slice(0, 500));
      }
    }
  }
  return lines.join("\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(`${renderReport(result)}\n`);
      process.exit(0);
    }
    process.stderr.write(`${renderReport(result)}\n`);
    process.exit(1);
  } catch (err) {
    const msg = String(err).replace(/\r?\n/g, " ");
    process.stderr.write(`vbrief_reconcile parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
