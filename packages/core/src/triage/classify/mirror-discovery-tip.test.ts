import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatMirrorDiscoveryDigestCues,
  formatMirrorDiscoveryTip,
  formatMirrorDiscoveryTipBody,
  isMirrorDiscoveryTipDue,
  MIRROR_DISCOVERY_ACK_COMMAND,
  MIRROR_DISCOVERY_ANTI_SWALLOW_RULE,
  MIRROR_DISCOVERY_DRY_RUN_COMMAND,
  MIRROR_DISCOVERY_EMPTY_ACTION_LABELS_HINT,
  MIRROR_DISCOVERY_NO_MATCH_DOMINATION_HINT,
  MIRROR_DISCOVERY_POLICY_SHOW_COMMAND,
  MIRROR_DISCOVERY_RECOMMENDED_ACTION_LABELS,
  MIRROR_DISCOVERY_STATE_FILE,
  maybeFormatMirrorDiscoveryTip,
  mirrorDiscoveryStateExists,
  parseMirrorDiscoveryState,
  readMirrorDiscoveryState,
  recordMirrorDiscoveryAcked,
  recordMirrorDiscoverySuccessfulDryRun,
  resolveMirrorDiscoveryStatePath,
} from "./mirror-discovery-tip.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t !== undefined) {
      rmSync(t, { recursive: true, force: true });
    }
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-mirror-discovery-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  return root;
}

describe("mirror discovery tip content (#3124)", () => {
  it("includes required existence + get-the-most content", () => {
    const body = formatMirrorDiscoveryTipBody();
    expect(body).toContain("default-on");
    expect(body).toContain(MIRROR_DISCOVERY_DRY_RUN_COMMAND);
    expect(body).toContain("--include-closed");
    expect(body).toContain("--apply");
    expect(body).toContain("never");
    expect(body).toMatch(/auto-accept|proposed\//i);
    expect(body).toContain("triaged");
    expect(body).toMatch(/control stamp|not a disposition/i);
    expect(body).toMatch(/Board usability is greatly decreased without `?actionLabels`?/i);
    expect(body).toContain("triage:deferred");
    expect(body).toContain("triage:archived");
    expect(body).toContain("triage:lifecycle-linked");
    expect(body).toContain("triage:needs-human");
    expect(body).toContain("triageAutoClassify");
    expect(body).toContain("PROJECT-DEFINITION");
    expect(body).toContain(MIRROR_DISCOVERY_POLICY_SHOW_COMMAND);
    expect(body).toMatch(/exist on GitHub/i);
    expect(body).toMatch(/before.*actionLabels|skips re-enrichment/i);
    expect(body).toContain("#2611");
    expect(body).toContain(MIRROR_DISCOVERY_ACK_COMMAND);
    expect(body).toContain(MIRROR_DISCOVERY_ANTI_SWALLOW_RULE);
    expect(MIRROR_DISCOVERY_RECOMMENDED_ACTION_LABELS.accept).toEqual(["triage:lifecycle-linked"]);
  });

  it("anti-swallow rule requires user-visible restatement of customization path", () => {
    expect(MIRROR_DISCOVERY_ANTI_SWALLOW_RULE).toContain("user-visible");
    expect(MIRROR_DISCOVERY_ANTI_SWALLOW_RULE).toContain("actionLabels");
    expect(MIRROR_DISCOVERY_ANTI_SWALLOW_RULE).toContain("triageAutoClassify");
    expect(MIRROR_DISCOVERY_ANTI_SWALLOW_RULE).toContain("#2611");
  });
});

describe("mirror discovery tip throttle (#3124)", () => {
  it("is not due after #4070 withdraw even when no state exists", () => {
    const root = tmpRoot();
    expect(isMirrorDiscoveryTipDue(root)).toBe(false);
    expect(maybeFormatMirrorDiscoveryTip(root)).toBe("");
  });

  it("does not emit or record shownAt", () => {
    const root = tmpRoot();
    const tip = maybeFormatMirrorDiscoveryTip(root, {
      now: new Date("2026-08-11T12:00:00.000Z"),
    });
    expect(tip).toBe("");
    expect(isMirrorDiscoveryTipDue(root)).toBe(false);
  });

  it("hides after successful dry-run", () => {
    const root = tmpRoot();
    expect(maybeFormatMirrorDiscoveryTip(root)).toBe("");
    recordMirrorDiscoverySuccessfulDryRun(root, {
      now: new Date("2026-08-11T13:00:00.000Z"),
    });
    expect(isMirrorDiscoveryTipDue(root)).toBe(false);
    expect(maybeFormatMirrorDiscoveryTip(root)).toBe("");
    const state = readMirrorDiscoveryState(root);
    expect(state.successfulDryRunAt).toBe("2026-08-11T13:00:00.000Z");
    // Second dry-run record is idempotent (keeps first timestamp).
    recordMirrorDiscoverySuccessfulDryRun(root, {
      now: new Date("2026-08-11T14:00:00.000Z"),
    });
    expect(readMirrorDiscoveryState(root).successfulDryRunAt).toBe("2026-08-11T13:00:00.000Z");
  });

  it("hides after operator ack", () => {
    const root = tmpRoot();
    recordMirrorDiscoveryAcked(root, { now: new Date("2026-08-11T15:00:00.000Z") });
    expect(isMirrorDiscoveryTipDue(root)).toBe(false);
    expect(maybeFormatMirrorDiscoveryTip(root)).toBe("");
  });

  it("parseMirrorDiscoveryState tolerates corrupt JSON", () => {
    expect(parseMirrorDiscoveryState("{")).toEqual({});
    expect(parseMirrorDiscoveryState(null)).toEqual({});
    expect(
      parseMirrorDiscoveryState(
        JSON.stringify({ shownAt: "t", ackedAt: "a", successfulDryRunAt: "d" }),
      ),
    ).toEqual({ shownAt: "t", ackedAt: "a", successfulDryRunAt: "d" });
  });

  it("recordShown=false evaluates without writing state", () => {
    const root = tmpRoot();
    const tip = maybeFormatMirrorDiscoveryTip(root, { recordShown: false });
    expect(tip).toBe("");
    expect(readMirrorDiscoveryState(root)).toEqual({});
  });
});

describe("mirror discovery digest cues (#3124)", () => {
  it("hints when planned with empty actionLabels", () => {
    const cues = formatMirrorDiscoveryDigestCues({
      planned: 10,
      applied: 0,
      skipped_no_match: 2,
      skipped_already_triaged: 0,
      skipped_closed: 0,
      actionLabelsEmpty: true,
      dry_run: true,
    });
    expect(cues).toContain(MIRROR_DISCOVERY_EMPTY_ACTION_LABELS_HINT);
  });

  it("hints when open no_match dominates", () => {
    const cues = formatMirrorDiscoveryDigestCues({
      planned: 5,
      applied: 0,
      skipped_no_match: 100,
      skipped_already_triaged: 0,
      skipped_closed: 640,
      actionLabelsEmpty: false,
      dry_run: true,
    });
    expect(cues).toContain(MIRROR_DISCOVERY_NO_MATCH_DOMINATION_HINT);
  });

  it("omits cues when neither condition holds", () => {
    const cues = formatMirrorDiscoveryDigestCues({
      planned: 50,
      applied: 0,
      skipped_no_match: 5,
      skipped_already_triaged: 10,
      skipped_closed: 0,
      actionLabelsEmpty: false,
      dry_run: true,
    });
    expect(cues).toEqual([]);
  });
});

describe("welcome surfaces tip (#3124 integration shape)", () => {
  it("state path lives under triage-cache", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
    const path = resolveMirrorDiscoveryStatePath(root);
    expect(path.replace(/\\/g, "/")).toMatch(
      /\.triage-cache\/scm-label-mirror-discovery-state\.json$/,
    );
  });
});

