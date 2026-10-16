import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as containedWriteMod from "../fs/contained-write.js";
import {
  clearPlanSequence,
  planSequenceGenerationPath,
  planSequenceLockPath,
  planSequencePath,
  readPlanSequence,
  writePlanSequence,
} from "./store.js";
import { createPlanSequence, isClosedPlanSequenceShape } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), "ps-store-"));
  roots.push(root);
  return root;
}

function sample(id = "s") {
  return createPlanSequence({
    sequence_id: id,
    sequence_kind: "checklist",
    authorized_by: "op",
    entries: [
      { id: "1", kind: "task" },
      { id: "2", kind: "task" },
    ],
  });
}

describe("plan-sequence store", () => {
  it("planSequencePath lives under .deft", () => {
    expect(planSequencePath("/tmp/proj").replace(/\\/g, "/")).toMatch(
      /\.deft\/plan-sequence\.json$/,
    );
  });

  it("round-trips write/read/clear with expected_generation", () => {
    const root = seed();
    const seq = sample();
    const written = writePlanSequence(root, seq, 0, { sourceRevision: "abc" });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.sequence.generation).toBe(1);
    expect(written.sequence.source_revision).toBe("abc");
    expect(readPlanSequence(root)?.generation).toBe(1);
    const cleared = clearPlanSequence(root, 1);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.removed).toBe(true);
    expect(readPlanSequence(root)).toBeNull();
    expect(existsSync(planSequenceLockPath(root))).toBe(false);
    expect(JSON.parse(readFileSync(planSequenceGenerationPath(root), "utf8"))).toEqual({
      generation: 2,
    });
  });

  it("persists the generation sidecar before the plan file", () => {
    const root = seed();
    const first = writePlanSequence(root, sample("a"), 0);
    expect(first.ok).toBe(true);
    const genPath = planSequenceGenerationPath(root);
    const planPath = planSequencePath(root);
    const genBefore = readFileSync(genPath, "utf8");
    const planBefore = readFileSync(planPath, "utf8");
    const origRename = containedWriteMod.containedRename;
    const rename = vi.spyOn(containedWriteMod, "containedRename").mockImplementation((input) => {
      if (input.to === planPath) {
        throw new Error("simulated published rename failure");
      }
      return origRename(input);
    });
    let failed: ReturnType<typeof writePlanSequence>;
    try {
      failed = writePlanSequence(root, sample("b"), 1);
    } finally {
      rename.mockRestore();
    }
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("persist-error");
    expect(readFileSync(genPath, "utf8")).not.toBe(genBefore);
    expect(JSON.parse(readFileSync(genPath, "utf8")).generation).toBe(2);
    expect(readFileSync(planPath, "utf8")).toBe(planBefore);
  });

  it("leaves the previous generation token intact when sidecar replace fails", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("a"), 0).ok).toBe(true);
    expect(clearPlanSequence(root, 1).ok).toBe(true);
    const genPath = planSequenceGenerationPath(root);
    const before = readFileSync(genPath, "utf8");
    const rename = vi.spyOn(containedWriteMod, "containedRename").mockImplementation(() => {
      throw new Error("simulated generation sidecar rename failure");
    });
    let failed: ReturnType<typeof writePlanSequence>;
    try {
      failed = writePlanSequence(root, sample("b"), 2);
    } finally {
      rename.mockRestore();
    }
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("persist-error");
      expect(failed.message).toMatch(/simulated generation sidecar rename failure/);
    }
    expect(readFileSync(genPath, "utf8")).toBe(before);
    expect(JSON.parse(before)).toEqual({ generation: 2 });
    expect(readPlanSequence(root)).toBeNull();
  });

  it("keeps a generation token across clear so recreate cannot reuse generation 1", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("a"), 0, { sourceRevision: "a" }).ok).toBe(true);
    expect(clearPlanSequence(root, 1).ok).toBe(true);
    const staleCreate = writePlanSequence(root, sample("stale"), 0, { sourceRevision: "stale" });
    expect(staleCreate.ok).toBe(false);
    if (!staleCreate.ok) {
      expect(staleCreate.code).toBe("generation-mismatch");
      expect(staleCreate.current_generation).toBe(2);
    }
    expect(readPlanSequence(root)).toBeNull();
    const replacement = writePlanSequence(root, sample("b"), 2, { sourceRevision: "b" });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.sequence.generation).toBe(3);
    expect(replacement.sequence.sequence_id).toBe("b");
    const staleWrite = writePlanSequence(root, sample("c"), 1, { sourceRevision: "c" });
    expect(staleWrite.ok).toBe(false);
    if (!staleWrite.ok) expect(staleWrite.code).toBe("generation-mismatch");
    const staleClear = clearPlanSequence(root, 1);
    expect(staleClear.ok).toBe(false);
    if (!staleClear.ok) expect(staleClear.code).toBe("generation-mismatch");
    expect(readPlanSequence(root)?.sequence_id).toBe("b");
    expect(readPlanSequence(root)?.generation).toBe(3);
  });

  it("returns already-absent without bumping the surviving generation token", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("a"), 0, { sourceRevision: "a" }).ok).toBe(true);
    expect(clearPlanSequence(root, 1).ok).toBe(true);
    const again = clearPlanSequence(root, 2);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.removed).toBe(false);
    expect(JSON.parse(readFileSync(planSequenceGenerationPath(root), "utf8"))).toEqual({
      generation: 2,
    });
  });

  it("prefers the sequence generation when the sidecar is stale", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("live"), 0, { sourceRevision: "live" }).ok).toBe(true);
    writeFileSync(planSequenceGenerationPath(root), `${JSON.stringify({ generation: 99 })}\n`);
    const staleSidecar = writePlanSequence(root, sample("next"), 99, { sourceRevision: "next" });
    expect(staleSidecar.ok).toBe(false);
    if (!staleSidecar.ok) {
      expect(staleSidecar.code).toBe("generation-mismatch");
      expect(staleSidecar.current_generation).toBe(1);
    }
    const next = writePlanSequence(root, sample("next"), 1, { sourceRevision: "next" });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.sequence.generation).toBe(2);
    expect(JSON.parse(readFileSync(planSequenceGenerationPath(root), "utf8"))).toEqual({
      generation: 2,
    });
  });

  it("fail-closes when the generation sidecar cannot be parsed after clear", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("a"), 0, { sourceRevision: "a" }).ok).toBe(true);
    expect(clearPlanSequence(root, 1).ok).toBe(true);
    const sidecar = planSequenceGenerationPath(root);
    writeFileSync(sidecar, "{not-json\n");
    const broken = writePlanSequence(root, sample("b"), 2, { sourceRevision: "b" });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe("parse-error");
    writeFileSync(sidecar, "[]\n");
    const arraySidecar = writePlanSequence(root, sample("b"), 2);
    expect(arraySidecar.ok).toBe(false);
    if (!arraySidecar.ok) expect(arraySidecar.code).toBe("parse-error");
    writeFileSync(sidecar, `${JSON.stringify({ generation: -1 })}\n`);
    const negative = clearPlanSequence(root, 2);
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.code).toBe("parse-error");
    expect(readPlanSequence(root)).toBeNull();
  });

  it("fail-closes when expected_generation is missing or non-integer", () => {
    const root = seed();
    const seq = sample();
    expect(writePlanSequence(root, seq, Number.NaN).ok).toBe(false);
    expect(writePlanSequence(root, seq, 1.5).ok).toBe(false);
    const missing = clearPlanSequence(root, undefined as unknown as number);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("missing-expected-generation");
    expect(existsSync(planSequencePath(root))).toBe(false);
  });

  it("rejects a stale expected generation without writing", () => {
    const root = seed();
    const first = writePlanSequence(root, sample("a"), 0, { sourceRevision: "r1" });
    expect(first.ok).toBe(true);
    const stale = writePlanSequence(root, sample("b"), 0, { sourceRevision: "r2" });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("generation-mismatch");
    expect(stale.current_generation).toBe(1);
    expect(readPlanSequence(root)?.sequence_id).toBe("a");
    expect(readPlanSequence(root)?.generation).toBe(1);
  });

  it("treats a legacy missing generation as expected 0 and does not write anyway", () => {
    const root = seed();
    const path = planSequencePath(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        sequence_id: "legacy",
        sequence_kind: "checklist",
        entries: [{ id: "1", kind: "task" }],
        current_index: 0,
        batching_allowed: false,
        continuation_past_final: false,
        exhausted: false,
        authorized_by: "op",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      })}\n`,
    );
    const anyway = writePlanSequence(root, sample("nope"), 1);
    expect(anyway.ok).toBe(false);
    if (!anyway.ok) expect(anyway.current_generation).toBe(0);
    expect(readPlanSequence(root)?.sequence_id).toBe("legacy");
    const migrated = writePlanSequence(root, sample("migrated"), 0, { sourceRevision: "mig" });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.sequence.generation).toBe(1);
    expect(readPlanSequence(root)?.sequence_id).toBe("migrated");
  });

  it("does not import occupancy or the PROJECT-DEFINITION lock", () => {
    const storeSrc = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const lockSrc = readFileSync(new URL("./mutation-lock.ts", import.meta.url), "utf8");
    expect(storeSrc).not.toMatch(/occupancy/);
    expect(lockSrc).not.toMatch(/occupancy/);
    expect(storeSrc).not.toMatch(/projectDefinitionMutationLock/);
    expect(lockSrc).not.toMatch(/projectDefinitionMutationLock/);
    expect(storeSrc).not.toMatch(/unlinkSync/);
  });

  it("admits generation and source_revision on the closed shape", () => {
    const seq = writePlanSequence(seed(), sample(), 0, { sourceRevision: "deadbeef" });
    expect(seq.ok).toBe(true);
    if (!seq.ok) return;
    expect(isClosedPlanSequenceShape(seq.sequence)).toBe(true);
    expect(isClosedPlanSequenceShape({ ...seq.sequence, extra_authority: true })).toBe(false);
  });

  it("returns lock-reentrant when a holder nests another mutation", () => {
    const root = seed();
    let nestedCode: string | undefined;
    const first = writePlanSequence(root, sample("outer"), 0, {
      sourceRevision: "outer",
      afterAcquire: () => {
        const nested = writePlanSequence(root, sample("inner"), 0);
        expect(nested.ok).toBe(false);
        if (!nested.ok) nestedCode = nested.code;
      },
    });
    expect(first.ok).toBe(true);
    expect(nestedCode).toBe("lock-reentrant");
    expect(readPlanSequence(root)?.sequence_id).toBe("outer");
  });

  it("returns lock-timeout when a live owner holds the sidecar", () => {
    const root = seed();
    const lockPath = planSequenceLockPath(root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, `${process.pid}-${"ab".repeat(16)}`),
      `${JSON.stringify({ pid: process.pid, token: "ab".repeat(16) })}\n`,
    );
    const timedOut = writePlanSequence(root, sample(), 0, {
      lock: { acquisitionBudgetMs: 0, sleepMs: () => undefined },
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.code).toBe("lock-timeout");
    expect(readPlanSequence(root)).toBeNull();
  });

  it("reaps a dead-PID sidecar and then mutates", () => {
    const root = seed();
    const lockPath = planSequenceLockPath(root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, `999999999-${"cd".repeat(16)}`), "{}\n");
    const written = writePlanSequence(root, sample("reap"), 0, { sourceRevision: "reap" });
    expect(written.ok).toBe(true);
    expect(readPlanSequence(root)?.sequence_id).toBe("reap");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses mutation when the on-disk record cannot be parsed", () => {
    const root = seed();
    const path = planSequencePath(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(path, "{not-json\n");
    const written = writePlanSequence(root, sample(), 0);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.code).toBe("parse-error");
    const cleared = clearPlanSequence(root, 0);
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) expect(cleared.code).toBe("parse-error");
    expect(readFileSync(path, "utf8")).toBe("{not-json\n");
  });

  it("clears a damaged published plan using the surviving generation token", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("a"), 0, { sourceRevision: "a" }).ok).toBe(true);
    const path = planSequencePath(root);
    writeFileSync(path, "{not-json\n");
    const cleared = clearPlanSequence(root, 1);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(readFileSync(planSequenceGenerationPath(root), "utf8"))).toEqual({
      generation: 2,
    });
    const next = writePlanSequence(root, sample("b"), 2, { sourceRevision: "b" });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.sequence.generation).toBe(3);
  });

  it("refuses mutation when on-disk generation is present but not a non-negative integer", () => {
    const root = seed();
    const path = planSequencePath(root);
    expect(writePlanSequence(root, sample("bad-gen"), 0, { sourceRevision: "bad-gen" }).ok).toBe(
      true,
    );
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    parsed.generation = -1;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`);
    const written = writePlanSequence(root, sample("next"), 0);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.code).toBe("parse-error");
    expect(JSON.parse(readFileSync(path, "utf8")) as { generation: unknown }).toEqual(
      expect.objectContaining({ generation: -1, sequence_id: "bad-gen" }),
    );
  });

  it("rejects a stale expected generation on clear without unlinking", () => {
    const root = seed();
    expect(writePlanSequence(root, sample("keep"), 0, { sourceRevision: "keep" }).ok).toBe(true);
    const stale = clearPlanSequence(root, 0);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("generation-mismatch");
    expect(readPlanSequence(root)?.sequence_id).toBe("keep");
  });

  it("times out on a legacy file sidecar and leaves the file in place", () => {
    const root = seed();
    const lockPath = planSequenceLockPath(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(lockPath, "legacy-lock\n");
    const timedOut = writePlanSequence(root, sample(), 0, {
      lock: { acquisitionBudgetMs: 0, sleepMs: () => undefined },
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.code).toBe("lock-timeout");
      expect(timedOut.message).toContain("legacy-file-sidecar");
      expect(timedOut.message).toContain("plan-sequence");
    }
    expect(readFileSync(lockPath, "utf8")).toBe("legacy-lock\n");
    const cleared = clearPlanSequence(root, 0, {
      lock: { acquisitionBudgetMs: 0, sleepMs: () => undefined },
    });
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) expect(cleared.code).toBe("lock-timeout");
  });

  it("times out on a malformed lock directory and unknown owner liveness", () => {
    const root = seed();
    const lockPath = planSequenceLockPath(root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "junk"), "x\n");
    const malformed = writePlanSequence(root, sample(), 0, {
      lock: { acquisitionBudgetMs: 0, sleepMs: () => undefined },
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.message).toContain("malformed-lock-directory");
    rmSync(join(lockPath, "junk"));
    writeFileSync(join(lockPath, `${process.pid}-${"ef".repeat(16)}`), "{}\n");
    const unknown = writePlanSequence(root, sample(), 0, {
      lock: {
        acquisitionBudgetMs: 0,
        sleepMs: () => undefined,
        probeProcess: () => "unknown",
      },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("owner-liveness-unknown");
  });

  it("treats a contended rmdir during dead-PID reap as lock-timeout", () => {
    const root = seed();
    const lockPath = planSequenceLockPath(root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, `999999998-${"ab".repeat(16)}`), "{}\n");
    const timedOut = writePlanSequence(root, sample(), 0, {
      lock: {
        acquisitionBudgetMs: 0,
        sleepMs: () => undefined,
        probeProcess: () => "dead",
        beforeLockDirRemove: (observed) => {
          writeFileSync(join(observed, "extra"), "x\n");
        },
      },
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.code).toBe("lock-timeout");
  });

  it("fail-closes a short owner write and unexpected rename errors", () => {
    const root = seed();
    const short = writePlanSequence(root, sample(), 0, {
      lock: { writeOwner: () => 0 },
    });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.code).toBe("lock-timeout");
      expect(short.message).toMatch(/short write/);
    }
    const boom = writePlanSequence(root, sample(), 0, {
      lock: {
        renameLock: () => {
          const err = new Error("boom") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        },
      },
    });
    expect(boom.ok).toBe(false);
    if (!boom.ok) {
      expect(boom.code).toBe("lock-timeout");
      expect(boom.message).toMatch(/boom/);
    }
  });
});

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    const tick = (): void => {
      if (existsSync(path)) {
        resolveWait();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        rejectWait(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function runOverlapWorker(input: {
  readonly root: string;
  readonly resultPath: string;
  readonly op: "advance" | "replace" | "clear";
  readonly expected: number;
  readonly holdMs: number;
  readonly startPath: string;
  readonly readyPath: string;
  readonly inputPath: string;
}): Promise<void> {
  const workerPath = join(input.root, `worker-${input.op}-${basename(input.resultPath)}.mjs`);
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const typesUrl = new URL("./types.ts", import.meta.url).href;
  writeFileSync(
    workerPath,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";\n` +
      `import { advancePlanSequence, createPlanSequence } from ${JSON.stringify(typesUrl)};\n` +
      `import { clearPlanSequence, readPlanSequence, writePlanSequence } from ${JSON.stringify(storeUrl)};\n` +
      `const [root, resultPath, op, expectedRaw, holdRaw, startPath, readyPath, inputPath] = process.argv.slice(2);\n` +
      `const expected = Number(expectedRaw);\n` +
      `const holdMs = Number(holdRaw);\n` +
      `const hold = () => { const until = Date.now() + holdMs; while (Date.now() < until) {} };\n` +
      `let snapshot = null;\n` +
      `if (op === "advance") {\n` +
      `  snapshot = readPlanSequence(root);\n` +
      `  if (snapshot === null) throw new Error("missing sequence");\n` +
      `} else if (op === "replace") {\n` +
      `  snapshot = createPlanSequence({\n` +
      `    sequence_id: "replacement",\n` +
      `    sequence_kind: "checklist",\n` +
      `    authorized_by: "op",\n` +
      `    entries: [{ id: "r", kind: "task" }],\n` +
      `  });\n` +
      `}\n` +
      `writeFileSync(inputPath, JSON.stringify({ op, expected, snapshot }) + "\\n");\n` +
      `writeFileSync(readyPath, "ready\\n");\n` +
      `const waitStart = Date.now();\n` +
      `while (!existsSync(startPath)) {\n` +
      `  if (Date.now() - waitStart > 5000) throw new Error("start gate timeout");\n` +
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n` +
      `}\n` +
      `const saved = JSON.parse(readFileSync(inputPath, "utf8"));\n` +
      `let result;\n` +
      `if (saved.op === "clear") {\n` +
      `  result = clearPlanSequence(root, saved.expected, { afterAcquire: hold });\n` +
      `} else if (saved.op === "replace") {\n` +
      `  result = writePlanSequence(root, saved.snapshot, saved.expected, { afterAcquire: hold, sourceRevision: "replace" });\n` +
      `} else {\n` +
      `  result = writePlanSequence(root, advancePlanSequence(saved.snapshot), saved.expected, { afterAcquire: hold, sourceRevision: "advance" });\n` +
      `}\n` +
      `writeFileSync(resultPath, JSON.stringify(result) + "\\n");\n`,
  );
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        workerPath,
        input.root,
        input.resultPath,
        input.op,
        String(input.expected),
        String(input.holdMs),
        input.startPath,
        input.readyPath,
        input.inputPath,
      ],
      { env: { ...process.env, DEFT_PROJECT_PATH: "" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectWorker);
    child.on("exit", (code) => {
      if (code === 0) resolveWorker();
      else rejectWorker(new Error(`${input.op} exited ${code}: ${stderr}`));
    });
  });
}

async function overlap(opA: "advance" | "replace" | "clear", opB: "advance" | "replace" | "clear") {
  const root = seed();
  const first = writePlanSequence(root, sample("seed"), 0, { sourceRevision: "seed" });
  expect(first.ok).toBe(true);
  const startPath = join(root, "start");
  const aReady = join(root, "a.ready");
  const bReady = join(root, "b.ready");
  const aResult = join(root, "a.json");
  const bResult = join(root, "b.json");
  const running = Promise.all([
    runOverlapWorker({
      root,
      resultPath: aResult,
      op: opA,
      expected: 1,
      holdMs: 80,
      startPath,
      readyPath: aReady,
      inputPath: join(root, "a.input.json"),
    }),
    runOverlapWorker({
      root,
      resultPath: bResult,
      op: opB,
      expected: 1,
      holdMs: 80,
      startPath,
      readyPath: bReady,
      inputPath: join(root, "b.input.json"),
    }),
  ]);
  await waitForFile(aReady, 5000);
  await waitForFile(bReady, 5000);
  writeFileSync(startPath, "go\n");
  await running;
  const a = JSON.parse(readFileSync(aResult, "utf8")) as { ok: boolean; code?: string };
  const b = JSON.parse(readFileSync(bResult, "utf8")) as { ok: boolean; code?: string };
  const wins = [a, b].filter((r) => r.ok);
  const losses = [a, b].filter((r) => !r.ok);
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);
  expect(losses[0]?.code).toBe("generation-mismatch");
  expect(existsSync(planSequenceLockPath(root))).toBe(false);
  return { root, a, b };
}

describe("plan-sequence two-process overlap (#3907)", () => {
  it("serializes advance-versus-advance so only one mints N+1", async () => {
    const { root } = await overlap("advance", "advance");
    const loaded = readPlanSequence(root);
    expect(loaded?.generation).toBe(2);
    expect(loaded?.current_index).toBe(1);
    expect(loaded?.entries.filter((e) => e.status === "completed")).toHaveLength(1);
  });

  it("serializes replace-versus-advance", async () => {
    const { root } = await overlap("replace", "advance");
    const loaded = readPlanSequence(root);
    expect(loaded?.generation).toBe(2);
    const replaced = loaded?.sequence_id === "replacement";
    const advanced = loaded?.sequence_id === "seed" && loaded.current_index === 1;
    expect(replaced || advanced).toBe(true);
  });

  it("serializes clear-versus-advance", async () => {
    const { root } = await overlap("clear", "advance");
    const loaded = readPlanSequence(root);
    if (loaded === null) {
      expect(existsSync(planSequencePath(root))).toBe(false);
    } else {
      expect(loaded.generation).toBe(2);
      expect(loaded.current_index).toBe(1);
    }
  });
});
