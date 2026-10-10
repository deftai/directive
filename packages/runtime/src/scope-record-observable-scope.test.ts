import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./scope-record-observable-scope.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const humanSeams = {
  isTty: () => true,
  hasControllingTerminal: () => true,
  readInteractiveConfirm: () => "mint",
  environ: {},
};

describe("scope-record-observable-scope CLI (#4495)", () => {
  it("prints usage", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(run(["--help"])).toBe(0);
  });

  it("refuses agent shells", () => {
    expect(
      run(["story.xbrief.json", "--actor", "david", "--confirm"], {
        ...humanSeams,
        environ: { CURSOR_AGENT: "1" },
      }),
    ).toBe(2);
  });

  it("refuses agent shells even with mintedVia in-harness-ask (#5010)", () => {
    expect(
      run(["story.xbrief.json", "--actor", "scott", "--confirm", "--minted-via=in-harness-ask"], {
        ...humanSeams,
        environ: { CURSOR_AGENT: "1" },
      }),
    ).toBe(2);
  });

  it("mints a human record from the namespaced contract", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-mint-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const xbrief = join(root, "xbrief", "pending", "story.xbrief.json");
    writeFileSync(
      xbrief,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-1",
          title: "T",
          status: "pending",
          items: [],
          "x-directive/observableChange": {
            changeKind: "fields-only",
            allowedChanges: [{ kind: "control", op: "add", name: "email" }],
          },
        },
      }),
      "utf8",
    );
    expect(run([xbrief, "--actor", "david", "--confirm", "--project-root", root], humanSeams)).toBe(
      0,
    );
    const rec = JSON.parse(
      readFileSync(join(root, ".deft", "observable-scope", "story-1.json"), "utf8"),
    ) as { humanApproval: { kind: string }; allowedChanges: unknown[] };
    expect(rec.humanApproval.kind).toBe("operator");
    expect(rec.allowedChanges).toEqual([{ kind: "control", op: "add", name: "email" }]);
  });

  it("records mintedVia in-harness-ask attestation (#5010)", () => {
    const root = mkdtempSync(join(tmpdir(), "os-mint-via-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const xbrief = join(root, "xbrief", "pending", "story.xbrief.json");
    writeFileSync(
      xbrief,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-ui",
          title: "T",
          status: "pending",
          items: [],
          "x-directive/observableChange": {
            changeKind: "fields-only",
            allowedChanges: [{ kind: "heading", op: "add", name: "Title" }],
          },
        },
      }),
      "utf8",
    );
    expect(
      run(
        [
          xbrief,
          "--actor",
          "david",
          "--confirm",
          "--minted-via",
          "in-harness-ask",
          "--project-root",
          root,
        ],
        humanSeams,
      ),
    ).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(root, ".deft", "observable-scope", "story-ui.json"), "utf8"),
    ) as { humanApproval: { mintedVia?: string } };
    expect(rec.humanApproval.mintedVia).toBe("in-harness-ask");
  });

  it("refuses worker-declared baselineRef", () => {
    const root = mkdtempSync(join(tmpdir(), "obs-mint-base-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const xbrief = join(root, "xbrief", "story.xbrief.json");
    writeFileSync(
      xbrief,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-1",
          "x-directive/observableChange": {
            baselineRef: "HEAD",
            allowedChanges: [{ kind: "control", op: "add", name: "email" }],
          },
        },
      }),
      "utf8",
    );
    expect(run([xbrief, "--actor", "david", "--confirm", "--project-root", root], humanSeams)).toBe(
      2,
    );
  });
});
