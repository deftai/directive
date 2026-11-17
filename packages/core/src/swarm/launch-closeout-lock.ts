import { join, resolve } from "node:path";
import { type LockDeps, withAppendLock } from "../slice/lock.js";

/**
 * The one lock that `swarm:launch` and cohort close-out share (#6422 item 2).
 * Its file sits beside the launch-occupancy record directory:
 * `.deft/swarm-launch-occupancy.lock`.
 */
export const LAUNCH_CLOSEOUT_LOCK_BASE_RELPATH = [".deft", "swarm-launch-occupancy"] as const;

export function launchCloseoutLockPath(projectRoot: string): string {
  return `${join(resolve(projectRoot), ...LAUNCH_CLOSEOUT_LOCK_BASE_RELPATH)}.lock`;
}

export type LaunchCloseoutLockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

/**
 * Run `fn` under the launch/close-out lock. Both a lock that cannot be
 * acquired (the caller runs the command again) and an error raised inside
 * `fn` come back as a returned failure, so a close-out that already moved
 * briefs can still report the move on disk (#6422 item 11).
 */
export function withLaunchCloseoutLock<T>(
  projectRoot: string,
  fn: () => T,
  deps: LockDeps = {},
): LaunchCloseoutLockResult<T> {
  const root = resolve(projectRoot);
  let entered = false;
  try {
    const value = withAppendLock(
      join(root, ...LAUNCH_CLOSEOUT_LOCK_BASE_RELPATH),
      () => {
        entered = true;
        return fn();
      },
      { ...deps, containmentRoot: root },
    );
    return { ok: true, value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (entered) {
      return {
        ok: false,
        detail: `swarm launch/close-out stopped with an unexpected error under its lock: ${message}`,
      };
    }
    return {
      ok: false,
      detail:
        `could not take the swarm launch/close-out lock ${launchCloseoutLockPath(root)}: ` +
        `${message}. Another swarm:launch or close-out is running; run the command again.`,
    };
  }
}
