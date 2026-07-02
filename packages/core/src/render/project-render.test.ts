import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateProjectDefinition } from "../vbrief-validate/project-definition.js";
import {
  acknowledgeProjectDefinitionStaleness,
  main as projectRenderMain,
  renderProjectDefinition,
} from "./project-render.js";

const ISSUE_REF = {
  type: "x-vbrief/github-issue",
  uri: "https://github.com/deftai/directive/issues/1696",
  title: "Issue #1696",
};

/**
 * Read + parse a JSON file, asserting the top-level payload is an object.
 * `JSON.parse` can return top-level `null` (and non-objects) without throwing,
 * so guard before property access rather than blindly casting.
 */
function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`expected top-level JSON object at ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function writeScope(
  vbriefDir: string,
  folder: string,
  filename: string,
  plan: Record<string, unknown>,
): void {
  const dir = join(vbriefDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }, null, 2)}\n`,
    "utf8",
  );
}

function writeProjectDefinition(vbriefDir: string, narratives?: Record<string, string>): void {
  writeFileSync(
    join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6", created: "2026-06-01T00:00:00Z" },
        plan: {
          title: "PROJECT-DEFINITION",
          status: "running",
          narratives: narratives ?? {
            Overview: "Test",
            "tech stack": "TS",
            Architecture: "Monolith",
            Configuration: "Defaults",
          },
          items: [],
          metadata: { staleness_flags: [] },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("project-render decompose round-trip", () => {
  it("render then validate passes for cancelled umbrella + completed stories (#1696)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-1696-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });

    writeScope(vbrief, "cancelled", "2026-06-16-umbrella.vbrief.json", {
      title: "Umbrella epic",
      status: "cancelled",
      items: [],
      metadata: { kind: "epic" },
      references: [
        ISSUE_REF,
        {
          type: "x-vbrief/plan",
          uri: "completed/2026-06-16-story-a.vbrief.json",
          title: "Story A",
        },
        {
          type: "x-vbrief/plan",
          uri: "completed/2026-06-16-story-b.vbrief.json",
          title: "Story B",
        },
      ],
    });
    writeScope(vbrief, "completed", "2026-06-16-story-a.vbrief.json", {
      title: "Story A",
      status: "completed",
      items: [],
      metadata: { kind: "story" },
      references: [ISSUE_REF],
      planRef: "cancelled/2026-06-16-umbrella.vbrief.json",
    });
    writeScope(vbrief, "completed", "2026-06-16-story-b.vbrief.json", {
      title: "Story B",
      status: "completed",
      items: [],
      metadata: { kind: "story" },
      references: [ISSUE_REF],
      planRef: "cancelled/2026-06-16-umbrella.vbrief.json",
    });

    writeProjectDefinition(vbrief);

    const [ok, message] = renderProjectDefinition(vbrief, {
      now: new Date("2026-06-24T12:00:00Z"),
    });
    expect(ok).toBe(true);
    expect(message).toContain("3 scope items");

    const parsed: unknown = JSON.parse(
      readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    );
    expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
    const projectDef = parsed as {
      plan: { items: Array<{ metadata?: { references?: unknown[] } }> };
    };

    const umbrella = projectDef.plan.items.find(
      (item) =>
        (item as { metadata?: { source_path?: string } }).metadata?.source_path ===
        "cancelled/2026-06-16-umbrella.vbrief.json",
    );
    expect(umbrella).toBeDefined();
    const umbrellaRefs = (umbrella as { metadata?: { references?: unknown[] } }).metadata
      ?.references;
    expect(Array.isArray(umbrellaRefs)).toBe(true);
    expect(umbrellaRefs?.some((ref) => (ref as { type?: string }).type === "x-vbrief/plan")).toBe(
      false,
    );
    expect(
      umbrellaRefs?.some((ref) => (ref as { type?: string }).type === "x-vbrief/github-issue"),
    ).toBe(true);

    const errors = validateProjectDefinition(
      "vbrief/PROJECT-DEFINITION.vbrief.json",
      projectDef as Record<string, unknown>,
      vbrief,
    );
    expect(errors.filter((e) => e.includes("registry-status"))).toEqual([]);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("project-render staleness acknowledgement (#640)", () => {
  const FIXED_NOW = new Date("2026-06-28T12:00:00Z");

  it("emits staleness flags on first render when completed scopes overlap narratives", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-640-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });

    writeScope(vbrief, "completed", "2026-06-28-architecture-story.vbrief.json", {
      title: "Architecture migration story",
      status: "completed",
      items: [],
    });
    writeProjectDefinition(vbrief);

    renderProjectDefinition(vbrief, { now: FIXED_NOW });

    const parsed = JSON.parse(
      readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    ) as { plan: { metadata?: { staleness_flags?: string[] } } };
    const flags = parsed.plan.metadata?.staleness_flags ?? [];
    expect(flags.some((f) => f.includes("Architecture"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("suppresses repeat flags after acknowledgement when no new completed scopes land", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-640-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });

    writeScope(vbrief, "completed", "2026-06-28-architecture-story.vbrief.json", {
      title: "Architecture migration story",
      status: "completed",
      items: [],
    });
    writeProjectDefinition(vbrief);

    renderProjectDefinition(vbrief, { now: FIXED_NOW });
    const [ackOk] = acknowledgeProjectDefinitionStaleness(vbrief, { now: FIXED_NOW });
    expect(ackOk).toBe(true);

    renderProjectDefinition(vbrief, { now: new Date("2026-06-28T13:00:00Z") });
    const parsed = JSON.parse(
      readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    ) as {
      plan: {
        metadata?: {
          staleness_flags?: string[];
          staleness_review?: { acknowledged_completed_scope_ids?: string[] };
        };
      };
    };
    expect(parsed.plan.metadata?.staleness_flags ?? []).toEqual([]);
    expect(parsed.plan.metadata?.staleness_review?.acknowledged_completed_scope_ids).toContain(
      "2026-06-28-architecture-story",
    );

    rmSync(root, { recursive: true, force: true });
  });

  it("re-flags when a new completed scope lands after acknowledgement", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-640-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });

    writeScope(vbrief, "completed", "2026-06-28-architecture-story.vbrief.json", {
      title: "Architecture migration story",
      status: "completed",
      items: [],
    });
    writeProjectDefinition(vbrief);

    renderProjectDefinition(vbrief, { now: FIXED_NOW });
    acknowledgeProjectDefinitionStaleness(vbrief, { now: FIXED_NOW });

    writeScope(vbrief, "completed", "2026-06-28-configuration-story.vbrief.json", {
      title: "Configuration rollout story",
      status: "completed",
      items: [],
    });

    renderProjectDefinition(vbrief, { now: new Date("2026-06-28T14:00:00Z") });
    const parsed = JSON.parse(
      readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"),
    ) as { plan: { metadata?: { staleness_flags?: string[] } } };
    const flags = parsed.plan.metadata?.staleness_flags ?? [];
    expect(flags.some((f) => f.includes("Configuration"))).toBe(true);
    expect(flags.some((f) => f.includes("Architecture migration story"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("project-render main() --project-root layout resolver (#2139)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeLifecycleDirs(root: string, layoutDir: string): string {
    const dir = join(root, layoutDir);
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(dir, f), { recursive: true });
    }
    const suffix = layoutDir === "xbrief" ? ".xbrief.json" : ".vbrief.json";
    writeFileSync(
      join(dir, `PROJECT-DEFINITION${suffix}`),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6", created: "2026-07-01T00:00:00Z" },
        plan: { title: "Test", status: "running", narratives: {}, items: [], metadata: {} },
      }),
      "utf8",
    );
    return dir;
  }

  it("resolves xbrief/ layout via --project-root on migrated tree (#2139)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-xbrief-"));
    tmpDirs.push(root);
    makeLifecycleDirs(root, "xbrief");
    const exit = projectRenderMain(["--project-root", root]);
    expect(exit).toBe(0);
  });

  it("falls back to vbrief/ via --project-root on legacy tree (#2139)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-vbrief-"));
    tmpDirs.push(root);
    makeLifecycleDirs(root, "vbrief");
    const exit = projectRenderMain(["--project-root", root]);
    expect(exit).toBe(0);
    expect(readFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "utf8")).toContain(
      "vBRIEFInfo",
    );
  });

  it("--acknowledge-staleness resolves xbrief/ layout via --project-root (#2139)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-ack-xbrief-"));
    tmpDirs.push(root);
    makeLifecycleDirs(root, "xbrief");
    projectRenderMain(["--project-root", root]);
    const exit = projectRenderMain(["--acknowledge-staleness", "--project-root", root]);
    expect(exit).toBe(0);
  });
});

