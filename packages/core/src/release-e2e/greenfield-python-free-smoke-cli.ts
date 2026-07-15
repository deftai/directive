#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rehearseGreenfieldPythonFreeSmoke } from "./greenfield-python-free-smoke.js";

const DEFAULT_OVERALL_TIMEOUT_MS = 900_000;

function parseOverallTimeoutMs(): number {
  const raw = process.env.DEFT_GREENFIELD_OVERALL_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OVERALL_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OVERALL_TIMEOUT_MS;
}

function logProgress(message: string): void {
  process.stderr.write(`${message}\n`);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const skipWorkspacePrep = process.env.DEFT_GREENFIELD_SKIP_PREP === "1";
const overallTimeoutMs = parseOverallTimeoutMs();

let lastProgress = "starting";
let finished = false;

const onProgress = (message: string): void => {
  lastProgress = message;
  logProgress(message);
};

const failClosed = (reason: string, exitCode = 1): void => {
  if (finished) {
    return;
  }
  finished = true;
  process.stdout.write(`${reason}\n`);
  process.exit(exitCode);
};

const overallTimer = setTimeout(() => {
  failClosed(
    `greenfield-python-free-smoke FAIL: overall budget exceeded (${overallTimeoutMs}ms); last step: ${lastProgress}`,
    1,
  );
}, overallTimeoutMs);

process.on("SIGTERM", () => {
  failClosed(
    `greenfield-python-free-smoke FAIL: received SIGTERM during "${lastProgress}" — likely runner kill after hang (root cause: spawn pipe deadlock fixed in engine-invoke #2554)`,
    143,
  );
});

process.on("SIGINT", () => {
  failClosed(`greenfield-python-free-smoke FAIL: interrupted during "${lastProgress}"`, 130);
});

logProgress(
  `greenfield-python-free-smoke: starting (overall budget ${overallTimeoutMs}ms, skipPrep=${skipWorkspacePrep})`,
);

const [ok, reason] = rehearseGreenfieldPythonFreeSmoke(
  repoRoot,
  {},
  { skipWorkspacePrep, onProgress },
);
clearTimeout(overallTimer);
finished = true;
process.stdout.write(`${reason}\n`);
process.exit(ok ? 0 : 1);
