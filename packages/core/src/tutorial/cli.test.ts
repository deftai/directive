import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type TutorialIo, tutorialMain } from "./cli.js";
import { shellQuotePath } from "./render.js";

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

describe("deft tutorial commands (#4981)", () => {
  it("prints the scripted step and does not offer again after skip", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    const skipped = run(projectRoot, prefs, ["skip", "--json"]);
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain('"status": "skipped"');
    expect(run(projectRoot, prefs, ["offer", "--json"]).out).toContain('"offerNow": false');

    const started = run(projectRoot, prefs, [
      "start",
      "--repo",
      repo,
      "--project",
      "signal",
      "--json",
    ]);
    expect(started.code).toBe(0);
    const body = JSON.parse(started.out) as {
      beatText: string;
      state: { repoPath: string; selectedProject: string };
    };
    expect(body.state.repoPath).toBe(resolve(repo));
    expect(body.state.selectedProject).toBe("signal");
    expect(body.beatText).toContain("Welcome to the Directive Tutorial!");
    expect(body.beatText).toContain("4. Leave");
    expect(body.beatText).not.toContain("Next:");
    expect(body.beatText).not.toContain("{name}");
  });

  it("accepts displayed write/result menu labels, not only hyphen tokens", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    const example = run(projectRoot, prefs, ["advance", "--project", "Use the example", "--json"]);
    expect(example.code).toBe(0);
    expect(JSON.parse(example.out).state.content).toContain("Alex");
    expect(run(projectRoot, prefs, ["advance", "--project", "No — change the plan"]).code).toBe(0);
    expect(JSON.parse(run(projectRoot, prefs, ["inspect", "--json"]).out).state.content).toBeNull();
    expect(run(projectRoot, prefs, ["advance", "--project", "Use the example"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/signal.xbrief.json",
      ]).code,
    ).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--check", "fail"]).code).toBe(0);
    const retried = run(projectRoot, prefs, [
      "advance",
      "--project",
      "Try again",
      "--check",
      "pass",
      "--json",
    ]);
    expect(retried.code).toBe(0);
    expect(JSON.parse(retried.out).state.checkPassed).toBe(true);
  });

  it("accepts displayed menu labels such as Use the example and Try again", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    const example = run(projectRoot, prefs, ["advance", "--project", "Use the example", "--json"]);
    expect(example.code).toBe(0);
    expect(JSON.parse(example.out).state.content).toContain("Alex");
    expect(
      run(projectRoot, prefs, ["advance", "--project", "No — change the plan", "--json"]).code,
    ).toBe(0);
    expect(JSON.parse(run(projectRoot, prefs, ["inspect", "--json"]).out).state.content).toBeNull();
    expect(run(projectRoot, prefs, ["advance", "--project", "Use the example"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/signal.xbrief.json",
      ]).code,
    ).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--check", "fail"]).code).toBe(0);
    const retried = run(projectRoot, prefs, [
      "advance",
      "--project",
      "Try again",
      "--check",
      "pass",
      "--json",
    ]);
    expect(retried.code).toBe(0);
    expect(JSON.parse(retried.out).state.checkPassed).toBe(true);
  });

  it("refuses to use the person's project as the sandbox", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const refused = run(projectRoot, prefs, ["start", "--repo", projectRoot]);
    expect(refused.code).toBe(1);
    expect(`${refused.out}${refused.err}`).toContain("disposable repository");
  });

  it("refuses a subdirectory of the person's project as the sandbox", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const nested = join(projectRoot, "nested-sandbox");
    const refused = run(projectRoot, prefs, ["start", "--repo", nested]);
    expect(refused.code).toBe(1);
    expect(`${refused.out}${refused.err}`).toContain("disposable repository");
  });

  it("refuses a missing --repo that would share the person's Git checkout and cleans up", () => {
    const parent = tempDir("deft-tutorial-shared-");
    execFileSync("git", ["init", "-q"], { cwd: parent });
    const projectRoot = join(parent, "app");
    mkdirSync(projectRoot);
    const prefs = tempDir("deft-tutorial-prefs-");
    const practice = join(parent, "practice");
    const refused = run(projectRoot, prefs, ["start", "--repo", practice, "--project", "signal"]);
    expect(refused.code).toBe(1);
    expect(`${refused.out}${refused.err}`).toContain("disposable repository");
    expect(existsSync(practice)).toBe(false);
  });

  it("refuses a bad --project before creating a missing --repo path", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const missing = join(tempDir("deft-tutorial-parent-"), "should-not-exist");
    const refused = run(projectRoot, prefs, ["start", "--repo", missing, "--project", "nope"]);
    expect(refused.code).toBe(1);
    expect(`${refused.out}${refused.err}`).toContain("Pick 1 Signal");
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a completed start before creating a missing --repo path", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    writeFileSync(
      join(prefs, "tutorial-state.json"),
      JSON.stringify({ status: "completed", completedAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const missing = join(tempDir("deft-tutorial-parent-"), "should-not-exist");
    const refused = run(projectRoot, prefs, ["start", "--repo", missing, "--project", "signal"]);
    expect(refused.code).toBe(1);
    expect(`${refused.out}${refused.err}`).toContain("already finished");
    expect(existsSync(missing)).toBe(false);
  });

  it("records a passing retry when --check is supplied with try-again", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "signal"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content", "Alex — on the bridge."]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/signal.xbrief.json",
      ]).code,
    ).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--check", "fail"]).code).toBe(0);
    const retried = run(projectRoot, prefs, [
      "advance",
      "--project",
      "1",
      "--check",
      "pass",
      "--json",
    ]);
    expect(retried.code).toBe(0);
    expect(JSON.parse(retried.out).state.checkPassed).toBe(true);
  });

  it("creates and inits a missing --repo path before saving progress", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const missing = join(tempDir("deft-tutorial-parent-"), "my-practice");
    const started = run(projectRoot, prefs, [
      "start",
      "--repo",
      missing,
      "--project",
      "signal",
      "--json",
    ]);
    expect(started.code).toBe(0);
    const body = JSON.parse(started.out) as { state: { repoPath: string } };
    expect(body.state.repoPath).toBe(resolve(missing));
    expect(existsSync(join(missing, ".git"))).toBe(true);
  });

  it("accepts a --repo whose Git root differs only by a directory link (macOS /tmp)", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const physical = tempDir("deft-tutorial-repo-");
    execFileSync("git", ["init", "-q"], { cwd: physical });
    const linkParent = tempDir("deft-tutorial-link-parent-");
    const linked = join(linkParent, "practice-link");
    // Junctions on Windows do not need SeCreateSymbolicLinkPrivilege.
    try {
      if (process.platform === "win32") {
        symlinkSync(physical, linked, "junction");
      } else {
        symlinkSync(physical, linked);
      }
    } catch {
      // Host cannot create links — isolation still covered by other tests.
      return;
    }
    const started = run(projectRoot, prefs, [
      "start",
      "--repo",
      linked,
      "--project",
      "signal",
      "--json",
    ]);
    expect(started.code).toBe(0);
    const body = JSON.parse(started.out) as { state: { repoPath: string } };
    expect(body.state.repoPath).toBe(resolve(linked));
  });

  it("refuses a --repo with a non-working .git file instead of reporting ready", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    // A .git *file* (not a repo) used to be skipped by the hasOwnGit short-circuit.
    writeFileSync(join(repo, ".git"), "not a git directory\n", "utf8");
    const refused = run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]);
    expect(refused.code).toBe(1);
    expect(`${refused.out}${refused.err}`).toMatch(
      /Git repository|not a git repository|initialize|invalid/i,
    );
  });

  it("does not re-emit start lifecycle commands after Back from change", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/signal.xbrief.json",
      ]).code,
    ).toBe(0);
    const onStart = run(projectRoot, prefs, ["inspect", "--json"]);
    expect(JSON.parse(onStart.out).command).toContain("scope:promote");
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    const backStep = run(projectRoot, prefs, ["advance", "--project", "4", "--json"]);
    expect(backStep.code).toBe(0);
    const backBody = JSON.parse(backStep.out) as {
      command: string | null;
      state: { currentBeat: string; startLifecycleDone: boolean };
      message: string;
    };
    expect(backBody.state.currentBeat).toBe("start");
    expect(backBody.state.startLifecycleDone).toBe(true);
    expect(backBody.command).toBeNull();
    expect(backBody.message).toContain("do not re-run");
    const inspect = run(projectRoot, prefs, ["inspect", "--json"]);
    expect(JSON.parse(inspect.out).command).toBeNull();
  });

  it("does not re-emit close complete after Back from leave", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/signal.xbrief.json",
      ]).code,
    ).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--check", "pass"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    const onClose = run(projectRoot, prefs, ["inspect", "--json"]);
    expect(JSON.parse(onClose.out).command).toContain("scope:stamp-evidence");
    expect(JSON.parse(onClose.out).command).toContain("scope:complete");
    expect(run(projectRoot, prefs, ["advance", "--complete"]).code).toBe(0);
    const backStep = run(projectRoot, prefs, ["advance", "--project", "back", "--json"]);
    expect(backStep.code).toBe(0);
    const backBody = JSON.parse(backStep.out) as {
      command: string | null;
      state: { currentBeat: string; closeLifecycleDone: boolean };
      message: string;
    };
    expect(backBody.state.currentBeat).toBe("close");
    expect(backBody.state.closeLifecycleDone).toBe(true);
    expect(backBody.command).toBeNull();
    expect(backBody.message).toContain("Close already ran");
    const inspect = run(projectRoot, prefs, ["inspect", "--json"]);
    expect(JSON.parse(inspect.out).command).toBeNull();

    // Further Back past close is refused — editable/prove rewind after close
    // would clear checkPassed while suppressing the check command.
    const pastClose = run(projectRoot, prefs, ["advance", "--project", "back", "--json"]);
    expect(pastClose.code).toBe(1);
    const pastBody = JSON.parse(pastClose.out) as {
      ok: boolean;
      message: string;
      state: { currentBeat: string; closeLifecycleDone: boolean };
    };
    expect(pastBody.ok).toBe(false);
    expect(pastBody.state.currentBeat).toBe("close");
    expect(pastBody.state.closeLifecycleDone).toBe(true);
    expect(pastBody.message).toContain("Work already closed");

    // Finish the sitting, then Back must refuse so completed cannot become in_progress.
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0); // close → leave
    expect(run(projectRoot, prefs, ["advance"]).code).toBe(0); // leave → completed
    const finished = JSON.parse(run(projectRoot, prefs, ["inspect", "--json"]).out) as {
      state: { status: string; currentBeat: string };
    };
    expect(finished.state.status).toBe("completed");
    const backFinished = run(projectRoot, prefs, ["advance", "--project", "back", "--json"]);
    expect(backFinished.code).toBe(1);
    const backFinishedBody = JSON.parse(backFinished.out) as {
      ok: boolean;
      message: string;
      state: { status: string; currentBeat: string };
    };
    expect(backFinishedBody.ok).toBe(false);
    expect(backFinishedBody.state.status).toBe("completed");
    expect(backFinishedBody.state.currentBeat).toBe("leave");
    expect(backFinishedBody.message).toContain("already finished");
  });

  it("accepts I have questions as the Discuss pause alias", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]).code).toBe(0);
    const paused = run(projectRoot, prefs, ["advance", "--project", "I have questions", "--json"]);
    expect(paused.code).toBe(0);
    const body = JSON.parse(paused.out) as {
      ok: boolean;
      message: string;
      state: { currentBeat: string };
    };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("What would you like to discuss?");
    expect(body.state.currentBeat).toBe("choose");
  });

  it("fills promote/activate and active work-file paths into start/verify commands", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo, "--project", "signal"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    const planned = run(projectRoot, prefs, [
      "advance",
      "--confirm",
      "--work-item",
      "xbrief/proposed/signal.xbrief.json",
      "--json",
    ]);
    expect(planned.code).toBe(0);
    const startStep = run(projectRoot, prefs, ["inspect", "--json"]);
    const startBody = JSON.parse(startStep.out) as { command: string | null };
    const proposed = shellQuotePath("xbrief/proposed/signal.xbrief.json");
    const active = shellQuotePath("xbrief/active/signal.xbrief.json");
    expect(startBody.command).toContain(`deft scope:promote -- ${proposed}`);
    expect(startBody.command).toContain(`deft scope:activate -- ${proposed}`);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    const prove = run(projectRoot, prefs, ["inspect", "--json"]);
    const proveBody = JSON.parse(prove.out) as { command: string | null };
    expect(proveBody.command).toContain(`deft verify:ac ${active}`);
    expect(proveBody.command).not.toContain("<active-work-file>");
  });

  it("walks choose → write → start → change → prove → close → leave", () => {
    const projectRoot = tempDir("deft-tutorial-cli-");
    const prefs = tempDir("deft-tutorial-prefs-");
    const repo = tempDir("deft-tutorial-repo-");
    expect(run(projectRoot, prefs, ["start", "--repo", repo]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "postcard"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content", "Wish you were here."]).code).toBe(0);
    expect(
      run(projectRoot, prefs, [
        "advance",
        "--confirm",
        "--work-item",
        "xbrief/proposed/postcard.xbrief.json",
      ]).code,
    ).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--confirm"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--content-seen"]).code).toBe(0);
    const failed = run(projectRoot, prefs, ["advance", "--check", "fail", "--json"]);
    expect(failed.code).toBe(0);
    expect(JSON.parse(failed.out).state.currentBeat).toBe("result");
    expect(run(projectRoot, prefs, ["advance", "--check", "pass"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--project", "1"]).code).toBe(0);
    expect(run(projectRoot, prefs, ["advance", "--complete"]).code).toBe(0);
    const left = run(projectRoot, prefs, ["advance", "--json"]);
    expect(JSON.parse(left.out).state.status).toBe("completed");
  });
});
