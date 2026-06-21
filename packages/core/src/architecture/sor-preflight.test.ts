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
});
