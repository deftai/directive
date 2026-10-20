import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-operator-scope-limit.js";

describe("verify-operator-scope-limit CLI (#4545)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseArgs requires prompt input and rejects unknown flags", () => {
    expect(parseArgs(["--quiet"]).prompt).toBeUndefined();
    expect(parseArgs(["--prompt", "do not add extras"]).prompt).toBe("do not add extras");
    expect(parseArgs(["--bogus"]).error).toMatch(/unrecognized/);
  });

  it("run exits 2 without a prompt and 0 when ceiling seeds cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "osl-cli-"));
    expect(run([])).toBe(2);
    expect(
      run(["--prompt", "add vehicle\n\ninitial version only", "--quiet", "--project-root", root]),
    ).toBe(0);
  });

  it("persists a durable ceiling artifact by default without output flags", () => {
    const root = mkdtempSync(join(tmpdir(), "osl-cli-durable-"));
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    expect(
      run([
        "--prompt",
        "add vehicle\n\nDo not add features beyond the requirements.",
        "--project-root",
        root,
      ]),
    ).toBe(0);
    const artifact = join(root, ".deft", "operator-scope-ceiling.json");
    expect(existsSync(artifact)).toBe(true);
    const body = JSON.parse(readFileSync(artifact, "utf8")) as {
      matchedPhrase: string;
      requirementLines: string[];
    };
    expect(body.matchedPhrase).toContain("do not add");
    expect(body.requirementLines).toContain("add vehicle");
    expect(stdout.join("")).toMatch(/surfaces were not checked/);
  });

  it("merges ceiling into an existing brief-out instead of replacing scope", () => {
    const root = mkdtempSync(join(tmpdir(), "osl-cli-merge-"));
    const briefPath = join(root, "proposed", "story.xbrief.json");
    mkdirSync(join(root, "proposed"), { recursive: true });
    writeFileSync(
      briefPath,
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "keep this title",
            status: "running",
            items: [{ id: "clause.1", title: "keep item", status: "pending" }],
            narratives: { Overview: "keep overview" },
            metadata: { keep: true },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(
      run([
        "--prompt",
        "add vehicle\n\ninitial version only",
        "--brief-out",
        briefPath,
        "--project-root",
        root,
        "--quiet",
      ]),
    ).toBe(0);

    const next = JSON.parse(readFileSync(briefPath, "utf8")) as {
      plan: {
        title: string;
        status: string;
        items: unknown[];
        narratives: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
    };
    expect(next.plan.title).toBe("keep this title");
    expect(next.plan.status).toBe("running");
    expect(next.plan.items).toHaveLength(1);
    expect(next.plan.narratives.Overview).toBe("keep overview");
    expect(next.plan.metadata.keep).toBe(true);
    expect(next.plan.metadata["x-directive/operatorScopeCeiling"]).toBeDefined();
  });

  it("runs default inventory and warns on untraceable surfaces", () => {
    const root = mkdtempSync(join(tmpdir(), "osl-cli-inv-"));
    const actionsDir = join(root, "app", "actions");
    mkdirSync(actionsDir, { recursive: true });
    writeFileSync(
      join(actionsDir, "actions.ts"),
      [
        "export async function addVehicleAction() {}",
        "export async function deleteVehicleAction() {}",
      ].join("\n"),
      "utf8",
    );
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    expect(run(["--prompt", "add vehicle\n\ninitial version only", "--project-root", root])).toBe(
      0,
    );
    const text = stdout.join("");
    expect(text).toMatch(/deleteVehicleAction/);
    expect(text).toMatch(/remove, or add to the brief and get operator approval/);
  });
});
