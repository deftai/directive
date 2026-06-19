import { randomUUID } from "node:crypto";
import { disclosureLine } from "../policy/disclosure.js";
import { resolvePolicy } from "../policy/resolve.js";
import { runDefaultMode } from "../triage/welcome/default-mode.js";
import { verifyRequiredTools } from "../verify-env/verify-tools.js";
import type { GitRunner } from "./git.js";
import { defaultGitRunner, gitHead, worktreePath } from "./git.js";
import {
  newRitualStatePayload,
  ritualStatePath,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";

export const QUICK_STEPS = ["alignment", "branch_policy", "triage_welcome"] as const;
export const GATED_STEPS = ["doctor", "cache_fresh"] as const;

const STEP_ALIASES: Record<string, string> = {
  branch: "branch_policy",
  "branch-policy": "branch_policy",
  cache: "cache_fresh",
  "cache-fresh": "cache_fresh",
  triage: "triage_welcome",
  "triage-welcome": "triage_welcome",
};

export interface DefaultBranchSync {
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly warning: string | null;
}

export interface SessionStartResult {
  readonly code: number;
  readonly payload: Record<string, unknown>;
  readonly lines: readonly string[];
}

export interface SessionStartOptions {
  readonly deferrals?: Readonly<Record<string, string>>;
  readonly now?: Date;
  readonly writeHistory?: boolean;
  readonly runGit?: GitRunner;
  readonly newSessionId?: () => string;
  readonly runTriageWelcome?: (
    projectRoot: string,
    options: { writeHistory: boolean; now: Date; output: (line: string) => void },
  ) => { exitCode: number };
  readonly verifyTools?: (output: (line: string) => void) => { exitCode: number };
}

function normaliseStepName(name: string): string {
  return STEP_ALIASES[name] ?? name;
}

export function parseDeferrals(rawValues: readonly string[]): {
  deferrals: Record<string, string>;
  errors: string[];
} {
  const allowed = new Set<string>([...QUICK_STEPS, ...GATED_STEPS]);
  const deferrals: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of rawValues) {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      errors.push(`--defer expects step=reason, got ${JSON.stringify(raw)}`);
      continue;
    }
    const name = raw.slice(0, eq);
    const reason = raw.slice(eq + 1);
    const stepName = normaliseStepName(name.trim());
    if (!allowed.has(stepName)) {
      errors.push(
        `unknown ritual step ${JSON.stringify(name)}; expected one of ${JSON.stringify([...allowed].sort())}`,
      );
      continue;
    }
    if (reason.trim().length === 0) {
      errors.push(`--defer ${name}=... requires a non-empty reason`);
      continue;
    }
    deferrals[stepName] = reason.trim();
  }
  return { deferrals, errors };
}

function recordDeferredSteps(
  steps: readonly string[],
  deferrals: Readonly<Record<string, string>>,
  now: Date,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of steps) {
    const reason = deferrals[name];
    if (reason) {
      out[name] = ritualStep({ ok: true, ts: now, deferredReason: reason });
    }
  }
  return out;
}

function defaultBranchCandidates(projectRoot: string, runGit: GitRunner): string[] {
  const sym = runGit(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (sym.code === 0 && sym.stdout) {
    const parts = sym.stdout.split("/");
    return [(parts.slice(1).join("/") || parts[0]) ?? ""];
  }
  const candidates: string[] = [];
  for (const branch of ["main", "master"]) {
    const check = runGit(projectRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (check.code === 0) {
      candidates.push(branch);
    }
  }
  return candidates;
}

export function defaultBranchSync(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): DefaultBranchSync {
  const candidates = defaultBranchCandidates(projectRoot, runGit);
  if (candidates.length === 0) {
    return {
      branch: null,
      upstream: null,
      ahead: null,
      behind: null,
      warning: "[deft branch] Could not resolve a local default branch (`main` or `master`).",
    };
  }
  const branch = candidates[0] ?? null;
  if (!branch) {
    return {
      branch: null,
      upstream: null,
      ahead: null,
      behind: null,
      warning: "[deft branch] Could not resolve a local default branch (`main` or `master`).",
    };
  }
  const upstreamResult = runGit(projectRoot, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstreamResult.code !== 0 || !upstreamResult.stdout) {
    return {
      branch,
      upstream: null,
      ahead: null,
      behind: null,
      warning: `[deft branch] Local ${branch} has no upstream tracking branch.`,
    };
  }
  const upstream = upstreamResult.stdout;
  const slash = upstream.indexOf("/");
  const remote = slash >= 0 ? upstream.slice(0, slash) : "origin";
  const remoteBranch = slash >= 0 ? upstream.slice(slash + 1) : upstream;
  const fetch = runGit(projectRoot, ["fetch", "--quiet", remote, remoteBranch]);
  if (fetch.code !== 0) {
    const detail = fetch.stderr || "remote refresh failed";
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning: `[deft branch] Could not refresh ${upstream} for local ${branch}: ${detail}`,
    };
  }
  const counts = runGit(projectRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `${branch}...${upstream}`,
  ]);
  if (counts.code !== 0 || !counts.stdout) {
    const detail = counts.stderr || "ahead/behind count failed";
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning: `[deft branch] Could not compare local ${branch} with ${upstream}: ${detail}`,
    };
  }
  const parts = counts.stdout.trim().split(/\s+/);
  if (parts.length !== 2) {
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning:
        `[deft branch] Could not parse branch sync counts for ${branch} ` +
        `and ${upstream}: ${counts.stdout}`,
    };
  }
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning:
        `[deft branch] Could not parse branch sync counts for ${branch} ` +
        `and ${upstream}: ${counts.stdout}`,
    };
  }
  if (ahead === 0 && behind === 0) {
    return { branch, upstream, ahead, behind, warning: null };
  }
  let warning: string;
  if (ahead > 0 && behind > 0) {
    warning =
      `[deft branch] Local ${branch} has diverged from ${upstream} ` +
      `(${ahead} ahead, ${behind} behind).`;
  } else if (behind > 0) {
    const plural = behind === 1 ? "commit" : "commits";
    warning = `[deft branch] Local ${branch} is behind ${upstream} by ${behind} ${plural}.`;
  } else {
    const plural = ahead === 1 ? "commit" : "commits";
    warning = `[deft branch] Local ${branch} is ahead of ${upstream} by ${ahead} ${plural}.`;
  }
  return { branch, upstream, ahead, behind, warning };
}

