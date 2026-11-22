import { describe, expect, it } from "vitest";
import { isHumanApprovalStamp } from "./digest.js";
import {
  DECLARED_RECORD_WRITER_VERBS,
  DECLARED_STAMP_KIND,
  INTENT_CONSTRAINT_WRITER_VERB,
  isDeclaredRecordStamp,
  isRecordStamp,
  OBSERVABLE_SCOPE_WRITER_VERB,
} from "./record-stamp.js";

const declared = (mintedVia: string, actor = "agent:leaf") => ({
  kind: DECLARED_STAMP_KIND,
  actor,
  mintedAt: "2026-11-22T00:00:00Z",
  mintedVia,
});

describe("declared record stamps (#7031)", () => {
  it("names the two declared writers", () => {
    expect(DECLARED_STAMP_KIND).toBe("declared");
    expect([...DECLARED_RECORD_WRITER_VERBS]).toEqual([
      "scope:record-observable-scope",
      "scope:record-intent-constraint",
    ]);
  });

  it("accepts a declared stamp from the record's own writer, any actor", () => {
    for (const verb of DECLARED_RECORD_WRITER_VERBS) {
      expect(isDeclaredRecordStamp(declared(verb), verb)).toBe(true);
      expect(isRecordStamp(declared(verb, "unspecified"), verb)).toBe(true);
    }
  });

  it("refuses a declared stamp from another verb, without mintedAt, or with another kind", () => {
    expect(
      isRecordStamp(declared(INTENT_CONSTRAINT_WRITER_VERB), OBSERVABLE_SCOPE_WRITER_VERB),
    ).toBe(false);
    expect(isRecordStamp(declared("in-harness-ask"), INTENT_CONSTRAINT_WRITER_VERB)).toBe(false);
    expect(
      isRecordStamp(
        { ...declared(INTENT_CONSTRAINT_WRITER_VERB), mintedAt: " " },
        INTENT_CONSTRAINT_WRITER_VERB,
      ),
    ).toBe(false);
    expect(
      isRecordStamp(
        { ...declared(INTENT_CONSTRAINT_WRITER_VERB), kind: "Declared" },
        INTENT_CONSTRAINT_WRITER_VERB,
      ),
    ).toBe(false);
    expect(isRecordStamp(null, INTENT_CONSTRAINT_WRITER_VERB)).toBe(false);
  });

  it("still accepts legacy human stamps, including in-harness-ask", () => {
    const legacy = { kind: "operator", actor: "scott", mintedAt: "2026-09-15T00:00:00Z" };
    expect(isRecordStamp(legacy, OBSERVABLE_SCOPE_WRITER_VERB)).toBe(true);
    expect(
      isRecordStamp({ ...legacy, mintedVia: "in-harness-ask" }, INTENT_CONSTRAINT_WRITER_VERB),
    ).toBe(true);
    expect(
      isRecordStamp(
        { kind: "agent", actor: "agent:leaf", mintedAt: "2026-09-15T00:00:00Z" },
        INTENT_CONSTRAINT_WRITER_VERB,
      ),
    ).toBe(false);
  });

  it("isHumanApprovalStamp still rejects a declared stamp (approved-scope, one-PR proof)", () => {
    for (const verb of DECLARED_RECORD_WRITER_VERBS) {
      expect(isHumanApprovalStamp(declared(verb, "scott"))).toBe(false);
    }
  });
});
