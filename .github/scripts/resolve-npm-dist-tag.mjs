#!/usr/bin/env node
// Resolve the npm dist-tag for a release version (#5852 Prefer-A Recut-6 P1/P4).
//
// Single source of truth for tag-push and workflow_dispatch publishes. The
// workflow runs this file from the workflow ref (github.workflow_sha), never
// from the peeled tag tree. Reads ONLY argv[2]: no environment variable and no
// workflow input can select the channel.
//
//   stable X.Y.Z            -> maintainer   (never SemVer-implicit latest)
//   X.Y.Z-<id>[.N]          -> <id>         (alpha / beta / rc / ...)
//   X.Y.Z-<numeric>[...]    -> next         (npm rejects range-shaped tags)
//   X.Y.Z-latest[.N]        -> refused      (latest only via the explicit promote verb)
//   other SemVer            -> next
//
// Moving npm `latest` is a separate explicit act (npm-publish.yml promote-latest job).
import { pathToFileURL } from "node:url";

// Linear SemVer (no nested quantifier on overlapping classes; CodeQL #155).
// Hyphenated ids via [.-] segments (beta-hotfix.1 / build-sha admitted; CodeQL-safe).
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const STABLE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PRERELEASE_ID = /^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z]+)/;

export function resolveDistTag(version) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`VERSION ${String(version)} is not SemVer`);
  }
  if (STABLE.test(version)) return "maintainer";
  const m = PRERELEASE_ID.exec(version);
  if (m !== null) {
    const pre = m[1];
    if (pre.toLowerCase() === "latest") {
      throw new Error(
        `prerelease id 'latest' refused (${version}); npm latest moves only via the explicit promote-latest verb`,
      );
    }
    return /^[0-9]+$/.test(pre) ? "next" : pre;
  }
  return "next";
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.stdout.write(`${resolveDistTag(process.argv[2])}\n`);
  } catch (err) {
    process.stderr.write(`::error::${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
