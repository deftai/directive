/**
 * `directive init --headless` — manifest emitter for no-shell consumer products
 * (#2268 / epic #2203).
 *
 * Hosted consumer products (e.g. deftai/deftvisage#1036) have no shell or npm
 * access to the end user's machine. This module serialises the merged keystone
 * `plan()` schema into a `{ version, files: [{ path, content, encoding }] }`
 * manifest with ALL execution side effects suppressed: no interactive prompts,
 * no git operations, no git-hook installation, and no filesystem writes outside
 * the explicit `--output` target. It makes no git-repo assumption and runs
 * against an empty / non-existent directory.
 *
 * Single-sourcing (the #2268 acceptance): the manifest is DERIVED from `plan()`
 * — the collected file set is threaded through `plan(..., { files })` and read
 * back out of {@link ResolutionPlan.files}. There is no separate "what would
 * init produce" reimplementation; the collectors here are the manifest-only,
 * read-only counterparts of the executing deposit path in `scaffold.ts` /
 * `init-deposit.ts` (they reuse the same render helpers WITHOUT filesystem or
 * git writes).
 *
 * On registry / content-resolution failure the CLI wrapper exits non-zero and
 * emits a JSON error object so the calling backend can treat it as non-fatal
 * (never a crash or a partial write).
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ResolutionEncoding, ResolutionFacts, ResolutionFile } from "@deftai/directive-types";
import {
  ContentPackageNotFoundError,
  resolveInstalledContentRoot,
} from "../deposit/resolve-content.js";
import { readCorePackageVersion } from "../engine-version.js";
import { containedWrite } from "../fs/contained-write.js";
import { agentsRefreshPlan } from "../platform/agents-md.js";
import { plan } from "../resolution/plan.js";
import { CANONICAL_INSTALL_ROOT } from "./constants.js";
import { buildInstallManifestText, PIN_DEPENDENCY_NAME } from "./scaffold.js";

/** POSIX-relative path of the payload VERSION marker inside the manifest. */
const PAYLOAD_VERSION_PATH = `${CANONICAL_INSTALL_ROOT}/VERSION`;

/** Provenance stamp written into the emitted `.deft/core/VERSION` marker. */
const HEADLESS_FETCHED_BY = "directive-init-headless";

/** The five xBRIEF lifecycle folders scaffolded into a fresh project. */
export const HEADLESS_XBRIEF_LIFECYCLE_DIRS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

const XBRIEF_LIFECYCLE_GITKEEP = `# Keeps this xbrief/ lifecycle directory present in version control so the
# deft-directive-setup pre-cutover guard does not fire on a fresh headless
# install. Emitted by \`directive init --headless\` (#2268).
`;

/** A single file entry in the headless manifest. */
export type HeadlessManifestFile = ResolutionFile;

/** The serialised headless manifest shape. */
export interface HeadlessManifest {
  /** Resolved framework version the manifest was built against. */
  readonly version: string;
  /** All files a consumer backend should materialise for a fresh install. */
  readonly files: readonly HeadlessManifestFile[];
}

/**
 * JSON error object emitted on a registry / content-resolution failure. The
 * calling backend treats a non-zero exit + this object as non-fatal.
 */
export interface HeadlessManifestErrorObject {
  readonly success: false;
  readonly error: string;
  readonly error_code: string;
}

/** Injectable seams; defaults are the real content-package resolution path. */
export interface HeadlessManifestSeams {
  /** Resolve the installed content-package root. Default: real npm resolution. */
  readonly resolveContentRoot?: () => Promise<string>;
  /** Override the resolved version (default: read the content package.json). */
  readonly readVersion?: (contentRoot: string) => string;
  /** Deterministic UTC ISO timestamp for the VERSION marker (default: now). */
  readonly nowIso?: () => string;
  /** Deterministic managed-section session id (default: fixed headless token). */
  readonly newSession?: () => string;
}

function defaultNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Read the resolved version from the content package.json (engine fallback). */
function resolveVersion(contentRoot: string, seams: HeadlessManifestSeams): string {
  if (seams.readVersion) return seams.readVersion(contentRoot);
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(contentRoot, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const version = (parsed as { version?: string }).version;
      if (version?.trim()) return version.trim();
    }
  } catch {
    // Fall through to the engine version.
  }
  return readCorePackageVersion();
}

/**
 * Decide the manifest encoding for a file's raw bytes. UTF-8 text round-trips
 * losslessly; anything else (or bytes carrying a NUL) is base64 so binary
 * payload assets survive JSON serialisation without corruption.
 */
function encodeBytes(buf: Buffer): { content: string; encoding: ResolutionEncoding } {
  if (!buf.includes(0)) {
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buf)) {
      return { content: text, encoding: "utf-8" };
    }
  }
  return { content: buf.toString("base64"), encoding: "base64" };
}

/** POSIX-normalise a path (manifest paths are always forward-slash). */
function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Walk the content-package tree read-only and collect one manifest entry per
 * file, prefixed with the canonical install root. The manifest-only counterpart
 * of `reconstituteDepositFromContent` — it materialises bytes into memory
 * instead of copying them onto disk.
 */
function collectPayloadFiles(contentRoot: string): ResolutionFile[] {
  const out: ResolutionFile[] = [];
  const stack: string[] = [contentRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const rel = toPosix(relative(contentRoot, full));
        const { content, encoding } = encodeBytes(readFileSync(full));
        out.push({ path: `${CANONICAL_INSTALL_ROOT}/${rel}`, content, encoding });
      }
    }
  }
  return out;
}

/**
 * Render the version-consistent `.deft/core/VERSION` marker. The `sha=` slot is
 * stamped with the resolved version (headless mode has no git checkout), which
 * is what keeps the emitted AGENTS.md managed section and the payload provably
 * consistent against a single resolved version.
 */
function collectVersionFile(version: string, nowIso: string): ResolutionFile {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const body = buildInstallManifestText({
    ref: tag,
    sha: version,
    tag,
    installRoot: CANONICAL_INSTALL_ROOT,
    fetchedAt: nowIso,
    fetchedBy: HEADLESS_FETCHED_BY,
  });
  return { path: PAYLOAD_VERSION_PATH, content: body, encoding: "utf-8" };
}

/**
 * Render the greenfield AGENTS.md (unmanaged header + attributed managed
 * section) from the SAME content root as the payload, so the managed section
 * can never drift from the deposited framework version. The managed-section
 * `sha=` is stamped with the resolved version for version-consistency.
 */
function collectAgentsMdFile(
  contentRoot: string,
  version: string,
  nowIso: string,
  sessionId: string,
): ResolutionFile {
  const agentsResult = agentsRefreshPlan("headless-project", {
    frameworkRoot: contentRoot,
    resolveSha: () => version,
    nowIso: () => nowIso,
    newSession: () => sessionId,
    readAgents: () => null,
  });
  const newContent = agentsResult.new_content;
  if (typeof newContent !== "string") {
    throw new Error(`AGENTS.md render produced no content (state: ${String(agentsResult.state)})`);
  }
  return { path: "AGENTS.md", content: newContent, encoding: "utf-8" };
}

/** The five xBRIEF lifecycle `.gitkeep` files (empty dirs can't ride a manifest). */
function collectXbriefScaffoldFiles(): ResolutionFile[] {
  return HEADLESS_XBRIEF_LIFECYCLE_DIRS.map((sub) => ({
    path: `xbrief/${sub}/.gitkeep`,
    content: XBRIEF_LIFECYCLE_GITKEEP,
    encoding: "utf-8" as const,
  }));
}

/** The pinned `package.json` devDependency snippet (exact, private workspace). */
function collectPackageJsonFile(version: string): ResolutionFile {
  const pinVersion = version.trim().replace(/^v/i, "");
  const pkg = {
    private: true,
    devDependencies: { [PIN_DEPENDENCY_NAME]: pinVersion },
  };
  return {
    path: "package.json",
    content: `${JSON.stringify(pkg, null, 2)}\n`,
    encoding: "utf-8",
  };
}

