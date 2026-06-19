import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git.js";
import { defaultWhich, spawnText } from "./spawn.js";
import type { ReleaseSeams } from "./types.js";

export function resolveGh(seams: ReleaseSeams = {}): string | null {
  const which = seams.whichGh ?? defaultWhich;
  return which("gh");
}

export function checkTagAvailable(
  version: string,
  repo: string,
  projectRoot: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const tag = `v${version}`;

  const local = runGit(projectRoot, ["tag", "-l", tag], seams);
  if (local.status !== 0) {
    return [false, `git tag -l failed: ${local.stderr.trim()}`];
  }
  if (local.stdout.trim() === tag) {
    return [
      false,
      `local tag ${tag} already exists; choose a different version ` +
        "(operator typo of a prior release is the most likely cause)",
    ];
  }

  const remote = runGit(projectRoot, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], seams);
  let remoteUnverifiedNote = "";
  if (remote.status !== 0) {
    const stderr = remote.stderr.trim();
    const firstLine = stderr.split("\n")[0] ?? "no stderr";
    remoteUnverifiedNote = ` (remote UNVERIFIED -- git ls-remote failed: ${firstLine})`;
  } else if (remote.stdout.includes(`refs/tags/${tag}`)) {
    return [false, `remote tag ${tag} already exists on origin; choose a different version`];
  }

  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return [
      true,
      `local clean${remoteUnverifiedNote} (gh CLI not on PATH; ` +
        "GitHub release surface UNVERIFIED -- install gh or pass " +
        "--skip-release to suppress this caveat)",
    ];
  }

  const spawn = seams.spawnText ?? spawnText;
  const gh = spawn(ghPath, ["release", "view", tag, "--repo", repo, "--json", "tagName"], {
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  if (gh.status === 0) {
    return [false, `GitHub release ${tag} already exists on ${repo}; choose a different version`];
  }
  return [true, `local clean${remoteUnverifiedNote}; no GitHub release ${tag} on ${repo}`];
}

export function createGithubRelease(
  projectRoot: string,
  version: string,
  repo: string,
  notes: string,
  options: { draft?: boolean; prerelease?: boolean } = {},
  seams: ReleaseSeams = {},
): [boolean, string] {
  const draft = options.draft ?? true;
  const prerelease = options.prerelease ?? false;
  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }

  const tag = `v${version}`;
  const cmd = [ghPath, "release", "create", tag, "--repo", repo, "--title", tag];
  if (draft) cmd.push("--draft");
  if (prerelease) cmd.push("--prerelease");

  let notesFile: string | null = null;
  if (notes) {
    const dir = tmpdir();
    notesFile = join(dir, `deft-release-notes-${process.pid}-${Date.now()}.md`);
    writeFileSync(notesFile, notes, { encoding: "utf8" });
    cmd.push("--notes-file", notesFile);
  } else {
    cmd.push("--generate-notes");
  }

  const spawn = seams.spawnText ?? spawnText;
  try {
    const result = spawn(ghPath, cmd.slice(1), {
      cwd: projectRoot,
      timeoutMs: 120_000,
      env: { ...process.env },
    });
    if (result.status !== 0) {
      return [false, `gh release create failed: ${result.stderr.trim()}`];
    }
    const flags: string[] = [];
    if (draft) flags.push("draft");
    if (prerelease) flags.push("prerelease");
    const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    return [true, `created GitHub release ${tag}${suffix}`];
  } finally {
    if (notesFile !== null) {
      try {
        unlinkSync(notesFile);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

type GhDraftState = "draft" | "public" | "not-found" | "error";

function ghReleaseViewIsDraft(
  ghPath: string,
  version: string,
  repo: string,
  projectRoot: string,
  seams: ReleaseSeams,
): [GhDraftState, string] {
  const tag = `v${version}`;
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(ghPath, ["release", "view", tag, "--repo", repo, "--json", "isDraft"], {
    cwd: projectRoot,
    timeoutMs: 30_000,
    env: { ...process.env },
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const lower = stderr.toLowerCase();
    if (lower.includes("not found") || lower.includes("release not found")) {
      return ["not-found", stderr];
    }
    return ["error", stderr];
  }
  try {
    const payload = JSON.parse(result.stdout || "{}") as { isDraft?: boolean };
    if (payload.isDraft === true) return ["draft", ""];
    if (payload.isDraft === false) return ["public", ""];
    return ["error", `isDraft missing from gh response: ${JSON.stringify(payload)}`];
  } catch (exc) {
    return ["error", `unparseable gh JSON: ${String(exc)}`];
  }
}

function ghReleaseFlipToDraft(
  ghPath: string,
  version: string,
  repo: string,
  projectRoot: string,
  seams: ReleaseSeams,
): [boolean, string] {
  const tag = `v${version}`;
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(ghPath, ["release", "edit", tag, "--repo", repo, "--draft=true"], {
    cwd: projectRoot,
    timeoutMs: 30_000,
    env: { ...process.env },
  });
  if (result.status !== 0) {
    return [false, `gh release edit failed: ${result.stderr.trim()}`];
  }
  return [true, `flipped ${tag} to draft`];
}

export function verifyReleaseDraft(
  projectRoot: string,
  version: string,
  repo: string,
  options: {
    maxAttempts?: number;
    interval?: number;
    sleep?: (seconds: number) => void;
  } = {},
  seams: ReleaseSeams = {},
): [boolean, string] {
  const maxAttempts = options.maxAttempts ?? 5;
  const interval = options.interval ?? 1.0;
  const sleepFn =
    options.sleep ??
    seams.sleep ??
    ((s: number) => {
      const start = Date.now();
      while (Date.now() - start < s * 1000) {
        // busy-wait fallback for tests injecting sleep
      }
    });

  if (maxAttempts <= 0) {
    return [true, "verify gate disabled (max_attempts <= 0)"];
  }

  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    process.stderr.write(
      "WARNING: cannot verify draft state (gh CLI not found on PATH); " +
        "defense-in-depth gate skipped (see #724)\n",
    );
    return [true, "gh CLI not found on PATH; verify gate skipped"];
  }

  let lastState = "";
  let lastDetail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [state, detail] = ghReleaseViewIsDraft(ghPath, version, repo, projectRoot, seams);
    lastState = state;
    lastDetail = detail;
    if (state === "draft") {
      return [true, `verified draft on attempt ${attempt}/${maxAttempts}`];
    }
    if (state === "public") {
      process.stderr.write(
        `WARNING: release v${version} landed as public; ` +
          "flipping to draft (defense-in-depth, see #724)\n",
      );
      const [ok, reason] = ghReleaseFlipToDraft(ghPath, version, repo, projectRoot, seams);
      if (ok) return [true, `flipped to draft (${reason})`];
      return [false, reason];
    }
    if (attempt < maxAttempts) {
      sleepFn(interval);
    }
  }

  if (lastState === "not-found") {
    process.stderr.write(
      `WARNING: release v${version} not found within ` +
        `${maxAttempts}*${interval}s budget; release.yml CI may still ` +
        "be processing (see #724)\n",
    );
    return [true, "not found within budget; verify gate inconclusive"];
  }

  process.stderr.write(
    `WARNING: verify gate could not confirm draft state for v${version}: ` +
      `last state '${lastState}'; detail: ${lastDetail} (see #724)\n`,
  );
  return [true, `inconclusive (${lastState}); verify gate skipped`];
}

/** Read upgrade banner for prependUpgradeBanner seam. */
export function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function defaultMkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "deft-release-"));
}
