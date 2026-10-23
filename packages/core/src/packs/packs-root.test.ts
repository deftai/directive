import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./pack-render.js";
import {
  bindPacksRoot,
  defaultPacksRoot,
  findFrameworkSourceRoot,
  PacksRootError,
  resolvePacksRoot,
} from "./packs-root.js";

// #5853: the pack root comes from flag -> env -> cwd walk-up, never from the
// module location while a framework source checkout is reachable.
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
// A module URL that lives outside every fixture's ancestry (installed package stand-in).
const FOREIGN_MODULE = pathToFileURL(
  join(tmpdir(), "pkg", "dist", "packs", "x", "pack-render.js"),
).href;

const tmpDirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "packs-root-5853-"));
  tmpDirs.push(root);
  mkdirSync(join(root, "content", "packs", "lessons"), { recursive: true });
  writeFileSync(
    join(root, "content", "packs", "lessons", "lessons-pack-0.1.json"),
    JSON.stringify({
      pack: "lessons",
      lessons: [{ title: "Fixture lesson", body: "fixture body" }],
    }),
  );
  mkdirSync(join(root, "sub", "deeper"), { recursive: true });
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("packs-root resolution (#5853)", () => {
  it("walks up from a subdirectory to the checkout carrying content/packs", () => {
    const root = fixture();
    expect(findFrameworkSourceRoot(join(root, "sub", "deeper"))).toBe(resolve(root));
    const bound = defaultPacksRoot(FOREIGN_MODULE, join(root, "sub", "deeper"));
    expect(bound).toEqual({
      repoRoot: resolve(root),
      contentRoot: join(resolve(root), "content"),
      frameworkSource: true,
    });
  });

  it("binds framework source to checkout content/ even when a staged content package exists", () => {
    const root = fixture();
    const pkg = join(root, "node_modules", "@deftai", "directive-content");
    mkdirSync(join(pkg, "skills"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}");
    expect(bindPacksRoot(root).contentRoot).toBe(join(root, "content"));
  });

  it("falls back to the module location only when the walk misses", () => {
    const outside = mkdtempSync(join(tmpdir(), "packs-root-5853-miss-"));
    tmpDirs.push(outside);
    const bound = defaultPacksRoot(
      pathToFileURL(join(REPO_ROOT, "packages", "core", "src", "packs", "pack-render.ts")).href,
      outside,
    );
    expect(bound.repoRoot).toBe(REPO_ROOT);
  });

  it("explicit flag beats env and env beats the walk", () => {
    const a = fixture();
    const b = fixture();
    const env = { DEFT_PROJECT_ROOT: b };
    expect(
      resolvePacksRoot({ projectRoot: a, env, cwd: REPO_ROOT, moduleUrl: FOREIGN_MODULE }).repoRoot,
    ).toBe(resolve(a));
    expect(resolvePacksRoot({ env, cwd: REPO_ROOT, moduleUrl: FOREIGN_MODULE }).repoRoot).toBe(
      resolve(b),
    );
  });

  it("refuses closed when an explicit root does not exist", () => {
    const missing = join(tmpdir(), "packs-root-5853-missing-does-not-exist");
    expect(() =>
      resolvePacksRoot({ projectRoot: missing, env: {}, moduleUrl: FOREIGN_MODULE }),
    ).toThrow(PacksRootError);
    expect(() =>
      resolvePacksRoot({ env: { DEFT_PROJECT_ROOT: missing }, moduleUrl: FOREIGN_MODULE }),
    ).toThrow(/DEFT_PROJECT_ROOT .* is not a directory/);
  });
});

describe("pack-render main binds to the resolved checkout (#5853)", () => {
  it("renders and checks a tmp fixture from a subdirectory cwd with no root override", () => {
    const root = fixture();
    vi.spyOn(process, "cwd").mockReturnValue(join(root, "sub", "deeper"));
    const saved = process.env.DEFT_PROJECT_ROOT;
    delete process.env.DEFT_PROJECT_ROOT;
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    try {
      expect(main(["--pack", "lessons"])).toBe(0);
      const lessons = join(root, "meta", "lessons.md");
      expect(readFileSync(lessons, "utf8")).toContain("Fixture lesson");
      expect(main(["--check", "--pack", "lessons"])).toBe(0);
      writeFileSync(lessons, "stale\n");
      expect(main(["--check", "--pack", "lessons"])).toBe(1);
      const report = err.join("");
      expect(report).toContain(lessons);
      expect(report).not.toMatch(/node_modules/);
    } finally {
      if (saved !== undefined) process.env.DEFT_PROJECT_ROOT = saved;
    }
  });

  it("honors --project-root and refuses a missing one", () => {
    const root = fixture();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(main(["--pack", "lessons", "--project-root", root])).toBe(0);
    expect(readFileSync(join(root, "meta", "lessons.md"), "utf8")).toContain("Fixture lesson");
    expect(main(["--check", `--project-root=${join(root, "nope")}`])).toBe(1);
    expect(err.join("")).toMatch(/--project-root .* is not a directory/);
  });
});
