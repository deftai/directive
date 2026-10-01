import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIFECYCLE_FOLDERS, scanLifecycleAnchors } from "../intake/reconcile-issues.js";
import { renderRoadmapToBuffer } from "../render/roadmap-render.js";
import { GIT_LS_FILES_Z_ENCODING, splitGitLsFilesZRecords } from "./build-dist.js";
import { EXIT_VIOLATION } from "./constants.js";
import {
  escapeReleaseDisplay,
  foldersForPhase,
  loneLfEquals,
  RELEASE_INPUT_PER_FILE_MAX_BYTES,
  RELEASE_INPUT_PER_VIEW_MAX_BYTES,
  ROADMAP_FOLDERS,
  SCANNER_FOLDERS,
  splitGitNulRecordsStrict,
  validateReleaseInputs,
  writeEscapedReleaseLine,
  writeReleaseInputDetails,
} from "./release-input.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "release-input-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  mkdirSync(join(root, "xbrief"));
  writeFileSync(join(root, "README"), "x\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

const MINIMAL = `{
  "xBRIEFInfo": { "version": "0.8" },
  "plan": { "title": "t", "status": "proposed" }
}
`;

function commitArtifact(root: string, folder: string, name: string, body = MINIMAL): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", `add ${folder}/${name}`]);
}

describe("escapeReleaseDisplay (#4317 F1)", () => {
  it("keeps [release-input] and OK/FAIL forges on one escaped line", () => {
    const raw =
      "xbrief/pending/foo\n[release-input] forged\n[3/13] Pre-flight... OK (no mismatches)";
    const escaped = escapeReleaseDisplay(raw);
    expect(escaped.includes("\n")).toBe(false);
    expect(escaped.includes("\r")).toBe(false);
    expect(escaped).toContain("\\n");
    expect(escaped.split("\n")).toHaveLength(1);
    expect(escaped).toContain("[release-input]");
    const chunks: string[] = [];
    writeEscapedReleaseLine(raw, {
      write: (c: string) => {
        chunks.push(String(c));
        return true;
      },
    } as unknown as NodeJS.WriteStream);
    expect(
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0),
    ).toHaveLength(1);
  });

  it("escapes tab and control bytes", () => {
    expect(escapeReleaseDisplay("a\tb")).toBe("a\\tb");
    expect(escapeReleaseDisplay(Buffer.from([0x01, 0x7f]))).toBe("\\x01\\x7f");
    expect(escapeReleaseDisplay(Buffer.from([0xe9]))).toBe("\\xe9");
    expect(escapeReleaseDisplay("é")).toBe("é");
  });
});

describe("loneLfEquals", () => {
  it("accepts exact LF, exact CRLF, and lone-LF expansion", () => {
    expect(loneLfEquals(Buffer.from("a\nb"), Buffer.from("a\nb"))).toBe(true);
    expect(loneLfEquals(Buffer.from("a\r\nb"), Buffer.from("a\r\nb"))).toBe(true);
    expect(loneLfEquals(Buffer.from("a\nb"), Buffer.from("a\r\nb"))).toBe(true);
    expect(loneLfEquals(Buffer.from("\nx"), Buffer.from("\r\nx"))).toBe(true);
  });

  it("rejects HEAD CRLF vs CRCRLF or LF, unmatched trailing bytes, and bare-CR drift", () => {
    expect(loneLfEquals(Buffer.from("a\r\nb"), Buffer.from("a\r\r\nb"))).toBe(false);
    expect(loneLfEquals(Buffer.from("a\r\nb"), Buffer.from("a\nb"))).toBe(false);
    expect(loneLfEquals(Buffer.from("a\nb"), Buffer.from("a\nbx"))).toBe(false);
    expect(loneLfEquals(Buffer.from("a\rb"), Buffer.from("ab"))).toBe(false);
  });
});

describe("splitGitNulRecordsStrict", () => {
  it("reuses splitGitLsFilesZRecords and refuses missing trailing NUL", () => {
    expect(GIT_LS_FILES_Z_ENCODING).toBeNull();
    const ok = Buffer.from("a\0b\0");
    expect(splitGitNulRecordsStrict(ok)?.map((b) => b.toString("utf8"))).toEqual(["a", "b"]);
    expect(splitGitLsFilesZRecords(ok)).toHaveLength(2);
    expect(splitGitNulRecordsStrict(Buffer.from("a\0b"))).toBeNull();
    expect(splitGitNulRecordsStrict(Buffer.alloc(0))).toEqual([]);
  });

  it("preserves a backslash byte in a git -z record (#4907)", () => {
    const record = Buffer.from("xbrief/pending/foo\\bar.xbrief.json\0");
    expect(splitGitNulRecordsStrict(record)?.map((b) => b.toString("utf8"))).toEqual([
      "xbrief/pending/foo\\bar.xbrief.json",
    ]);
  });
});

