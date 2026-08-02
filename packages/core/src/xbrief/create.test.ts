/**
 * Golden create/verify round-trips + failure cases for #3057.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createXbrief, parseCreateArgv, runXbriefCreateCli } from "./create.js";
import { expandUserPath, resolveXbriefOutPaths, XbriefPathError } from "./paths.js";
import { MD_REQUIRED_SECTIONS, parseMarkdownMeta } from "./styles.js";
import { XBRIEF_STYLES } from "./types.js";
import { runXbriefVerifyCli, verifyXbrief } from "./verify.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("parseCreateArgv (#3057)", () => {
  it("requires --format and --out", () => {
    const missingFormat = parseCreateArgv(["--out", "a.xbrief.json"]);
    expect(missingFormat).toMatchObject({
      error: expect.stringContaining("missing required --format"),
    });

    const missingOut = parseCreateArgv(["--format", "json"]);
    expect(missingOut).toMatchObject({ error: expect.stringContaining("missing required --out") });
  });

  it("rejects invalid format and style", () => {
    expect(parseCreateArgv(["--format", "yaml", "--out", "x"])).toMatchObject({
      error: expect.stringContaining("invalid --format"),
    });
    expect(parseCreateArgv(["--format", "json", "--out", "x", "--style", "epic"])).toMatchObject({
      error: expect.stringContaining("invalid --style"),
    });
  });

  it("parses happy-path flags", () => {
    const parsed = parseCreateArgv([
      "--format",
      "both",
      "--out",
      "xbrief/demo",
      "--style",
      "playbook",
      "--title",
      "Demo",
      "--id",
      "demo-1",
      "--force",
    ]);
    expect(parsed).toMatchObject({
      format: "both",
      out: "xbrief/demo",
      style: "playbook",
      title: "Demo",
      id: "demo-1",
      force: true,
    });
  });
});

describe("path expand + containment (#3057)", () => {
  it("expands tilde and %USERPROFILE%-class env vars", () => {
    const home = join(tmpdir(), "xbrief-home-fake");
    expect(expandUserPath("~/docs/a", { home })).toBe(join(home, "docs", "a"));
    expect(
      expandUserPath("%USERPROFILE%\\docs\\a", {
        home,
        env: { USERPROFILE: home },
      }),
    ).toBe(join(home, "docs", "a"));
  });

  it("fails closed on project-root escape", () => {
    const root = freshRoot("xbrief-escape-");
    expect(() =>
      resolveXbriefOutPaths({
        projectRoot: root,
        out: join("..", "outside"),
        format: "json",
      }),
    ).toThrow(XbriefPathError);
  });

  it("resolves stem pairs for format=both", () => {
    const root = freshRoot("xbrief-stem-");
    const paths = resolveXbriefOutPaths({
      projectRoot: root,
      out: "notes/demo",
      format: "both",
    });
    expect(paths.jsonAbs).toBe(join(root, "notes", "demo.xbrief.json"));
    expect(paths.mdAbs).toBe(join(root, "notes", "demo.xbrief.md"));
  });
});

describe("create golden round-trips (#3057)", () => {
  it.each([...XBRIEF_STYLES])("creates json+md for style=%s and verify passes", (style) => {
    const root = freshRoot(`xbrief-create-${style}-`);
    const created = createXbrief({
      format: "both",
      out: `out/${style}-demo`,
      style,
      title: `${style} demo`,
      id: `${style}-1`,
      projectRoot: root,
      force: true,
      now: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("OK xbrief:create");
    expect(created.stdout).toContain("not a lifecycle move");

    const jsonPath = join(root, "out", `${style}-demo.xbrief.json`);
    const mdPath = join(root, "out", `${style}-demo.xbrief.md`);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      xBRIEFInfo: { version: string };
      plan: { title: string; status: string; id?: string; items: unknown[] };
    };
    expect(doc.xBRIEFInfo.version).toBe("0.8");
    expect(doc.plan.title).toBe(`${style} demo`);
    expect(doc.plan.id).toBe(`${style}-1`);
    expect(Array.isArray(doc.plan.items)).toBe(true);

    const md = readFileSync(mdPath, "utf8");
    const meta = parseMarkdownMeta(md);
    for (const section of MD_REQUIRED_SECTIONS[style]) {
      expect(meta.sections.has(section)).toBe(true);
    }

    const verified = verifyXbrief({
      format: "both",
      out: `out/${style}-demo`,
      style,
      projectRoot: root,
    });
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout).toContain("OK xbrief:verify");
  });

  it("supports format=json only and format=md only", () => {
    const root = freshRoot("xbrief-format-");
    const jsonOnly = createXbrief({
      format: "json",
      out: "solo/json-only",
      style: "scope",
      title: "JSON only",
      projectRoot: root,
    });
    expect(jsonOnly.exitCode).toBe(0);
    expect(existsSync(join(root, "solo", "json-only.xbrief.json"))).toBe(true);
    expect(existsSync(join(root, "solo", "json-only.xbrief.md"))).toBe(false);

    const mdOnly = createXbrief({
      format: "md",
      out: "solo/md-only",
      style: "mission",
      title: "MD only",
      projectRoot: root,
    });
    expect(mdOnly.exitCode).toBe(0);
    expect(existsSync(join(root, "solo", "md-only.xbrief.md"))).toBe(true);
    expect(existsSync(join(root, "solo", "md-only.xbrief.json"))).toBe(false);
  });

  it("refuses overwrite without --force", () => {
    const root = freshRoot("xbrief-force-");
    const first = createXbrief({
      format: "json",
      out: "once",
      style: "scope",
      title: "Once",
      projectRoot: root,
    });
    expect(first.exitCode).toBe(0);
    const second = createXbrief({
      format: "json",
      out: "once",
      style: "scope",
      title: "Twice",
      projectRoot: root,
    });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("target exists");
  });
});

describe("CLI entry points (#3057)", () => {
  it("runXbriefCreateCli missing flags exits 2", () => {
    const r = runXbriefCreateCli([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("missing required --format");
  });

  it("runXbriefVerifyCli missing flags exits 2", () => {
    const r = runXbriefVerifyCli(["--format", "json"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("missing required --out");
  });

  it("create then verify via CLI argv", () => {
    const root = freshRoot("xbrief-cli-");
    const created = runXbriefCreateCli([
      "--format=both",
      "--out=cli/demo",
      "--style=scope",
      "--title=CLI Demo",
      "--id=cli-demo",
      `--project-root=${root}`,
      "--force",
    ]);
    expect(created.exitCode).toBe(0);
    const verified = runXbriefVerifyCli([
      "--format=both",
      "--out=cli/demo",
      "--style=scope",
      `--project-root=${root}`,
    ]);
    expect(verified.exitCode).toBe(0);
  });

  it("prints create help on --help", () => {
    const r = runXbriefCreateCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("xbrief:create");
    expect(r.stdout).toMatch(/lifecycle|scope:\*/);
  });

  it("rejects path escape via CLI", () => {
    const root = freshRoot("xbrief-cli-escape-");
    const r = runXbriefCreateCli([
      "--format",
      "json",
      "--out",
      join("..", "outside"),
      `--project-root=${root}`,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/escape|refused/i);
  });

  it("creates from --from-json and enforces size cap", () => {
    const root = freshRoot("xbrief-from-json-");
    const src = join(root, "seed.xbrief.json");
    const seed = {
      xBRIEFInfo: { version: "0.8", description: "seed" },
      plan: { title: "Seeded", status: "draft", items: [] },
    };
    writeFileSync(src, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    const ok = createXbrief({
      format: "json",
      out: "from/seed",
      style: "scope",
      fromJson: src,
      projectRoot: root,
      force: true,
    });
    expect(ok.exitCode).toBe(0);

    const capped = createXbrief({
      format: "json",
      out: "from/capped",
      style: "scope",
      title: "Capped",
      projectRoot: root,
      sizeCapBytes: 40,
    });
    expect(capped.exitCode).toBe(1);
    expect(capped.stderr).toContain("size cap");
  });

  it("rejects empty path and project-root stem", () => {
    expect(() => expandUserPath("")).toThrow(XbriefPathError);
    const root = freshRoot("xbrief-root-stem-");
    expect(() =>
      resolveXbriefOutPaths({ projectRoot: root, out: ".", format: "json", cwd: root }),
    ).toThrow(XbriefPathError);
  });

  it("accepts ./ relative out and .xbrief.json suffix strip", () => {
    const root = freshRoot("xbrief-rel-");
    const paths = resolveXbriefOutPaths({
      projectRoot: root,
      out: "./nested/file.xbrief.json",
      format: "json",
      cwd: root,
    });
    expect(paths.jsonAbs).toBe(join(root, "nested", "file.xbrief.json"));
    expect(paths.mdAbs).toBeNull();
  });

  it("parseCreateArgv rejects missing flag values and unknown args", () => {
    expect(parseCreateArgv(["--format"])).toMatchObject({
      error: expect.stringContaining("expected one argument"),
    });
    expect(parseCreateArgv(["--format", "json", "--out", "x", "--nope"])).toMatchObject({
      error: expect.stringContaining("unrecognized"),
    });
  });
});
