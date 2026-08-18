import { basename } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { applyWorktreeOccupancy, releaseOccupancy } from "./occupancy.js";

export function runOccupancyStressRounds(input: {
  readonly root: string;
  readonly logPath: string;
  readonly sessionId: string;
  readonly rounds: number;
}): void {
  for (let i = 0; i < input.rounds; i += 1) {
    const claimed = applyWorktreeOccupancy(input.root, {
      sessionId: input.sessionId,
      now: new Date(),
    });
    if (claimed.code !== 0) continue;
    containedWrite({
      root: input.root,
      target: basename(input.logPath),
      data: `ENTER ${input.sessionId}\n`,
      mode: "append",
    });
    containedWrite({
      root: input.root,
      target: basename(input.logPath),
      data: `LEAVE ${input.sessionId}\n`,
      mode: "append",
    });
    releaseOccupancy(input.root, { sessionId: input.sessionId, now: new Date() });
  }
}

const root = process.env.OCCUPANCY_STRESS_ROOT ?? "";
if (root.length > 0) {
  runOccupancyStressRounds({
    root,
    logPath: process.env.OCCUPANCY_STRESS_LOG ?? "",
    sessionId: process.env.OCCUPANCY_STRESS_SESSION ?? "",
    rounds: Number(process.env.OCCUPANCY_STRESS_ROUNDS ?? "0"),
  });
}
