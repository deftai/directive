import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlanSequence } from "../plan-sequence/types.js";
import {
  classifyPlanningPublicationSet,
  listStagedIndexEntries,
  parseStagedRawZ,
  planningPublicationPathRole,
  readStagedBlob,
  type StagedIndexEntry,
  stagedRelPathsFromEntries,
} from "./planning-publication.js";

const BLOB = "1".repeat(40);
const ZERO = "0".repeat(40);

function added(path: string, mode = "100644", blob = BLOB): StagedIndexEntry {
  return { path, kind: "A", mode, blob };
}

function deleted(path: string): StagedIndexEntry {
  return { path, kind: "D", mode: "000000", blob: ZERO };
}

function closedPlan(extra: Record<string, unknown> = {}): string {
  const plan = createPlanSequence({
    sequence_id: "phase-c",
    sequence_kind: "delivery",
    entries: [{ id: "c1", kind: "story", issue: 5839 }],
    authorized_by: "operator",
  });
  return JSON.stringify({ ...plan, ...extra });
}

const noRead = (): string | null => {
  throw new Error("no blob read expected");
};

describe("planningPublicationPathRole (#5839 clause 2)", () => {
  it.each([
    ["CHANGELOG.md", "inventory"],
    [".deft/plan-sequence.json", "inventory"],
    ["docs/design/c1.md", "inventory"],
    ["docs/decisions/c1.md", "inventory"],
    ["xbrief/proposed/c1.xbrief.json", "neutral"],
    ["xbrief/pending/c1.xbrief.json", "neutral"],
    ["xbrief/completed/c1.xbrief.json", "neutral"],
    ["xbrief/cancelled/c1.xbrief.json", "neutral"],
    ["vbrief/proposed/c1.vbrief.json", "neutral"],
    ["xbrief/decisions/2026-10-22-c1.decision.json", "neutral"],
    ["vbrief/decisions/c1.decision.json", "neutral"],
  ])("%s is %s", (path, role) => {
    expect(planningPublicationPathRole(path)).toBe(role);
  });

  it.each([
    "xbrief/active/c1.xbrief.json",
    "xbrief/active/.gitkeep",
    "xbrief/proposed/extra.json",
    "xbrief/proposed/README.md",
    "xbrief/proposed/sub/c1.xbrief.json",
    "xbrief/decisions/helper.ts",
    "xbrief/decisions/c1.md",
    "xbrief/plan.xbrief.json",
    "xbrief/PROJECT-DEFINITION.xbrief.json",
    "docs/design/sub/c1.md",
    "docs/design/.md",
    "docs/design/c1.yaml",
    "docs/decisions/c1.json",
    "docs/notes.md",
    "docs/requirements/c.md",
    "REQUIREMENTS.md",
    "src/a.ts",
    " CHANGELOG.md",
    "CHANGELOG.md\r",
    "docs/design/c1.md\r",
    "docs\\design\\c1.md",
    "docs/design/a\\b.md",
    "xbrief/proposed/a\\b.xbrief.json",
    "./docs/design/c1.md",
  ])("%j disqualifies the set", (path) => {
    expect(planningPublicationPathRole(path)).toBeNull();
  });
});

describe("classifyPlanningPublicationSet (#5839 clauses 2-3)", () => {
  it("admits the filed 15-file package without reading any blob", () => {
    const entries: StagedIndexEntry[] = [];
    for (let i = 1; i <= 5; i++) {
      entries.push(added(`docs/design/c${String(i)}.md`));
      entries.push(added(`xbrief/proposed/c${String(i)}.xbrief.json`));
      entries.push(added(`xbrief/decisions/2026-10-22-c${String(i)}.decision.json`));
    }
    const read = vi.fn(noRead);
    const verdict = classifyPlanningPublicationSet(entries, read);
    expect(verdict.admitted).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an empty set and any disqualifying path", () => {
    expect(classifyPlanningPublicationSet([], noRead).admitted).toBe(false);
    const verdict = classifyPlanningPublicationSet(
      [added("docs/design/c1.md"), added("xbrief/decisions/helper.ts")],
      noRead,
    );
    expect(verdict).toMatchObject({ admitted: false });
    if (!verdict.admitted) expect(verdict.reason).toContain("helper.ts");
  });

  it("admits only mode 100644 for added or modified entries", () => {
    for (const mode of ["100755", "120000", "160000"]) {
      const verdict = classifyPlanningPublicationSet([added("docs/design/c1.md", mode)], noRead);
      expect(verdict.admitted, mode).toBe(false);
    }
    expect(
      classifyPlanningPublicationSet(
        [{ path: "CHANGELOG.md", kind: "M", mode: "100644", blob: BLOB }],
        noRead,
      ).admitted,
    ).toBe(true);
  });

  it("refuses change kinds other than A, M and D", () => {
    for (const kind of ["T", "C", "R", "U", "X"]) {
      const verdict = classifyPlanningPublicationSet(
        [{ path: "docs/design/c1.md", kind, mode: "100644", blob: BLOB }],
        noRead,
      );
      expect(verdict.admitted, kind).toBe(false);
    }
  });

  it("admits deletions of inventory and record paths without a content read", () => {
    const verdict = classifyPlanningPublicationSet(
      [
        deleted("docs/design/old.md"),
        deleted(".deft/plan-sequence.json"),
        deleted("xbrief/proposed/c1.xbrief.json"),
      ],
      noRead,
    );
    expect(verdict.admitted).toBe(true);
  });

  it("refuses a deletion of a disqualifying path", () => {
    expect(
      classifyPlanningPublicationSet([deleted("docs/design/old.md"), deleted("src/a.ts")], noRead)
        .admitted,
    ).toBe(false);
  });

  it("checks the plan-sequence index blob with isClosedPlanSequenceShape", () => {
    const entries = [added(".deft/plan-sequence.json", "100644", "abc")];
    const read = vi.fn((blob: string) => (blob === "abc" ? closedPlan() : null));
    expect(classifyPlanningPublicationSet(entries, read).admitted).toBe(true);
    expect(read).toHaveBeenCalledWith("abc");

    expect(classifyPlanningPublicationSet(entries, () => "{not json").admitted).toBe(false);
    expect(classifyPlanningPublicationSet(entries, () => null).admitted).toBe(false);
    expect(
      classifyPlanningPublicationSet(entries, () => closedPlan({ extra_authority: true })).admitted,
    ).toBe(false);
  });

  it("admits an approved insert: a plan-sequence with insert_approvals rows (#6205 seam)", () => {
    const row = { entry_id: "c1", grant_id: "g-1", approved_at: "2026-11-16T00:00:00Z" };
    const entries = [added(".deft/plan-sequence.json")];
    expect(
      classifyPlanningPublicationSet(entries, () => closedPlan({ insert_approvals: [row] }))
        .admitted,
    ).toBe(true);
    expect(
      classifyPlanningPublicationSet(entries, () =>
        closedPlan({ insert_approvals: [{ ...row, forged: true }] }),
      ).admitted,
    ).toBe(false);
  });
});

