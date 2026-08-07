/**
 * Branch coverage for CI weather platform status URL helpers (#3185 / #3180).
 */
import { describe, expect, it } from "vitest";
import {
  attachPlatformStatusUrls,
  CI_WEATHER_READY_STATES,
  isCiWeatherReadyState,
  PLATFORM_STATUS_BLACKSMITH_URL,
  PLATFORM_STATUS_GITHUB_URL,
  platformStatusUrlsForWeather,
} from "./platform-status.js";

describe("platform-status branches (#3185)", () => {
  it("classifies weather vs non-weather ready states", () => {
    for (const state of CI_WEATHER_READY_STATES) {
      expect(isCiWeatherReadyState(state)).toBe(true);
    }
    expect(isCiWeatherReadyState(null)).toBe(false);
    expect(isCiWeatherReadyState(undefined)).toBe(false);
    expect(isCiWeatherReadyState("")).toBe(false);
    expect(isCiWeatherReadyState("ready")).toBe(false);
    expect(isCiWeatherReadyState("not_ready_yet")).toBe(false);
  });

  it("returns status URLs only for weather states", () => {
    expect(platformStatusUrlsForWeather("ci_never_scheduled")).toEqual({
      platform_status_github: PLATFORM_STATUS_GITHUB_URL,
      platform_status_blacksmith: PLATFORM_STATUS_BLACKSMITH_URL,
    });
    expect(platformStatusUrlsForWeather(null)).toBeNull();
    expect(platformStatusUrlsForWeather("ready")).toBeNull();
  });

  it("attachPlatformStatusUrls mutates weather records and leaves others", () => {
    const weather = { ready_state: "runner_capacity_stall" };
    attachPlatformStatusUrls(weather);
    expect(weather).toMatchObject({
      platform_status_github: PLATFORM_STATUS_GITHUB_URL,
      platform_status_blacksmith: PLATFORM_STATUS_BLACKSMITH_URL,
    });

    const plain = { ready_state: "ready" };
    attachPlatformStatusUrls(plain);
    expect(plain).not.toHaveProperty("platform_status_github");

    const override = { ready_state: "ready" };
    attachPlatformStatusUrls(override, "ci_failures");
    expect(override).toMatchObject({
      platform_status_github: PLATFORM_STATUS_GITHUB_URL,
    });

    const noState = { other: 1 };
    attachPlatformStatusUrls(noState);
    expect(noState).not.toHaveProperty("platform_status_github");

    const nonStringState = { ready_state: 12 as unknown as string };
    attachPlatformStatusUrls(nonStringState);
    expect(nonStringState).not.toHaveProperty("platform_status_github");
  });
});
