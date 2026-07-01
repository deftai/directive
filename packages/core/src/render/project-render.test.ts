import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
