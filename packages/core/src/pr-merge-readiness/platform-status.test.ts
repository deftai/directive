import { describe, expect, it } from "vitest";
import {
  attachPlatformStatusUrls,
  CI_WEATHER_READY_STATES,
  isCiWeatherReadyState,
  PLATFORM_STATUS_BLACKSMITH_URL,
  PLATFORM_STATUS_GITHUB_URL,
  platformStatusUrlsForWeather,
} from "./platform-status.js";

describe("platform status URLs (#3180)", () => {
  it("pins static GitHub and Blacksmith status page URLs", () => {
    expect(PLATFORM_STATUS_GITHUB_URL).toBe("https://www.githubstatus.com/");
    expect(PLATFORM_STATUS_BLACKSMITH_URL).toBe("https://status.blacksmith.sh/");
  });

  it("classifies weather-class ready_state values", () => {
    for (const state of CI_WEATHER_READY_STATES) {
      expect(isCiWeatherReadyState(state)).toBe(true);
      expect(platformStatusUrlsForWeather(state)).toEqual({
        platform_status_github: PLATFORM_STATUS_GITHUB_URL,
        platform_status_blacksmith: PLATFORM_STATUS_BLACKSMITH_URL,
      });
    }
  });

  it("returns null for non-weather ready_state", () => {
    expect(isCiWeatherReadyState("ready")).toBe(false);
    expect(isCiWeatherReadyState("not_ready_yet")).toBe(false);
    expect(isCiWeatherReadyState(null)).toBe(false);
    expect(platformStatusUrlsForWeather("ready")).toBeNull();
  });

  it("attachPlatformStatusUrls only mutates weather-class records", () => {
    const weather = attachPlatformStatusUrls({ ready_state: "ci_never_scheduled" });
    expect(weather.platform_status_github).toBe(PLATFORM_STATUS_GITHUB_URL);
    expect(weather.platform_status_blacksmith).toBe(PLATFORM_STATUS_BLACKSMITH_URL);

    const ready = attachPlatformStatusUrls({ ready_state: "ready" });
    expect(ready.platform_status_github).toBeUndefined();
    expect(ready.platform_status_blacksmith).toBeUndefined();
  });
});
