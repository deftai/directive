import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLegacyRefusalJson,
  buildLegacyRefusalMessage,
  detectLegacyLayout,
  LEGACY_LAYOUT_REFUSED_EXIT_CODE,
  type LegacyDetectSeams,
  LegacyLayoutRefusedError,
  legacyLayoutSignpostLine,
} from "./legacy-detect.js";

const PROJ = "/proj";

function seamsFor(opts: {
  dirs?: string[];
  files?: string[];
  texts?: Record<string, string>;
}): LegacyDetectSeams {
  const dirs = new Set((opts.dirs ?? []).map((p) => join(PROJ, p)));
  const files = new Set((opts.files ?? []).map((p) => join(PROJ, p)));
  const texts: Record<string, string> = {};
  for (const [rel, body] of Object.entries(opts.texts ?? {})) {
    texts[join(PROJ, rel)] = body;
  }
  return {
    isDir: (p) => dirs.has(p),
    isFile: (p) => files.has(p),
    readText: (p) => texts[p] ?? null,
  };
}

const V3_AGENTS =
  "Deft is installed in .deft/core.\n<!-- deft:managed-section v3 sha=abc -->\nbody\n<!-- /deft:managed-section -->\n";

describe("detectLegacyLayout — not legacy", () => {
  it("canonical .deft/core layout is not legacy", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({ dirs: [".deft/core"], texts: { "AGENTS.md": V3_AGENTS } }),
    );
    expect(result.legacy).toBe(false);
    expect(result.kind).toBeNull();
  });

  it("greenfield (nothing installed) is not legacy", () => {
    const result = detectLegacyLayout(PROJ, seamsFor({}));
    expect(result.legacy).toBe(false);
  });

  it("declared .deft/core in AGENTS.md but missing dir is drift, not legacy", () => {
    const result = detectLegacyLayout(PROJ, seamsFor({ texts: { "AGENTS.md": V3_AGENTS } }));
    expect(result.legacy).toBe(false);
  });

  it("a non-deft AGENTS.md (no managed marker) is not legacy", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({ texts: { "AGENTS.md": "# My project\nNo deft here.\n" } }),
    );
    expect(result.legacy).toBe(false);
  });

  it("a truncated AGENTS.md with only the close tag is corruption, not legacy", () => {
    // The bare `deft:managed-section` substring also appears in the close tag,
    // so a mid-write / truncated file carrying only `<!-- /deft:managed-section -->`
    // must not be misclassified as a pre-v0.27 sentinel layout (#1970 review).
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({
        texts: {
          "AGENTS.md": "# Project\nbody with no open tag\n<!-- /deft:managed-section -->\n",
        },
      }),
    );
    expect(result.legacy).toBe(false);
    expect(result.kind).toBeNull();
  });
});

describe("detectLegacyLayout — legacy shapes", () => {
  it("orphan .deft/VERSION (no .deft/core) is legacy", () => {
    const result = detectLegacyLayout(PROJ, seamsFor({ files: [".deft/VERSION"] }));
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("orphan-deft-version");
    expect(result.evidence).toContain(".deft/VERSION");
  });

  it("legacy deft/-prefixed install (deft/main.md) is legacy", () => {
    const result = detectLegacyLayout(PROJ, seamsFor({ dirs: ["deft"], files: ["deft/main.md"] }));
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("legacy-deft-prefixed");
  });

  it("legacy deft/ recognized via skills subdir", () => {
    const result = detectLegacyLayout(PROJ, seamsFor({ dirs: ["deft", "deft/skills"] }));
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("legacy-deft-prefixed");
  });

  it("deft/ backed by .git is a clone/submodule", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({ dirs: ["deft"], files: ["deft/main.md", "deft/.git"] }),
    );
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("git-clone-or-submodule");
  });

  it(".gitmodules referencing deftai/directive is a submodule", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({
        files: [".gitmodules"],
        texts: {
          ".gitmodules":
            '[submodule "x"]\n  path = vendor/x\n  url = https://github.com/deftai/directive.git\n',
        },
      }),
    );
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("git-clone-or-submodule");
  });

  it(".gitmodules with a deft path (mirror url) is a submodule", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({
        files: [".gitmodules"],
        texts: {
          ".gitmodules": '[submodule "deft"]\n  path = deft\n  url = git@example.com:me/fork.git\n',
        },
      }),
    );
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("git-clone-or-submodule");
  });

  it("AGENTS.md declaring the deft/ install root is legacy", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({
        texts: { "AGENTS.md": "Deft is installed in deft.\nFull guidelines: deft/main.md\n" },
      }),
    );
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("legacy-deft-prefixed");
  });

  it("pre-v0.27 sentinel-only AGENTS.md (no v2/v3 section) is legacy", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({
        texts: {
          "AGENTS.md":
            "# Project\n<!-- deft:managed-section v1 -->\nold body\n<!-- /deft:managed-section -->\n",
        },
      }),
    );
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("pre-v0.27-sentinel-agents-md");
  });

  it("ignores .gitmodules unrelated to the framework", () => {
    const result = detectLegacyLayout(
      PROJ,
      seamsFor({
        files: [".gitmodules"],
        texts: {
          ".gitmodules":
            '[submodule "libs"]\n  path = libs/foo\n  url = https://github.com/me/foo.git\n',
        },
      }),
    );
    expect(result.legacy).toBe(false);
  });
});

