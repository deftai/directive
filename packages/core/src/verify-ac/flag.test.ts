import { describe, expect, it } from "vitest";
import { parseRunSummaryJsonl } from "../run-summary/index.js";
import {
  commandCountFromFingerprint,
  flagPassAfterFailFromJsonl,
  flagPassAfterFailWithMethodChange,
  readVerificationAttempts,
  unresolvedMethodChangePasses,
} from "./flag.js";

function jsonl(
  events: readonly {
    check_id: string;
    method_fingerprint: string;
    outcome: "pass" | "fail";
    independent_rederivation?: boolean;
  }[],
): string {
  return events
    .map((payload, i) =>
      JSON.stringify({
        event: "verification",
        session_id: "s1",
        seq: i + 1,
        payload,
      }),
    )
    .join("\n");
}

describe("flagPassAfterFailWithMethodChange (#3322)", () => {
  it("does not flag fail then pass with the same method (product change)", () => {
    const flagged = flagPassAfterFailWithMethodChange([
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "pass",
        independent_rederivation: false,
        session_id: "s1",
      },
    ]);
    expect(flagged).toEqual([]);
  });

  it("flags fail then a different method then pass on one check id", () => {
    const flagged = flagPassAfterFailFromJsonl(
      jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        { check_id: "eq", method_fingerprint: "json-v2", outcome: "pass" },
      ]),
    );
    expect(flagged).toEqual([
      {
        check_id: "eq",
        failed_method: "diff-v1",
        passed_method: "json-v2",
        independent_rederivation: false,
      },
    ]);
    expect(unresolvedMethodChangePasses(flagged)).toHaveLength(1);
  });

  it("includes resolved_command_count_delta when the walk shrinks (#3397)", () => {
    const flagged = flagPassAfterFailFromJsonl(
      jsonl([
        {
          check_id: "eq",
          method_fingerprint: "vitest run a\0vitest run b\0vitest run c\0deadbeef",
          outcome: "fail",
        },
        {
          check_id: "eq",
          method_fingerprint: "true\0deadbeef",
          outcome: "pass",
        },
      ]),
    );
    expect(flagged[0]?.resolved_command_count_delta).toBe(-2);
  });

  it("reads command counts from walk fingerprints and legacy method ids", () => {
    expect(commandCountFromFingerprint("diff-v1")).toBe(1);
    expect(commandCountFromFingerprint("true\0/app")).toBe(1);
    expect(commandCountFromFingerprint("a\0b\0C:\\work")).toBe(2);
    expect(commandCountFromFingerprint("one\0two\0three")).toBe(3);
    expect(commandCountFromFingerprint("a\0b\0c\0deadbeef")).toBe(3);
  });

  it("treats recorded independent re-derivation as resolved", () => {
    const flagged = flagPassAfterFailFromJsonl(
      jsonl([
        { check_id: "eq", method_fingerprint: "diff-v1", outcome: "fail" },
        {
          check_id: "eq",
          method_fingerprint: "json-v2",
          outcome: "pass",
          independent_rederivation: true,
        },
      ]),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.independent_rederivation).toBe(true);
    expect(unresolvedMethodChangePasses(flagged)).toEqual([]);
  });

  it("keeps check ids independent", () => {
    const flagged = flagPassAfterFailFromJsonl(
      jsonl([
        { check_id: "a", method_fingerprint: "m1", outcome: "fail" },
        { check_id: "b", method_fingerprint: "m1", outcome: "fail" },
        { check_id: "b", method_fingerprint: "m1", outcome: "pass" },
        { check_id: "a", method_fingerprint: "m2", outcome: "pass" },
      ]),
    );
    expect(flagged).toEqual([
      {
        check_id: "a",
        failed_method: "m1",
        passed_method: "m2",
        independent_rederivation: false,
      },
    ]);
  });

  it("clears a same-method pass so a later method change is not stale-flagged", () => {
    const flagged = flagPassAfterFailWithMethodChange([
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "pass",
        independent_rederivation: false,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "json-v2",
        outcome: "pass",
        independent_rederivation: false,
        session_id: "s1",
      },
    ]);
    expect(flagged).toEqual([]);
  });

  it("flags fail A then fail B then pass B as a method change", () => {
    const flagged = flagPassAfterFailWithMethodChange([
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "json-v2",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "json-v2",
        outcome: "pass",
        independent_rederivation: false,
        session_id: "s1",
      },
    ]);
    expect(flagged).toEqual([
      {
        check_id: "eq",
        failed_method: "diff-v1",
        passed_method: "json-v2",
        independent_rederivation: false,
      },
    ]);
  });

  it("does not keep a re-derived pass as an active failure", () => {
    const flagged = flagPassAfterFailWithMethodChange([
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "json-v2",
        outcome: "pass",
        independent_rederivation: true,
        session_id: "s1",
      },
      {
        check_id: "eq",
        method_fingerprint: "csv-v3",
        outcome: "pass",
        independent_rederivation: false,
        session_id: "s1",
      },
    ]);
    expect(flagged).toEqual([
      {
        check_id: "eq",
        failed_method: "diff-v1",
        passed_method: "json-v2",
        independent_rederivation: true,
      },
    ]);
  });

  it("does not pair a fail in one session with a pass in another", () => {
    const flagged = flagPassAfterFailWithMethodChange([
      {
        check_id: "eq",
        method_fingerprint: "diff-v1",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "sess-old",
      },
      {
        check_id: "eq",
        method_fingerprint: "json-v2",
        outcome: "pass",
        independent_rederivation: false,
        session_id: "sess-new",
      },
    ]);
    expect(flagged).toEqual([]);
  });

  it("skips malformed verification lines", () => {
    const attempts = readVerificationAttempts(
      parseRunSummaryJsonl(
        [
          JSON.stringify({ event: "session_start", session_id: "s1", payload: {} }),
          JSON.stringify({
            event: "verification",
            session_id: "s1",
            payload: { check_id: "", method_fingerprint: "m", outcome: "fail" },
          }),
          JSON.stringify({
            event: "verification",
            session_id: "s1",
            payload: { check_id: "eq", method_fingerprint: "", outcome: "fail" },
          }),
          JSON.stringify({
            event: "verification",
            session_id: "s1",
            payload: { check_id: "eq", method_fingerprint: "m", outcome: "maybe" },
          }),
          JSON.stringify({
            event: "verification",
            session_id: "s1",
            payload: [],
          }),
          JSON.stringify({
            event: "verification",
            session_id: "s1",
            payload: null,
          }),
          JSON.stringify({
            event: "verification",
            session_id: "s1",
            payload: { check_id: "eq", method_fingerprint: "m", outcome: "fail" },
          }),
        ].join("\n"),
      ),
    );
    expect(attempts).toEqual([
      {
        check_id: "eq",
        method_fingerprint: "m",
        outcome: "fail",
        independent_rederivation: false,
        session_id: "s1",
      },
    ]);
  });
});
