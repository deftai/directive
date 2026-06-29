import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestTagToVersion, parseInstallManifest } from "../doctor/manifest.js";
import { resolveVersion } from "../doctor/paths.js";

/** Default subprocess timeout for `git ls-remote` (seconds). */
export const REMOTE_PROBE_DEFAULT_TIMEOUT = 5.0;

/** Baked-in canonical upstream (#1320). Never probe consumer origin. */
export const DEFT_UPSTREAM_URL = "https://github.com/deftai/directive.git";

const MANIFEST_UPSTREAM_URL_KEYS = [
  "source_url",
  "url",
  "upstream_url",
  "upstream",
  "origin",
] as const;

/** Reject git ls-remote targets that could be parsed as options (#CodeQL). */
export function isSafeGitLsRemoteTarget(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.length > 0 && !trimmed.startsWith("-");
}

function normalizePrereleaseForSort(pre: string): string {
  const match = /^(alpha|beta|rc)\.(\d+)(.*)$/i.exec(pre);
  if (match?.[1] && match[2]) {
    const padded = match[2].padStart(8, "0");
    return `${match[1].toLowerCase()}.${padded}${match[3] ?? ""}`;
  }
  return pre;
}

const SEMVER_TAG_RE = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?<pre>-[\w][\w.-]*)?$/;

export type RemoteProbeStatus = "ok" | "behind" | "skipped" | "no-upstream" | "no-tags" | "error";

export interface RemoteProbeResult {
  readonly status: RemoteProbeStatus;
  readonly current: string;
  readonly remote?: string;
  readonly upstream_url?: string;
  readonly reason?: string;
  readonly error?: string;
}

export type SemverKey = readonly [number, number, number, number, string];

export interface GitRunner {
  lsRemoteTags(upstreamUrl: string, timeoutMs: number): string[] | "timeout" | "os-error";
}

export function parseSemverTag(tag: string): SemverKey | null {
  if (!tag) {
    return null;
  }
  const match = SEMVER_TAG_RE.exec(tag.trim());
  if (!match?.groups) {
    return null;
  }
  const pre = match.groups.pre ?? "";
  const preStripped = pre.replace(/^-/, "");
  return [
    Number(match.groups.major),
    Number(match.groups.minor),
    Number(match.groups.patch),
    pre ? 0 : 1,
    normalizePrereleaseForSort(preStripped),
  ];
}

export function maxSemverTag(tags: readonly string[]): string | null {
  const parsed: Array<{ key: SemverKey; tag: string }> = [];
  for (const tag of tags) {
    const key = parseSemverTag(tag);
    if (key !== null) {
      parsed.push({ key, tag });
    }
  }
  if (parsed.length === 0) {
    return null;
  }
  parsed.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) {
      const av = a.key[i];
      const bv = b.key[i];
      if (typeof av === "number" && typeof bv === "number" && av !== bv) {
        return av - bv;
      }
      if (typeof av === "string" && typeof bv === "string" && av !== bv) {
        return av < bv ? -1 : 1;
      }
    }
    return 0;
  });
  return parsed[parsed.length - 1]?.tag ?? null;
}

function readVendoredManifest(projectRoot: string): Record<string, string> | null {
  for (const candidate of [
    join(projectRoot, ".deft", "core", "VERSION"),
    join(projectRoot, ".deft", "VERSION"),
    join(projectRoot, "deft", "VERSION"),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      return parseInstallManifest(readFileSync(candidate, "utf8"));
    } catch {}
  }
  return null;
}

export function resolveProbeCurrentVersion(projectRoot: string, frameworkRoot?: string): string {
  const manifest = readVendoredManifest(projectRoot);
  if (manifest) {
    const derived = manifestTagToVersion(manifest);
    if (derived) {
      return derived;
    }
  }
  return resolveVersion(frameworkRoot).replace(/^v/, "");
}

export function resolveUpstreamUrl(projectRoot: string): string {
  const manifest = readVendoredManifest(projectRoot);
  if (manifest) {
    for (const key of MANIFEST_UPSTREAM_URL_KEYS) {
      const value = manifest[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return DEFT_UPSTREAM_URL;
}

export function resolveProbeTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DEFT_REMOTE_PROBE_TIMEOUT ?? "").trim();
  if (!raw) {
    return REMOTE_PROBE_DEFAULT_TIMEOUT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return REMOTE_PROBE_DEFAULT_TIMEOUT;
  }
  return value;
}

export function noNetworkActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DEFT_NO_NETWORK ?? "").trim() === "1";
}

export function parseLsRemoteTags(stdout: string): string[] {
  const tags: string[] = [];
  for (const line of stdout.split("\n")) {
    const marker = "\trefs/tags/";
    const idx = line.indexOf(marker);
    if (idx < 0) {
      continue;
    }
    const tag = line.slice(idx + marker.length).trim();
    if (tag) {
      tags.push(tag);
    }
  }
  return tags;
}

