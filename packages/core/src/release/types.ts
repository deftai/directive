/* v8 ignore file -- type-only surface */
export interface ReleaseConfig {
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
  readonly skipTag: boolean;
  readonly skipRelease: boolean;
  readonly allowDirty: boolean;
  readonly draft: boolean;
  readonly skipCi: boolean;
  readonly skipBuild: boolean;
  readonly summary: string | null;
  readonly allowVbriefDrift: boolean;
}

export interface ReleaseFlags {
  readonly help: boolean;
  readonly version: string | null;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly projectRoot: string | null;
  readonly dryRun: boolean;
  readonly skipTag: boolean;
  readonly skipRelease: boolean;
  readonly allowDirty: boolean;
  readonly allowVbriefDrift: boolean;
  readonly skipCi: boolean;
  readonly skipBuild: boolean;
  readonly draft: boolean;
  readonly summary: string | null;
  readonly unknown: readonly string[];
}

export interface SpawnResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReleaseSeams {
  readonly todayIso?: () => string;
  readonly sleep?: (seconds: number) => void;
  readonly whichGh?: (name: string) => string | null;
  readonly whichUv?: (name: string) => string | null;
  readonly spawnText?: (
    cmd: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    },
  ) => SpawnResult;
  readonly writeFile?: (path: string, content: string) => void;
  readonly readFile?: (path: string) => string;
  readonly fileExists?: (path: string) => boolean;
  readonly runCi?: (projectRoot: string) => [boolean, string];
  readonly refreshRoadmap?: (projectRoot: string) => [boolean, string];
  readonly checkVbriefLifecycleSync?: (
    projectRoot: string,
    repo: string,
  ) => [boolean, number, string];
  readonly runBuild?: (projectRoot: string, version: string | null) => [boolean, string];
  readonly runUvLock?: (projectRoot: string) => [boolean, string];
  readonly checkTagAvailable?: (
    version: string,
    repo: string,
    projectRoot: string,
  ) => [boolean, string];
}
