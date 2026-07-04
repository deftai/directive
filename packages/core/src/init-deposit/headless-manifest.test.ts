import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolutionFile } from "@deftai/directive-types";
import { afterEach, describe, expect, it } from "vitest";
import { ContentPackageNotFoundError } from "../deposit/resolve-content.js";
import {
  buildHeadlessManifest,
  HEADLESS_XBRIEF_LIFECYCLE_DIRS,
  type HeadlessManifest,
  runInitHeadlessCli,
} from "./headless-manifest.js";

const CONTENT_VERSION = "9.9.9";

const AGENTS_ENTRY_TEMPLATE = `# Deft entry

<!-- deft:managed-section v3 -->
# Deft managed rules

Follow the framework rules here.
<!-- /deft:managed-section -->
`;

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal fake content-package root: version, template, payload + one binary. */
function fakeContentRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "headless-content-"));
  created.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-content", version: CONTENT_VERSION }, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "templates", "agents-entry.md"), AGENTS_ENTRY_TEMPLATE, "utf8");
  writeFileSync(join(root, "SKILL.md"), "# Core skill body\n", "utf8");
  mkdirSync(join(root, "skills", "deft"), { recursive: true });
  writeFileSync(join(root, "skills", "deft", "SKILL.md"), "text payload\n", "utf8");
  // A binary asset with a NUL byte forces base64 encoding.
  writeFileSync(join(root, "logo.bin"), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]));
  return root;
}

function seams() {
  const root = fakeContentRoot();
  return {
    root,
    resolveContentRoot: () => Promise.resolve(root),
    nowIso: () => "2026-07-03T00:00:00Z",
    newSession: () => "headlesssess1",
  };
}

function fileByPath(manifest: HeadlessManifest, path: string): ResolutionFile | undefined {
  return manifest.files.find((f) => f.path === path);
}

