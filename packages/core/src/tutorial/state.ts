/**
 * Directive Tutorial progress (#4981).
 *
 * Lives in the person's user-preferences home (sidecar next to USER.md),
 * not in the product project and not only inside the practice sandbox.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveUserMdPath } from "../user-config/resolve-user-md.js";

export const TUTORIAL_STATE_FILENAME = "tutorial-state.json";
export const TUTORIAL_CONTENT_VERSION = "1";

export const PROJECT_IDS = ["signal", "postcard", "echo"] as const;
export type TutorialProjectId = (typeof PROJECT_IDS)[number];

export type TutorialStatus = "not_started" | "offered" | "in_progress" | "completed" | "skipped";

export interface TutorialBeatRef {
  readonly id: string;
  readonly wired: boolean;
}

export interface TutorialState {
  readonly status: TutorialStatus;
  readonly selectedProject: TutorialProjectId | null;
  readonly currentBeat: string | null;
  readonly completedBeats: readonly string[];
  readonly version: string;
  readonly content: string | null;
  readonly workItemPath: string | null;
  readonly repoPath: string | null;
  readonly checkPassed: boolean | null;
  /**
   * Start step lifecycle (branch + promote + activate) already ran for this
   * sitting. Survives Back to `start` so the agent does not re-run those
   * commands after the work file left proposed/.
   */
  readonly startLifecycleDone: boolean;
  /**
   * Close step (`scope:complete`) already ran for this sitting. Survives Back
   * to `close` so the agent does not re-run complete against a moved file.
   */
  readonly closeLifecycleDone: boolean;
  /** Write step: Plan/Done accepted after toy content is collected. */
  readonly planAccepted: boolean;
  readonly planConfirmed: boolean;
  readonly contentSeen: boolean;
  readonly offeredAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly skippedAt: string | null;
}

export interface AdvanceAction {
  readonly project?: string;
  readonly content?: string;
  readonly workItemPath?: string;
  readonly confirm?: boolean;
  readonly contentSeen?: boolean;
  readonly check?: "pass" | "fail";
  readonly complete?: boolean;
}

export interface TutorialStep {
  readonly ok: boolean;
  readonly message: string;
  readonly state: TutorialState;
  readonly beatId: string | null;
  /** True only on the call that records the one automatic offer. */
  readonly offerNow: boolean;
}

export function emptyTutorialState(): TutorialState {
  return {
    status: "not_started",
    selectedProject: null,
    currentBeat: null,
    completedBeats: [],
    version: TUTORIAL_CONTENT_VERSION,
    content: null,
    workItemPath: null,
    repoPath: null,
    checkPassed: null,
    startLifecycleDone: false,
    closeLifecycleDone: false,
    planAccepted: false,
    planConfirmed: false,
    contentSeen: false,
    offeredAt: null,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
  };
}

export function isProjectId(value: string): value is TutorialProjectId {
  return (PROJECT_IDS as readonly string[]).includes(value);
}

/** Menu numbers on step 1, or the project id. */
export function resolveProjectChoice(value: string): TutorialProjectId | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "signal") return "signal";
  if (normalized === "2" || normalized === "postcard") return "postcard";
  if (normalized === "3" || normalized === "echo") return "echo";
  return isProjectId(normalized) ? normalized : null;
}

/**
 * Leave the sitting at any step. Records skipped so the automatic offer
 * does not fire again; explicit start still works.
 */
export function leaveTutorial(state: TutorialState): TutorialStep {
  // Completion leaves currentBeat on "leave"; protect every completed sitting.
  if (state.status === "completed") {
    return step(
      false,
      "The tutorial is already finished. Reset before leaving again.",
      state,
      state.currentBeat,
    );
  }
  if (state.status === "not_started" && state.currentBeat === null) {
    return skipOffer(state);
  }
  const next: TutorialState = {
    ...emptyTutorialState(),
    status: "skipped",
    offeredAt: state.offeredAt ?? nowIso(),
    skippedAt: nowIso(),
  };
  return step(true, "Left the tutorial. Explicit start still works.", next, null);
}

export function shouldOfferTutorial(state: TutorialState): boolean {
  return state.status === "not_started";
}

/** Sidecar next to the resolved USER.md path. */
export function tutorialStatePath(
  options: {
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homeDir?: string;
  } = {},
): string {
  const resolved = resolveUserMdPath(options);
  return join(dirname(resolved.path), TUTORIAL_STATE_FILENAME);
}