describe("detectLegacyLayout — real filesystem", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function root(): string {
    const d = mkdtempSync(join(tmpdir(), "legacy-detect-"));
    created.push(d);
    return d;
  }

  it("detects an orphan .deft/VERSION on disk with default seams", () => {
    const r = root();
    mkdirSync(join(r, ".deft"), { recursive: true });
    writeFileSync(join(r, ".deft", "VERSION"), "tag: 'v0.26.0'\n", "utf8");
    const result = detectLegacyLayout(r);
    expect(result.legacy).toBe(true);
    expect(result.kind).toBe("orphan-deft-version");
  });

  it("a canonical .deft/core on disk is not legacy with default seams", () => {
    const r = root();
    mkdirSync(join(r, ".deft", "core"), { recursive: true });
    expect(detectLegacyLayout(r).legacy).toBe(false);
  });
});

describe("refusal helpers", () => {
  const detection = {
    legacy: true as const,
    kind: "orphan-deft-version" as const,
    detail: "Found an orphan .deft/VERSION manifest with no .deft/core/ directory.",
    evidence: [".deft/VERSION"],
  };

  it("buildLegacyRefusalMessage signposts the stable URL and carries no version", () => {
    const msg = buildLegacyRefusalMessage("init", detection);
    expect(msg).toContain("refusing to deposit");
    expect(msg).toContain("npx @deftai/directive init");
    expect(msg).toContain("github.com/deftai/directive/blob/master/content/UPGRADING.md");
    expect(msg).toContain("github.com/deftai/directive/releases");
    expect(msg).not.toMatch(/v?\d+\.\d+\.\d+/);
  });

  it("buildLegacyRefusalMessage update variant re-runs the update verb", () => {
    const msg = buildLegacyRefusalMessage("update", detection);
    expect(msg).toContain("refusing to refresh");
    expect(msg).toContain("npx @deftai/directive update");
  });

  it("buildLegacyRefusalJson carries machine fields + stable URLs, no version", () => {
    const json = buildLegacyRefusalJson("init", "/proj", detection);
    expect(json.success).toBe(false);
    expect(json.action).toBe("refuse");
    expect(json.legacy_layout).toBe(true);
    expect(json.legacy_layout_kind).toBe("orphan-deft-version");
    expect(json.error_code).toBe("legacy_layout_refused");
    expect(json.upgrading_doc_url).toContain("UPGRADING.md");
    expect(JSON.stringify(json)).not.toMatch(/v?\d+\.\d+\.\d+/);
  });

  it("legacyLayoutSignpostLine carries the stable URL", () => {
    const line = legacyLayoutSignpostLine(detection);
    expect(line).toContain("Legacy Deft layout detected");
    expect(line).toContain("UPGRADING.md");
    expect(line).not.toMatch(/v?\d+\.\d+\.\d+/);
  });

  it("LegacyLayoutRefusedError exposes the detection and exit code", () => {
    const err = new LegacyLayoutRefusedError(detection);
    expect(err).toBeInstanceOf(Error);
    expect(err.detection.kind).toBe("orphan-deft-version");
    expect(LEGACY_LAYOUT_REFUSED_EXIT_CODE).toBe(2);
  });
});