describe("project-render main() cwd layout resolver (#2149)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("prefers xbrief layout from cwd without recreating vbrief", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-cwd-xbrief-"));
    tmpDirs.push(root);
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", f), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8", created: "2026-07-01T00:00:00Z" },
          plan: { title: "PROJECT-DEFINITION", status: "running", narratives: {}, items: [] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const exit = projectRenderMain([]);
      expect(exit).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }
    expect(existsSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"))).toBe(true);
    expect(existsSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"))).toBe(false);
  });

  it("creates a fresh xbrief-enveloped skeleton (never .vbrief.json) on a migrated tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-cwd-xbrief-skeleton-"));
    tmpDirs.push(root);
    // A migrated tree that already carries at least one .xbrief.json artifact, but NO
    // PROJECT-DEFINITION yet -- render must synthesize it as .xbrief.json + xBRIEFInfo.
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "completed", "2026-07-02-legacy-content.xbrief.json"),
      // Historical vBRIEF-serialized content inside the migrated tree must not flip the layout.
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { title: "Old", status: "done" } }),
      "utf8",
    );

    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const exit = projectRenderMain([]);
      expect(exit).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }

    const xbriefDefPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    expect(existsSync(xbriefDefPath)).toBe(true);
    expect(existsSync(join(root, "xbrief", "PROJECT-DEFINITION.vbrief.json"))).toBe(false);
    expect(existsSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"))).toBe(false);
    const parsed = readJsonObject(xbriefDefPath);
    expect(parsed.xBRIEFInfo).toEqual(expect.objectContaining({ version: "0.8" }));
    expect(parsed.vBRIEFInfo).toBeUndefined();
  });

  it("keeps a legacy vbrief-enveloped skeleton on an unmigrated tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pr-cwd-vbrief-skeleton-"));
    tmpDirs.push(root);
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "completed", "2026-07-02-story.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { title: "Story", status: "done" } }),
      "utf8",
    );

    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const exit = projectRenderMain([]);
      expect(exit).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }

    const vbriefDefPath = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    expect(existsSync(vbriefDefPath)).toBe(true);
    const parsed = readJsonObject(vbriefDefPath);
    expect(parsed.vBRIEFInfo).toEqual(expect.objectContaining({ version: "0.6" }));
    expect(parsed.xBRIEFInfo).toBeUndefined();
  });
});
