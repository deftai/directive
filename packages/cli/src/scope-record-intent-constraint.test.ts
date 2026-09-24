import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./scope-record-intent-constraint.js";

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

describe("scope-record-intent-constraint CLI (#4541)", () => {
  it("prints usage", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(run(["--help"])).toBe(0);
  });

  it("refuses agent shells", () => {
    expect(
      run(["story.xbrief.json", "--actor", "scott", "--confirm"], {
        ...humanSeams,
        environ: { CURSOR_AGENT: "1" },
      }),
    ).toBe(2);
  });

  it("refuses agent shells even with mintedVia in-harness-ask (#5010)", () => {
    expect(
      run(
        ["story.xbrief.json", "--actor", "scott", "--confirm", "--minted-via=in-harness-ask"],
        {
          ...humanSeams,
          environ: { CURSOR_AGENT: "1" },
        },
      ),
    ).toBe(2);
  });

  it("mints a human record from the namespaced contract", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-mint-"));
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
          "x-directive/intentConstraint": {
            constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
          },
        },
      }),
      "utf8",
    );
    expect(run([xbrief, "--actor", "scott", "--confirm", "--project-root", root], humanSeams)).toBe(
      0,
    );
    const rec = JSON.parse(
      readFileSync(join(root, ".deft", "intent-constraint", "story-1.json"), "utf8"),
    ) as { humanApproval: { kind: string }; constraints: unknown[] };
    expect(rec.humanApproval.kind).toBe("operator");
    expect(rec.constraints).toEqual([
      { value: "1024", unit: "bytes", rejectionScope: "invocation" },
    ]);
  });

  it("records mintedVia in-harness-ask attestation (#5010)", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-mint-via-"));
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
          "x-directive/intentConstraint": {
            constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
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
          "scott",
          "--confirm",
          "--minted-via=in-harness-ask",
          "--project-root",
          root,
        ],
        humanSeams,
      ),
    ).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(root, ".deft", "intent-constraint", "story-1.json"), "utf8"),
    ) as { humanApproval: { mintedVia?: string } };
    expect(rec.humanApproval.mintedVia).toBe("in-harness-ask");
  });

  it("refuses unknown mintedVia", () => {
    expect(
      parseArgs(["story.xbrief.json", "--actor", "scott", "--minted-via", "agent"]).error,
    ).toMatch(/minted-via/);
  });

  it("refuses worker-declared baselineRef", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-mint-base-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const xbrief = join(root, "xbrief", "story.xbrief.json");
    writeFileSync(
      xbrief,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: "story-1",
          "x-directive/intentConstraint": {
            baselineRef: "HEAD",
            constraints: [{ value: "1024", unit: "bytes", rejectionScope: "invocation" }],
          },
        },
      }),
      "utf8",
    );
    expect(run([xbrief, "--actor", "scott", "--confirm", "--project-root", root], humanSeams)).toBe(
      2,
    );
  });
});
