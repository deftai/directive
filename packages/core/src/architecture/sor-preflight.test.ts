/**
 * Vitest tests for sor-preflight.ts -- mirror key Python test cases from
 * tests/cli/test_preflight_architecture_sor.py including non-happy-path fixtures.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  architecturePreflightSorMain,
  type DetectedSignal,
  evaluateDiff,
  evaluateDiffText,
  evaluateStory,
  scanDiff,
  storageMatches,
  systemOfRecord,
  validateRecord,
} from "./sor-preflight.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "sor_gate");

function fixture(name: string): string {
  return join(FIXTURE_DIR, name);
}

function _writeStory(dir: string, payload: unknown): string {
  const path = join(dir, "vbrief", "active", "story.vbrief.json");
  mkdirSync(join(dir, "vbrief", "active"), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

describe("evaluateStory", () => {
  it("durable_product_state on json_file fails", () => {
    const result = evaluateStory(fixture("durable_json_fails.vbrief.json"));
    expect(result.code).toBe(1);
    expect(result.message).toContain("Durable");
    expect(result.message).toContain("json_file");
  });

  it("durable_product_state on approved DB passes", () => {
    const result = evaluateStory(fixture("durable_db_passes.vbrief.json"));
    expect(result.code).toBe(0);
  });

  it("canonical_artifact file reads pass", () => {
    const result = evaluateStory(fixture("canonical_artifact_passes.vbrief.json"));
    expect(result.code).toBe(0);
  });

  it("cache file passes with invalidation metadata", () => {
    const good = evaluateStory(fixture("cache_file_passes.vbrief.json"));
    expect(good.code).toBe(0);
  });

  it("cache file fails without invalidation metadata", () => {
    const raw = JSON.parse(
      readFileSync(fixture("cache_file_passes.vbrief.json"), "utf8"),
    ) as Record<string, unknown>;
    const arch = raw.architecture as Record<string, unknown>;
    const sor = arch.systemOfRecord as Record<string, unknown>;
    const surfaces = sor.stateSurfaces as Record<string, unknown>[];
    const surface = { ...surfaces[0]! };
    delete surface.invalidationRules;
    sor.stateSurfaces = [surface];
    const tmpDir = join(tmpdir(), `sor-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const badPath = join(tmpDir, "story.vbrief.json");
    writeFileSync(badPath, JSON.stringify(raw, null, 2), "utf8");
    const bad = evaluateStory(badPath);
    expect(bad.code).toBe(1);
    expect(bad.message).toContain("invalidation");
  });

  it("reference-app parity fails without persistence/auth comparison", () => {
    const result = evaluateStory(fixture("reference_app_missing_comparison_fails.vbrief.json"));
    expect(result.code).toBe(1);
    expect(result.message).toContain("Reference-application parity");
  });

  it("missing story path returns code 2", () => {
    const result = evaluateStory("/nonexistent/path/story.vbrief.json");
    expect(result.code).toBe(2);
  });

  it("non-JSON file returns code 2", () => {
    const tmpPath = join(tmpdir(), `bad-json-${Date.now()}.json`);
    writeFileSync(tmpPath, "not json", "utf8");
    const result = evaluateStory(tmpPath);
    expect(result.code).toBe(2);
  });
});

describe("evaluateDiffText", () => {
  it("canonical artifact file reads pass", () => {
    const diff = `\
diff --git a/app/catalog.py b/app/catalog.py
--- a/app/catalog.py
+++ b/app/catalog.py
@@ -0,0 +1 @@
+CATALOG = json.loads(Path("seed-catalog.json").read_text(encoding="utf-8"))
`;
    const result = evaluateDiffText(diff, {
      projectRoot: REPO_ROOT,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("no stateful diff signals");
  });

  it("durable db diff passes with mutation and model signals", () => {
    const diff = `\
diff --git a/app/models.py b/app/models.py
--- a/app/models.py
+++ b/app/models.py
@@ -0,0 +1,3 @@
+class Workspace(Base):
+    __tablename__ = "workspaces"
+    id = db.Column(db.String, primary_key=True)
diff --git a/app/routes.py b/app/routes.py
--- a/app/routes.py
+++ b/app/routes.py
@@ -0,0 +1,2 @@
+@app.post("/workspaces")
+def create_workspace():
`;
    const result = evaluateDiffText(diff, {
      projectRoot: REPO_ROOT,
      storyPath: fixture("durable_db_passes.vbrief.json"),
    });
    expect(result.code).toBe(0);
  });

  it("declared db but diff implements json_file fails", () => {
    const diff = `\
diff --git a/app/workspace_repository.py b/app/workspace_repository.py
--- a/app/workspace_repository.py
+++ b/app/workspace_repository.py
@@ -0,0 +1 @@
+Path("workspaces.json").write_text(json.dumps(workspaces), encoding="utf-8")
`;
    const result = evaluateDiffText(diff, {
      projectRoot: REPO_ROOT,
      storyPath: fixture("durable_db_passes.vbrief.json"),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("json_file");
    const msg = result.message;
    expect(msg.includes("forbids") || msg.includes("without a state surface")).toBe(true);
  });

  it("browser storage passes for ephemeral_ui_state", () => {
    const diff = `\
diff --git a/web/sidebar.ts b/web/sidebar.ts
--- a/web/sidebar.ts
+++ b/web/sidebar.ts
@@ -0,0 +1 @@
+localStorage.setItem("selectedSidebarTab", tabId)
`;
    const ok = evaluateDiffText(diff, {
      projectRoot: REPO_ROOT,
      storyPath: fixture("browser_ephemeral_passes.vbrief.json"),
    });
    expect(ok.code).toBe(0);
  });

  it("browser storage fails for durable state story", () => {
    const diff = `\
diff --git a/web/sidebar.ts b/web/sidebar.ts
--- a/web/sidebar.ts
+++ b/web/sidebar.ts
@@ -0,0 +1 @@
+localStorage.setItem("selectedSidebarTab", tabId)
`;
    const blocked = evaluateDiffText(diff, {
      projectRoot: REPO_ROOT,
      storyPath: fixture("durable_db_passes.vbrief.json"),
    });
    expect(blocked.code).toBe(1);
    expect(blocked.message).toContain("browser_storage");
  });
});

describe("scanDiff", () => {
  it("exempts its own helper files", () => {
    const diff = `\
diff --git a/scripts/_sor_gate_diff.py b/scripts/_sor_gate_diff.py
--- a/scripts/_sor_gate_diff.py
+++ b/scripts/_sor_gate_diff.py
@@ -0,0 +1,3 @@
+r"(write_text|write_bytes)"
+r"\\b(auth|session|permission)\\b"
+Path("workspaces.json").write_text("{}")
`;
    const [signals] = scanDiff(diff);
    expect(signals).toHaveLength(0);
  });

  it("detects filesystem writes in non-exempt paths", () => {
    const diff = `\
diff --git a/app/store.py b/app/store.py
--- a/app/store.py
+++ b/app/store.py
@@ -0,0 +1 @@
+Path("data.json").write_text(json.dumps(data))
`;
    const [signals] = scanDiff(diff);
    expect(signals.some((s) => s.kind === "filesystem_write")).toBe(true);
  });
});

describe("storageMatches", () => {
  it("matches exact json_file", () => {
    expect(storageMatches("json_file", "json_file")).toBe(true);
  });

  it("matches database aliases", () => {
    expect(storageMatches("database", "application database")).toBe(true);
  });

  it("filesystem does not match json_file", () => {
    expect(storageMatches("filesystem", "json_file")).toBe(false);
  });

  it("database does not match indexeddb (browser)", () => {
    expect(storageMatches("database", "indexeddb")).toBe(false);
  });
});

describe("validateRecord", () => {
  it("null record returns code 1", () => {
    const result = validateRecord(null);
    expect(result.code).toBe(1);
    expect(result.message).toContain("no architecture.systemOfRecord");
  });

  it("empty stateSurfaces returns code 1", () => {
    const result = validateRecord({ stateSurfaces: [] });
    expect(result.code).toBe(1);
  });

  it("valid cache surface passes", () => {
    const record = {
      stateSurfaces: [
        {
          name: "MyCache",
          classification: "cache",
          approvedStorage: "json_file",
          invalidationRules: "expires after 5 minutes",
        },
      ],
    };
    const result = validateRecord(record);
    expect(result.code).toBe(0);
  });
});

describe("systemOfRecord", () => {
  it("extracts from top-level architecture", () => {
    const payload = {
      architecture: { systemOfRecord: { stateSurfaces: [] } },
    };
    expect(systemOfRecord(payload)).not.toBeNull();
  });

  it("extracts from plan.architecture", () => {
    const payload = {
      plan: { architecture: { systemOfRecord: { stateSurfaces: [] } } },
    };
    expect(systemOfRecord(payload)).not.toBeNull();
  });

  it("returns null when absent", () => {
    expect(systemOfRecord({ plan: {} })).toBeNull();
  });
});

describe("architecturePreflightSorMain", () => {
  it("--story-path passing fixture exits 0", () => {
    const code = architecturePreflightSorMain([
      "--story-path",
      fixture("durable_db_passes.vbrief.json"),
    ]);
    expect(code).toBe(0);
  });

  it("--story-path failing fixture exits 1", () => {
    const code = architecturePreflightSorMain([
      "--story-path",
      fixture("durable_json_fails.vbrief.json"),
    ]);
    expect(code).toBe(1);
  });

  it("no args exits 2", () => {
    const code = architecturePreflightSorMain([]);
    expect(code).toBe(2);
  });

  it("unrecognized arg exits 2", () => {
    const code = architecturePreflightSorMain(["--unknown-flag"]);
    expect(code).toBe(2);
  });

  it("--story-path= equals form exits 0 for passing fixture", () => {
    const code = architecturePreflightSorMain([
      `--story-path=${fixture("durable_db_passes.vbrief.json")}`,
      "--project-root=/tmp",
    ]);
    expect(code).toBe(0);
  });

  it("--json flag emits JSON and exits 1 for failing fixture", () => {
    const code = architecturePreflightSorMain([
      "--json",
      "--story-path",
      fixture("durable_json_fails.vbrief.json"),
    ]);
    expect(code).toBe(1);
  });

  it("--base-ref against a non-git dir exits 2 (gate misconfigured)", () => {
    const dir = mkTmp();
    expect(architecturePreflightSorMain(["--base-ref", "HEAD", "--project-root", dir])).toBe(2);
  });

  it("--base-ref= equals form against a non-git dir exits 2", () => {
    const dir = mkTmp();
    expect(architecturePreflightSorMain([`--base-ref=HEAD`, `--project-root=${dir}`])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Helpers for the additional coverage suites
// ---------------------------------------------------------------------------

function mkTmp(): string {
  const dir = join(tmpdir(), `sor-cov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function durableSurface(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Workspaces",
    classification: "durable_product_state",
    approvedStorage: ["database"],
    owner: "platform-team",
    permissionBoundary: "tenant",
    migrationRequired: true,
    auditRequired: true,
    concurrencyRequired: true,
    concurrencySemantics: "optimistic",
    transactionBoundary: "request",
    recoverySemantics: "rollback",
    conflictDetection: "version",
    deleteSemantics: "soft",
    migrationPath: "alembic",
    ...over,
  };
}

function cacheSurface(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Cache",
    classification: "cache",
    approvedStorage: ["database"],
    invalidationRules: "ttl 5m",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// validateRecord -- surface classification branches
// ---------------------------------------------------------------------------

describe("validateRecord surface branches", () => {
  it("flags unknown classification", () => {
    const result = validateRecord({ stateSurfaces: [{ name: "X", classification: "bogus" }] });
    expect(result.code).toBe(1);
    expect(result.message).toContain("Unknown or missing classification");
  });

  it("flags durable surface with no approvedStorage and missing required fields", () => {
    const result = validateRecord({
      stateSurfaces: [{ name: "U", classification: "durable_product_state" }],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("no approvedStorage");
    expect(result.message).toContain("missing required field");
  });

  it("flags durable surface that approves unsafe local storage", () => {
    const result = validateRecord({
      stateSurfaces: [durableSurface({ approvedStorage: ["json_file"] })],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("unsafe local storage");
  });

  it("passes a fully-specified durable database surface", () => {
    const result = validateRecord({ stateSurfaces: [durableSurface()] });
    expect(result.code).toBe(0);
  });

  it("flags a file-backed cache without invalidation rules", () => {
    const result = validateRecord({
      stateSurfaces: [{ name: "C", classification: "cache", approvedStorage: ["json_file"] }],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("invalidation");
  });

  it("flags an import/export artifact marked live", () => {
    const result = validateRecord({
      stateSurfaces: [{ name: "Exp", classification: "import_export_artifact", liveState: true }],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("live or authoritative");
  });

  it("flags a canonical artifact marked mutable", () => {
    const result = validateRecord({
      stateSurfaces: [{ name: "Can", classification: "canonical_artifact", mutable: true }],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("mutable or authoritative");
  });
});

// ---------------------------------------------------------------------------
// validateReferenceApps
// ---------------------------------------------------------------------------

describe("validateReferenceApps", () => {
  const parityStory = {
    plan: {
      narratives: { Description: "Implementation modeled after the reference app for parity." },
    },
  };

  it("flags missing auth and permission comparison groups", () => {
    const record = {
      stateSurfaces: [durableSurface()],
      referenceApplicationComparisons: [
        { note: "We compare database persistence schema with the reference app." },
      ],
    };
    const result = validateRecord(record, { storyPayload: parityStory });
    expect(result.code).toBe(1);
    expect(result.message).toContain("comparison");
  });

  it("passes when all comparison groups are covered", () => {
    const record = {
      stateSurfaces: [durableSurface()],
      referenceApplicationComparisons: [
        {
          note:
            "database persistence schema parity; auth session identity parity; " +
            "permission authorization ownership role membership parity.",
        },
      ],
    };
    const result = validateRecord(record, { storyPayload: parityStory });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateRecord -- diff signal validation
// ---------------------------------------------------------------------------

describe("validateRecord signal validation", () => {
  function sig(over: Partial<DetectedSignal> & { kind: string }): DetectedSignal {
    return { path: "app/x.py", line: 3, detail: "x", ...over };
  }

  it("flags storage forbidden by a surface", () => {
    const record = { stateSurfaces: [durableSurface({ forbiddenStorage: ["json_file"] })] };
    const result = validateRecord(record, {
      signals: [sig({ kind: "filesystem_write", storage: "json_file" })],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("forbids");
  });

  it("flags storage with no approving surface", () => {
    const result = validateRecord(
      { stateSurfaces: [cacheSurface()] },
      { signals: [sig({ kind: "filesystem_write", storage: "json_file" })] },
    );
    expect(result.code).toBe(1);
    expect(result.message).toContain("without a state surface");
  });

  it("flags a mutation endpoint with no durable owner", () => {
    const result = validateRecord(
      { stateSurfaces: [cacheSurface()] },
      { signals: [sig({ kind: "mutation_endpoint", line: null })] },
    );
    expect(result.code).toBe(1);
    expect(result.message).toContain("no durable owner");
  });

  it("flags an auth signal with no auth surface", () => {
    const result = validateRecord(
      { stateSurfaces: [cacheSurface()] },
      { signals: [sig({ kind: "auth_state" })] },
    );
    expect(result.code).toBe(1);
    expect(result.message).toContain("no auth_session_state");
  });

  it("flags a workflow signal with no durable owner", () => {
    const result = validateRecord(
      { stateSurfaces: [cacheSurface()] },
      { signals: [sig({ kind: "workflow_state" })] },
    );
    expect(result.code).toBe(1);
    expect(result.message).toContain("no durable or service-backed owner");
  });
});

// ---------------------------------------------------------------------------
// scanDiff -- signal kind coverage
// ---------------------------------------------------------------------------

describe("scanDiff signal kinds", () => {
  function diffFor(path: string, line: string): string {
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -0,0 +1 @@",
      `+${line}`,
      "",
    ].join("\n");
  }

  it("detects a stateful module name via path", () => {
    const [signals] = scanDiff(diffFor("app/user_repository.py", "x = 1"));
    expect(signals.some((s) => s.kind === "state_module")).toBe(true);
  });

  it("detects a database migration path", () => {
    const [signals] = scanDiff(diffFor("app/migrations/001_init.py", "x = 1"));
    expect(signals.some((s) => s.kind === "database_model" && s.storage === "database")).toBe(true);
  });

  it("detects in-memory state in a store module", () => {
    const [signals] = scanDiff(diffFor("app/session_store.py", "_data = {}"));
    expect(signals.some((s) => s.kind === "in_memory_state")).toBe(true);
  });

  it("detects a mutation endpoint", () => {
    const [signals] = scanDiff(diffFor("app/routes.py", '@app.post("/items")'));
    expect(signals.some((s) => s.kind === "mutation_endpoint")).toBe(true);
  });

  it("detects a database model declaration", () => {
    const [signals] = scanDiff(diffFor("app/models.py", "class Item(models.Model):"));
    expect(signals.some((s) => s.kind === "database_model")).toBe(true);
  });

  it("detects an auth/session signal", () => {
    const [signals] = scanDiff(diffFor("app/svc.py", "session = get_session(user)"));
    expect(signals.some((s) => s.kind === "auth_state")).toBe(true);
  });

  it("detects a workflow state change", () => {
    const [signals] = scanDiff(diffFor("app/worker.py", "class JobQueue:"));
    expect(signals.some((s) => s.kind === "workflow_state")).toBe(true);
  });

  it("infers yaml/toml/sqlite storage from filesystem writes", () => {
    const [yaml] = scanDiff(diffFor("app/a.py", 'Path("config.yaml").write_text(data)'));
    expect(yaml.some((s) => s.storage === "yaml_file")).toBe(true);
    const [toml] = scanDiff(diffFor("app/b.py", 'Path("c.toml").write_text(data)'));
    expect(toml.some((s) => s.storage === "toml_file")).toBe(true);
    const [sqlite] = scanDiff(diffFor("app/c.py", 'Path("d.db").write_text(data)'));
    expect(sqlite.some((s) => s.storage === "sqlite_file")).toBe(true);
    const [fs] = scanDiff(diffFor("app/d.py", 'Path("plain").write_text(data)'));
    expect(fs.some((s) => s.storage === "filesystem")).toBe(true);
  });

  it("handles deletions (+++ /dev/null), context and removed lines", () => {
    const diff = [
      "diff --git a/app/old.py b/app/old.py",
      "--- a/app/old.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x = 1",
      "diff --git a/app/keep.py b/app/keep.py",
      "--- a/app/keep.py",
      "+++ b/app/keep.py",
      "@@ -1,3 +1,3 @@",
      " context line",
      "-removed = 1",
      "+added = 2",
      "",
    ].join("\n");
    const [, changedPaths] = scanDiff(diff);
    expect(changedPaths).toContain("app/keep.py");
  });
});

// ---------------------------------------------------------------------------
// evaluateDiffText -- multi-record and no-record branches
// ---------------------------------------------------------------------------

describe("evaluateDiffText record resolution", () => {
  function sorVbrief(): unknown {
    return { architecture: { systemOfRecord: { stateSurfaces: [durableSurface()] } } };
  }

  it("returns code 2 when multiple changed vBRIEFs carry SoR records", () => {
    const proj = mkTmp();
    mkdirSync(join(proj, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(proj, "vbrief", "active", "a.vbrief.json"),
      JSON.stringify(sorVbrief()),
      "utf8",
    );
    writeFileSync(
      join(proj, "vbrief", "active", "b.vbrief.json"),
      JSON.stringify(sorVbrief()),
      "utf8",
    );
    const diff = [
      "diff --git a/vbrief/active/a.vbrief.json b/vbrief/active/a.vbrief.json",
      "+++ b/vbrief/active/a.vbrief.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "diff --git a/vbrief/active/b.vbrief.json b/vbrief/active/b.vbrief.json",
      "+++ b/vbrief/active/b.vbrief.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "diff --git a/app/repo.py b/app/repo.py",
      "+++ b/app/repo.py",
      "@@ -0,0 +1 @@",
      '+Path("x.json").write_text(json.dumps(d))',
      "",
    ].join("\n");
    const result = evaluateDiffText(diff, { projectRoot: proj });
    expect(result.code).toBe(2);
    expect(result.message).toContain("multiple changed vBRIEFs");
  });

  it("returns code 1 when a stateful signal has no design record at all", () => {
    const proj = mkTmp();
    const diff = [
      "diff --git a/app/repo.py b/app/repo.py",
      "+++ b/app/repo.py",
      "@@ -0,0 +1 @@",
      '+Path("x.json").write_text(json.dumps(d))',
      "",
    ].join("\n");
    const result = evaluateDiffText(diff, { projectRoot: proj });
    expect(result.code).toBe(1);
    expect(result.message).toContain("no matching architecture.systemOfRecord");
  });

  it("resolves a single changed vBRIEF record automatically", () => {
    const proj = mkTmp();
    mkdirSync(join(proj, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(proj, "vbrief", "active", "only.vbrief.json"),
      JSON.stringify(sorVbrief()),
      "utf8",
    );
    const diff = [
      "diff --git a/vbrief/active/only.vbrief.json b/vbrief/active/only.vbrief.json",
      "+++ b/vbrief/active/only.vbrief.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "diff --git a/app/models.py b/app/models.py",
      "+++ b/app/models.py",
      "@@ -0,0 +1 @@",
      "+class Item(models.Model):",
      "",
    ].join("\n");
    const result = evaluateDiffText(diff, { projectRoot: proj });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateDiff -- git invocation error path
// ---------------------------------------------------------------------------

describe("evaluateDiff", () => {
  it("returns code 2 when git diff cannot run (non-git dir)", () => {
    const dir = mkTmp();
    const result = evaluateDiff(dir, "HEAD");
    expect(result.code).toBe(2);
    expect(result.message).toContain("gate misconfigured");
  });
});

// ---------------------------------------------------------------------------
// Additional normalization / edge branches
// ---------------------------------------------------------------------------

describe("storageMatches alias coverage", () => {
  it("matches external_service aliases", () => {
    expect(storageMatches("external_service", "api provider")).toBe(true);
  });

  it("matches via long-alias substring inclusion", () => {
    expect(storageMatches("database", "myapplication_database_backend")).toBe(true);
  });

  it("does not match an unrelated short token", () => {
    expect(storageMatches("database", "cache")).toBe(false);
  });
});

describe("validateRecord additional surface edge cases", () => {
  it("treats stateSurfaces that is not an array as missing", () => {
    const result = validateRecord({ stateSurfaces: "nope" });
    expect(result.code).toBe(1);
    expect(result.message).toContain("missing or empty");
  });

  it("reports unnamed surface and non-string classification", () => {
    const result = validateRecord({ stateSurfaces: [{ classification: 123 }] });
    expect(result.code).toBe(1);
    expect(result.message).toContain("<unnamed>");
  });

  it("accepts durable required fields supplied as arrays/objects", () => {
    const surface = durableSurface({
      owner: ["platform"],
      recoverySemantics: { mode: "rollback" },
    });
    const result = validateRecord({ stateSurfaces: [surface] });
    expect(result.code).toBe(0);
  });

  it("flags a durable required field supplied as an empty array", () => {
    const surface = durableSurface({ owner: [] });
    const result = validateRecord({ stateSurfaces: [surface] });
    expect(result.code).toBe(1);
    expect(result.message).toContain("missing required field 'owner'");
  });

  it("flags an import/export artifact whose live flag is the string 'true'", () => {
    const result = validateRecord({
      stateSurfaces: [
        { name: "E", classification: "import_export_artifact", authoritative: "true" },
      ],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("live or authoritative");
  });
});

describe("evaluateDiffText changed-folder filters", () => {
  function sorVbrief(): unknown {
    return { architecture: { systemOfRecord: { stateSurfaces: [durableSurface()] } } };
  }

  it("reads SoR records from a changed vbrief/pending path and skips other folders", () => {
    const proj = mkTmp();
    mkdirSync(join(proj, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      join(proj, "vbrief", "pending", "only.vbrief.json"),
      JSON.stringify(sorVbrief()),
      "utf8",
    );
    const diff = [
      "diff --git a/vbrief/completed/old.vbrief.json b/vbrief/completed/old.vbrief.json",
      "+++ b/vbrief/completed/old.vbrief.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "diff --git a/vbrief/pending/only.vbrief.json b/vbrief/pending/only.vbrief.json",
      "+++ b/vbrief/pending/only.vbrief.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "diff --git a/app/models.py b/app/models.py",
      "+++ b/app/models.py",
      "@@ -0,0 +1 @@",
      "+class Item(models.Model):",
      "",
    ].join("\n");
    const result = evaluateDiffText(diff, { projectRoot: proj });
    expect(result.code).toBe(0);
  });
});
