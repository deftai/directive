import { resolveGh } from "../release/gh.js";
import { spawnText } from "../release/spawn.js";
import type { SpawnResult } from "../release/types.js";
import { RELEASES_LIST_ENDPOINT_TEMPLATE } from "./constants.js";
import type { NormalisedRelease, ReleasePublishSeams, ViewReleaseState } from "./types.js";

export function normaliseReleasePayload(restPayload: Record<string, unknown>): NormalisedRelease {
  return {
    isDraft: Boolean(restPayload.draft ?? false),
    name: restPayload.name as string | null | undefined,
    tagName: restPayload.tag_name as string | null | undefined,
    url: restPayload.html_url as string | null | undefined,
    id: restPayload.id as number | null | undefined,
  };
}

export function ghApiFindReleaseByTag(
  ghPath: string,
  repo: string,
  tag: string,
  seams: ReleasePublishSeams = {},
): [ViewReleaseState, NormalisedRelease | null, string] {
  const endpoint = RELEASES_LIST_ENDPOINT_TEMPLATE.replace("{repo}", repo);
  const spawn = seams.spawnText ?? spawnText;
  let result: SpawnResult;
  try {
    result = spawn(ghPath, ["api", "--paginate", endpoint], {
      timeoutMs: 120_000,
      env: { ...process.env },
    });
  } catch {
    return ["gh-error", null, "gh CLI not found on PATH"];
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return ["gh-error", null, `gh api ${endpoint} failed: ${stderr}`];
  }
  let restPayload: unknown;
  try {
    restPayload = JSON.parse(result.stdout);
  } catch (exc) {
    return ["gh-error", null, `gh api ${endpoint} returned non-JSON: ${String(exc)}`];
  }
  if (!Array.isArray(restPayload)) {
    const typeName = restPayload === null ? "null" : typeof restPayload;
    return ["gh-error", null, `gh api ${endpoint} returned non-list (${typeName})`];
  }
  for (const entry of restPayload) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.tag_name !== tag) {
      continue;
    }
    const payload = normaliseReleasePayload(record);
    if (payload.isDraft) {
      return ["draft", payload, ""];
    }
    return ["published", payload, ""];
  }
  return ["not-found", null, `release ${tag} not found on ${repo}`];
}

export function viewRelease(
  version: string,
  repo: string,
  seams: ReleasePublishSeams = {},
): [ViewReleaseState, NormalisedRelease | null, string] {
  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return ["gh-error", null, "gh CLI not found on PATH"];
  }
  const tag = `v${version}`;
  return ghApiFindReleaseByTag(ghPath, repo, tag, seams);
}

export function editReleasePublish(
  version: string,
  repo: string,
  releaseId: number | null | undefined = undefined,
  seams: ReleasePublishSeams = {},
): [boolean, string] {
  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }
  const tag = `v${version}`;
  const spawn = seams.spawnText ?? spawnText;
  let resolvedId = releaseId;

  if (resolvedId === undefined || resolvedId === null) {
    const [state, payload, reason] = ghApiFindReleaseByTag(ghPath, repo, tag, seams);
    if (state === "not-found") {
      return [false, `release ${tag} not found on ${repo}`];
    }
    if (state === "gh-error") {
      return [false, `could not resolve release id: ${reason}`];
    }
    if (!payload || payload.id === undefined || payload.id === null) {
      return [false, `release ${tag} payload missing 'id' field`];
    }
    resolvedId = payload.id;
  }

  const endpoint = `repos/${repo}/releases/${resolvedId}`;
  let result: SpawnResult;
  try {
    result = spawn(ghPath, ["api", endpoint, "--method", "PATCH", "-F", "draft=false"], {
      timeoutMs: 60_000,
      env: { ...process.env },
    });
  } catch {
    return [false, "gh CLI not found on PATH"];
  }
  if (result.status !== 0) {
    return [false, `gh api ${endpoint} (PATCH) failed: ${result.stderr.trim()}`];
  }
  return [true, `flipped ${tag} to published`];
}
