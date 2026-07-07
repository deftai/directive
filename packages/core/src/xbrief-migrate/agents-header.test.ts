import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectStaleUnmanagedHeader,
  patchAgentsMdHeader,
  renderHeaderPatchSummary,
  renderStaleHeaderLine,
  rewriteUnmanagedHeaderTokens,
} from "./agents-header.js";
import { MIGRATED_ARTIFACT_DIR } from "./constants.js";

const MANAGED_BLOCK = [
  "<!-- deft:managed-section v3 sha=abc123 refreshed=2026-07-02T00:00:00Z session=deadbeef -->",
  "# Deft — AI Development Framework",
  "Managed body deliberately mentions vbrief/active/x.xbrief.json and vbrief:preflight.",
  "<!-- /deft:managed-section -->",
].join("\n");

const STALE_HEADER = [
  "# Cartograph",
  "",
  "## Session orientation",
  "Scoped work items live in `vbrief/`.",
  "",
  "## Local dev",
  "Run the `test-single.vbrief.json` fixture.",
  "",
  "## Lifecycle",
  "- `task scope:promote -- vbrief/proposed/foo.vbrief.json`",
  "- `task vbrief:preflight -- vbrief/active/foo.vbrief.json`",
  "",
  MANAGED_BLOCK,
  "",
  "## Notes",
  "Archive lives under vbrief/completed/.",
  "",
].join("\n");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("rewriteUnmanagedHeaderTokens", () => {
  it("rewrites legacy tokens in the unmanaged header and preserves the managed section verbatim", () => {
    const result = rewriteUnmanagedHeaderTokens(STALE_HEADER);
    expect(result.changed).toBe(true);

    // Unmanaged header now references xbrief.
    expect(result.content).toContain("Scoped work items live in `xbrief/`.");
    expect(result.content).toContain("`test-single.xbrief.json`");
    expect(result.content).toContain("scope:promote -- xbrief/proposed/foo.xbrief.json");
    expect(result.content).toContain("xbrief:preflight -- xbrief/active/foo.xbrief.json");
    expect(result.content).toContain("Archive lives under xbrief/completed/.");

    // Managed block is byte-for-byte intact — its legacy tokens survive.
    expect(result.content).toContain(MANAGED_BLOCK);
    expect(result.content).toContain(
      "Managed body deliberately mentions vbrief/active/x.xbrief.json and vbrief:preflight.",
    );
  });

  it("reports per-token replacement counts", () => {
    const result = rewriteUnmanagedHeaderTokens(STALE_HEADER);
    const byToken = new Map(result.replacements.map((r) => [r.legacy, r.count]));
    // vbrief/ appears in header lines: scoped/, proposed/, active/, completed/ (4).
    expect(byToken.get("vbrief/")).toBe(4);
    // .vbrief.json appears in test-single, proposed/foo, active/foo (3).
    expect(byToken.get(".vbrief.json")).toBe(3);
    expect(byToken.get("vbrief:preflight")).toBe(1);
  });

  it("is idempotent — a second pass is a no-op", () => {
    const first = rewriteUnmanagedHeaderTokens(STALE_HEADER);
    const second = rewriteUnmanagedHeaderTokens(first.content);
    expect(second.changed).toBe(false);
    expect(second.replacements).toHaveLength(0);
    expect(second.content).toBe(first.content);
  });

  it("rewrites the whole document when there is no managed section", () => {
    const plain = "See vbrief/active/story.xbrief.json and run vbrief:preflight.\n";
    const result = rewriteUnmanagedHeaderTokens(plain);
    expect(result.content).toBe("See xbrief/active/story.xbrief.json and run xbrief:preflight.\n");
    expect(result.changed).toBe(true);
  });

  it("preserves CRLF line endings and leaves clean content unchanged", () => {
    const crlf = "line one on xbrief/\r\nline two\r\n";
    const result = rewriteUnmanagedHeaderTokens(crlf);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(crlf);
  });
});

