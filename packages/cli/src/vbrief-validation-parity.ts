#!/usr/bin/env node
/**
 * Golden-output parity harness (#1782 s2): runs BOTH the Python oracle
 * (frozen ``scripts/_vbrief_*.py`` helpers via an inline driver) and the
 * ported TS vbrief-validation CLI over shared fixtures, then diffs exit codes
 * and byte-identical stdout/stderr (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PARITY_SCENARIO_NAMES } from "@deftai/core/vbrief-validation";

const PYTHON_DRIVER = String.raw`import json, os, sys
from pathlib import Path

ROOT = Path(os.environ["DEFT_ROOT"])
sys.path.insert(0, str(ROOT / "scripts"))

from _vbrief_validation import (
    HASH_SUFFIX_LENGTH,
    ID_MAX_LENGTH,
    RECOVERY_HINT,
    finalize_migration,
    isolate_invalid_output,
    slug_fallback_id,
    slugify_id,
    validate_migration_output,
)
from _vbrief_fidelity import (
    align_spec_narratives,
    build_edges_from_tasks,
    build_requirements_narrative,
    format_migration_log_entry,
    ingest_spec_narratives,
    map_spec_status,
    parse_requirement_definitions,
    parse_spec_tasks,
    task_scope_narratives,
)
from _vbrief_legacy import (
    lookup_canonical,
    normalize_title,
    parse_top_level_sections,
    partition_sections,
    SPEC_KNOWN_MAPPINGS,
)
from _vbrief_story_quality import story_quality_issues
from _vbrief_safety import (
    RenameRecord,
    SafetyManifest,
    dirty_tree_refusal_message,
    is_tree_dirty,
    plan_backups,
    premigrate_sibling,
    sha256_of,
    write_backups,
)

DEPRECATION_SENTINEL = "<!-- deft:deprecated-redirect -->"

SAMPLE_SPEC_TASKS = """## Overview

Intro.

### t1.1.1 -- Widget support [done]

Build the widget layer.

Depends on: t1.0.1, t1.0.2

**Traces**: FR-1, NFR-2

Acceptance criteria:

- Given a user, when they open the widget, then it renders.

- The widget persists state across reloads.

## Requirements

FR-1: Users can open widgets.
NFR-2: Widget state persists.
"""

STORY_QUALITY_BASE = {
    "title": "Auth model",
    "description": (
        "Auth model persistence stores user identity and session state. The story covers focused "
        "model changes plus matching unit tests for save and load behavior."
    ),
    "implementation_plan": (
        "- Update the src/auth model persistence code so valid payloads are saved through the model boundary.\n"
        "- Add focused tests for successful persistence and a missing-record fixture in tests/auth/model."
    ),
    "user_story": "As an auth maintainer, I want persisted user records, so that login state survives requests.",
    "acceptance_texts": [
        "Given a valid user payload, when the auth model saves it, then the user record persists.",
        "Given an existing user, when the auth model loads it, then the saved identity returns.",
    ],
    "acceptance_count_justification": "",
    "swarm": {
        "file_scope": ["src/auth/model.ts", "tests/auth/model.test.ts"],
        "verify_commands": ["npm test -- auth/model"],
        "expected_outputs": ["Updated auth model tests pass"],
        "depends_on": [],
        "conflict_group": "auth",
        "size": "M",
        "file_scope_confidence": "high",
        "model_tier": "medium",
        "parallel_safe": True,
    },
    "concurrent_ready": True,
}

EDGE_SPEC = """### t1.1.1 -- Title A [done]

Body line.

Depends on: t1.0.1, t1.0.2

**Traces**: FR-1, NFR-2

Acceptance criteria:

- crit one

#### \x60t2.2\x60 Backtick title

**Depends on** : none

Traces: FR-9

Acceptance:

- crit two

### t3.3.3: colon title [pending]

Dependson: t1.0.1

##### t6.6.6 five hashes not a task

### t4.4.4    spaced   [wip]

### t5.5.5 title with [notend] tail
"""

EDGE_HEADINGS = """## Title one  

body1

##   Spaced Title   

body2

## 

still body

### h3 not top

## Final

last
"""

EDGE_SLUGS = ["---Hello---World---", "!!!", "  spaced  ", "Mix-Of_Things 42", "a" * 90 + "----"]

EDGE_STORIES = [
    "As  a   maintainer ,  I want   x , so   that   y .",
    "As an engineer, I want feature, so that benefit.",
    "as a x, i want y, so that z.",
    "As a role, I want cap, so that out",
    "As a, I want y, so that z.",
    "As a role, I want cap, so that done.",
    "As a dev, I want\nmulti line, so that\noutcome.\n",
    "As a dev, I want a, b, c, so that x, y, z.",
    "As a   role,   I   want   cap,   so   that   out.",
    "   As a role, I want cap, so that out.  \n",
    "As a role, I want cap, so that out",
    "As a role, I want cap.",
    "As a role, so that out.",
    "I want cap, As a role, so that out.",
    "As animal, I want cap, so that out.",
    "As a role, I want , so that out.",
    "As a role, I want cap, so that .",
    "As a role, I want cap, so that v1.2 ships.",
    "As a role, I want cap, so that out.x",
]


def sorted_diag(errors, warnings):
    return {"errors": sorted(errors), "warnings": sorted(warnings)}


def sort_failure_actions(actions):
    prefix, errors, suffix = [], [], []
    seen = False
    for line in actions:
        if line.startswith("  ") and ".vbrief.json:" in line:
            errors.append(line)
            seen = True
        elif seen:
            suffix.append(line)
        else:
            prefix.append(line)
    return prefix + sorted(errors) + suffix


def sort_failure_stderr(stderr):
    lines = stderr.split("\n")
    prefix, errors, suffix = [], [], []
    seen = False
    for line in lines:
        if line.startswith("  ") and ".vbrief.json:" in line:
            errors.append(line)
            seen = True
        elif seen:
            suffix.append(line)
        else:
            prefix.append(line)
    return "\n".join(prefix + sorted(errors) + suffix)


def normalize_fixture(obj, fixture_root):
    token = "<FIXTURE>"
    root = fixture_root.replace("\\", "/")
    if isinstance(obj, str):
        return obj.replace(root, token)
    if isinstance(obj, list):
        return [normalize_fixture(item, fixture_root) for item in obj]
    if isinstance(obj, dict):
        return {k: normalize_fixture(v, fixture_root) for k, v in obj.items()}
    return obj


def dump(obj, fixture_root=""):
    if fixture_root:
        obj = normalize_fixture(obj, fixture_root)
    payload = json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=False)
    if not payload.endswith("\n"):
        payload += "\n"
    sys.stdout.write(payload)


def write_valid_pd(vbrief_dir: Path):
    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": "PROJECT-DEFINITION",
            "status": "running",
            "narratives": {
                "Overview": "Test overview narrative.",
                "tech stack": "Python 3.12",
            },
            "items": [],
        },
    }
    (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(json.dumps(data), encoding="utf-8")


def run_scenario(name, fixture_root):
    fixture = Path(fixture_root)
    if name == "slugify-basic":
        return {"scenario": name, "ok": True, "payload": {
            "hello": slugify_id("Hello World"),
            "special": slugify_id("Add widget (v2)!"),
            "untitled": slugify_id(""),
            "constants": {"ID_MAX_LENGTH": ID_MAX_LENGTH, "HASH_SUFFIX_LENGTH": HASH_SUFFIX_LENGTH, "RECOVERY_HINT": RECOVERY_HINT},
        }}
    if name == "slugify-collision":
        existing = {"hello"}
        first = slugify_id("hello world", existing)
        second = slugify_id("hello world", existing)
        return {"scenario": name, "ok": True, "payload": {"first": first, "second": second, "size": len(existing)}}
    if name == "slug-fallback-id":
        return {"scenario": name, "ok": True, "payload": {
            "number": slug_fallback_id({"number": "42", "task_id": "1.1", "title": "foo"}),
            "taskId": slug_fallback_id({"number": "", "task_id": "1.1.2", "title": "foo"}),
            "synthetic": slug_fallback_id({"number": "", "task_id": "", "synthetic_id": "roadmap-3", "title": "foo"}),
            "title": slug_fallback_id({"title": "Fix login bug"}),
            "untitled": slug_fallback_id({}),
        }}
    if name == "validate-migration-missing-dir":
        missing = fixture / "nonexistent"
        errors, warnings = validate_migration_output(missing)
        return {"scenario": name, "ok": True, "payload": sorted_diag(errors, warnings)}
    if name == "validate-migration-empty-dir":
        vbrief = fixture / "vbrief"
        vbrief.mkdir(parents=True, exist_ok=True)
        errors, warnings = validate_migration_output(vbrief)
        return {"scenario": name, "ok": True, "payload": sorted_diag(errors, warnings)}
    if name == "validate-migration-valid-pd":
        vbrief = fixture / "vbrief-valid"
        vbrief.mkdir(parents=True, exist_ok=True)
        write_valid_pd(vbrief)
        errors, warnings = validate_migration_output(vbrief)
        return {"scenario": name, "ok": True, "payload": sorted_diag(errors, warnings)}
    if name == "validate-migration-invalid-status":
        vbrief = fixture / "vbrief-bad"
        vbrief.mkdir(parents=True, exist_ok=True)
        (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": {"title": "Bad", "status": "in_progress", "items": []}}),
            encoding="utf-8",
        )
        errors, warnings = validate_migration_output(vbrief)
        return {"scenario": name, "ok": True, "payload": sorted_diag(errors, warnings)}
    if name == "isolate-invalid-output":
        project_root = fixture / "isolate"
        project_root.mkdir(parents=True, exist_ok=True)
        vbrief = project_root / "vbrief"
        vbrief.mkdir(parents=True, exist_ok=True)
        (vbrief / "sentinel.txt").write_text("marker", encoding="utf-8")
        (project_root / "vbrief.invalid").mkdir(exist_ok=True)
        (project_root / "vbrief.invalid.2").mkdir(exist_ok=True)
        target = isolate_invalid_output(project_root, vbrief)
        return {"scenario": name, "ok": True, "payload": {
            "target": target.as_posix().replace(fixture.as_posix(), "<FIXTURE>") if target else None,
            "sentinel": (project_root / "vbrief.invalid.3" / "sentinel.txt").read_text(encoding="utf-8"),
        }}
    if name == "finalize-migration-success":
        project_root = fixture / "finalize-ok"
        vbrief = project_root / "vbrief"
        vbrief.mkdir(parents=True, exist_ok=True)
        write_valid_pd(vbrief)
        import io
        buf = io.StringIO()
        class _Writer:
            def write(self, s):
                buf.write(s)
        import _vbrief_validation as mod
        old = sys.stderr
        sys.stderr = _Writer()
        try:
            ok, actions = finalize_migration(project_root, vbrief, ["CREATE ok"])
        finally:
            sys.stderr = old
        return {"scenario": name, "ok": True, "payload": {"ok": ok, "actions": actions, "stderr": buf.getvalue()}}
    if name == "finalize-migration-failure":
        project_root = fixture / "finalize-fail"
        vbrief = project_root / "vbrief"
        vbrief.mkdir(parents=True, exist_ok=True)
        (vbrief / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps({"vBRIEFInfo": {"version": "0.6"}, "plan": {}}),
            encoding="utf-8",
        )
        import io
        buf = io.StringIO()
        class _Writer:
            def write(self, s):
                buf.write(s)
        old = sys.stderr
        sys.stderr = _Writer()
        try:
            ok, actions = finalize_migration(project_root, vbrief, ["CREATE bad"])
        finally:
            sys.stderr = old
        return {"scenario": name, "ok": True, "payload": {
            "ok": ok,
            "actions": sort_failure_actions(actions),
            "stderr": sort_failure_stderr(buf.getvalue()),
        }}
    if name == "legacy-normalize-title":
        return {"scenario": name, "ok": True, "payload": {
            "techStack": normalize_title("Tech Stack"),
            "camel": normalize_title("ProblemStatement"),
            "trailingNewline": normalize_title("Branching Strategy\n"),
            "empty": normalize_title(""),
        }}
    if name == "legacy-lookup-canonical":
        return {"scenario": name, "ok": True, "payload": {
            "overview": lookup_canonical("Summary", SPEC_KNOWN_MAPPINGS),
            "unknown": lookup_canonical("Mystery Section", SPEC_KNOWN_MAPPINGS),
        }}
    if name == "legacy-parse-sections":
        content = "## Overview\n\nAn overview.\n\n### Sub-section\n\ninside overview\n\n## Goals\n\nSome goals.\n"
        sections = parse_top_level_sections(content)
        return {"scenario": name, "ok": True, "payload": {
            "count": len(sections),
            "firstTitle": sections[0][0],
            "hasSubsection": "### Sub-section" in sections[0][1],
            "trailingEmpty": parse_top_level_sections("## Only\n\nBody\n"),
        }}
    if name == "legacy-partition-sections":
        sections = parse_top_level_sections("## Summary\n\nOverview body.\n\n## Mystery\n\nLegacy body.\n")
        canonical, legacy = partition_sections(sections, SPEC_KNOWN_MAPPINGS)
        return {"scenario": name, "ok": True, "payload": {"canonical": canonical, "legacyCount": len(legacy)}}
    if name == "fidelity-map-spec-status":
        return {"scenario": name, "ok": True, "payload": {
            "done": map_spec_status("done"),
            "unknown": map_spec_status("weird"),
            "empty": map_spec_status(""),
            "trailing": map_spec_status("completed\n"),
        }}
    if name == "fidelity-parse-spec-tasks":
        tasks = parse_spec_tasks(SAMPLE_SPEC_TASKS)
        return {"scenario": name, "ok": True, "payload": {
            "tasks": tasks,
            "empty": parse_spec_tasks(""),
            "trailingNewline": parse_spec_tasks(SAMPLE_SPEC_TASKS + "\n"),
        }}
    if name == "fidelity-requirements":
        reqs = parse_requirement_definitions(SAMPLE_SPEC_TASKS)
        return {"scenario": name, "ok": True, "payload": {
            "requirements": reqs,
            "narrative": build_requirements_narrative(reqs),
            "empty": build_requirements_narrative({}),
        }}
    if name == "fidelity-edges-and-narratives":
        tasks = parse_spec_tasks(SAMPLE_SPEC_TASKS)
        return {"scenario": name, "ok": True, "payload": {
            "edges": build_edges_from_tasks(tasks),
            "scope": task_scope_narratives(tasks[0] if tasks else {}),
            "aligned": align_spec_narratives({"tech stack": "Rust", "Overview": "Hi"}),
        }}
    if name == "fidelity-ingest-spec":
        canonical, log_entries, legacy = ingest_spec_narratives(SAMPLE_SPEC_TASKS)
        return {"scenario": name, "ok": True, "payload": {
            "canonicalKeys": list(canonical.keys()),
            "firstLog": format_migration_log_entry(log_entries[0]) if log_entries else None,
            "legacyCount": len(legacy),
        }}
    if name == "story-quality-happy":
        return {"scenario": name, "ok": True, "payload": {"issues": story_quality_issues(**STORY_QUALITY_BASE)}}
    if name == "story-quality-failures":
        return {"scenario": name, "ok": True, "payload": {
            "userStory": story_quality_issues(**{**STORY_QUALITY_BASE, "user_story": "Just build it."}),
            "broadScope": story_quality_issues(**{**STORY_QUALITY_BASE, "swarm": {**STORY_QUALITY_BASE["swarm"], "file_scope": ["backend"]}}),
            "genericVerify": story_quality_issues(**{**STORY_QUALITY_BASE, "swarm": {**STORY_QUALITY_BASE["swarm"], "verify_commands": ["task check"]}}),
            "endOfStringObservable": story_quality_issues(**{**STORY_QUALITY_BASE, "acceptance_texts": [
                "A user with valid credentials logs into the system successfully today.",
                "Given an existing user, when the auth model loads it, then the saved identity returns.",
            ]}),
        }}
    if name == "safety-premigrate-sibling":
        return {"scenario": name, "ok": True, "payload": {
            "md": premigrate_sibling(Path("/tmp/SPECIFICATION.md")).as_posix(),
            "json": premigrate_sibling(Path("/tmp/specification.vbrief.json")).as_posix(),
            "noExt": premigrate_sibling(Path("/tmp/README")).as_posix(),
        }}
    if name == "safety-plan-backups":
        project_root = fixture / "safety-backups"
        project_root.mkdir(parents=True, exist_ok=True)
        (project_root / "SPECIFICATION.md").write_text("spec", encoding="utf-8")
        (project_root / "PROJECT.md").write_text(DEPRECATION_SENTINEL, encoding="utf-8")
        pairs = plan_backups(project_root)
        return {"scenario": name, "ok": True, "payload": {
            "pairs": [[src.name, dst.name] for src, dst in pairs],
            "dirtyMessage": dirty_tree_refusal_message(),
            "isDirty": is_tree_dirty(project_root),
        }}
    if name == "safety-manifest-roundtrip":
        manifest = SafetyManifest(
            version="1",
            migration_timestamp="2026-04-22T00:00:00Z",
            created_files=["vbrief/migration/LEGACY-REPORT.md"],
            renames=[
                RenameRecord(
                    original="vbrief/migration/LEGACY-REPORT.md",
                    current="vbrief/migration/LEGACY-REPORT.reviewed.md",
                    renamed_by="deft-directive-sync Phase 6c",
                    renamed_at="2026-04-22T00:45:00Z",
                )
            ],
        )
        clone = SafetyManifest.from_json(manifest.to_json())
        return {"scenario": name, "ok": True, "payload": {
            "resolved": clone.current_path_for("vbrief/migration/LEGACY-REPORT.md"),
            "shaEmpty": sha256_of(fixture / "missing-file"),
        }}
    if name == "safety-write-backups-dryrun":
        project_root = fixture / "safety-write"
        project_root.mkdir(parents=True, exist_ok=True)
        src = project_root / "SPECIFICATION.md"
        src.write_text("hello", encoding="utf-8")
        dst = premigrate_sibling(src)
        records, actions = write_backups(project_root, [(src, dst)], dry_run=True)
        return {"scenario": name, "ok": True, "payload": {"records": [
            {"source": r.source, "backup": r.backup, "source_sha256": r.source_sha256, "size_bytes": r.size_bytes}
            for r in records
        ], "actions": actions}}
    if name == "regex-edge-cases":
        return {"scenario": name, "ok": True, "payload": {
            "tasks": parse_spec_tasks(EDGE_SPEC),
            "headings": parse_top_level_sections(EDGE_HEADINGS),
            "slugs": [slugify_id(s) for s in EDGE_SLUGS],
            "stories": [
                any("UserStory must match" in i for i in story_quality_issues(**{**STORY_QUALITY_BASE, "user_story": s}))
                for s in EDGE_STORIES
            ],
        }}
    return {"scenario": name, "ok": False, "payload": {"error": f"unknown scenario: {name}"}}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    fixture_root = os.environ.get("DEFT_VBRIEF_VALIDATION_FIXTURE", "")
    if mode == "--scenario":
        dump(run_scenario(sys.argv[2], fixture_root), fixture_root)
        return 0
    sys.stderr.write("usage: driver --scenario NAME\n")
    return 2

if __name__ == "__main__":
    raise SystemExit(main())
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

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Capture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function normaliseHarnessNoise(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Using CPython") &&
        !line.startsWith("Creating virtual environment") &&
        !line.startsWith("Installed "),
    )
    .join("\n");
}

export function diffParity(
  python: ScenarioResult,
  ts: ScenarioResult,
): {
  exitMismatch: boolean;
  outputMismatch: boolean;
  pythonOutput: string;
  tsOutput: string;
} {
  const pythonOutput = normaliseHarnessNoise(python.stdout);
  const tsOutput = normaliseHarnessNoise(ts.stdout);
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    outputMismatch: pythonOutput !== tsOutput,
    pythonOutput,
    tsOutput,
  };
}

function installPythonDriver(_deftRoot: string): { driverPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deft-vbrief-validation-py-driver-"));
  const driverPath = join(dir, "vbrief_validation_parity_driver.py");
  writeFileSync(driverPath, PYTHON_DRIVER, "utf8");
  chmodSync(driverPath, 0o755);
  return {
    driverPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runScenario(
  deftRoot: string,
  driverPath: string,
  name: string,
): { python: ScenarioResult; ts: ScenarioResult } {
  const pyFixture = mkdtempSync(join(tmpdir(), "deft-vbrief-validation-parity-py-"));
  const tsFixture = mkdtempSync(join(tmpdir(), "deft-vbrief-validation-parity-ts-"));
  const envBase = {
    DEFT_CACHE_DISABLE: "1",
    PYTHONUTF8: "1",
    DEFT_ROOT: deftRoot,
  };
  try {
    const py = runCapture("uv", ["run", "python", driverPath, "--scenario", name], deftRoot, {
      ...envBase,
      DEFT_VBRIEF_VALIDATION_FIXTURE: pyFixture,
    });
    const ts = runCapture(
      "node",
      [
        join(deftRoot, "packages", "cli", "dist", "vbrief-validation.js"),
        "--scenario",
        name,
        "--fixture-root",
        tsFixture,
      ],
      deftRoot,
      envBase,
    );
    return {
      python: { name, exitCode: py.status, stdout: py.stdout, stderr: py.stderr },
      ts: { name, exitCode: ts.status, stdout: ts.stdout, stderr: ts.stderr },
    };
  } finally {
    rmSync(pyFixture, { recursive: true, force: true });
    rmSync(tsFixture, { recursive: true, force: true });
  }
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const driver = installPythonDriver(deftRoot);
  const scenarios: ParityResult["scenarios"] = [];
  try {
    for (const name of PARITY_SCENARIO_NAMES) {
      const ran = runScenario(deftRoot, driver.driverPath, name);
      scenarios.push({
        name,
        pythonExit: ran.python.exitCode,
        tsExit: ran.ts.exitCode,
        ...diffParity(ran.python, ran.ts),
      });
    }
  } finally {
    driver.cleanup();
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.outputMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `vbrief_validation parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["vbrief_validation parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.outputMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
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
    process.stderr.write(`vbrief_validation parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
