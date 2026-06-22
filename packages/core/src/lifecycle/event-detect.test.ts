import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { contentRoot } from "../content-root.js";
import {
  clearRegistryCache,
  DEPRECATED_SKILL_REDIRECT_SENTINEL,
  detectAgentsMdStale,
  detectRemoteDrift,
  EventEmissionError,
  emit,
  loadRegistry,
  nowUtcIso,
  registeredEventNames,
} from "./event-detect.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
// #1875: the event registry is shippable content (content/events/ in source).
const REGISTRY_PATH = join(contentRoot(REPO_ROOT), "events", "registry.json");

const EXPECTED_DETECTION_BOUND_NAMES = new Set([
  "pre-cutover:detected",
  "vbrief:invalid",
  "agents-md:stale",
  "version:drift",
  "dirty-tree:detected",
  "framework:remote-drift",
]);

const EXPECTED_EVENT_NAMES = new Set([
  ...EXPECTED_DETECTION_BOUND_NAMES,
  "session:interrupted",
  "session:resumed",
  "plan:approved",
  "legacy:detected",
]);

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

afterEach(() => {
  clearRegistryCache();
  delete process.env.DEFT_EVENT_LOG;
});

describe("event detect registry", () => {
  it("loads registry", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    expect(registry.version).toBe("1");
    expect(Array.isArray(registry.events)).toBe(true);
  });

  it("lists six detection-bound events", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const detectionBound = (registry.events as Record<string, unknown>[]).filter(
      (e) => e.category === "detection-bound",
    );
    expect(detectionBound).toHaveLength(6);
    const names = new Set(detectionBound.map((e) => e.name));
    expect(names).toEqual(EXPECTED_DETECTION_BOUND_NAMES);
  });

  it("registered names match expected union", () => {
    expect(registeredEventNames(REGISTRY_PATH)).toEqual(EXPECTED_EVENT_NAMES);
  });
});

describe("event detect emit", () => {
  it("returns record matching schema", () => {
    const record = emit(
      "dirty-tree:detected",
      { project_root: "/tmp/example" },
      {
        registryPath: REGISTRY_PATH,
      },
    );
    expect(Object.keys(record).sort()).toEqual(["detected_at", "event", "payload"]);
    expect(record.event).toBe("dirty-tree:detected");
    expect(ISO_TIMESTAMP_RE.test(record.detected_at)).toBe(true);
    expect(record.payload).toEqual({ project_root: "/tmp/example" });
  });

  it("rejects unregistered event", () => {
    expect(() => emit("not-a-real:event", {}, { registryPath: REGISTRY_PATH })).toThrow(
      EventEmissionError,
    );
  });

  it("writes to log file when env set", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-log-"));
    const logPath = join(root, "events.log");
    process.env.DEFT_EVENT_LOG = logPath;
    const record = emit(
      "version:drift",
      {
        current_version: "0.20.0",
        marker_path: "/tmp/example/vbrief/.deft-version",
        project_root: "/tmp/example",
        recorded_version: "0.19.0",
      },
      { registryPath: REGISTRY_PATH },
    );
    expect(readFileSync(logPath, "utf8").trim()).toBe(JSON.stringify(record));
    rmSync(root, { recursive: true, force: true });
  });

  it("caps payload lists at 50", () => {
    const bigErrors = Array.from({ length: 120 }, (_, i) => `err-${i}`);
    const record = emit(
      "vbrief:invalid",
      {
        error_count: bigErrors.length,
        errors: bigErrors,
        vbrief_dir: "/tmp",
        warning_count: 0,
        warnings: [],
      },
      { registryPath: REGISTRY_PATH },
    );
    expect(record.payload.errors).toHaveLength(50);
    expect(record.payload.error_count).toBe(120);
  });

  it("nowUtcIso matches seconds precision", () => {
    expect(ISO_TIMESTAMP_RE.test(nowUtcIso())).toBe(true);
  });
});