describe("patchAgentsMdHeader", () => {
  it("patches an on-disk AGENTS.md and reports patched", () => {
    const root = mkdtempSync(join(tmpdir(), "header-patch-"));
    temps.push(root);
    writeFileSync(join(root, "AGENTS.md"), STALE_HEADER, "utf8");

    const outcome = patchAgentsMdHeader(root);
    expect(outcome.kind).toBe("patched");
    const written = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(written).toContain("Scoped work items live in `xbrief/`.");
    expect(written).toContain(MANAGED_BLOCK);
  });

  it("returns clean when the header has no legacy tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "header-clean-"));
    temps.push(root);
    writeFileSync(join(root, "AGENTS.md"), "# Clean\nAll xbrief/ here.\n", "utf8");
    const outcome = patchAgentsMdHeader(root);
    expect(outcome.kind).toBe("clean");
    expect(outcome.replacements).toHaveLength(0);
  });

  it("returns absent when AGENTS.md does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "header-absent-"));
    temps.push(root);
    const outcome = patchAgentsMdHeader(root);
    expect(outcome.kind).toBe("absent");
  });

  it("honours read/write seams without touching disk", () => {
    let written: string | null = null;
    const outcome = patchAgentsMdHeader("/nowhere", {
      readText: () => "run vbrief:preflight -- vbrief/active/x.xbrief.json\n",
      writeText: (_path, text) => {
        written = text;
      },
    });
    expect(outcome.kind).toBe("patched");
    expect(written).toBe("run xbrief:preflight -- xbrief/active/x.xbrief.json\n");
  });

  it("captures a write failure as a non-fatal `failed` outcome instead of throwing", () => {
    const outcome = patchAgentsMdHeader("/nowhere", {
      readText: () => "run vbrief:preflight -- vbrief/active/x.xbrief.json\n",
      writeText: () => {
        throw new Error("EACCES: read-only AGENTS.md");
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.error).toContain("EACCES");
    expect(renderHeaderPatchSummary(outcome)).toContain("patch failed");
    expect(renderHeaderPatchSummary(outcome)).toContain("migrate:xbrief");
  });
});

describe("renderHeaderPatchSummary", () => {
  it("summarises a patched outcome with per-token detail", () => {
    const outcome = patchAgentsMdHeader("/nowhere", {
      readText: () => STALE_HEADER,
      writeText: () => {},
    });
    const summary = renderHeaderPatchSummary(outcome);
    expect(summary).toContain("rewrote 8 legacy vbrief token(s)");
    expect(summary).toContain("vbrief/ ×4");
    expect(summary).toContain("vbrief:preflight ×1");
  });

  it("summarises clean and absent outcomes", () => {
    expect(
      renderHeaderPatchSummary({ kind: "clean", path: "AGENTS.md", replacements: [] }),
    ).toContain("no legacy vbrief tokens found");
    expect(
      renderHeaderPatchSummary({ kind: "absent", path: "AGENTS.md", replacements: [] }),
    ).toContain("no AGENTS.md present");
  });
});

describe("detectStaleUnmanagedHeader", () => {
  function scaffold(withXbrief: boolean, agents: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "header-detect-"));
    temps.push(root);
    if (withXbrief) {
      mkdirSync(join(root, MIGRATED_ARTIFACT_DIR, "active"), { recursive: true });
    }
    if (agents !== null) {
      writeFileSync(join(root, "AGENTS.md"), agents, "utf8");
    }
    return root;
  }

  it("flags xbrief tree + stale unmanaged header", () => {
    const root = scaffold(true, STALE_HEADER);
    const detection = detectStaleUnmanagedHeader(root);
    expect(detection.stale).toBe(true);
    expect(detection.matches).toContain("vbrief/");
    expect(detection.matches).toContain("vbrief:preflight");
  });

  it("does NOT flag legacy tokens that live only in the managed section", () => {
    const managedOnly = ["# Clean header on xbrief/", "", MANAGED_BLOCK, ""].join("\n");
    const root = scaffold(true, managedOnly);
    expect(detectStaleUnmanagedHeader(root).stale).toBe(false);
  });

  it("does NOT flag when there is no xbrief tree yet", () => {
    const root = scaffold(false, STALE_HEADER);
    expect(detectStaleUnmanagedHeader(root).stale).toBe(false);
  });

  it("does NOT flag when AGENTS.md is absent", () => {
    const root = scaffold(true, null);
    expect(detectStaleUnmanagedHeader(root).stale).toBe(false);
  });
});

describe("renderStaleHeaderLine", () => {
  it("returns a clean line when no drift is present", () => {
    const root = mkdtempSync(join(tmpdir(), "header-line-clean-"));
    temps.push(root);
    mkdirSync(join(root, MIGRATED_ARTIFACT_DIR), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Clean xbrief/ header\n", "utf8");
    expect(renderStaleHeaderLine(root)).toContain("AGENTS.md header drift: none");
  });

  it("signposts the drift with remediation guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "header-line-stale-"));
    temps.push(root);
    mkdirSync(join(root, MIGRATED_ARTIFACT_DIR), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), STALE_HEADER, "utf8");
    const line = renderStaleHeaderLine(root);
    expect(line).toContain("still");
    expect(line).toContain("migrate:xbrief");
    expect(line).toContain("xbrief/");
  });

  it("accepts an injected readText seam (no disk I/O for the AGENTS.md read)", () => {
    const root = mkdtempSync(join(tmpdir(), "header-line-seam-"));
    temps.push(root);
    mkdirSync(join(root, MIGRATED_ARTIFACT_DIR), { recursive: true });
    // No AGENTS.md on disk — the seam supplies a stale header in memory.
    const line = renderStaleHeaderLine(
      root,
      () => "run vbrief:preflight -- vbrief/active/x.xbrief.json\n",
    );
    expect(line).toContain("migrate:xbrief");
    expect(line).toContain("vbrief:preflight");
  });
});
