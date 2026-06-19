import { resolveGh, spawnText } from "../release/index.js";
import type { GhReleasePayload, RollbackSeams } from "./types.js";

export function ghReleaseViewJson(
  version: string,
  repo: string,
  seams: RollbackSeams = {},
): [boolean, GhReleasePayload | null, string] {
  if (seams.ghReleaseViewJson) {
    return seams.ghReleaseViewJson(version, repo);
  }

  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return [false, null, "gh CLI not found on PATH"];
  }

  const tag = `v${version}`;
  const spawn = seams.spawnText ?? spawnText;
  try {
    const result = spawn(
      ghPath,
      [
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "isDraft,name,tagName,createdAt,publishedAt,assets,url",
      ],
      {
        timeoutMs: 60_000,
        env: { ...process.env },
      },
    );
    if (result.status !== 0) {
      return [false, null, result.stderr.trim()];
    }
    try {
      return [true, JSON.parse(result.stdout) as GhReleasePayload, ""];
    } catch (exc) {
      return [false, null, `non-JSON: ${String(exc)}`];
    }
  } catch {
    return [false, null, "gh CLI not found on PATH"];
  }
}

export function ghReleaseExists(
  version: string,
  repo: string,
  seams: RollbackSeams = {},
): ["exists" | "not-found" | "error", GhReleasePayload | null, string] {
  const [ok, payload, reason] = ghReleaseViewJson(version, repo, seams);
  if (ok) {
    return ["exists", payload, ""];
  }
  const lowered = reason.toLowerCase();
  if (lowered.includes("not found")) {
    return ["not-found", null, reason];
  }
  return ["error", null, reason];
}

export function ghReleaseDelete(
  version: string,
  repo: string,
  seams: RollbackSeams = {},
): [boolean, string] {
  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }

  const tag = `v${version}`;
  const spawn = seams.spawnText ?? spawnText;
  try {
    const result = spawn(
      ghPath,
      ["release", "delete", tag, "--repo", repo, "--yes", "--cleanup-tag"],
      {
        timeoutMs: 60_000,
        env: { ...process.env },
      },
    );
    if (result.status !== 0) {
      return [false, `gh release delete failed: ${result.stderr.trim()}`];
    }
    return [true, `deleted release ${tag} (with tag cleanup)`];
  } catch {
    return [false, "gh CLI not found on PATH"];
  }
}
