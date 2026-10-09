/**
 * `deft tutorial:*` (#4981). The agent runs these. The person still chooses
 * the project, supplies content, says yes, runs the check, and sees the result.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fillBeat, loadTutorial, projectFields, renderBeat, type TutorialBeat } from "./render.js";
import {
  type AdvanceAction,
  advanceTutorial,
  backBeat,
  leaveTutorial,
  loadTutorialState,
  offerTutorial,
  resetTutorial,
  resolveProjectChoice,
  resumeTutorial,
  saveTutorialState,
  skipBeat,
  skipOffer,
  startTutorial,
  type TutorialStep,
  tutorialStatePathPersonal,
} from "./state.js";

export interface TutorialIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

const SUBCOMMANDS = [
  "offer",
  "start",
  "inspect",
  "advance",
  "resume",
  "skip",
  "leave",
  "reset",
  "decline",
  "defer",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function tutorialMarkerExists(dir: string): boolean {
  for (const candidate of [
    join(dir, "content", "tutorial", "beats.json"),
    join(dir, "tutorial", "beats.json"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export function findFrameworkRoot(start: string): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (tutorialMarkerExists(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function defaultFrameworkRoot(): string {
  return findFrameworkRoot(dirname(fileURLToPath(import.meta.url))) ?? resolve(".");
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.lastIndexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/** Physical path when the entry exists (macOS `/tmp` → `/private/tmp`); else resolve. */
function physicalPath(path: string): string {
  try {
    if (existsSync(path)) return realpathSync(path);
  } catch {
    // fall through
  }
  return resolve(path);
}

function samePath(left: string, right: string): boolean {
  return physicalPath(left) === physicalPath(right);
}

function pathIsInside(inner: string, outer: string): boolean {
  const root = physicalPath(outer);
  const target = physicalPath(inner);
  return target === root || target.startsWith(root + sep);
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const DISPOSABLE_REPO_MSG =
  "The practice project must run in a disposable repository, not the person's project.";

function disposableRepoError(repo: string, projectRoot: string): string | null {
  if (samePath(repo, projectRoot) || pathIsInside(repo, projectRoot)) {
    return DISPOSABLE_REPO_MSG;
  }
  const projectGit = gitRoot(projectRoot);
  const repoGit = gitRoot(repo);
  if (projectGit !== null && repoGit !== null && samePath(projectGit, repoGit)) {
    return DISPOSABLE_REPO_MSG;
  }
  return null;
}

function initGitRepo(repo: string): { ok: true } | { ok: false; message: string } {
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    return { ok: true };
  } catch (initErr: unknown) {
    return {
      ok: false,
      message: initErr instanceof Error ? initErr.message : String(initErr),
    };
  }
}

function ensureRepo(
  projectRoot: string,
  requested: string | undefined,
  projectId: string | null,
): { ok: true; repo: string } | { ok: false; message: string } {
  if (requested !== undefined && requested.trim().length > 0) {
    const repo = resolve(requested);
    const early = disposableRepoError(repo, projectRoot);
    if (early !== null) return { ok: false, message: early };

    let createdDir = false;
    let createdGit = false;
    const cleanup = (): void => {
      if (createdGit) rmSync(join(repo, ".git"), { recursive: true, force: true });
      if (createdDir) rmSync(repo, { recursive: true, force: true });
    };

    if (existsSync(repo)) {
      try {
        if (!statSync(repo).isDirectory()) {
          return { ok: false, message: `Sandbox path is not a directory: ${repo}` };
        }
      } catch (statErr: unknown) {
        return {
          ok: false,
          message: statErr instanceof Error ? statErr.message : String(statErr),
        };
      }
    } else {
      try {
        mkdirSync(repo, { recursive: true });
        createdDir = true;
      } catch (mkdirErr: unknown) {
        return {
          ok: false,
          message: mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr),
        };
      }
    }

    // Re-check after materializing: a missing path under a parent Git checkout
    // (e.g. --project-root /repo/app --repo /repo/practice) only reveals the
    // shared git root once the directory exists.
    const late = disposableRepoError(repo, projectRoot);
    if (late !== null) {
      cleanup();
      return { ok: false, message: late };
    }

    // Nested under another checkout (git root is a parent) — refuse.
    const root = gitRoot(repo);
    if (root !== null && !samePath(root, repo)) {
      cleanup();
      return { ok: false, message: DISPOSABLE_REPO_MSG };
    }

    // Require a working Git root. A dir with a broken/empty `.git` must not
    // report ready — attempt init (or surface the failure) like before.
    if (root === null) {
      const inited = initGitRepo(repo);
      if (!inited.ok) {
        cleanup();
        return { ok: false, message: inited.message };
      }
      createdGit = true;
      if (gitRoot(repo) === null) {
        cleanup();
        return {
          ok: false,
          message: "Could not initialize a Git repository in the practice path.",
        };
      }
      const afterInit = disposableRepoError(repo, projectRoot);
      if (afterInit !== null) {
        cleanup();
        return { ok: false, message: afterInit };
      }
    }
    return { ok: true, repo };
  }
  const prefix = projectId ? `${projectId}-` : "tutorial-";
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const err = disposableRepoError(repo, projectRoot);
  if (err !== null) {
    rmSync(repo, { recursive: true, force: true });
    return { ok: false, message: err };
  }
  const inited = initGitRepo(repo);
  if (!inited.ok) {
    rmSync(repo, { recursive: true, force: true });
    return { ok: false, message: inited.message };
  }
  return { ok: true, repo };
}

