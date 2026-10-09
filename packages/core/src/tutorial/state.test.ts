import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceTutorial,
  backBeat,
  emptyTutorialState,
  leaveTutorial,
  loadTutorialState,
  offerTutorial,
  resetTutorial,
  resumeTutorial,
  saveTutorialState,
  shouldOfferTutorial,
  skipBeat,
  skipOffer,
  startTutorial,
  type TutorialBeatRef,
  type TutorialState,
  tutorialStatePathPersonal,
} from "./state.js";

const beats: readonly TutorialBeatRef[] = [
  { id: "choose", wired: true },
  { id: "write", wired: true },
  { id: "start", wired: true },
  { id: "change", wired: true },
  { id: "result", wired: true },
  { id: "close", wired: true },
  { id: "leave", wired: true },
];

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function prefsHome(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-tutorial-prefs-"));
  temps.push(root);
  return root;
}

function begin(): TutorialState {
  return startTutorial(emptyTutorialState(), "/tmp/signal-sandbox", beats).state;
}

describe("Directive Tutorial state (#4981)", () => {
  it("offers once, and skip does not offer again", () => {
    const offered = offerTutorial(emptyTutorialState());
    expect(offered.offerNow).toBe(true);
    expect(offered.state.status).toBe("offered");
    expect(shouldOfferTutorial(offered.state)).toBe(false);
    expect(offerTutorial(offered.state).offerNow).toBe(false);

    const skipped = skipOffer(emptyTutorialState());
    expect(skipped.state.status).toBe("skipped");
    expect(shouldOfferTutorial(skipped.state)).toBe(false);
  });

  it("allows explicit start after skip", () => {
    const skipped = skipOffer(emptyTutorialState());
    const started = startTutorial(skipped.state, "/tmp/signal-sandbox", beats, "signal");
    expect(started.ok).toBe(true);
    expect(started.state.status).toBe("in_progress");
    expect(started.state.currentBeat).toBe("choose");
    expect(started.state.selectedProject).toBe("signal");
  });

  it("stores progress in the preferences home and resumes", () => {
    const home = prefsHome();
    const path = join(home, "tutorial-state.json");
    let state = startTutorial(emptyTutorialState(), "/tmp/signal-sandbox", beats).state;
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    saveTutorialState(state, { path });
    const loaded = loadTutorialState({ path });
    const resumed = resumeTutorial(loaded);
    expect(resumed.state.currentBeat).toBe("write");
    expect(resumed.state.selectedProject).toBe("signal");
  });

  it("personal state path ignores cwd workspace-local USER.md (#5464)", () => {
    const home = prefsHome();
    const personal = tutorialStatePathPersonal({
      env: {},
      platform: "win32",
      homeDir: home,
    });
    expect(personal).toBe(join(home, "AppData", "Roaming", "deft", "tutorial-state.json"));
  });

  it("keeps a failed check on prove-it and advances only after continue on a pass", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "postcard" }).state;
    state = advanceTutorial(state, beats, { content: "Wish you were here." }).state;
    expect(state.currentBeat).toBe("write");
    expect(state.content).toBe("Wish you were here.");
    expect(state.planAccepted).toBe(false);
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/postcard.xbrief.json",
    }).state;
    expect(state.currentBeat).toBe("start");
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { contentSeen: true }).state;
    expect(state.currentBeat).toBe("result");

    const failed = advanceTutorial(state, beats, { check: "fail" });
    expect(failed.ok).toBe(true);
    expect(failed.state.currentBeat).toBe("result");
    expect(failed.state.checkPassed).toBe(false);

    const passed = advanceTutorial(failed.state, beats, { check: "pass" });
    expect(passed.state.currentBeat).toBe("result");
    expect(passed.state.checkPassed).toBe(true);

    const continued = advanceTutorial(passed.state, beats, { confirm: true });
    expect(continued.state.currentBeat).toBe("close");
  });

  it("closes only after a passed check, then completes on leave", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "echo" }).state;
    state = advanceTutorial(state, beats, { content: "Q: Hi? A: Hello." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/echo.xbrief.json",
    }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { contentSeen: true }).state;
    state = advanceTutorial(state, beats, { check: "pass" }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    expect(state.currentBeat).toBe("close");

    const closed = advanceTutorial(state, beats, { complete: true });
    expect(closed.state.currentBeat).toBe("leave");

    const left = advanceTutorial(closed.state, beats, {});
    expect(left.state.status).toBe("completed");
    expect(left.state.completedAt).not.toBeNull();
  });

  it("reset clears progress without re-arming the automatic offer", () => {
    const started = begin();
    const reset = resetTutorial(started);
    expect(reset.state.currentBeat).toBeNull();
    expect(reset.state.selectedProject).toBeNull();
    expect(shouldOfferTutorial(reset.state)).toBe(false);
    expect(reset.state.status).toBe("offered");
  });

  it("mid-tutorial skip moves one step without finishing", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    const skipped = skipBeat(state, beats);
    expect(skipped.ok).toBe(true);
    expect(skipped.state.currentBeat).toBe("start");
    expect(skipped.state.status).toBe("in_progress");
  });

  it("accepts numbered menu picks and leave clears the sitting", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "2" }).state;
    expect(state.selectedProject).toBe("postcard");
    expect(state.currentBeat).toBe("write");

    const left = leaveTutorial(state);
    expect(left.ok).toBe(true);
    expect(left.state.status).toBe("skipped");
    expect(left.state.currentBeat).toBeNull();
    expect(shouldOfferTutorial(left.state)).toBe(false);
  });

  it("refuses restart after completed until reset, without reusing prior fields", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = advanceTutorial(state, beats, { content: "Alex — on the bridge." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/signal.xbrief.json",
    }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { contentSeen: true }).state;
    state = advanceTutorial(state, beats, { check: "pass" }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { complete: true }).state;
    state = advanceTutorial(state, beats, {}).state;
    expect(state.status).toBe("completed");
    expect(state.currentBeat).toBe("leave");

    const leaveRefused = leaveTutorial(state);
    expect(leaveRefused.ok).toBe(false);
    expect(leaveRefused.message).toContain("already finished");
    expect(leaveRefused.state.status).toBe("completed");

    const refused = startTutorial(state, "/tmp/signal-sandbox-2", beats, "echo");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("Reset");

    const reset = resetTutorial(state);
    const restarted = startTutorial(reset.state, "/tmp/signal-sandbox-2", beats, "echo");
    expect(restarted.ok).toBe(true);
    expect(restarted.state.content).toBeNull();
    expect(restarted.state.workItemPath).toBeNull();
    expect(restarted.state.checkPassed).toBeNull();
    expect(restarted.state.selectedProject).toBe("echo");
  });

  it("does not graduate via skip-to-leave when the check never passed", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = skipBeat(state, beats).state; // write -> start
    state = skipBeat(state, beats).state; // start -> change
    state = skipBeat(state, beats).state; // change -> result
    state = advanceTutorial(state, beats, { check: "fail" }).state;
    state = skipBeat(state, beats).state; // result -> close
    state = skipBeat(state, beats).state; // close -> leave
    expect(state.currentBeat).toBe("leave");
    expect(state.completedBeats).not.toContain("close");
    const finished = advanceTutorial(state, beats, {});
    expect(finished.ok).toBe(false);
    expect(finished.state.status).not.toBe("completed");
  });

  it("clears plan and work file when Back returns to write", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = advanceTutorial(state, beats, { content: "Alex — on the bridge." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/signal.xbrief.json",
    }).state;
    expect(state.currentBeat).toBe("start");
    expect(state.planAccepted).toBe(true);
    expect(state.workItemPath).not.toBeNull();

    const backed = backBeat(state, beats);
    expect(backed.ok).toBe(true);
    expect(backed.state.currentBeat).toBe("write");
    expect(backed.state.planAccepted).toBe(false);
    expect(backed.state.workItemPath).toBeNull();
    expect(backed.state.content).toBeNull();
  });

  it("keeps startLifecycleDone when Back returns to start so commands are not repeated", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = advanceTutorial(state, beats, { content: "Alex — on the bridge." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/signal.xbrief.json",
    }).state;
    expect(state.currentBeat).toBe("start");
    expect(state.startLifecycleDone).toBe(false);

    state = advanceTutorial(state, beats, { confirm: true }).state;
    expect(state.currentBeat).toBe("change");
    expect(state.startLifecycleDone).toBe(true);

    const backed = backBeat(state, beats);
    expect(backed.state.currentBeat).toBe("start");
    expect(backed.state.startLifecycleDone).toBe(true);
    expect(backed.message).toContain("do not re-run");

    const toWrite = backBeat(backed.state, beats);
    expect(toWrite.state.currentBeat).toBe("write");
    expect(toWrite.state.startLifecycleDone).toBe(false);
  });

  it("keeps closeLifecycleDone when Back returns to close so complete is not repeated", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = advanceTutorial(state, beats, { content: "Alex — on the bridge." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/signal.xbrief.json",
    }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { contentSeen: true }).state;
    state = advanceTutorial(state, beats, { check: "pass" }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    expect(state.currentBeat).toBe("close");
    expect(state.closeLifecycleDone).toBe(false);

    state = advanceTutorial(state, beats, { complete: true }).state;
    expect(state.currentBeat).toBe("leave");
    expect(state.closeLifecycleDone).toBe(true);

    const backed = backBeat(state, beats);
    expect(backed.state.currentBeat).toBe("close");
    expect(backed.state.closeLifecycleDone).toBe(true);
    expect(backed.message).toContain("Close already ran");

    // Further Back past close is refused once close has run.
    const pastClose = backBeat(backed.state, beats);
    expect(pastClose.ok).toBe(false);
    expect(pastClose.state.currentBeat).toBe("close");
    expect(pastClose.state.closeLifecycleDone).toBe(true);
    expect(pastClose.message).toContain("Work already closed");
  });

  it("refuses Back after the tutorial is completed so finished progress cannot reopen", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = advanceTutorial(state, beats, { content: "Alex — on the bridge." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/signal.xbrief.json",
    }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { contentSeen: true }).state;
    state = advanceTutorial(state, beats, { check: "pass" }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { complete: true }).state;
    state = advanceTutorial(state, beats, {}).state;
    expect(state.status).toBe("completed");
    expect(state.currentBeat).toBe("leave");

    const backed = backBeat(state, beats);
    expect(backed.ok).toBe(false);
    expect(backed.state.status).toBe("completed");
    expect(backed.state.currentBeat).toBe("leave");
    expect(backed.message).toContain("already finished");
  });

  it("clears prove-it results when Back returns to change", () => {
    let state = begin();
    state = advanceTutorial(state, beats, { project: "signal" }).state;
    state = advanceTutorial(state, beats, { content: "Alex — on the bridge." }).state;
    state = advanceTutorial(state, beats, {
      confirm: true,
      workItemPath: "xbrief/proposed/signal.xbrief.json",
    }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    state = advanceTutorial(state, beats, { contentSeen: true }).state;
    state = advanceTutorial(state, beats, { check: "pass" }).state;
    state = advanceTutorial(state, beats, { confirm: true }).state;
    expect(state.currentBeat).toBe("close");
    expect(state.checkPassed).toBe(true);
    expect(state.completedBeats).toContain("result");

    const backed = backBeat(state, beats); // close -> result
    expect(backed.state.currentBeat).toBe("result");
    expect(backed.state.checkPassed).toBe(true);
    expect(backed.state.completedBeats).not.toContain("result");

    const toChange = backBeat(backed.state, beats); // result -> change
    expect(toChange.state.currentBeat).toBe("change");
    expect(toChange.state.checkPassed).toBeNull();
    expect(toChange.state.completedBeats).not.toContain("close");

    // Stale close completion must not graduate after rewind.
    let skipped = toChange.state;
    skipped = skipBeat(skipped, beats).state; // change -> result
    skipped = skipBeat(skipped, beats).state; // result -> close
    skipped = skipBeat(skipped, beats).state; // close -> leave
    const finished = advanceTutorial(skipped, beats, {});
    expect(finished.ok).toBe(false);
    expect(finished.state.status).not.toBe("completed");
  });
});