/**
 * Tutorial progress is personal (#4981 / PR #5464 Greptile P1).
 * Prefer DEFT_USER_PATH / platform USER.md and skip cwd workspace-local
 * `.deft/USER.md`, so practice-sandbox cwd does not fork tutorial-state.json.
 */
export function tutorialStatePathPersonal(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homeDir?: string } = {},
): string {
  const env = options.env ?? process.env;
  const override = env.DEFT_USER_PATH?.trim();
  if (override) {
    return join(dirname(resolve(override)), TUTORIAL_STATE_FILENAME);
  }
  const resolved = resolveUserMdPath({
    ...options,
    // Sentinel with no USER.md → platform / default rungs only.
    projectRoot: join(options.homeDir ?? ".", "__deft_tutorial_no_workspace__"),
  });
  return join(dirname(resolved.path), TUTORIAL_STATE_FILENAME);
}

export function loadTutorialState(
  options: {
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homeDir?: string;
    path?: string;
  } = {},
): TutorialState {
  const path = options.path ?? tutorialStatePath(options);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TutorialState> & {
      declined?: boolean;
      deferred?: boolean;
      completed?: boolean;
      offered?: boolean;
      beaconLine?: string;
    };
    return normalizeState(raw);
  } catch {
    // Missing or unreadable state → fresh sitting (returned-failure, not throw).
    return emptyTutorialState();
  }
}

function normalizeState(raw: Partial<TutorialState> & Record<string, unknown>): TutorialState {
  const empty = emptyTutorialState();
  let status: TutorialStatus = empty.status;
  if (
    raw.status === "not_started" ||
    raw.status === "offered" ||
    raw.status === "in_progress" ||
    raw.status === "completed" ||
    raw.status === "skipped"
  ) {
    status = raw.status;
  } else if (raw.completed === true) {
    status = "completed";
  } else if (raw.declined === true || raw.deferred === true) {
    status = "skipped";
  } else if (typeof raw.currentBeat === "string" && raw.currentBeat.length > 0) {
    status = "in_progress";
  } else if (raw.offered === true) {
    status = "offered";
  }

  const selected =
    typeof raw.selectedProject === "string" && isProjectId(raw.selectedProject)
      ? raw.selectedProject
      : null;

  const completedBeats = Array.isArray(raw.completedBeats)
    ? raw.completedBeats.filter((id): id is string => typeof id === "string")
    : [];

  const content =
    typeof raw.content === "string"
      ? raw.content
      : typeof raw.beaconLine === "string"
        ? raw.beaconLine
        : null;

  return {
    status,
    selectedProject: selected,
    currentBeat: typeof raw.currentBeat === "string" ? raw.currentBeat : null,
    completedBeats,
    version: typeof raw.version === "string" ? raw.version : TUTORIAL_CONTENT_VERSION,
    content,
    workItemPath: typeof raw.workItemPath === "string" ? raw.workItemPath : null,
    repoPath: typeof raw.repoPath === "string" ? raw.repoPath : null,
    checkPassed: raw.checkPassed === true ? true : raw.checkPassed === false ? false : null,
    startLifecycleDone: raw.startLifecycleDone === true,
    closeLifecycleDone: raw.closeLifecycleDone === true,
    planAccepted: raw.planAccepted === true,
    planConfirmed: raw.planConfirmed === true,
    contentSeen: raw.contentSeen === true || raw.lineSeen === true,
    offeredAt: typeof raw.offeredAt === "string" ? raw.offeredAt : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    skippedAt: typeof raw.skippedAt === "string" ? raw.skippedAt : null,
  };
}

