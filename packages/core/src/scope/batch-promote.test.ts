import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { batchPromote } from "./batch-promote.js";
import { lifecycleMain } from "./main.js";
import { checkWipCapForAdditional } from "./wip-cap-check.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "batch-promote-"));
  roots.push(root);
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "test", created: "2026-07-31T00:00:00Z" },
      plan: { title: "PROJECT-DEFINITION", status: "running", policy: { wipCap: 20 }, items: [] },
    }),
    "utf8",
  );
  return root;
}

function writeProposed(root: string, name: string, title = name): string {
  const path = join(root, "xbrief", "proposed", name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: title, created: "2026-07-31T00:00:00Z" },
      plan: { title, status: "proposed", items: [] },
    }),
    "utf8",
  );
  return path;
}

afterEach(() => {
  // temp dirs cleaned by OS; keep list short for local runs
  roots.length = 0;
});

describe("batchPromote (#3011)", () => {
  it("promotes all proposed/ scopes when --batch has no paths", () => {
    const root = freshRoot();
    writeProposed(root, "2026-07-31-a.xbrief.json", "A");
    writeProposed(root, "2026-07-31-b.xbrief.json", "B");
    const result = batchPromote({ projectRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.promoted).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(lifecycleMain(["promote", "--batch", "--project-root", root])).toBe(0);
  });

  it("promotes only explicit paths when listed", () => {
    const root = freshRoot();
    const a = writeProposed(root, "2026-07-31-a.xbrief.json", "A");
    writeProposed(root, "2026-07-31-b.xbrief.json", "B");
    const result = batchPromote({ projectRoot: root, files: [a] });
    expect(result.promoted).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("returns empty success when proposed/ is empty", () => {
    const root = freshRoot();
    const result = batchPromote({ projectRoot: root });
    expect(result.promoted).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  it("refuses batch when WIP would exceed cap unless --force", () => {
    const root = freshRoot();
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "test", created: "2026-07-31T00:00:00Z" },
        plan: { title: "PROJECT-DEFINITION", status: "running", policy: { wipCap: 2 }, items: [] },
      }),
      "utf8",
    );
    // Fill WIP with two pending scopes
    for (const name of ["p1", "p2"]) {
      writeFileSync(
        join(root, "xbrief", "pending", `${name}.xbrief.json`),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8", description: name },
          plan: { title: name, status: "pending", items: [] },
        }),
        "utf8",
      );
    }
    writeProposed(root, "2026-07-31-c.xbrief.json", "C");
    writeProposed(root, "2026-07-31-d.xbrief.json", "D");
    const refused = batchPromote({ projectRoot: root });
    expect(refused.exitCode).toBe(1);
    expect(refused.promoted).toBe(0);
    expect(refused.messages.some((m) => m.includes("WIP cap"))).toBe(true);

    const forced = batchPromote({ projectRoot: root, force: true });
    expect(forced.promoted).toBe(2);
    expect(forced.wipCapOverride).toBe(true);
  });

  it("checkWipCapForAdditional matches single-promote and batch math", () => {
    const root = freshRoot();
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "test" },
        plan: { title: "PROJECT-DEFINITION", status: "running", policy: { wipCap: 3 }, items: [] },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "pending", "one.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "one", status: "pending", items: [] },
      }),
      "utf8",
    );
    // count=1, cap=3, add=2 → allowed (1+2=3)
    expect(checkWipCapForAdditional(root, 2, false).allowed).toBe(true);
    // add=3 → 1+3=4 > 3 refuse
    expect(checkWipCapForAdditional(root, 3, false).allowed).toBe(false);
    expect(checkWipCapForAdditional(root, 3, true).forceOverride).toBe(true);
  });

  it("lifecycleMain promote --batch wires through CLI", () => {
    const root = freshRoot();
    writeProposed(root, "2026-07-31-cli.xbrief.json", "CLI");
    expect(lifecycleMain(["promote", "--batch", "--project-root", root])).toBe(0);
    expect(lifecycleMain(["promote", "--batch", "--project-root", root])).toBe(0); // empty second run
  });
});
