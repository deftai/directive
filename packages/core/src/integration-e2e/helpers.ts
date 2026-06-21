import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import {
  restIssueListPaginated,
  setPaginatedLister,
  setSingleIssueFetcher,
  setSleepFn,
} from "../cache/fetch.js";
import { auditPath } from "../cache/paths.js";
import { restIssueView } from "../scm/gh-rest.js";

export const REPO = "deftai/directive";
export const SCALE_ISSUE_COUNT = 60;

const tempRoots: string[] = [];

afterEach(() => {
  setPaginatedLister(restIssueListPaginated);
  setSingleIssueFetcher(restIssueView);
  setSleepFn(() => {});
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

export function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function fakeIssue(number: number, body?: string): Record<string, unknown> {
  return {
    number,
    title: `Fake issue ${number}`,
    body:
      body ??
      `## Summary\n\nEnd-to-end integration fixture for issue ${number}.\nNo credentials, no injection-heading tokens, no invisible Unicode.\n`,
    state: "open",
    user: { login: "tester" },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-05T00:00:00Z",
    labels: [{ name: "triage" }],
    comments: 0,
    html_url: `https://github.com/${REPO}/issues/${number}`,
  };
}

export function readAuditRecords(cacheRoot: string): Record<string, unknown>[] {
  const audit = auditPath(cacheRoot);
  try {
    const raw = readFileSync(audit, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function populateCacheLayout(
  cacheRoot: string,
  repo: string,
  issueNumbers: readonly number[],
): void {
  const [owner, name] = repo.split("/", 2);
  const base = join(cacheRoot, "github-issue", owner ?? "", name ?? "");
  mkdirSync(base, { recursive: true });
  for (const n of issueNumbers) {
    const edir = join(base, String(n));
    mkdirSync(edir, { recursive: true });
    const payload = fakeIssue(n);
    writeFileSync(join(edir, "raw.json"), JSON.stringify(payload), "utf8");
    writeFileSync(
      join(edir, "meta.json"),
      JSON.stringify({
        source: "github-issue",
        key: `${repo}/${n}`,
        fetched_at: "2026-05-05T00:00:00Z",
        ttl_seconds: 7 * 24 * 60 * 60,
        expires_at: "2099-01-01T00:00:00Z",
        scan_result: {
          passed: true,
          scanned_at: "2026-05-05T00:00:00Z",
          scanner_version: "2.1.0",
          flags: [],
        },
        size_bytes: JSON.stringify(payload).length,
        stale: false,
      }),
      "utf8",
    );
  }
}

export function createConsumerProject(parent: string): string {
  const root = join(parent, "consumer");
  mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
  mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
  mkdirSync(join(root, "vbrief", "active"), { recursive: true });
  mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
  mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "specification.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.5" },
        plan: {
          title: "Consumer Project",
          status: "draft",
          narratives: {
            Overview: "A fixture consumer project used by deft's consumer-tasks integration suite.",
          },
          items: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

export function writeScopeVbrief(
  projectRoot: string,
  folder: string,
  filename: string,
  status = "proposed",
): string {
  const target = join(projectRoot, "vbrief", folder, filename);
  writeFileSync(
    target,
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.5" },
        plan: {
          title: "Consumer fixture scope",
          status,
          items: [],
          references: [{ type: "github-issue", id: "#42" }],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return target;
}

export interface DispatchCall {
  command: string;
  projectRoot: string;
  frameworkRoot: string;
}

export function isFrameworkSourceContext(frameworkRoot: string, projectRoot: string): boolean {
  return resolve(frameworkRoot) === resolve(projectRoot);
}

/** Mirror ``scripts/_project_context.dispatch_task_check`` for consumer-task e2e. */
export function dispatchTaskCheck(
  frameworkRoot: string,
  projectRoot: string,
  runner: (command: string, projectRoot: string, frameworkRoot: string) => { code: number },
): number {
  const target = isFrameworkSourceContext(frameworkRoot, projectRoot)
    ? "check:framework-source"
    : "check:consumer";
  return runner(target, projectRoot, frameworkRoot).code;
}

export type RateLimitProbe = { core: number; graphql: number } | null;

/** Hermetic mirror of ``tests/integration/test_scm_smoke._probe_rate_limit``. */
export function probeRateLimit(
  runGhApi: () => { returncode: number; stdout: string },
): RateLimitProbe {
  try {
    const proc = runGhApi();
    if (proc.returncode !== 0 || proc.stdout.trim().length === 0) {
      return null;
    }
    const body = JSON.parse(proc.stdout) as unknown;
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const resources = (body as { resources?: unknown }).resources;
    if (typeof resources !== "object" || resources === null) {
      return null;
    }
    const core = (resources as { core?: unknown }).core;
    const graphql = (resources as { graphql?: unknown }).graphql;
    if (
      typeof core !== "object" ||
      core === null ||
      Array.isArray(core) ||
      typeof graphql !== "object" ||
      graphql === null ||
      Array.isArray(graphql)
    ) {
      return null;
    }
    const coreRemaining = Number.parseInt(
      String((core as { remaining?: unknown }).remaining ?? 0),
      10,
    );
    const graphqlRemaining = Number.parseInt(
      String((graphql as { remaining?: unknown }).remaining ?? 0),
      10,
    );
    if (Number.isNaN(coreRemaining) || Number.isNaN(graphqlRemaining)) {
      return null;
    }
    return { core: coreRemaining, graphql: graphqlRemaining };
  } catch {
    return null;
  }
}