export function saveTutorialState(
  state: TutorialState,
  options: {
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homeDir?: string;
    path?: string;
  } = {},
): void {
  const path = options.path ?? tutorialStatePath(options);
  const root = dirname(path);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(prefix)) {
    // Refuse the write without throwing (intent-constraint free pattern).
    return;
  }
  mkdirSync(root, { recursive: true });
  containedWrite({
    root: resolvedRoot,
    target: resolvedPath,
    data: `${JSON.stringify(state, null, 2)}\n`,
    mode: "replace",
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function step(
  ok: boolean,
  message: string,
  state: TutorialState,
  beatId: string | null,
  offerNow = false,
): TutorialStep {
  return { ok, message, state, beatId, offerNow };
}

function wiredIds(beats: readonly TutorialBeatRef[]): string[] {
  return beats.filter((beat) => beat.wired).map((beat) => beat.id);
}

function nextWired(beats: readonly TutorialBeatRef[], current: string): string | null {
  const ids = wiredIds(beats);
  const index = ids.indexOf(current);
  if (index < 0) return null;
  return ids[index + 1] ?? null;
}

function previousWired(beats: readonly TutorialBeatRef[], current: string): string | null {
  const ids = wiredIds(beats);
  const index = ids.indexOf(current);
  if (index <= 0) return null;
  return ids[index - 1] ?? null;
}

/** Clear plan / work-file / prove-it fields when the person rewinds or changes project. */
function clearPlanAndLater(state: TutorialState): TutorialState {
  return {
    ...state,
    content: null,
    workItemPath: null,
    planAccepted: false,
    planConfirmed: false,
    contentSeen: false,
    checkPassed: null,
    startLifecycleDone: false,
    closeLifecycleDone: false,
  };
}

/** Step back one wired beat (Discuss/Back contract). */
export function backBeat(state: TutorialState, beats: readonly TutorialBeatRef[]): TutorialStep {
  if (state.status === "completed") {
    return step(
      false,
      "The tutorial is already finished. Reset before going back.",
      state,
      state.currentBeat,
    );
  }
  if (state.currentBeat === null) {
    return step(false, "The tutorial has not started.", state, null);
  }
  const prior = previousWired(beats, state.currentBeat);
  if (prior === null) {
    return step(
      false,
      "This is the first step. Leave or Discuss instead.",
      state,
      state.currentBeat,
    );
  }
  const ids = wiredIds(beats);
  const priorIndex = ids.indexOf(prior);
  // After close ran, Back may return to close (to re-read) but must not reach
  // earlier editable/prove steps — that clears checkPassed while keeping
  // closeLifecycleDone, so forward shows "run the check" with command null.
  const closeIndex = ids.indexOf("close");
  if (state.closeLifecycleDone && closeIndex >= 0 && priorIndex < closeIndex) {
    return step(
      false,
      "Work already closed. Leave or Discuss instead of going back to earlier steps.",
      state,
      state.currentBeat,
    );
  }
  // Drop completion marks at/after the landing step — rewind invalidates later proof.
  let next: TutorialState = {
    ...state,
    currentBeat: prior,
    completedBeats: state.completedBeats.filter((id) => {
      const index = ids.indexOf(id);
      return index >= 0 && index < priorIndex;
    }),
  };
  // Landing on or before change must re-run prove-it; keep checkPassed only on result+.
  const changeIndex = ids.indexOf("change");
  if (changeIndex >= 0 && priorIndex <= changeIndex) {
    next = { ...next, checkPassed: null };
  }
  // Rewinding into choose or write must not keep a stale plan / work file.
  // clearPlanAndLater also clears closeLifecycleDone (same as startLifecycleDone).
  if (prior === "choose" || prior === "write") {
    next = clearPlanAndLater(next);
  }
  if (prior === "choose") {
    next = { ...next, selectedProject: null };
  }
  const message =
    prior === "start" && next.startLifecycleDone
      ? "Moved back one step. Lifecycle commands already ran — do not re-run them. Read it aloud."
      : prior === "close" && next.closeLifecycleDone
        ? "Moved back one step. Close already ran — do not re-run it. Read it aloud."
        : "Moved back one step. Read it aloud.";
  return step(true, message, next, prior);
}

function withCompleted(state: TutorialState, beatId: string): TutorialState {
  if (state.completedBeats.includes(beatId)) return state;
  return { ...state, completedBeats: [...state.completedBeats, beatId] };
}

export function offerTutorial(state: TutorialState): TutorialStep {
  if (!shouldOfferTutorial(state)) {
    return step(true, "Do not offer the tutorial again.", state, state.currentBeat, false);
  }
  const next: TutorialState = {
    ...state,
    status: "offered",
    offeredAt: state.offeredAt ?? nowIso(),
  };
  return step(true, "Offer the Directive Tutorial once.", next, null, true);
}

/** First-offer skip (also covers legacy decline/defer). */
export function skipOffer(state: TutorialState): TutorialStep {
  if (state.currentBeat !== null || state.status === "in_progress") {
    return step(false, "The tutorial has already started.", state, state.currentBeat);
  }
  if (state.status === "completed") {
    return step(false, "The tutorial is already finished. Reset before skipping.", state, null);
  }
  const next: TutorialState = {
    ...state,
    status: "skipped",
    skippedAt: nowIso(),
    offeredAt: state.offeredAt ?? nowIso(),
  };
  return step(true, "Recorded skip. Explicit re-run still works.", next, null);
}

export function startTutorial(
  state: TutorialState,
  repoPath: string,
  beats: readonly TutorialBeatRef[],
  project?: string,
): TutorialStep {
  if (state.status === "completed") {
    return step(
      false,
      "The tutorial is already finished. Reset before starting again.",
      state,
      null,
    );
  }
  if (state.currentBeat !== null && state.status === "in_progress") {
    return step(true, "The tutorial is already in progress.", state, state.currentBeat);
  }
  const first = wiredIds(beats)[0];
  if (first === undefined) {
    return step(false, "The tutorial has no wired beat.", state, null);
  }
  const trimmed = repoPath.trim();
  if (trimmed.length === 0) {
    return step(false, "The practice project needs a disposable repository path.", state, null);
  }

  let selected: TutorialProjectId | null = null;
  if (project !== undefined) {
    const resolved = resolveProjectChoice(project);
    if (resolved === null) {
      return step(false, "Pick 1 Signal, 2 Postcard, 3 Echo, or 4 Leave.", state, null);
    }
    selected = resolved;
  }

  // Fresh sitting: do not reuse content / work-file / check results from a prior run.
  const next: TutorialState = {
    ...emptyTutorialState(),
    status: "in_progress",
    selectedProject: selected,
    currentBeat: first,
    repoPath: trimmed,
    offeredAt: state.offeredAt ?? nowIso(),
    startedAt: nowIso(),
  };
  return step(true, "Practice sandbox is ready. Read this step aloud.", next, first);
}

export function resumeTutorial(state: TutorialState): TutorialStep {
  if (state.currentBeat === null) {
    return step(true, "The tutorial has not started.", state, null);
  }
  return step(true, "Resume this step. Read it aloud.", state, state.currentBeat);
}

export function resetTutorial(state: TutorialState): TutorialStep {
  const next: TutorialState = {
    ...emptyTutorialState(),
    // Reset clears progress; does not by itself re-fire the automatic offer.
    status: state.status === "not_started" ? "not_started" : "offered",
    offeredAt: state.offeredAt,
  };
  return step(true, "Progress cleared. This does not offer the tutorial again.", next, null);
}

/** Mid-tutorial skip to the next wired beat (does not finish the work). */
export function skipBeat(state: TutorialState, beats: readonly TutorialBeatRef[]): TutorialStep {
  if (state.currentBeat === null) {
    return skipOffer(state);
  }
  if (!wiredIds(beats).includes(state.currentBeat)) {
    return step(false, "This step is not wired.", state, state.currentBeat);
  }
  const following = nextWired(beats, state.currentBeat);
  if (following === null) {
    return step(
      false,
      "This is the last step. Skip does not finish the work.",
      state,
      state.currentBeat,
    );
  }
  // Skip moves forward without recording completion — final leave still needs a real close.
  const next: TutorialState = { ...state, currentBeat: following, status: "in_progress" };
  return step(true, "Skipped to the next step. The work is not finished.", next, following);
}

export function advanceTutorial(
  state: TutorialState,
  beats: readonly TutorialBeatRef[],
  action: AdvanceAction,
): TutorialStep {
  if (state.currentBeat === null) {
    return step(false, "The tutorial has not started.", state, null);
  }
  if (!wiredIds(beats).includes(state.currentBeat)) {
    return step(false, "This step is not wired.", state, state.currentBeat);
  }

  const gate = gateAdvance(state, action);
  if (!gate.ok || gate.state === undefined) {
    return step(false, gate.message, state, state.currentBeat);
  }

  // Prove step: record pass/fail and stay until Continue after a pass.
  if (state.currentBeat === "result" && (action.check === "fail" || action.check === "pass")) {
    return step(true, gate.message, gate.state, state.currentBeat);
  }

  // Write step: stay until content, Plan/Done confirm, and work file are all recorded.
  if (state.currentBeat === "write") {
    const next = gate.state;
    const hasContent = next.content !== null && next.content.trim().length > 0;
    const hasWorkItem = next.workItemPath !== null && next.workItemPath.trim().length > 0;
    if (!hasContent || !next.planAccepted || !hasWorkItem) {
      return step(true, gate.message, next, state.currentBeat);
    }
  }

  if (state.currentBeat === "leave") {
    return step(true, gate.message, gate.state, "leave");
  }

  const following = nextWired(beats, state.currentBeat);
  if (following === null) {
    return step(false, "There is no next wired step.", gate.state, state.currentBeat);
  }
  const marked = withCompleted(gate.state, state.currentBeat);
  const next = { ...marked, currentBeat: following, status: "in_progress" as const };
  return step(true, "Read the next step aloud.", next, following);
}

function gateAdvance(
  state: TutorialState,
  action: AdvanceAction,
): { ok: boolean; message: string; state?: TutorialState } {
  switch (state.currentBeat) {
    case "choose": {
      const raw = action.project?.trim() ?? "";
      const resolved = resolveProjectChoice(raw);
      if (resolved === null) {
        return {
          ok: false,
          message: "Pick 1, 2, 3, or 4 (Leave) before this step can move on.",
        };
      }
      // Changing (or re-picking) a project must not keep a prior plan / work file.
      return {
        ok: true,
        message: "Practice project recorded.",
        state: { ...clearPlanAndLater(state), selectedProject: resolved },
      };
    }
    case "write": {
      const content = action.content?.trim() ?? state.content?.trim() ?? "";
      if (content.length === 0) {
        return {
          ok: false,
          message: "The person has to supply the toy content before this step can move on.",
        };
      }

      // Phase 1: collect content, then stay to show Plan/Done with it filled in.
      if (state.content === null || state.content.trim().length === 0) {
        return {
          ok: true,
          message: "Toy content recorded. Show Plan and Done next.",
          state: { ...state, content },
        };
      }

      // Phase 2: confirm Plan/Done (content already present).
      if (!state.planAccepted) {
        if (action.confirm !== true) {
          return {
            ok: false,
            message: "Say yes if Plan and Done look right before this step can move on.",
          };
        }
        const workItemPath = action.workItemPath?.trim() ?? "";
        if (workItemPath.length === 0) {
          return {
            ok: true,
            message: "Plan and Done accepted. Write the work file next.",
            state: { ...state, content, planAccepted: true },
          };
        }
        return {
          ok: true,
          message: "Work file recorded.",
          state: { ...state, content, planAccepted: true, workItemPath },
        };
      }

      // Phase 3: proposed work file path, then leave the write step.
      const workItemPath = action.workItemPath?.trim() ?? "";
      if (workItemPath.length === 0) {
        return {
          ok: false,
          message: "The proposed work file has to exist before this step can move on.",
        };
      }
      return {
        ok: true,
        message: "Work file recorded.",
        state: { ...state, content, workItemPath },
      };
    }
    case "start": {
      if (action.confirm !== true) {
        return { ok: false, message: "The person has to say yes before this step can move on." };
      }
      return {
        ok: true,
        message: state.startLifecycleDone
          ? "Plan confirmed. Lifecycle commands already ran."
          : "Plan confirmed.",
        state: { ...state, planConfirmed: true, startLifecycleDone: true },
      };
    }
    case "change": {
      if (action.contentSeen !== true) {
        return {
          ok: false,
          message: "The person has to see the toy work before this step can move on.",
        };
      }
      return { ok: true, message: "Content seen.", state: { ...state, contentSeen: true } };
    }
    case "result": {
      if (action.check === "fail") {
        return {
          ok: true,
          message: "Stay on this step. Fix the mismatch and run the same check again.",
          state: { ...state, checkPassed: false },
        };
      }
      if (action.check === "pass") {
        return {
          ok: true,
          message: "Check verified. Continue when ready.",
          state: { ...state, checkPassed: true },
        };
      }
      if (state.checkPassed === true && action.confirm === true) {
        return { ok: true, message: "Continue after verified check.", state };
      }
      return {
        ok: false,
        message: "Run the acceptance check, then continue when it verifies.",
      };
    }
    case "close": {
      if (state.checkPassed !== true) {
        return {
          ok: false,
          message: "The acceptance check must pass before the work can be closed.",
        };
      }
      if (action.complete !== true && action.confirm !== true) {
        return { ok: false, message: "Confirm complete before this step can move on." };
      }
      return {
        ok: true,
        message: state.closeLifecycleDone ? "Work closed. Complete already ran." : "Work closed.",
        state: { ...state, closeLifecycleDone: true },
      };
    }
    case "leave": {
      const closedProperly = state.checkPassed === true && state.completedBeats.includes("close");
      if (!closedProperly) {
        return {
          ok: false,
          message:
            "Finish and close the work before completing the tutorial, or leave with deft tutorial:leave.",
        };
      }
      return {
        ok: true,
        message: "The practice sitting is finished.",
        state: {
          ...state,
          status: "completed",
          completedAt: nowIso(),
          currentBeat: "leave",
        },
      };
    }
    default:
      return { ok: false, message: "This step cannot advance." };
  }
}

/** @deprecated Use skipOffer / skipBeat. Kept for CLI alias compatibility. */
export const declineTutorial = skipOffer;
/** @deprecated Use skipOffer. */
export const deferTutorial = skipOffer;
/** @deprecated Use skipBeat. */
export const skipTutorial = skipBeat;