/**
 * Greenfield fact-set for the headless manifest. `hasDeftCore: false` routes
 * `plan()` to `init` mode (Row 2), before any engine/pin reconciliation — no
 * git-repo assumption, no reachable-engine requirement.
 */
function headlessGreenfieldFacts(): ResolutionFacts {
  return {
    hasGit: false,
    hasAppCode: false,
    hasDeftCore: false,
    deftCorePayloadVersion: null,
    hasManagedSection: false,
    managedSectionSha: null,
    hasVbrief: false,
    hasXbrief: false,
    preCutoverArtifacts: false,
    engineReachable: false,
    engineVersion: null,
    pinVersion: null,
  };
}

/**
 * Build the headless manifest. Reads the content package read-only, collects
 * the fresh-install file set (payload + version-consistent AGENTS.md + xBRIEF
 * scaffold + pinned package.json), threads it through `plan()` so the manifest
 * is single-sourced from the resolution schema, and returns the serialisable
 * shape. Performs NO filesystem writes and NO git operations.
 *
 * Throws (never partially writes) on content-resolution failure; the CLI
 * wrapper converts the throw into a JSON error object + non-zero exit.
 */
export async function buildHeadlessManifest(
  seams: HeadlessManifestSeams = {},
): Promise<HeadlessManifest> {
  const resolveContentRoot = seams.resolveContentRoot ?? resolveInstalledContentRoot;
  const contentRoot = await resolveContentRoot();
  const version = resolveVersion(contentRoot, seams);
  const nowIso = (seams.nowIso ?? defaultNowIso)();
  const sessionId = (seams.newSession ?? (() => "headlessmanif"))();

  const payload = collectPayloadFiles(contentRoot).filter(
    (file) => file.path !== PAYLOAD_VERSION_PATH,
  );
  const files: ResolutionFile[] = [
    ...payload,
    collectVersionFile(version, nowIso),
    collectAgentsMdFile(contentRoot, version, nowIso, sessionId),
    ...collectXbriefScaffoldFiles(),
    collectPackageJsonFile(version),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Single-source the manifest from plan(): the collected set rides the
  // ResolutionPlan.files channel, and we read it back out — no reimplementation.
  const resolved = plan(headlessGreenfieldFacts(), {}, { files });
  return { version, files: resolved.files };
}

export interface RunInitHeadlessCliOptions {
  /** Explicit `--output` target, or null to emit the manifest to stdout. */
  readonly outputPath: string | null;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: HeadlessManifestSeams;
  /**
   * Filesystem write seam (test-only). The default creates the parent directory
   * and writes the file; an injected seam OWNS all filesystem contact (including
   * directory creation), so the manifest write stays fully isolatable in tests.
   */
  readonly writeFile?: (path: string, data: string) => void;
}

/**
 * CLI-facing entrypoint for `directive init --headless`. Emits the manifest to
 * `--output` (the ONLY permitted filesystem write) or stdout, and on failure
 * writes a JSON error object to stdout and returns exit code 1.
 */
export async function runInitHeadlessCli(options: RunInitHeadlessCliOptions): Promise<number> {
  try {
    const manifest = await buildHeadlessManifest(options.seams);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (options.outputPath) {
      const abs = resolve(options.outputPath);
      const writeFile =
        options.writeFile ??
        ((path, data) => {
          // Contain under the output parent (arbitrary --output path; #2980 wave A).
          const parent = dirname(path);
          mkdirSync(parent, { recursive: true });
          containedWrite({
            root: resolve(parent),
            target: basename(path),
            data,
            mode: "replace",
          });
        });
      writeFile(abs, serialized);
      options.writeErr(
        `directive init --headless: wrote ${manifest.files.length}-file manifest (v${manifest.version}) to ${abs}\n`,
      );
    } else {
      options.writeOut(serialized);
    }
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const error_code =
      cause instanceof ContentPackageNotFoundError
        ? "content_resolution_failed"
        : "headless_manifest_failed";
    const errorObject: HeadlessManifestErrorObject = {
      success: false,
      error: message,
      error_code,
    };
    options.writeOut(`${JSON.stringify(errorObject, null, 2)}\n`);
    return 1;
  }
}
