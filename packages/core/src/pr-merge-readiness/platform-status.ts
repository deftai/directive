/**
 * Static platform status page URLs for CI weather attribution (#3180).
 *
 * v1 surfaces URLs only — no network fetch. Agents MUST open these pages when
 * weather-class `ci_ready_state` fires (or CI never starts for HEAD) and apply
 * the attribution table in scm/github.md + review-cycle.
 */

/** Public GitHub Status (Actions / Webhooks components). */
export const PLATFORM_STATUS_GITHUB_URL = "https://www.githubstatus.com/";

/** Public Blacksmith Status (runner provider; may mirror GH Actions health). */
export const PLATFORM_STATUS_BLACKSMITH_URL = "https://status.blacksmith.sh/";

/**
 * Weather-class ready_state values from evaluateCiGate (#3167).
 * Status URLs are attached only for these (not ordinary ready / not_ready_yet).
 */
export const CI_WEATHER_READY_STATES = [
  "ci_never_scheduled",
  "runner_capacity_stall",
  "ci_failures",
  "ci_cancelled_no_failover",
] as const;

export type CiWeatherReadyState = (typeof CI_WEATHER_READY_STATES)[number];

const WEATHER_SET: ReadonlySet<string> = new Set(CI_WEATHER_READY_STATES);

export function isCiWeatherReadyState(
  state: string | null | undefined,
): state is CiWeatherReadyState {
  return state != null && WEATHER_SET.has(state);
}

/** Static status URL fields for weather-class states; null when not weather. */
export function platformStatusUrlsForWeather(state: string | null | undefined): {
  platform_status_github: string;
  platform_status_blacksmith: string;
} | null {
  if (!isCiWeatherReadyState(state)) {
    return null;
  }
  return {
    platform_status_github: PLATFORM_STATUS_GITHUB_URL,
    platform_status_blacksmith: PLATFORM_STATUS_BLACKSMITH_URL,
  };
}

/**
 * Attach static status URLs onto a CI partial/summary record when weather-class.
 * Mutates and returns the same object for call-site chaining.
 */
export function attachPlatformStatusUrls(
  ci: Record<string, unknown>,
  readyState?: string | null,
): Record<string, unknown> {
  const state = readyState ?? (typeof ci.ready_state === "string" ? ci.ready_state : null);
  const urls = platformStatusUrlsForWeather(state);
  if (urls !== null) {
    ci.platform_status_github = urls.platform_status_github;
    ci.platform_status_blacksmith = urls.platform_status_blacksmith;
  }
  return ci;
}
