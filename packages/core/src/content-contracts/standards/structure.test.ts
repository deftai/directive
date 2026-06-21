import { describe, expect, it } from "vitest";
import { isDir, isFile } from "./_helpers.js";

describe("test_structure.py", () => {
  it("coding/", () => {
    expect(isDir("coding")).toBe(true);
  });
  it("context/", () => {
    expect(isDir("context")).toBe(true);
  });
  it("contracts/", () => {
    expect(isDir("contracts")).toBe(true);
  });
  it("core/", () => {
    expect(isDir("core")).toBe(true);
  });
  it("deployments/", () => {
    expect(isDir("deployments")).toBe(true);
  });
  it("history/", () => {
    expect(isDir("history")).toBe(true);
  });
  it("interfaces/", () => {
    expect(isDir("interfaces")).toBe(true);
  });
  it("languages/", () => {
    expect(isDir("languages")).toBe(true);
  });
  it("meta/", () => {
    expect(isDir("meta")).toBe(true);
  });
  it("resilience/", () => {
    expect(isDir("resilience")).toBe(true);
  });
  it("scm/", () => {
    expect(isDir("scm")).toBe(true);
  });
  it("strategies/", () => {
    expect(isDir("strategies")).toBe(true);
  });
  it("swarm/", () => {
    expect(isDir("swarm")).toBe(true);
  });
  it("templates/", () => {
    expect(isDir("templates")).toBe(true);
  });
  it("tools/", () => {
    expect(isDir("tools")).toBe(true);
  });
  it("vbrief/", () => {
    expect(isDir("vbrief")).toBe(true);
  });
  it("verification/", () => {
    expect(isDir("verification")).toBe(true);
  });
  it("commands.md", () => {
    expect(isFile("commands.md")).toBe(true);
  });
  it("main.md", () => {
    expect(isFile("main.md")).toBe(true);
  });
  it("README.md", () => {
    expect(isFile("README.md")).toBe(true);
  });
  it("REFERENCES.md", () => {
    expect(isFile("REFERENCES.md")).toBe(true);
  });
  it("CHANGELOG.md", () => {
    expect(isFile("CHANGELOG.md")).toBe(true);
  });
  it("LICENSE.md", () => {
    expect(isFile("LICENSE.md")).toBe(true);
  });
  it("Taskfile.yml", () => {
    expect(isFile("Taskfile.yml")).toBe(true);
  });
  it("run", () => {
    expect(isFile("run")).toBe(true);
  });
  it("run.bat", () => {
    expect(isFile("run.bat")).toBe(true);
  });
  it("strategies/interview.md", () => {
    expect(isFile("strategies/interview.md")).toBe(true);
  });
  it("strategies/yolo.md", () => {
    expect(isFile("strategies/yolo.md")).toBe(true);
  });
  it("strategies/speckit.md", () => {
    expect(isFile("strategies/speckit.md")).toBe(true);
  });
  it("strategies/map.md", () => {
    expect(isFile("strategies/map.md")).toBe(true);
  });
  it("strategies/discuss.md", () => {
    expect(isFile("strategies/discuss.md")).toBe(true);
  });
  it("strategies/probe.md", () => {
    expect(isFile("strategies/probe.md")).toBe(true);
  });
  it("strategies/research.md", () => {
    expect(isFile("strategies/research.md")).toBe(true);
  });
  it("strategies/roadmap.md", () => {
    expect(isFile("strategies/roadmap.md")).toBe(true);
  });
  it("strategies/bdd.md", () => {
    expect(isFile("strategies/bdd.md")).toBe(true);
  });
  it("strategies/rapid.md", () => {
    expect(isFile("strategies/rapid.md")).toBe(true);
  });
  it("strategies/enterprise.md", () => {
    expect(isFile("strategies/enterprise.md")).toBe(true);
  });
  it("strategies/bdd.md", () => {
    expect(isFile("strategies/bdd.md")).toBe(true);
  });
  it("strategies/rapid.md", () => {
    expect(isFile("strategies/rapid.md")).toBe(true);
  });
  it("strategies/enterprise.md", () => {
    expect(isFile("strategies/enterprise.md")).toBe(true);
  });
  it("docs/getting-started.md", () => {
    expect(isFile("docs/getting-started.md")).toBe(true);
  });
});
