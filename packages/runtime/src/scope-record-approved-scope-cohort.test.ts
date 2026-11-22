/**
 * Cohort approved-scope mint (#7083): one typed mint writes a record pair into
 * each story's own worktree; refusals land before the prompt; a failed run
 * removes only its own files.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedWrite, scopeProvenance } from "@deftai/directive-core";
import { startUatLease } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./scope-record-approved-scope.js";
import { parseCohortManifest } from "./scope-record-approved-scope-cohort.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function seams(prompts: { n: number }) {
  return {
    isTty: () => true,
    environ: {},
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => {
      prompts.n += 1;
      return "mint";
    },
  };
}

function briefPayload(id: string, scope: string[]) {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id,
      title: id,
      status: "running",
      items: [
        {
          id: "clause.1",
          title: `${id} works`,
          status: "proposed",
          narrative: { Acceptance: `When ${id} runs, it works.` },
        },
      ],
      metadata: { kind: "story", swarm: { file_scope: scope } },
    },
  };
}

/** A project root holding one worktree directory per story and a manifest. */
function cohort(stories: { id: string; scope?: string[]; raw?: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "cohort-mint-7083-"));
  temps.push(root);
  const rows: { xbrief_path: string; worktree_path: string }[] = [];
  for (const s of stories) {
    const wt = join(root, `wt-${s.id}`);
    const rel = `xbrief/active/${s.id}.xbrief.json`;
    mkdirSync(join(wt, "xbrief", "active"), { recursive: true });
    const text =
      s.raw ?? `${JSON.stringify(briefPayload(s.id, s.scope ?? [`src/${s.id}.ts`]), null, 2)}\n`;
    writeFileSync(join(wt, ...rel.split("/")), text, "utf8");
    rows.push({ xbrief_path: rel, worktree_path: wt });
  }
  const manifest = join(root, "cohort.json");
  writeFileSync(manifest, JSON.stringify(rows), "utf8");
  const argv = ["--manifest", manifest, "--project-root", root, "--actor", "scott", "--confirm"];
  return { root, manifest, argv, wt: (id: string) => join(root, `wt-${id}`) };
}

const pairOf = (wt: string, id: string) => ({
  record: join(wt, ".deft", "approved-scope", `${id}.json`),
  intent: join(wt, ".deft", "approved-scope", `${id}.intent.json`),
});

function capture() {
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
  return { out: () => out.join(""), err: () => err.join("") };
}

