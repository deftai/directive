/** Skill-validation gate: external fetch must not pair with execute/install without mitigation (#1532 / #1936). */

export type ExternalFetchViolation = {
  skillPath: string;
  detail: string;
};

const EXTERNAL_FETCH_RE =
  /\b(fetch(?:ing)?(?:\s+\w+){0,6}\s+(?:the\s+)?(?:url|content|article|related\s+urls?|http|https|web\s+page)|fetch\s+and\s+read|webfetch|mcp.*fetch)/i;

const EXECUTE_FROM_EXTERNAL_RE =
  /\b(download|install|run|execute)\b.{0,40}\b(?:found|inside|within|in)\b.{0,40}\b(?:fetched|external|url|content|page|article)\b|\bfollow\b.{0,40}\b(?:instructions?|commands?)\b.{0,40}\b(?:download|install|run|execute)\b|\bexecute\b.{0,40}\b(?:commands?|scripts?|instructions?)\b.{0,40}\b(?:found|inside|within)\b/i;

const FETCH_THEN_EXECUTE_RE =
  /\bfetch\b.{0,120}\b(?:then|and)\b.{0,60}\b(?:run|execute|install|download)\b/i;

const RUN_FETCHED_ARTIFACT_RE = /\b(?:run|execute|install)\b.{0,40}\b(?:downloaded|fetched)\b/i;

const FETCHED_ARTIFACT_RE =
  /\b(?:downloaded|fetched)\b.{0,40}\b(?:script|binary|executable|tool|installer|package|file)\b/i;

const FOLLOW_RELATED_URLS_RE = /\bfetch(?:ing)?\s+related\s+urls?\b/i;

const SECURITY_CONTEXT_HEADING = /## Security context/i;
const UNTRUSTED_DOCTRINE_RE = /untrusted\s+(?:external\s+)?(?:content|data)/i;
const FORBID_EXTERNAL_EXECUTE_RE =
  /⊗[\s\S]{0,200}\b(?:download|install|execute|run)\b[\s\S]{0,200}\b(?:external|fetched|externally|found inside)\b/i;

/** Strip HTML comment blocks; repeat until stable for CodeQL multi-char sanitization. */
function stripHtmlComments(text: string): string {
  let body = text;
  let prev = "";
  while (prev !== body) {
    prev = body;
    body = body.replace(/<!--[\s\S]*?-->/g, "");
  }
  return body;
}

/** Strip YAML frontmatter and HTML comment banners before scanning skill prose. */
export function skillProse(raw: string): string {
  let body = raw.replace(/\r\n/g, "\n");
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) {
      body = body.slice(end + 4);
    }
  }
  return stripHtmlComments(body);
}

export function hasExternalFetchSignal(prose: string): boolean {
  return EXTERNAL_FETCH_RE.test(prose);
}

export function hasRiskyExternalFetchPattern(prose: string): boolean {
  if (!hasExternalFetchSignal(prose)) {
    return false;
  }
  return (
    hasExecuteFromExternalSignal(prose) ||
    FOLLOW_RELATED_URLS_RE.test(prose) ||
    /\bfetch\b.{0,40}\bfollow\b/i.test(prose)
  );
}

export function hasExecuteFromExternalSignal(prose: string): boolean {
  return (
    EXECUTE_FROM_EXTERNAL_RE.test(prose) ||
    FETCH_THEN_EXECUTE_RE.test(prose) ||
    RUN_FETCHED_ARTIFACT_RE.test(prose) ||
    FETCHED_ARTIFACT_RE.test(prose)
  );
}

export function hasUntrustedFetchMitigation(prose: string): boolean {
  return (
    SECURITY_CONTEXT_HEADING.test(prose) &&
    UNTRUSTED_DOCTRINE_RE.test(prose) &&
    FORBID_EXTERNAL_EXECUTE_RE.test(prose)
  );
}

export function analyzeSkillExternalFetch(
  skillPath: string,
  rawText: string,
): ExternalFetchViolation | null {
  const prose = skillProse(rawText);
  if (!hasExternalFetchSignal(prose)) {
    return null;
  }
  if (!hasRiskyExternalFetchPattern(prose)) {
    return null;
  }
  if (hasUntrustedFetchMitigation(prose)) {
    return null;
  }
  return {
    skillPath,
    detail:
      "external fetch or follow-through language without Security context untrusted-data / forbid-execute mitigation (#1936)",
  };
}

/** Collect violations across skill entries (used by verify-source gate + tests). */
export function collectExternalFetchViolations(
  entries: ReadonlyArray<{ path: string; text: string }>,
): ExternalFetchViolation[] {
  const violations: ExternalFetchViolation[] = [];
  for (const { path, text } of entries) {
    const finding = analyzeSkillExternalFetch(path, text);
    if (finding !== null) {
      violations.push(finding);
    }
  }
  return violations;
}