function beatById(beats: readonly TutorialBeat[], id: string): TutorialBeat | undefined {
  return beats.find((beat) => beat.id === id);
}

function payload(step: TutorialStep, beatText: string | null, command: string | null): string {
  return `${JSON.stringify({ ...step, beatText, command }, null, 2)}\n`;
}

function actionFrom(argv: readonly string[]): AdvanceAction {
  const check = flagValue(argv, "--check");
  return {
    project: flagValue(argv, "--project"),
    content: flagValue(argv, "--content") ?? flagValue(argv, "--line"),
    workItemPath: flagValue(argv, "--work-item"),
    confirm: hasFlag(argv, "--confirm"),
    contentSeen: hasFlag(argv, "--content-seen") || hasFlag(argv, "--line-seen"),
    check: check === "pass" || check === "fail" ? check : undefined,
    complete: hasFlag(argv, "--complete"),
  };
}

/** Normalize a menu label ("Use the example" → "use-the-example"). */
function menuToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[—–]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function menuMatches(flag: string | undefined, ...aliases: string[]): boolean {
  if (flag === undefined || flag.length === 0) return false;
  const token = menuToken(flag);
  return aliases.some((alias) => token === menuToken(alias));
}

function isDiscussPick(flag: string | undefined): boolean {
  // #5373 / #1470: visible hatch is Discuss; "I have questions" is the accepted-input alias.
  return menuMatches(flag, "discuss", "I have questions");
}

function isBackPick(flag: string | undefined): boolean {
  return menuMatches(flag, "back");
}

function discussStep(state: Parameters<typeof leaveTutorial>[0]): TutorialStep {
  return {
    ok: true,
    message: "What would you like to discuss?",
    state,
    beatId: state.currentBeat,
    offerNow: false,
  };
}

