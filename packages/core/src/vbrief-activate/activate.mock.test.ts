import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("activate statSync failure branch", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("../fs/projection-containment.js");
    vi.doUnmock("../fs/contained-write.js");
    vi.resetModules();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports statSync failures after existsSync succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-stat-"));
    roots.push(root);
    const path = join(root, "xbrief", "pending", "x.xbrief.json");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (target: string) => target === path || actual.existsSync(target),
        statSync: (target: string) => {
          if (target === path) {
            throw new Error("stat denied");
          }
          return actual.statSync(target);
        },
      };
    });

    const { activate } = await import("./activate.js");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not read vBRIEF");
    expect(result.message).toContain("stat denied");
  });

  it("refuses when assertProjectionContained throws (#3147), leaving pending intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-contain-"));
    roots.push(root);
    const path = join(root, "xbrief", "pending", "story.xbrief.json");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("../fs/projection-containment.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../fs/projection-containment.js")>();
      return {
        ...actual,
        assertProjectionContained: (projectDir: string, targetPath: string) => {
          // Use actual.ProjectionContainmentError so activate's instanceof check matches.
          throw new actual.ProjectionContainmentError(
            `projection write refused: ${targetPath} is a symlink escaping the project tree ${projectDir}`,
            {
              projectDir,
              targetPath,
              offendingPath: targetPath,
            },
          );
        },
      };
    });

    const { activate } = await import("./activate.js");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("projection write refused");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(false);
  });

  it("re-throws unexpected errors from assertProjectionContained (#3147)", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-contain-rethrow-"));
    roots.push(root);
    const path = join(root, "xbrief", "pending", "story.xbrief.json");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("../fs/projection-containment.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../fs/projection-containment.js")>();
      return {
        ...actual,
        assertProjectionContained: () => {
          throw new Error("unexpected containment probe failure");
        },
      };
    });

    const { activate } = await import("./activate.js");
    expect(() => activate(path)).toThrow(/unexpected containment probe failure/);
    expect(existsSync(path)).toBe(true);
  });

  it("reports mkdir failures on active dir (#3147)", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-mkdir-"));
    roots.push(root);
    const path = join(root, "xbrief", "pending", "story.xbrief.json");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        mkdirSync: (target: string, options?: Parameters<typeof actual.mkdirSync>[1]) => {
          if (String(target).includes("active")) {
            throw new Error("mkdir denied");
          }
          return actual.mkdirSync(target, options);
        },
      };
    });

    const { activate } = await import("./activate.js");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not create");
    expect(result.message).toContain("mkdir denied");
    expect(existsSync(path)).toBe(true);
  });

  it("reports containedWrite failures and keeps pending (#3147)", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-write-"));
    roots.push(root);
    const path = join(root, "xbrief", "pending", "story.xbrief.json");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("../fs/contained-write.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../fs/contained-write.js")>();
      return {
        ...actual,
        containedWrite: () => {
          throw new Error("write sink refused");
        },
      };
    });

    const { activate } = await import("./activate.js");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not write");
    expect(result.message).toContain("write sink refused");
    expect(existsSync(path)).toBe(true);
  });

  it("reports unlink failures after a successful write (#3147)", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-unlink-"));
    roots.push(root);
    const path = join(root, "xbrief", "pending", "story.xbrief.json");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        unlinkSync: (target: string) => {
          if (target === path) {
            throw new Error("unlink denied");
          }
          return actual.unlinkSync(target);
        },
      };
    });

    const { activate } = await import("./activate.js");
    const result = activate(path, { now: new Date("2026-06-19T12:00:00.000Z") });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("could not remove source");
    expect(result.message).toContain("unlink denied");
    // Destination was written; source cleanup failed.
    expect(existsSync(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(true);
  });

  it("maps JSON parse property-name and trailing-data error messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-json-map-"));
    roots.push(root);
    const pending = join(root, "xbrief", "pending");
    mkdirSync(pending, { recursive: true });

    const propPath = join(pending, "prop.xbrief.json");
    writeFileSync(propPath, "{foo:1}", "utf8");
    const { activate } = await import("./activate.js");
    const propResult = activate(propPath);
    expect(propResult.exitCode).toBe(1);
    expect(propResult.message).toMatch(/Expecting property name|not valid JSON/);

    const trailPath = join(pending, "trail.xbrief.json");
    writeFileSync(trailPath, '{"a":1} trailing', "utf8");
    const trailResult = activate(trailPath);
    expect(trailResult.exitCode).toBe(1);
    expect(trailResult.message).toMatch(/Extra data|not valid JSON/);
  });
});