describe("detectAgentsMdStale", () => {
  it("returns null when AGENTS.md absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-no-agents-"));
    expect(detectAgentsMdStale(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when all skills present", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-ok-"));
    const skillDir = join(root, "deft", "skills", "deft-directive-setup");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# setup\nFresh skill content.\n", "utf8");
    writeFileSync(
      join(root, "AGENTS.md"),
      "Read deft/skills/deft-directive-setup/SKILL.md for setup.\n",
      "utf8",
    );
    expect(detectAgentsMdStale(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("detects missing skill path", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-missing-"));
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "Read deft/skills/deft-not-real/SKILL.md.\n", "utf8");
    const payload = detectAgentsMdStale(root);
    expect(payload).not.toBeNull();
    expect(payload?.missing_paths).toEqual(["deft/skills/deft-not-real/SKILL.md"]);
    expect(payload?.redirect_paths).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("detects redirect stub skill path", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-redirect-"));
    const skillDir = join(root, "deft", "skills", "deft-old-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `${DEPRECATED_SKILL_REDIRECT_SENTINEL}\n# deft-old-skill (Deprecated)\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      "Read deft/skills/deft-old-skill/SKILL.md for guidance.\n",
      "utf8",
    );
    const payload = detectAgentsMdStale(root);
    expect(payload?.redirect_paths).toEqual(["deft/skills/deft-old-skill/SKILL.md"]);
    expect(payload?.missing_paths).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("dedupes repeated tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-dedupe-"));
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(
      join(root, "AGENTS.md"),
      "deft/skills/deft-x/SKILL.md\nAlso see deft/skills/deft-x/SKILL.md again.\n",
      "utf8",
    );
    const payload = detectAgentsMdStale(root);
    expect(payload?.missing_paths).toEqual(["deft/skills/deft-x/SKILL.md"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("supports explicit framework root", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-fw-"));
    const framework = join(root, "skills-root");
    const skillDir = join(framework, "skills", "deft-directive-sync");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# sync\n", "utf8");
    writeFileSync(
      join(root, "AGENTS.md"),
      "Read deft/skills/deft-directive-sync/SKILL.md\n",
      "utf8",
    );
    expect(detectAgentsMdStale(root, { frameworkRoot: framework })).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("detectRemoteDrift", () => {
  it("returns null when probe absent or not behind", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-drift-"));
    expect(detectRemoteDrift(root)).toBeNull();
    expect(detectRemoteDrift(root, { probeResult: { status: "current" } })).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("builds payload when behind", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-behind-"));
    const payload = detectRemoteDrift(root, {
      probeResult: {
        commits_behind: 3,
        current: "0.32.0",
        remote: "0.33.0",
        status: "behind",
        upstream_url: "https://github.com/deftai/directive.git",
      },
    });
    expect(payload).toEqual({
      commits_behind: 3,
      current_version: "0.32.0",
      project_root: resolve(root),
      remote_version: "0.33.0",
      upstream_url: "https://github.com/deftai/directive.git",
    });
    rmSync(root, { recursive: true, force: true });
  });
});

describe("event detect misc", () => {
  it("treats unreadable skill file as missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-unreadable-"));
    const skillDir = join(root, "deft", "skills", "deft-broken-skill");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(skillDir, "SKILL.md"), { recursive: true });
    writeFileSync(
      join(root, "AGENTS.md"),
      "Read deft/skills/deft-broken-skill/SKILL.md.\n",
      "utf8",
    );
    const payload = detectAgentsMdStale(root);
    expect(payload?.missing_paths).toEqual(["deft/skills/deft-broken-skill/SKILL.md"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("uses cached registry on second load", () => {
    clearRegistryCache();
    const first = loadRegistry();
    const second = loadRegistry();
    expect(first).toBe(second);
  });

  it("swallows log write failures", () => {
    const root = mkdtempSync(join(tmpdir(), "ed-logfail-"));
    const logDir = join(root, "events.log");
    mkdirSync(logDir, { recursive: true });
    process.env.DEFT_EVENT_LOG = logDir;
    expect(() =>
      emit("dirty-tree:detected", { project_root: "/tmp" }, { registryPath: REGISTRY_PATH }),
    ).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