export function tutorialMain(argv: readonly string[], io: TutorialIo = consoleIo()): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || !isSubcommand(subcommand)) {
    io.writeErr(
      "usage: deft tutorial:offer|start|inspect|advance|resume|skip|leave|reset [--project signal|postcard|echo|1|2|3] [--json]\n",
    );
    return 1;
  }

  const projectRootFlag = flagValue(rest, "--project-root");
  const projectRoot = resolve(projectRootFlag ?? ".");
  const frameworkRoot = resolve(flagValue(rest, "--framework-root") ?? defaultFrameworkRoot());
  const prefsHome = flagValue(rest, "--prefs-home");
  // Always personal prefs unless --prefs-home (sidecar next to USER.md).
  // --project-root only places the practice sandbox; it must not fork state (#5464 P1).
  const statePath =
    prefsHome !== undefined
      ? join(resolve(prefsHome), "tutorial-state.json")
      : tutorialStatePathPersonal();
  const asJson = hasFlag(rest, "--json");
  const stateOpts = { projectRoot, path: statePath };

  let tutorial: ReturnType<typeof loadTutorial>;
  try {
    tutorial = loadTutorial(frameworkRoot);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.writeErr(`tutorial: cannot read the beats (${message})\n`);
    return 1;
  }

  const beats = tutorial.script.beats;
  const state = loadTutorialState(stateOpts);
  let step: TutorialStep;

  try {
    switch (subcommand) {
      case "offer":
        step = offerTutorial(state);
        break;
      case "decline":
      case "defer":
        step = skipOffer(state);
        break;
      case "start": {
        const projectFlag = flagValue(rest, "--project");
        // Refuse completed / bad --project before creating a sandbox on disk.
        if (state.status === "completed") {
          step = startTutorial(state, state.repoPath ?? "", beats, projectFlag);
          break;
        }
        if (
          (state.currentBeat === null || state.status !== "in_progress") &&
          projectFlag !== undefined &&
          resolveProjectChoice(projectFlag) === null
        ) {
          step = {
            ok: false,
            message: "Pick 1 Signal, 2 Postcard, 3 Echo, or 4 Leave.",
            state,
            beatId: state.currentBeat,
            offerNow: false,
          };
          break;
        }
        let repoPath = state.repoPath ?? "";
        if (state.currentBeat === null || state.status !== "in_progress") {
          const ensured = ensureRepo(
            projectRoot,
            flagValue(rest, "--repo"),
            projectFlag ?? state.selectedProject,
          );
          if (!ensured.ok) {
            step = {
              ok: false,
              message: ensured.message,
              state,
              beatId: state.currentBeat,
              offerNow: false,
            };
            break;
          }
          repoPath = ensured.repo;
        }
        step = startTutorial(state, repoPath, beats, projectFlag);
        break;
      }
      case "inspect":
        step = resumeTutorial(state);
        break;
      case "resume":
        step = resumeTutorial(state);
        break;
      case "skip":
        step = skipBeat(state, beats);
        break;
      case "leave":
        step = leaveTutorial(state);
        break;
      case "reset":
        step = resetTutorial(state);
        break;
      case "advance": {
        const projectFlag = flagValue(rest, "--project")?.trim().toLowerCase();
        const hasContent = state.content !== null && state.content.trim().length > 0;
        const hasWorkItem = state.workItemPath !== null && state.workItemPath.trim().length > 0;

        const discussPick =
          isDiscussPick(projectFlag) ||
          (state.currentBeat === "choose" && projectFlag === "5") ||
          (state.currentBeat === "write" && !hasContent && projectFlag === "3") ||
          (state.currentBeat === "write" &&
            hasContent &&
            !state.planAccepted &&
            projectFlag === "4") ||
          (state.currentBeat === "write" &&
            state.planAccepted &&
            !hasWorkItem &&
            projectFlag === "2") ||
          ((state.currentBeat === "start" ||
            state.currentBeat === "change" ||
            state.currentBeat === "close" ||
            state.currentBeat === "result") &&
            projectFlag === "3");
        if (discussPick) {
          step = discussStep(state);
          break;
        }

        const backPick =
          isBackPick(projectFlag) ||
          (state.currentBeat === "choose" && projectFlag === "6") ||
          (state.currentBeat === "write" && !hasContent && projectFlag === "4") ||
          (state.currentBeat === "write" &&
            hasContent &&
            !state.planAccepted &&
            projectFlag === "5") ||
          (state.currentBeat === "write" &&
            state.planAccepted &&
            !hasWorkItem &&
            projectFlag === "3") ||
          ((state.currentBeat === "start" ||
            state.currentBeat === "change" ||
            state.currentBeat === "close" ||
            state.currentBeat === "result") &&
            projectFlag === "4");
        if (backPick) {
          step = backBeat(state, beats);
          break;
        }

        const leavePick =
          menuMatches(projectFlag, "leave") ||
          (state.currentBeat === "choose" && projectFlag === "4") ||
          (state.currentBeat === "write" && !hasContent && projectFlag === "2") ||
          (state.currentBeat === "write" &&
            hasContent &&
            !state.planAccepted &&
            projectFlag === "3") ||
          (state.currentBeat === "write" &&
            state.planAccepted &&
            !hasWorkItem &&
            projectFlag === "1") ||
          ((state.currentBeat === "start" ||
            state.currentBeat === "change" ||
            state.currentBeat === "close") &&
            projectFlag === "2") ||
          (state.currentBeat === "result" && projectFlag === "2" && !hasFlag(rest, "--check"));
        if (leavePick) {
          step = leaveTutorial(state);
          break;
        }

        // Write step: content first. 1 Use the example / free --content; Leave/Discuss/Back above.
        if (state.currentBeat === "write" && !hasContent) {
          if (menuMatches(projectFlag, "1", "example", "use-the-example", "use the example")) {
            const fields = projectFields(
              tutorial.projects,
              state.selectedProject,
              null,
              state.workItemPath,
            );
            const example = fields.contentExample?.trim() ?? "";
            if (example.length === 0) {
              step = {
                ok: false,
                message: "This practice project has no example content.",
                state,
                beatId: state.currentBeat,
                offerNow: false,
              };
              break;
            }
            step = advanceTutorial(state, beats, { ...actionFrom(rest), content: example });
            break;
          }
        }

        // Write step: after content, Plan/Done menu — 1 Yes / 2 No — change the plan.
        if (state.currentBeat === "write" && hasContent && !state.planAccepted) {
          if (menuMatches(projectFlag, "2", "no", "no-change-the-plan", "no — change the plan")) {
            step = {
              ok: true,
              message: "Plan not accepted. Ask for new toy content.",
              state: { ...state, content: null, planAccepted: false },
              beatId: state.currentBeat,
              offerNow: false,
            };
            break;
          }
          if (menuMatches(projectFlag, "1", "yes")) {
            step = advanceTutorial(state, beats, { ...actionFrom(rest), confirm: true });
            break;
          }
        }

        // Start: 1 Yes → confirm
        if (state.currentBeat === "start" && menuMatches(projectFlag, "1", "yes")) {
          step = advanceTutorial(state, beats, { ...actionFrom(rest), confirm: true });
          break;
        }
        // Change: 1 Go → content seen
        if (state.currentBeat === "change" && menuMatches(projectFlag, "1", "go")) {
          step = advanceTutorial(state, beats, { ...actionFrom(rest), contentSeen: true });
          break;
        }
        // Result after verified: 1 Continue → confirm to leave prove step
        if (
          state.currentBeat === "result" &&
          state.checkPassed === true &&
          menuMatches(projectFlag, "1", "continue", "go")
        ) {
          step = advanceTutorial(state, beats, { ...actionFrom(rest), confirm: true });
          break;
        }
        // Result fail menu: 1 Try again — if --check is also supplied, record it now.
        if (
          state.currentBeat === "result" &&
          state.checkPassed === false &&
          menuMatches(projectFlag, "1", "try-again", "try again", "go")
        ) {
          const action = actionFrom(rest);
          if (action.check === "pass" || action.check === "fail") {
            step = advanceTutorial(state, beats, action);
            break;
          }
          step = {
            ok: true,
            message: "Stay on this step. Fix the mismatch and run the same check again.",
            state,
            beatId: state.currentBeat,
            offerNow: false,
          };
          break;
        }
        // Close: 1 Go → complete
        if (state.currentBeat === "close" && menuMatches(projectFlag, "1", "go")) {
          step = advanceTutorial(state, beats, { ...actionFrom(rest), complete: true });
          break;
        }
        step = advanceTutorial(state, beats, actionFrom(rest));
        break;
      }
      default:
        return 1;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.writeErr(`tutorial: ${message}\n`);
    return 1;
  }

  if (step.ok) {
    saveTutorialState(step.state, stateOpts);
  }

  const beat = step.beatId === null ? undefined : beatById(beats, step.beatId);
  const fields = projectFields(
    tutorial.projects,
    step.state.selectedProject,
    step.state.content,
    step.state.workItemPath,
  );
  const filled = beat === undefined ? null : fillBeat(beat, fields);
  const showPlanConfirm =
    step.beatId === "write" &&
    step.state.content !== null &&
    step.state.content.trim().length > 0 &&
    !step.state.planAccepted;
  const showWorkItemPending =
    step.beatId === "write" &&
    step.state.planAccepted &&
    (step.state.workItemPath === null || step.state.workItemPath.trim().length === 0);
  const beatText =
    beat === undefined
      ? null
      : renderBeat(beat, tutorial.glossary, fields, {
          contentReady: showPlanConfirm,
          workItemPending: showWorkItemPending,
          checkVerdict: step.beatId === "result" && step.state.checkPassed !== null,
          checkPassed: step.state.checkPassed,
        });
  // After start/close lifecycle ran once, do not re-emit those commands on Back.
  // Close also moves the active work file — suppress result verify:ac afterward.
  const command =
    (step.beatId === "start" && step.state.startLifecycleDone) ||
    (step.beatId === "close" && step.state.closeLifecycleDone) ||
    (step.beatId === "result" && step.state.closeLifecycleDone)
      ? null
      : (filled?.command ?? null);

  if (asJson) {
    io.writeOut(payload(step, beatText, command));
  } else {
    io.writeOut(`${step.message}\n`);
    if (beatText !== null) {
      io.writeOut(`\n${beatText}\n`);
    }
  }
  return step.ok ? 0 : 1;
}

function consoleIo(): TutorialIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  };
}
