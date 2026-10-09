import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeWorkItemPath,
  beatById,
  fillBeat,
  loadTutorial,
  projectFields,
  renderBeat,
  renderWiredSession,
  shellQuotePath,
  shellQuotePathFor,
  wiredBeats,
} from "./render.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Directive Tutorial session messages (#4981)", () => {
  const { glossary, script, projects } = loadTutorial(repoRoot);
  const fields = projectFields(projects, "signal", "Alex — on the bridge.");
  const mustBeat = (id: string) => {
    const beat = beatById(script, id);
    if (beat === undefined) {
      throw new Error(`missing beat: ${id}`);
    }
    return beat;
  };

  it("reads the version-1 glossary terms", () => {
    expect([...glossary.keys()]).toEqual([
      "Directive",
      "work file",
      "work item",
      "proposed",
      "ready",
      "in progress",
      "done",
      "acceptance",
      "branch",
      "check",
      "evidence",
      "in-scope files",
    ]);
  });

  it("loads the three menu projects", () => {
    expect([...projects.keys()].sort()).toEqual(["echo", "postcard", "signal"]);
  });

  it("wires all seven shared steps", () => {
    expect(wiredBeats(script).map((beat) => beat.id)).toEqual([
      "choose",
      "write",
      "start",
      "change",
      "result",
      "close",
      "leave",
    ]);
  });

  it("welcomes on step 1 and names the menu", () => {
    const message = renderBeat(mustBeat("choose"), glossary, fields);
    expect(message).toContain("Welcome to the Directive Tutorial!");
    expect(message).toContain("Step 1 of 7.");
    expect(message).toContain("about 10 minutes");
    expect(message).toContain("1. Signal");
    expect(message).toContain("2. Postcard");
    expect(message).toContain("3. Echo");
    expect(message).toContain("4. Leave");
    expect(message).toContain("progress is saved");
    expect(message).toContain("6. Back — not available yet (use Leave or Discuss)");
    expect(message).not.toContain("**Directive** —");
    expect(message).toContain("Something to keep in mind:");
    expect(message).not.toContain("Next:");
  });

  it("asks for content first, then confirms Plan/Done with the filled line", () => {
    const empty = projectFields(projects, "signal", null);
    const write = renderBeat(mustBeat("write"), glossary, empty);
    expect(write).toContain("Signal");
    expect(write).toContain("Alex — on the bridge.");
    expect(write).toContain("1. Use the example");
    expect(write).toContain("2. Leave");
    expect(write).toContain("**acceptance** —");
    expect(write).not.toContain("Do Plan and Done look right?");
    expect(write).not.toContain("{name}");
    expect(write).not.toContain("Command:");

    const afterContent = renderBeat(mustBeat("write"), glossary, fields, {
      contentReady: true,
    });
    expect(afterContent).toContain("Alex — on the bridge.");
    expect(afterContent).toContain("Do Plan and Done look right?");
    expect(afterContent).toContain("1. Yes");
    expect(afterContent).toContain("2. No — change the plan");
    expect(afterContent).toContain("3. Leave");
    expect(afterContent).not.toContain("**acceptance**");
    expect(afterContent).not.toContain("Something to keep in mind:");
    expect(afterContent).not.toContain("Use the example");

    const start = renderBeat(mustBeat("start"), glossary, fields);
    expect(start).toContain("**branch** —");
    expect(start).not.toContain("Command:");
    expect(fillBeat(mustBeat("start"), fields).command).toContain("feat/signal-prints-this-line");
  });

  it("shows verify/continue menus after the check instead of asking the person to rubber-stamp", () => {
    const change = renderBeat(mustBeat("change"), glossary, fields);
    expect(change).toContain("I will change only what this work owns");
    expect(change).toContain("Ready for me to write the files");

    const pass = renderBeat(mustBeat("result"), glossary, fields, {
      checkVerdict: true,
      checkPassed: true,
    });
    expect(pass).toContain("The acceptance check verified.");
    expect(pass).toContain("1. Continue");
    expect(pass).not.toContain("Did the acceptance check verify?");

    const fail = renderBeat(mustBeat("result"), glossary, fields, {
      checkVerdict: true,
      checkPassed: false,
    });
    expect(fail).toContain("did not verify");
    expect(fail).toContain("1. Try again");

    const pending = renderBeat(mustBeat("write"), glossary, fields, {
      workItemPending: true,
    });
    expect(pending).toContain("Next I'll write the proposed work file and save its path.");
    expect(pending).not.toContain("--work-item");

    const leave = renderBeat(mustBeat("leave"), glossary, fields);
    expect(leave).toContain("Step 7 of 7 — Wrap up.");
    expect(leave).toContain("Next up: set up your real project.");
  });

  it("renders the full wired session for a chosen project", () => {
    const messages = renderWiredSession(script, glossary, fields);
    expect(messages).toHaveLength(7);
    expect(messages[0]).toContain("Step 1 of 7.");
    expect(messages[6]).toContain("Step 7 of 7 — Wrap up.");
  });

  it("does not expand slots inside learner content or work-file paths", () => {
    const withLiteralSlots = projectFields(
      projects,
      "signal",
      "Say {name} aloud",
      "/tmp/{name}/xbrief/proposed/signal.xbrief.json",
    );
    expect(withLiteralSlots.content).toBe("Say {name} aloud");
    expect(withLiteralSlots.workItemPath).toContain("{name}");
    expect(withLiteralSlots.workItemPath).not.toContain("Signal");
    // Authored templates still expand {content}; the literal's `{name}` stays literal.
    expect(withLiteralSlots.workSentence).toBe("Signal prints this status line: Say {name} aloud");
  });

  it("quotes work-file paths and rewrites Windows proposed paths to active", () => {
    expect(shellQuotePathFor("linux", "/tmp/My Practice/xbrief/proposed/signal.xbrief.json")).toBe(
      "'/tmp/My Practice/xbrief/proposed/signal.xbrief.json'",
    );
    expect(shellQuotePathFor("linux", "/tmp/$USER/xbrief/proposed/signal.xbrief.json")).toBe(
      "'/tmp/$USER/xbrief/proposed/signal.xbrief.json'",
    );
    expect(shellQuotePathFor("linux", "/tmp/practice!/xbrief/proposed/signal.xbrief.json")).toBe(
      "'/tmp/practice!/xbrief/proposed/signal.xbrief.json'",
    );
    expect(shellQuotePathFor("linux", "/tmp/it's/xbrief/proposed/signal.xbrief.json")).toBe(
      `'/tmp/it'\\''s/xbrief/proposed/signal.xbrief.json'`,
    );
    expect(
      shellQuotePathFor("win32", String.raw`C:\My Practice\xbrief\proposed\signal.xbrief.json`),
    ).toBe(String.raw`"C:\My Practice\xbrief\proposed\signal.xbrief.json"`);
    expect(shellQuotePathFor("win32", String.raw`C:\say "hi"\signal.xbrief.json`)).toBe(
      String.raw`"C:\say ""hi""\signal.xbrief.json"`,
    );
    expect(activeWorkItemPath("xbrief\\proposed\\signal.xbrief.json")).toBe(
      "xbrief\\active\\signal.xbrief.json",
    );
    const withPath = projectFields(
      projects,
      "signal",
      "Alex — on the bridge.",
      "/tmp/My Practice/xbrief/proposed/signal.xbrief.json",
    );
    const start = fillBeat(mustBeat("start"), withPath);
    const quoted = shellQuotePath("/tmp/My Practice/xbrief/proposed/signal.xbrief.json");
    expect(start.command).toContain(`deft scope:promote -- ${quoted}`);
    expect(start.command).not.toMatch(/promote -- \/tmp\/My Practice\//);
    const close = fillBeat(mustBeat("close"), withPath);
    const activeQuoted = shellQuotePath("/tmp/My Practice/xbrief/active/signal.xbrief.json");
    expect(close.command).toContain(`deft scope:stamp-evidence -- ${activeQuoted}`);
    expect(close.command).toContain(`deft scope:complete -- ${activeQuoted}`);
    expect(close.command.indexOf("stamp-evidence")).toBeLessThan(
      close.command.indexOf("scope:complete"),
    );
  });
});
