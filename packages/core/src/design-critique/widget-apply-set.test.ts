import { describe, expect, it } from "vitest";
import {
  operatorVerbApplySet,
  WIDGET_ACCEPT,
  WIDGET_ACCEPT_SYNTHESIS,
  WIDGET_BACK,
  WIDGET_DISCUSS,
  WIDGET_HALT,
  WIDGET_POST_TABLE,
  WIDGET_RETRY,
  WIDGET_WALK,
  WIDGET_WALK_ALL,
} from "./widget-apply-set.js";

describe("operatorVerbApplySet (#4202)", () => {
  it("treats a menu with no posted successor lean as a miss", () => {
    const result = operatorVerbApplySet({
      successorLeanPosted: false,
      disagreeCount: 1,
      residualHeadingCount: 1,
      autoStamp: false,
    });
    expect(result.miss).toBe(true);
    expect(result.verbs).toEqual([]);
  });

  it("prints no operator verbs on the auto-stamp path", () => {
    const result = operatorVerbApplySet({
      successorLeanPosted: true,
      disagreeCount: 0,
      residualHeadingCount: 0,
      autoStamp: true,
    });
    expect(result.miss).toBe(false);
    expect(result.verbs).toEqual([]);
    expect(result.numbered.map((row) => row.label)).toEqual([WIDGET_DISCUSS, WIDGET_BACK]);
  });

  it("does not print retry when residual headings are empty", () => {
    const result = operatorVerbApplySet({
      successorLeanPosted: true,
      disagreeCount: 1,
      residualHeadingCount: 0,
      autoStamp: false,
    });
    expect(result.verbs).not.toContain(WIDGET_RETRY);
    expect(result.verbs).toContain(WIDGET_WALK);
    expect(result.verbs).toContain(WIDGET_WALK_ALL);
    expect(result.verbs).toContain(WIDGET_ACCEPT);
  });

  it("prints retry only when residual headings are named", () => {
    const result = operatorVerbApplySet({
      successorLeanPosted: true,
      disagreeCount: 1,
      residualHeadingCount: 2,
      autoStamp: false,
    });
    expect(result.verbs).toEqual([
      WIDGET_ACCEPT,
      WIDGET_WALK,
      WIDGET_WALK_ALL,
      WIDGET_RETRY,
      WIDGET_POST_TABLE,
      WIDGET_ACCEPT_SYNTHESIS,
      WIDGET_HALT,
    ]);
  });

  it("does not print walk when no take is disagree", () => {
    const result = operatorVerbApplySet({
      successorLeanPosted: true,
      disagreeCount: 0,
      residualHeadingCount: 0,
      autoStamp: false,
    });
    expect(result.verbs).toEqual([WIDGET_ACCEPT, WIDGET_HALT]);
    expect(result.verbs).not.toContain(WIDGET_WALK);
    expect(result.verbs).not.toContain(WIDGET_WALK_ALL);
    expect(result.verbs).not.toContain(WIDGET_POST_TABLE);
    expect(result.verbs).not.toContain(WIDGET_ACCEPT_SYNTHESIS);
  });

  it("ends every numbered widget with Discuss then Back", () => {
    const result = operatorVerbApplySet({
      successorLeanPosted: true,
      disagreeCount: 1,
      residualHeadingCount: 1,
      autoStamp: false,
    });
    const labels = result.numbered.map((row) => row.label);
    expect(labels.slice(-2)).toEqual([WIDGET_DISCUSS, WIDGET_BACK]);
    expect(result.numbered.map((row) => row.n)).toEqual(labels.map((_, index) => index + 1));
  });
});