export function runSessionStart(
  projectRoot: string,
  options: SessionStartOptions = {},
): SessionStartResult {
  const instant = options.now ?? new Date();
  const deferrals = options.deferrals ?? {};
  const runGit = options.runGit ?? defaultGitRunner;
  const { head: gitHeadValue, error: gitError } = gitHead(projectRoot, runGit);
  if (gitHeadValue === null) {
    const payload = {
      ready: false,
      message: gitError ?? "could not resolve git HEAD",
    };
    return { code: 2, payload, lines: [payload.message as string] };
  }

  const quickSteps: Record<string, Record<string, unknown>> = recordDeferredSteps(
    QUICK_STEPS,
    deferrals,
    instant,
  );
  const gatedSteps: Record<string, Record<string, unknown>> = recordDeferredSteps(
    GATED_STEPS,
    deferrals,
    instant,
  );
  const lines: string[] = [];

  if (!quickSteps.alignment) {
    const message = "Deft Directive active -- AGENTS.md loaded.";
    quickSteps.alignment = ritualStep({ ok: true, ts: instant, message });
    lines.push(message);
  }

  if (!quickSteps.branch_policy) {
    const result = resolvePolicy(projectRoot);
    const message = disclosureLine(result);
    const ok = result.error === null || result.source === "default-fail-closed";
    quickSteps.branch_policy = ritualStep({
      ok,
      ts: instant,
      message,
      exitCode: ok ? 0 : 2,
    });
    lines.push(message);
    const branchSync = defaultBranchSync(projectRoot, runGit);
    if (branchSync.warning) {
      lines.push(branchSync.warning);
    }
  }

  const verifyToolsFn =
    options.verifyTools ??
    ((output) => {
      const toolLines: string[] = [];
      const result = verifyRequiredTools({ outputFn: (line) => toolLines.push(line) });
      for (const line of toolLines) {
        output(line);
      }
      return { exitCode: result.exitCode };
    });
  verifyToolsFn((line) => lines.push(line));

  if (!quickSteps.triage_welcome) {
    const captured: string[] = [];
    const triageCommand = ["triage_welcome.run_default_mode", "--project-root", projectRoot];
    try {
      const runWelcome =
        options.runTriageWelcome ??
        ((root, welcomeOpts) => {
          const outcome = runDefaultMode(root, {
            output: welcomeOpts.output,
            writeHistory: welcomeOpts.writeHistory,
          });
          return { exitCode: outcome.exitCode };
        });
      const outcome = runWelcome(projectRoot, {
        writeHistory: options.writeHistory !== false,
        now: instant,
        output: (line) => captured.push(line),
      });
      const ok = outcome.exitCode === 0;
      const message = captured.join("\n").trim() || "triage welcome completed";
      quickSteps.triage_welcome = ritualStep({
        ok,
        ts: instant,
        message,
        exitCode: outcome.exitCode,
        command: triageCommand,
      });
      lines.push(...captured);
    } catch (exc) {
      const message = `triage welcome failed: ${String(exc)}`;
      quickSteps.triage_welcome = ritualStep({
        ok: false,
        ts: instant,
        message,
        exitCode: 2,
        command: triageCommand,
      });
      lines.push(message);
    }
  }

  const payload = newRitualStatePayload({
    sessionId: (options.newSessionId ?? randomUUID)(),
    gitHead: gitHeadValue,
    worktreePath: worktreePath(projectRoot, runGit),
    startedAt: instant,
    quickSteps,
    gatedSteps,
  });
  const statePath = writeRitualState(projectRoot, payload);
  const failed = Object.entries(quickSteps)
    .filter(([, step]) => !step.ok && !step.deferred_reason)
    .map(([name]) => name);
  const code = failed.length > 0 ? 1 : 0;
  const resultPayload = {
    ready: code === 0,
    exit_code: code,
    state_path: statePath,
    quick_steps: quickSteps,
    gated_steps: gatedSteps,
    message: code === 0 ? "session ritual recorded" : "session ritual failed",
  };
  return { code, payload: resultPayload, lines };
}

export { ritualStatePath };
