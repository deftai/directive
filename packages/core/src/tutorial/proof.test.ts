/**
 * Proof coverage for the Directive Tutorial (#4981).
 * Progress lives in preferences; practice work uses a disposable repo.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleMain } from "../scope/main.js";
import { formatBriefJson } from "../scope/vbrief-json.js";
import { type TutorialIo, tutorialMain } from "./cli.js";
import { loadTutorial, projectFields, renderWiredSession } from "./render.js";

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

function run(
  projectRoot: string,
  prefsHome: string,
  argv: readonly string[],
): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: TutorialIo = {
    writeOut: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  };
  const code = tutorialMain(
    [
      ...argv,
      "--project-root",
      projectRoot,
      "--framework-root",
      frameworkRoot,
      "--prefs-home",
      prefsHome,
    ],
    io,
  );
  return { code, out, err };
}

describe("Directive Tutorial proof (#4981)", () => {
  it("covers offer, skip, each menu project render, resume, retry, reset, and complete", () => {
    const { glossary, script, projects } = loadTutorial(frameworkRoot);
    for (const id of ["signal", "postcard", "echo"] as const) {
      const messages = renderWiredSession(script, glossary, projectFields(projects, id));
      expect(messages).toHaveLength(7);
      expect(messages[0]).toContain("Welcome to the Directive Tutorial!");
      expect(messages.join("\n")).toContain(projects.get(id)?.fields.name ?? id);
    }

    const projectRoot = tempDir("deft-tutorial-proof-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");

    expect(run(projectRoot, prefs, ["offer", "--json"]).out).toContain('"offerNow": true');
    expect(run(projectRoot, prefs, ["skip", "--json"]).out).toContain('"status": "skipped"');
    expect(run(projectRoot, prefs, ["offer", "--json"]).out).toContain('"offerNow": false');

    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "echo"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "echo"]).code).toBe(0);
    const resumed = run(projectRoot, prefs, ["resume", "--json"]);
    expect(JSON.parse(resumed.out).state.currentBeat).toBe("write");

    expect(run(projectRoot, prefs, ["advance", "--content", "Q: Hi? A: Hello."]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/echo.xbrief.json",
      ]).code,
    ).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--check", "fail"]).code).toBe(0);
    expect(JSON.parse(run(projectRoot, prefs, ["inspect", "--json"]).out).state.currentBeat).toBe(
      "result",
    );
    expect(run(projectRoot, prefs, ["advance", "--check", "pass"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "continue"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--complete"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance"]).code).toBe(0);
    expect(JSON.parse(run(projectRoot, prefs, ["inspect", "--json"]).out).state.status).toBe(
      "completed",
    );

    expect(run(projectRoot, prefs, ["reset", "--json"]).out).toContain('"currentBeat": null');
    expect(run(projectRoot, prefs, ["offer", "--json"]).out).toContain('"offerNow": false');
  });

  it("practice close stamps acceptance evidence then completes with non-delivery", () => {
    const root = tempDir("deft-tutorial-close-");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "signal"), { recursive: true });
    writeFileSync(join(root, "signal", "signal.mjs"), "console.log('ok');\n", "utf8");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "signal-practice", scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
      "utf8",
    );
    const active = join(root, "xbrief", "active", "signal.xbrief.json");
    writeFileSync(
      active,
      formatBriefJson({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "signal-practice",
          title: "Signal practice",
          status: "running",
          items: [{ id: "clause.1", title: "clause.1", status: "pending" }],
          acceptance: {
            commands: ["npm test"],
            none_stated: false,
            source_rung: "derived",
            ambiguity_attestation: "none_found",
            clauses: [
              {
                id: 1,
                text: "unit covers signal/signal.mjs",
                artifact_path: "signal/signal.mjs",
                ambiguous: false,
              },
            ],
          },
          metadata: {
            swarm: {
              file_scope: ["signal/**"],
              verify_commands: ["npm test"],
            },
          },
        },
      }),
      "utf8",
    );

    const out: string[] = [];
    const err: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    try {
      expect(lifecycleMain(["stamp-evidence", active, "--project-root", root])).toBe(0);
      const completeCode = lifecycleMain([
        "complete",
        active,
        "--project-root",
        root,
        "--non-delivery",
        "experiment_archived",
      ]);
      expect(completeCode, err.join("") || out.join("")).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const completed = join(root, "xbrief", "completed", "signal.xbrief.json");
    expect(existsSync(completed)).toBe(true);
    const parsed = JSON.parse(readFileSync(completed, "utf8")) as {
      plan: { items: Array<Record<string, unknown>>; status: string };
    };
    expect(parsed.plan.status).toBe("completed");
    expect(parsed.plan.items[0]?.["x-directive/evidence"]).toMatchObject({
      kind: "test",
      pointer: "signal/signal.mjs",
    });
    expect(out.join("")).toMatch(/stamp-evidence|Completed/i);
  });
});