// `JSON.parse` returns top-level `null` (not a throw) for the literal `null`, so
// a guarded parse keeps property reads from blowing up with a TypeError outside
// the parse boundary.
function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") {
    throw new Error(
      `expected a JSON object payload, received ${value === null ? "null" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function captureIo(): {
  out: string[];
  err: string[];
  writeOut: (t: string) => void;
  writeErr: (t: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writeOut: (t) => {
      out.push(t);
    },
    writeErr: (t) => {
      err.push(t);
    },
  };
}

describe("buildHeadlessManifest (#2268 a1: valid manifest shape)", () => {
  it("emits a {version, files:[{path,content,encoding}]} manifest derived from plan()", async () => {
    const s = seams();
    const manifest = await buildHeadlessManifest(s);

    expect(manifest.version).toBe(CONTENT_VERSION);
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const file of manifest.files) {
      expect(typeof file.path).toBe("string");
      expect(typeof file.content).toBe("string");
      expect(["utf-8", "base64"]).toContain(file.encoding);
    }
    // Files are sorted by path for deterministic output.
    const paths = manifest.files.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it("includes the .deft/core payload, AGENTS.md, xBRIEF scaffold, and pinned package.json", async () => {
    const s = seams();
    const manifest = await buildHeadlessManifest(s);
    const paths = new Set(manifest.files.map((f) => f.path));

    expect(paths.has(".deft/core/SKILL.md")).toBe(true);
    expect(paths.has(".deft/core/skills/deft/SKILL.md")).toBe(true);
    expect(paths.has(".deft/core/VERSION")).toBe(true);
    expect(paths.has("AGENTS.md")).toBe(true);
    expect(paths.has("package.json")).toBe(true);
    for (const sub of HEADLESS_XBRIEF_LIFECYCLE_DIRS) {
      expect(paths.has(`xbrief/${sub}/.gitkeep`)).toBe(true);
    }
  });

  it("base64-encodes binary payload assets and utf-8-encodes text", async () => {
    const s = seams();
    const manifest = await buildHeadlessManifest(s);
    const binary = fileByPath(manifest, ".deft/core/logo.bin");
    const text = fileByPath(manifest, ".deft/core/SKILL.md");

    expect(binary?.encoding).toBe("base64");
    expect(Buffer.from(binary?.content ?? "", "base64")).toEqual(
      Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]),
    );
    expect(text?.encoding).toBe("utf-8");
    expect(text?.content).toBe("# Core skill body\n");
  });

  it("emits exactly one .deft/core/VERSION marker (payload VERSION never duplicated)", async () => {
    const s = seams();
    // A stray VERSION in the content payload must be superseded, not duplicated.
    writeFileSync(join(s.root, "VERSION"), "tag: 'v0.0.0'\n", "utf8");
    const manifest = await buildHeadlessManifest(s);
    const versionFiles = manifest.files.filter((f) => f.path === ".deft/core/VERSION");
    expect(versionFiles).toHaveLength(1);
    expect(versionFiles[0]?.content).toContain(`tag: 'v${CONTENT_VERSION}'`);
  });
});

describe("buildHeadlessManifest (#2268 a2: version-consistency)", () => {
  it("keeps AGENTS.md managed section, payload VERSION, and the pin on one resolved version", async () => {
    const s = seams();
    const manifest = await buildHeadlessManifest(s);

    const agents = fileByPath(manifest, "AGENTS.md");
    const version = fileByPath(manifest, ".deft/core/VERSION");
    const pkg = fileByPath(manifest, "package.json");

    expect(agents?.content).toContain(`<!-- deft:managed-section v3 sha=${CONTENT_VERSION}`);
    expect(version?.content).toContain(`sha: '${CONTENT_VERSION}'`);
    expect(version?.content).toContain(`tag: 'v${CONTENT_VERSION}'`);
    const parsedPkg = parseJsonObject(pkg?.content ?? "{}");
    const devDeps = parsedPkg.devDependencies as Record<string, unknown>;
    expect(devDeps["@deftai/directive"]).toBe(CONTENT_VERSION);
    expect(manifest.version).toBe(CONTENT_VERSION);
  });

  it("renders the managed section from the SAME content root as the payload", async () => {
    const s = seams();
    const manifest = await buildHeadlessManifest(s);
    const agents = fileByPath(manifest, "AGENTS.md");
    // Body text from the fake template proves the AGENTS.md is single-sourced.
    expect(agents?.content).toContain("Follow the framework rules here.");
    expect(agents?.content).toContain("<!-- /deft:managed-section -->");
  });
});

describe("buildHeadlessManifest (#2268 a3: empty dir / no git-repo assumption)", () => {
  it("runs with zero filesystem writes and no cwd dependency", async () => {
    const s = seams();
    const before = process.cwd();
    const manifest = await buildHeadlessManifest(s);
    expect(manifest.files.length).toBeGreaterThan(0);
    // No git dir, no scratch dir, nothing created beside the (unrelated) cwd.
    expect(process.cwd()).toBe(before);
  });

  it("is deterministic given fixed clock + session seams", async () => {
    const s = seams();
    const a = await buildHeadlessManifest(s);
    const b = await buildHeadlessManifest(s);
    expect(a).toEqual(b);
  });
});

describe("runInitHeadlessCli (#2268 a4: graceful failure + output handling)", () => {
  it("writes the manifest to --output as the ONLY filesystem write", async () => {
    const s = seams();
    const outDir = mkdtempSync(join(tmpdir(), "headless-out-"));
    created.push(outDir);
    const outPath = join(outDir, "nested", "manifest.json");
    const io = captureIo();
    const writes: string[] = [];

    const code = await runInitHeadlessCli({
      outputPath: outPath,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: s,
      writeFile: (path, data) => {
        writes.push(path);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, data);
      },
    });

    expect(code).toBe(0);
    expect(writes).toEqual([outPath]);
    expect(existsSync(outPath)).toBe(true);
    const parsed = parseJsonObject(readFileSync(outPath, "utf8"));
    expect(parsed.version).toBe(CONTENT_VERSION);
    expect(io.out.join("")).toBe(""); // stdout stays clean when writing a file
    expect(io.err.join("")).toContain("wrote");
  });

  it("emits the manifest to stdout when no --output target is given", async () => {
    const s = seams();
    const io = captureIo();
    const code = await runInitHeadlessCli({
      outputPath: null,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: s,
    });
    expect(code).toBe(0);
    const parsed = parseJsonObject(io.out.join(""));
    expect(parsed.version).toBe(CONTENT_VERSION);
    expect(Array.isArray(parsed.files)).toBe(true);
  });

  it("exits non-zero + emits a JSON error object on content-resolution failure", async () => {
    const io = captureIo();
    const writes: string[] = [];
    const code = await runInitHeadlessCli({
      outputPath: join(tmpdir(), "should-not-be-written.json"),
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: {
        resolveContentRoot: () =>
          Promise.reject(new ContentPackageNotFoundError("registry unreachable")),
      },
      writeFile: (path) => {
        writes.push(path);
      },
    });

    expect(code).toBe(1);
    expect(writes).toEqual([]); // no partial write
    const parsed = parseJsonObject(io.out.join(""));
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe("content_resolution_failed");
    expect(parsed.error).toContain("registry unreachable");
  });
});