export function defaultGitRunner(): GitRunner {
  return {
    lsRemoteTags(upstreamUrl: string, timeoutMs: number): string[] | "timeout" | "os-error" {
      if (!isSafeGitLsRemoteTarget(upstreamUrl)) {
        return "os-error";
      }
      try {
        const proc = spawnSync("git", ["ls-remote", "--tags", "--refs", "--", upstreamUrl.trim()], {
          encoding: "utf8",
          timeout: timeoutMs,
        });
        if (proc.error) {
          const code = (proc.error as NodeJS.ErrnoException).code;
          if (code === "ETIMEDOUT" || proc.error.message.includes("timed out")) {
            return "timeout";
          }
          return "os-error";
        }
        if (proc.status !== 0) {
          return [];
        }
        return parseLsRemoteTags(proc.stdout ?? "");
      } catch (exc) {
        if (exc instanceof Error && exc.message.includes("ETIMEDOUT")) {
          return "timeout";
        }
        return "os-error";
      }
    },
  };
}

export interface RunRemoteProbeOptions {
  readonly projectRoot: string;
  readonly frameworkRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly git?: GitRunner;
}

export function runRemoteProbe(options: RunRemoteProbeOptions): RemoteProbeResult {
  const env = options.env ?? process.env;
  const current = resolveProbeCurrentVersion(options.projectRoot, options.frameworkRoot);
  if (noNetworkActive(env)) {
    return {
      status: "skipped",
      reason: "DEFT_NO_NETWORK=1",
      current,
    };
  }
  const timeoutSec = resolveProbeTimeout(env);
  const upstreamUrl = resolveUpstreamUrl(options.projectRoot);
  const git = options.git ?? defaultGitRunner();
  const tagsResult = git.lsRemoteTags(upstreamUrl, Math.ceil(timeoutSec * 1000));
  if (tagsResult === "timeout") {
    return {
      status: "error",
      current,
      upstream_url: upstreamUrl,
      error: "timeout",
    };
  }
  if (tagsResult === "os-error") {
    return {
      status: "error",
      current,
      upstream_url: upstreamUrl,
      error: "Error: git unavailable",
    };
  }
  const remoteTag = maxSemverTag(tagsResult);
  if (remoteTag === null) {
    return {
      status: "no-tags",
      current,
      upstream_url: upstreamUrl,
    };
  }
  const remoteKey = parseSemverTag(remoteTag);
  const currentKey = parseSemverTag(current.startsWith("v") ? current : `v${current}`);
  if (currentKey !== null && remoteKey !== null && compareSemverKeys(remoteKey, currentKey) > 0) {
    return {
      status: "behind",
      current,
      remote: remoteTag,
      upstream_url: upstreamUrl,
    };
  }
  return {
    status: "ok",
    current,
    remote: remoteTag,
    upstream_url: upstreamUrl,
  };
}

function compareSemverKeys(a: SemverKey, b: SemverKey): number {
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) {
      continue;
    }
    if (typeof av === "number" && typeof bv === "number") {
      return av - bv;
    }
    return String(av) < String(bv) ? -1 : 1;
  }
  return 0;
}

export interface EmitCheckUpdatesOptions {
  readonly jsonMode: boolean;
  readonly writeOut: (text: string) => void;
}

export function emitCheckUpdates(
  result: RemoteProbeResult,
  options: EmitCheckUpdatesOptions,
): number {
  if (options.jsonMode) {
    const payload: Record<string, string> = {
      status: result.status,
      current: result.current,
    };
    if (result.remote !== undefined) {
      payload.remote = result.remote;
    }
    if (result.upstream_url !== undefined) {
      payload.upstream_url = result.upstream_url;
    }
    if (result.reason !== undefined) {
      payload.reason = result.reason;
    }
    if (result.error !== undefined) {
      payload.error = result.error;
    }
    options.writeOut(`${JSON.stringify(payload, Object.keys(payload).sort())}\n`);
  } else {
    const current = result.current;
    switch (result.status) {
      case "ok":
        options.writeOut(`OK upstream=${result.remote}\n`);
        break;
      case "behind":
        options.writeOut(
          `BEHIND upstream=${result.remote} current=v${current} commits-behind=unknown\n`,
        );
        break;
      case "skipped":
        options.writeOut(`SKIPPED reason=DEFT_NO_NETWORK current=v${current}\n`);
        break;
      case "no-upstream":
        options.writeOut(`NO-UPSTREAM current=v${current}\n`);
        break;
      case "no-tags":
        options.writeOut(`NO-TAGS current=v${current} upstream=${result.upstream_url ?? ""}\n`);
        break;
      default:
        options.writeOut(
          `ERROR current=v${current} upstream=${result.upstream_url ?? ""} error=${result.error ?? "unknown"}\n`,
        );
        break;
    }
  }
  return result.status === "behind" ? 1 : 0;
}

export function runCheckUpdates(
  argv: readonly string[],
  options: {
    projectRoot?: string;
    frameworkRoot?: string;
    env?: NodeJS.ProcessEnv;
    git?: GitRunner;
    writeOut?: (text: string) => void;
  } = {},
): number {
  const jsonMode = argv.includes("--json");
  const result = runRemoteProbe({
    projectRoot: options.projectRoot ?? process.cwd(),
    frameworkRoot: options.frameworkRoot,
    env: options.env,
    git: options.git,
  });
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  return emitCheckUpdates(result, { jsonMode, writeOut });
}