describe("folder coupling", () => {
  it("scanner folders are production LIFECYCLE_FOLDERS including cancelled", () => {
    expect([...SCANNER_FOLDERS]).toEqual([...LIFECYCLE_FOLDERS]);
    expect(SCANNER_FOLDERS).toContain("cancelled");
    expect(foldersForPhase("scanner")).toEqual(SCANNER_FOLDERS);
  });

  it("roadmap folders exclude cancelled and match renderRoadmapToBuffer", () => {
    expect([...ROADMAP_FOLDERS]).toEqual(["pending", "proposed", "active", "completed"]);
    expect(ROADMAP_FOLDERS).not.toContain("cancelled");
    expect(foldersForPhase("roadmap")).toEqual(ROADMAP_FOLDERS);
  });
});

describe("canonical root", () => {
  it("missing xbrief and vbrief is missing-lifecycle-root / EXIT_VIOLATION", () => {
    const root = mkdtempSync(join(tmpdir(), "release-input-norooot-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "t@t.local"]);
    git(root, ["config", "user.name", "T"]);
    writeFileSync(join(root, "README"), "x\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing-lifecycle-root");
    expect(result.exitCode).toBe(EXIT_VIOLATION);
    expect(result.selectedPaths).toEqual([]);
    expect(result.payloadReads).toBe(0);
  });

  it("legacy-only vbrief refuses without traversing vbrief files", () => {
    const root = mkdtempSync(join(tmpdir(), "release-input-legacy-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "t@t.local"]);
    git(root, ["config", "user.name", "T"]);
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "vbrief", "pending", "secret.vbrief.json"), MINIMAL);
    writeFileSync(join(root, "README"), "x\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("legacy-only");
    expect(result.payloadReads).toBe(0);
    expect(result.selectedPaths.join("")).not.toContain("secret");
  });

  it("empty canonical root with empty views passes", () => {
    const root = initRepo();
    expect(validateReleaseInputs(root, "scanner").ok).toBe(true);
    expect(validateReleaseInputs(root, "roadmap").ok).toBe(true);
  });

  it("symlink xbrief root fails before target reads", () => {
    const root = initRepo();
    rmSync(join(root, "xbrief"), { recursive: true, force: true });
    const target = join(root, "other");
    mkdirSync(join(target, "pending"), { recursive: true });
    writeFileSync(join(target, "pending", "a.xbrief.json"), MINIMAL);
    // Directory junction needs no symlink privilege and still lstats as a symlink (#4907).
    if (process.platform === "win32") {
      symlinkSync(target, join(root, "xbrief"), "junction");
    } else {
      symlinkSync(target, join(root, "xbrief"));
    }
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unsafe-node");
    expect(result.payloadReads).toBe(0);
  });
});

describe("three-view census", () => {
  it("refuses ignored untracked *.premigrate.xbrief.json before payload reads", () => {
    const root = initRepo();
    writeFileSync(join(root, ".gitignore"), "*.premigrate.xbrief.json\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "ignore"]);
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "xbrief", "cancelled"), { recursive: true });
    writeFileSync(join(root, "xbrief", "proposed", "a.premigrate.xbrief.json"), MINIMAL);
    writeFileSync(join(root, "xbrief", "cancelled", "b.premigrate.xbrief.json"), MINIMAL);
    git(root, ["config", "status.showUntrackedFiles", "no"]);
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("untracked");
    expect(result.payloadReads).toBe(0);
    expect(result.selectedPaths.some((p) => p.includes("premigrate"))).toBe(true);
  });

  it("refuses an uncommitted content change", () => {
    const root = initRepo();
    commitArtifact(root, "pending", "story.xbrief.json");
    writeFileSync(join(root, "xbrief", "pending", "story.xbrief.json"), `${MINIMAL}\n`, "utf8");
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("uncommitted");
  });

  it("accepts lone-LF expansion in an eol=lf tree as an input pass", () => {
    const root = initRepo();
    commitArtifact(root, "pending", "story.xbrief.json", '{\n  "x": 1\n}\n');
    writeFileSync(join(root, "xbrief", "pending", "story.xbrief.json"), '{\r\n  "x": 1\r\n}\r\n');
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(true);
  });

  // Win32 treats `\` as a separator, so this committed name is not a reachable fixture there (#4907).
  it.skipIf(process.platform === "win32")(
    "keeps a POSIX backslash in a committed filename across all three views",
    () => {
      const root = initRepo();
      commitArtifact(root, "pending", "foo\\bar.xbrief.json");
      const result = validateReleaseInputs(root, "scanner");
      expect(result.ok).toBe(true);
      expect(result.code).toBe("ok");
      expect(result.selectedPaths).toEqual(["xbrief/pending/foo\\bar.xbrief.json"]);
    },
  );
});

describe("production-reader observer", () => {
  it("scanner includes cancelled/; roadmap excludes it", () => {
    const root = initRepo();
    for (const folder of LIFECYCLE_FOLDERS) {
      commitArtifact(
        root,
        folder,
        `${folder}.xbrief.json`,
        `{
  "xBRIEFInfo": { "version": "0.8" },
  "plan": { "title": "${folder}-title", "status": "${folder === "completed" || folder === "cancelled" ? "completed" : "proposed"}" }
}
`,
      );
    }
    mkdirSync(join(root, "xbrief", "pending", "nested"), { recursive: true });
    writeFileSync(join(root, "xbrief", "pending", "nested", "deep.xbrief.json"), MINIMAL);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "nested"]);
    writeFileSync(join(root, "xbrief", "pending", "notes.md"), "nope\n");

    const scan = validateReleaseInputs(root, "scanner");
    const road = validateReleaseInputs(root, "roadmap");
    expect(scan.ok).toBe(true);
    expect(road.ok).toBe(true);
    expect(scan.selectedPaths.some((p) => p.includes("cancelled/"))).toBe(true);
    expect(road.selectedPaths.some((p) => p.includes("cancelled/"))).toBe(false);
    expect(scan.selectedPaths.some((p) => p.includes("nested/"))).toBe(false);
    expect(scan.selectedPaths.some((p) => p.endsWith("notes.md"))).toBe(false);

    const anchors = scanLifecycleAnchors(join(root, "xbrief"));
    expect(anchors.some((a) => String(a.rel_path).startsWith("cancelled/"))).toBe(true);
    const rendered = renderRoadmapToBuffer(join(root, "xbrief", "pending"));
    expect(rendered).toContain("pending-title");
    expect(rendered).not.toContain("cancelled-title");
  });
});