describe("scope:record-approved-scope --manifest (#7083)", () => {
  it("prints every story, takes one typed mint and writes each pair into its own worktree", () => {
    const c = cohort([{ id: "story-a" }, { id: "story-b", scope: ["src/b.ts", "docs/b.md"] }]);
    const prompts = { n: 0 };
    const io = capture();
    expect(run(c.argv, seams(prompts))).toBe(0);
    expect(prompts.n).toBe(1);
    const text = io.out();
    for (const s of [
      "story-a",
      "story-b",
      "src/b.ts",
      "docs/b.md",
      "When story-b runs, it works.",
    ]) {
      expect(text).toContain(s);
    }
    expect(text).toMatch(/cohortDigest [0-9a-f]{64}; metadata, not authority/);
    for (const id of ["story-a", "story-b"]) {
      const pair = pairOf(c.wt(id), id);
      expect(existsSync(pair.record)).toBe(true);
      expect(existsSync(pair.intent)).toBe(true);
      const record = JSON.parse(readFileSync(pair.record, "utf8")) as Record<string, unknown>;
      const preimage = JSON.parse(readFileSync(pair.intent, "utf8")) as unknown;
      expect(record.planId).toBe(id);
      expect(record.xbriefRelPath).toBe(`xbrief/active/${id}.xbrief.json`);
      expect(record.intentDigest).toBe(scopeProvenance.computeIntentDigest(preimage));
      expect(text).toContain(String(record.intentDigest));
      expect(typeof record.authHashV1).toBe("string");
      expect((record.humanApproval as Record<string, unknown>).actor).toBe("scott");
    }
    // The other story's pair never lands in this worktree.
    expect(existsSync(pairOf(c.wt("story-a"), "story-b").record)).toBe(false);
  });

  it("leaves an identical pair untouched and does not prompt when nothing is new", () => {
    const c = cohort([{ id: "story-a" }]);
    capture();
    expect(run(c.argv, seams({ n: 0 }))).toBe(0);
    const before = readFileSync(pairOf(c.wt("story-a"), "story-a").record, "utf8");
    const prompts = { n: 0 };
    const io = capture();
    expect(run(c.argv, seams(prompts))).toBe(0);
    expect(prompts.n).toBe(0);
    expect(io.out()).toContain("identical pair present; left untouched");
    expect(readFileSync(pairOf(c.wt("story-a"), "story-a").record, "utf8")).toBe(before);
  });

  it("refuses a differing or half pair before the prompt and writes nothing", () => {
    for (const mode of ["differing", "half"] as const) {
      const c = cohort([{ id: "story-a" }, { id: "story-b" }]);
      const pair = pairOf(c.wt("story-b"), "story-b");
      mkdirSync(join(c.wt("story-b"), ".deft", "approved-scope"), { recursive: true });
      writeFileSync(pair.record, JSON.stringify({ planId: "story-b", fileScopeDigest: "x" }));
      if (mode === "differing") writeFileSync(pair.intent, "{}\n");
      const prompts = { n: 0 };
      const io = capture();
      expect(run(c.argv, seams(prompts))).toBe(1);
      expect(prompts.n).toBe(0);
      expect(io.err()).toContain(mode === "half" ? "half-present" : "exists and differs");
      expect(existsSync(pairOf(c.wt("story-a"), "story-a").record)).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("refuses a glob brief and a duplicate-key brief before the prompt", () => {
    const dup =
      '{"xBRIEFInfo":{"version":"0.8"},"plan":{"id":"story-d","id":"story-e",' +
      '"metadata":{"swarm":{"file_scope":["src/d.ts"]}}}}\n';
    for (const stories of [
      [{ id: "story-a" }, { id: "story-g", scope: ["src/**/*.ts"] }],
      [{ id: "story-a" }, { id: "story-d", raw: dup }],
    ]) {
      const c = cohort(stories);
      const prompts = { n: 0 };
      const io = capture();
      expect(run(c.argv, seams(prompts))).toBe(1);
      expect(prompts.n).toBe(0);
      expect(io.err()).toMatch(/glob entries|duplicate/i);
      expect(existsSync(pairOf(c.wt("story-a"), "story-a").record)).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("removes only its own files after a failure following the first file of a pair", () => {
    const c = cohort([{ id: "story-a" }, { id: "story-b" }]);
    const b = pairOf(c.wt("story-b"), "story-b");
    capture();
    const code = run(
      c.argv,
      seams({ n: 0 }),
      {},
      {
        write: (root, target, data) => {
          if (target === b.record) throw new Error("disk full");
          containedWrite({ root, target, data, mode: "create" });
        },
      },
    );
    expect(code).toBe(1);
    for (const p of [...Object.values(pairOf(c.wt("story-a"), "story-a")), b.intent, b.record]) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it("keeps a concurrently created file and removes only its own", () => {
    const c = cohort([{ id: "story-a" }, { id: "story-b" }]);
    const b = pairOf(c.wt("story-b"), "story-b");
    capture();
    const code = run(
      c.argv,
      seams({ n: 0 }),
      {},
      {
        write: (root, target, data) => {
          if (target === b.intent) {
            // Someone else creates the file between the check and our exclusive create.
            mkdirSync(join(c.wt("story-b"), ".deft", "approved-scope"), { recursive: true });
            writeFileSync(b.intent, "foreign\n");
          }
          containedWrite({ root, target, data, mode: "create" });
        },
      },
    );
    expect(code).toBe(1);
    expect(readFileSync(b.intent, "utf8")).toBe("foreign\n");
    expect(existsSync(b.record)).toBe(false);
    for (const p of Object.values(pairOf(c.wt("story-a"), "story-a"))) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it("removes its own partial file when a write fails after the create", () => {
    const c = cohort([{ id: "story-a" }, { id: "story-b" }]);
    const b = pairOf(c.wt("story-b"), "story-b");
    capture();
    const code = run(
      c.argv,
      seams({ n: 0 }),
      {},
      {
        write: (root, target, data) => {
          if (target === b.intent) {
            containedWrite({ root, target, data: "{", mode: "create" });
            throw new Error("write interrupted");
          }
          containedWrite({ root, target, data, mode: "create" });
        },
      },
    );
    expect(code).toBe(1);
    for (const p of [...Object.values(pairOf(c.wt("story-a"), "story-a")), b.intent, b.record]) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it("refuses when a target worktree holds an active UAT lease", () => {
    const c = cohort([{ id: "story-a" }, { id: "story-b" }]);
    startUatLease({ projectRoot: c.wt("story-b"), campaignId: "uat-7083", actor: "op" });
    const prompts = { n: 0 };
    capture();
    expect(run(c.argv, seams(prompts))).not.toBe(0);
    expect(prompts.n).toBe(0);
    expect(existsSync(pairOf(c.wt("story-a"), "story-a").record)).toBe(false);
  });

  it("keeps the human-presence gate: a non-TTY run writes nothing", () => {
    const c = cohort([{ id: "story-a" }]);
    capture();
    expect(run(c.argv, { ...seams({ n: 0 }), isTty: () => false })).toBe(2);
    expect(existsSync(pairOf(c.wt("story-a"), "story-a").record)).toBe(false);
  });

  it("keeps --add-path single-brief and validates the manifest shape", () => {
    expect(parseArgs(["--manifest", "m.json", "--actor", "s", "--add-path", "x"]).error).toMatch(
      /single-brief/,
    );
    expect(parseArgs(["b.json", "--manifest", "m.json", "--actor", "s"]).error).toMatch(
      /no xBRIEF path/,
    );
    expect(parseArgs(["--manifest", "m.json", "--actor", "s"]).error).toBeUndefined();
    expect(parseCohortManifest("[]").ok).toBe(false);
    expect(parseCohortManifest('[{"xbrief_path":"a"}]').ok).toBe(false);
    expect(parseCohortManifest('[{"xbrief_path":"a","worktree_path":"w"}]').ok).toBe(true);
  });
});