describe("parseStagedRawZ (#5839 clause 3)", () => {
  it("parses NUL-delimited raw records and keeps paths unmodified", () => {
    const out =
      `:000000 100644 ${ZERO} ${BLOB} A\0 CHANGELOG.md\0` +
      `:100644 000000 ${BLOB} ${ZERO} D\0docs/design/old.md\0`;
    expect(parseStagedRawZ(out)).toEqual([
      { path: " CHANGELOG.md", kind: "A", mode: "100644", blob: BLOB },
      { path: "docs/design/old.md", kind: "D", mode: "000000", blob: ZERO },
    ]);
    expect(parseStagedRawZ("")).toEqual([]);
  });

  it("returns null on malformed records", () => {
    expect(parseStagedRawZ("docs/design/x.md\0")).toBeNull();
    expect(parseStagedRawZ(`:100644 100644 ${BLOB} M\0x.md\0`)).toBeNull();
    expect(parseStagedRawZ(`:100644 100644 ${BLOB} ${BLOB} M\0`)).toBeNull();
    expect(parseStagedRawZ(`:100644 100644 ${BLOB} ${BLOB} \0x.md\0`)).toBeNull();
  });

  it("stagedRelPathsFromEntries normalizes like the earlier --name-only producer", () => {
    expect(
      stagedRelPathsFromEntries([
        added(" CHANGELOG.md"),
        added("docs/design/x.md\r"),
        added("   "),
      ]),
    ).toEqual(["CHANGELOG.md", "docs/design/x.md"]);
  });
});

describe("listStagedIndexEntries / readStagedBlob on a real index (#5839)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function git(root: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: "pipe" });
  }

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-5839-index-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "core.hooksPath", "/dev/null"]);
    return root;
  }

  function put(root: string, rel: string, text: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }

  it("lists kind, mode and blob, keeps raw paths and reads the index blob", () => {
    const root = repo();
    put(root, "docs/design/old.md", "old\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "seed"]);
    put(root, "docs/design/c1.md", "staged\n");
    git(root, ["add", "docs/design/c1.md"]);
    put(root, "docs/design/c1.md", "edited after staging\n");
    git(root, ["rm", "-q", "docs/design/old.md"]);
    const lead = git(root, ["hash-object", "-w", join(root, "docs/design/c1.md")]).trim();
    git(root, ["update-index", "--add", "--cacheinfo", `100644,${lead}, CHANGELOG.md`]);

    const listed = listStagedIndexEntries(root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const byPath = new Map(listed.entries.map((e) => [e.path, e]));
    expect(byPath.get(" CHANGELOG.md")).toMatchObject({ kind: "A", mode: "100644" });
    expect(byPath.get("docs/design/old.md")).toMatchObject({ kind: "D", mode: "000000" });
    const c1 = byPath.get("docs/design/c1.md");
    expect(c1).toMatchObject({ kind: "A", mode: "100644" });
    expect(readStagedBlob(root, (c1 as StagedIndexEntry).blob)).toBe("staged\n");
    expect(readStagedBlob(root, "f".repeat(40))).toBeNull();
  });

  it("reads a staged blob larger than 1 MiB (#6602)", () => {
    const root = repo();
    const entries = Array.from({ length: 30000 }, (_unused, i) => ({
      id: `story-${String(i)}-with-a-long-padding-name`,
    }));
    const text = JSON.stringify({ version: 1, entries });
    expect(text.length).toBeGreaterThan(1024 * 1024);
    put(root, ".deft/plan-sequence.json", text);
    git(root, ["add", ".deft/plan-sequence.json"]);
    const blob = git(root, ["rev-parse", ":.deft/plan-sequence.json"]).trim();
    expect(readStagedBlob(root, blob)).toBe(text);
  });

  it("returns a Result, not a throw, outside a git repository", () => {
    const listed = listStagedIndexEntries(join(tmpdir(), "deft-5839-missing-root"));
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.message.length).toBeGreaterThan(0);
    const plain = mkdtempSync(join(tmpdir(), "deft-5839-plain-"));
    roots.push(plain);
    const notRepo = listStagedIndexEntries(plain);
    expect(notRepo.ok).toBe(false);
    if (!notRepo.ok) expect(notRepo.message).toMatch(/git diff --cached --raw failed/);
  });
});