describe("size budgets", () => {
  it("accepts the exact 1 MiB per-file boundary and refuses +1", () => {
    const root = initRepo();
    const body = Buffer.alloc(RELEASE_INPUT_PER_FILE_MAX_BYTES, 0x61);
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "xbrief", "pending", "exact.xbrief.json"), body);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "exact"]);
    expect(validateReleaseInputs(root, "scanner").ok).toBe(true);

    const over = initRepo();
    mkdirSync(join(over, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(over, "xbrief", "pending", "over.xbrief.json"),
      Buffer.alloc(RELEASE_INPUT_PER_FILE_MAX_BYTES + 1, 0x61),
    );
    git(over, ["add", "-A"]);
    git(over, ["commit", "-q", "-m", "over"]);
    const refused = validateReleaseInputs(over, "scanner");
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("oversized");
    expect(refused.payloadReads).toBe(0);
  });

  it("refuses aggregate 64 MiB + 1 via metadata without payload reads", () => {
    const root = initRepo();
    commitArtifact(root, "pending", "a.xbrief.json");
    commitArtifact(root, "pending", "b.xbrief.json", `${MINIMAL} `);
    const half = Math.floor(RELEASE_INPUT_PER_VIEW_MAX_BYTES / 2) + 1;
    const result = validateReleaseInputs(root, "scanner", {
      diskSizeOf: () => half,
      headBlobSizeOf: () => half,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("oversized");
    expect(result.payloadReads).toBe(0);
  });

  it("real 64 MiB selected payload plus cat-file framing is accepted", () => {
    const root = initRepo();
    const per = RELEASE_INPUT_PER_FILE_MAX_BYTES;
    const count = RELEASE_INPUT_PER_VIEW_MAX_BYTES / per;
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const body = Buffer.alloc(per, 0x61);
      body.writeUInt32BE(i, 0);
      writeFileSync(join(root, "xbrief", "pending", `f${i}.xbrief.json`), body);
    }
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "big"]);
    const result = validateReleaseInputs(root, "scanner");
    expect(result.ok).toBe(true);
    expect(result.payloadReads).toBeGreaterThan(0);
  }, 120_000);

  it("distinct invalid-UTF-8 HEAD blobs stay unequal", () => {
    expect(loneLfEquals(Buffer.from([0x80]), Buffer.from([0x81]))).toBe(false);
    expect(loneLfEquals(Buffer.from([0x80]), Buffer.from([0x80]))).toBe(true);
  });
});

describe("writeReleaseInputDetails", () => {
  it("emits single-line [release-input] details outside emit()", () => {
    const chunks: string[] = [];
    writeReleaseInputDetails(
      {
        ok: false,
        exitCode: 1,
        code: "untracked",
        violations: [
          {
            code: "untracked",
            path: "xbrief/pending/a\n[3/13] OK (no mismatches)",
            remedy: "remove or relocate",
          },
        ],
        selectedPaths: [],
        payloadReads: 0,
      },
      {
        write: (c: string) => {
          chunks.push(String(c));
          return true;
        },
      } as unknown as NodeJS.WriteStream,
    );
    const text = chunks.join("");
    expect(text.startsWith("[release-input] ")).toBe(true);
    expect(text).toContain("\\n");
    expect(text).toContain("did not promote CHANGELOG");
    for (const line of text.split("\n").filter(Boolean)) {
      expect(line.includes("\n")).toBe(false);
    }
  });
});