describe("mirror discovery tip branch residual (#3124 / #3287 hairline)", () => {
  it("parseMirrorDiscoveryState covers array / non-string field branches", () => {
    expect(parseMirrorDiscoveryState("[]")).toEqual({});
    expect(parseMirrorDiscoveryState("null")).toEqual({});
    expect(parseMirrorDiscoveryState(JSON.stringify({ shownAt: 1, ackedAt: null }))).toEqual({});
    expect(parseMirrorDiscoveryState(JSON.stringify({ ackedAt: "" }))).toEqual({ ackedAt: "" });
    // empty ackedAt does not hide tip
    const root = tmpRoot();
    const path = resolveMirrorDiscoveryStatePath(root);
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(path, JSON.stringify({ ackedAt: "", successfulDryRunAt: "" }), "utf8");
    expect(isMirrorDiscoveryTipDue(root)).toBe(false);
  });

  it("maybeFormat swallows writeState errors", () => {
    const root = tmpRoot();
    const tip = maybeFormatMirrorDiscoveryTip(root, {
      writeState: () => {
        throw new Error("disk full");
      },
    });
    expect(tip).toBe("");
  });

  it("custom readState/writeState and both digest cues together", () => {
    const root = tmpRoot();
    let written = "";
    const tip = maybeFormatMirrorDiscoveryTip(root, {
      now: new Date("2026-08-11T16:00:00.000Z"),
      readState: () => null,
      writeState: (_p, content) => {
        written = content;
      },
    });
    expect(tip).toBe("");
    expect(written).toBe("");
    const cues = formatMirrorDiscoveryDigestCues({
      planned: 10,
      applied: 2,
      skipped_no_match: 80,
      skipped_already_triaged: 5,
      skipped_closed: 0,
      actionLabelsEmpty: true,
      dry_run: true,
    });
    expect(cues.length).toBe(2);
    expect(cues).toContain(MIRROR_DISCOVERY_EMPTY_ACTION_LABELS_HINT);
    expect(cues).toContain(MIRROR_DISCOVERY_NO_MATCH_DOMINATION_HINT);
  });

  it("default filesystem write path creates state file", () => {
    const root = tmpRoot();
    expect(mirrorDiscoveryStateExists(root)).toBe(false);
    recordMirrorDiscoveryAcked(root, { now: new Date("2026-08-11T17:00:00.000Z") });
    expect(mirrorDiscoveryStateExists(root)).toBe(true);
    const state = readMirrorDiscoveryState(root);
    expect(state.ackedAt).toBe("2026-08-11T17:00:00.000Z");
  });

  it("formatMirrorDiscoveryTip ends with newline", () => {
    const tip = formatMirrorDiscoveryTip();
    expect(tip.endsWith("\n")).toBe(true);
    expect(formatMirrorDiscoveryTipBody().length).toBeGreaterThan(100);
  });
});
