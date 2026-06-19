import {
  DEFAULT_REPO,
  FRESH_UNRELEASED_BLOCK,
  UNRELEASED_LINK_RE,
  UNRELEASED_RE,
  UPGRADE_BANNER_RELPATH,
} from "./constants.js";

/** Split CHANGELOG content into (body, link-footer). */
export function splitBodyAndLinks(text: string): [string, string] {
  const lines = text.split(/(?<=\n)/);
  let firstLinkIdx: number | null = null;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    if (line.startsWith("[Unreleased]:") || /^\[\d+\.\d+\.\d+\]:/.test(line)) {
      firstLinkIdx = idx;
      break;
    }
  }
  if (firstLinkIdx === null) {
    return [text, ""];
  }
  return [lines.slice(0, firstLinkIdx).join(""), lines.slice(firstLinkIdx).join("")];
}

function extractPreviousVersion(footer: string): string | null {
  const match = UNRELEASED_LINK_RE.exec(footer);
  return match?.groups?.prev ?? null;
}

/** Promote [Unreleased] to [<version>] - <today> and refresh the link footer. */
export function promoteChangelog(
  text: string,
  version: string,
  repo: string,
  today: string,
  summary: string | null = null,
): string {
  if (!UNRELEASED_RE.test(text)) {
    throw new Error("CHANGELOG.md does not contain a '## [Unreleased]' heading.");
  }
  if (summary !== null && (summary.includes("\n") || summary.includes("\r"))) {
    throw new Error(
      "--summary is single-line; got embedded newline. " +
        "Author the blockquote on a single line.",
    );
  }

  const [body, footer] = splitBodyAndLinks(text);
  let promotedHeading = `## [${version}] - ${today}`;
  if (summary) {
    promotedHeading = `${promotedHeading}\n\n> ${summary}\n`;
  }
  const freshBlock = `${FRESH_UNRELEASED_BLOCK.trimEnd()}\n\n`;
  const replacement = freshBlock + promotedHeading;
  const newBody = body.replace(UNRELEASED_RE, () => replacement);
  if (newBody === body) {
    throw new Error("Failed to locate exactly one '## [Unreleased]' heading.");
  }

  const prev = extractPreviousVersion(footer);
  const newUnreleasedLink = `[Unreleased]: https://github.com/${repo}/compare/v${version}...HEAD`;
  const versionLink = prev
    ? `[${version}]: https://github.com/${repo}/compare/v${prev}...v${version}`
    : `[${version}]: https://github.com/${repo}/releases/tag/v${version}`;

  let newFooter: string;
  if (footer) {
    const footerLines = footer.split(/(?<=\n)/);
    let replaced = false;
    const newFooterLines: string[] = [];
    for (const line of footerLines) {
      if (!replaced && line.startsWith("[Unreleased]:")) {
        newFooterLines.push(`${newUnreleasedLink}\n`);
        newFooterLines.push(`${versionLink}\n`);
        replaced = true;
        continue;
      }
      newFooterLines.push(line);
    }
    if (!replaced) {
      newFooterLines.unshift(`${versionLink}\n`);
      newFooterLines.unshift(`${newUnreleasedLink}\n`);
    }
    newFooter = newFooterLines.join("");
  } else {
    newFooter = `${newUnreleasedLink}\n${versionLink}\n`;
  }

  return newBody + newFooter;
}

/** Extract the body of ## [<version>] - <date> for use as release notes. */
export function sectionForVersion(text: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Avoid /m on $ — JS $ with multiline matches every line end, not only EOF (Python \\Z).
  const pattern = new RegExp(
    `(?:^|\\n)##\\s+\\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=(?:\\n##\\s+\\[)|$)`,
  );
  const match = pattern.exec(text);
  if (!match?.[1]) {
    return "";
  }
  return match[1].trim();
}

/** Lead maintainer-mode GitHub release notes with the upgrade banner (#1413). */
export function prependUpgradeBanner(
  notes: string,
  repo: string,
  projectRoot: string,
  readText: (path: string) => string | null,
): string {
  if (repo !== DEFAULT_REPO) {
    return notes;
  }
  const bannerPath = `${projectRoot}/${UPGRADE_BANNER_RELPATH}`;
  let banner: string | null;
  try {
    banner = readText(bannerPath);
  } catch {
    return notes;
  }
  if (banner === null) {
    return notes;
  }
  const normalized = banner.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return notes;
  }
  return `${normalized}\n\n${notes}`;
}
