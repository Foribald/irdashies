/**
 * Inferring LMU's pit speed limit.
 *
 * LMU publishes no pit speed limit. Its shared memory says whether the
 * limiter is available and whether it is engaged -- mSpeedLimiterAvailable,
 * mSpeedLimiter, mSpeedLimiterActive -- and nothing at all about what it
 * limits to. There is no track field to read, so the only source is the car
 * itself: with the limiter engaged and the throttle pinned, speed climbs to
 * the cap and then stays there.
 *
 * So this is a converging measurement, not a lookup. It is deliberately slow
 * to commit, because the failure it replaces was committing far too fast.
 *
 * The previous version latched the first frame whose speed had risen by less
 * than 0.1 m/s since the one before. The bridge polls every 8 ms, where
 * 0.1 m/s amounts to 12.5 m/s^2 -- more acceleration than anything manages in
 * a pit lane -- so the test passed on the second qualifying frame and froze
 * whatever speed the car happened to be doing. A 60 kph pit lane reported 48,
 * and a different run of the same lane reported something else again, because
 * the answer depended only on where the car was when the limiter came on.
 */

/** How long speed must hold at its peak before that peak is the limit. */
export const PIT_SPEED_HOLD_MS = 1000;
/** Noise tolerance on "the peak went up", m/s. */
const PEAK_EPSILON_MS = 0.05;
/** Below this the car is crawling and tells us nothing about the cap. */
const MIN_CALIBRATION_SPEED_MS = 1;

export interface LmuPitSpeedState {
  /** Highest limited speed seen so far, m/s. */
  peakMs: number | undefined;
  /** Time spent at that peak, counted across qualifying frames only. */
  heldMs: number;
  /** The previous qualifying frame's timestamp, for the interval. */
  lastTickMs: number | undefined;
  /** The published estimate, m/s, or undefined while none is known. */
  limitMs: number | undefined;
}

export const createLmuPitSpeedState = (): LmuPitSpeedState => ({
  peakMs: undefined,
  heldMs: 0,
  lastTickMs: undefined,
  limitMs: undefined,
});

/** Forgets everything. For a track change, where the cap may differ. */
export const resetLmuPitSpeedState = (state: LmuPitSpeedState): void => {
  state.peakMs = undefined;
  state.heldMs = 0;
  state.lastTickMs = undefined;
  state.limitMs = undefined;
};

export interface LmuPitSpeedSample {
  /** Monotonic milliseconds. */
  now: number;
  speedMs: number | undefined;
  inPits: boolean;
  limiterEngaged: boolean;
  throttle: number | undefined;
  brake: number | undefined;
}

/**
 * Folds one frame into the estimate.
 *
 * Returns the limit in m/s only on the frame that changed it, so the caller
 * can republish the session snapshot on a change rather than every poll.
 */
export function updateLmuPitSpeedLimit(
  state: LmuPitSpeedState,
  sample: LmuPitSpeedSample
): number | undefined {
  const { speedMs } = sample;
  const qualifies =
    sample.inPits &&
    sample.limiterEngaged &&
    (sample.throttle ?? 0) > 0.95 &&
    (sample.brake ?? 1) < 0.01 &&
    speedMs !== undefined &&
    Number.isFinite(speedMs) &&
    speedMs > MIN_CALIBRATION_SPEED_MS;

  if (!qualifies) {
    // Paused, not reset: the peak so far is still a lower bound on the cap.
    // Dropping the timestamp is what stops the gap being counted as time the
    // car spent sitting at that peak -- a driver who lifts halfway down the
    // pit lane must not thereby confirm a half-speed limit.
    state.lastTickMs = undefined;
    return undefined;
  }

  const speed = speedMs as number;
  const elapsed =
    state.lastTickMs === undefined
      ? 0
      : Math.max(0, sample.now - state.lastTickMs);
  state.lastTickMs = sample.now;

  if (state.peakMs === undefined || speed > state.peakMs + PEAK_EPSILON_MS) {
    // Still climbing, so nothing is known yet. This is the branch the old
    // threshold fell through on every frame of a normal pit exit.
    state.peakMs = speed;
    state.heldMs = 0;
    return undefined;
  }

  state.heldMs += elapsed;
  if (state.heldMs < PIT_SPEED_HOLD_MS) return undefined;

  const limitMs = Math.round(state.peakMs * 3.6) / 3.6;
  // Revised upward only. An under-estimate -- a burst too short to reach the
  // cap, or a queue that held the car below it -- is corrected by any later
  // observation, while a cap cannot fall within one track.
  if (state.limitMs !== undefined && limitMs <= state.limitMs) return undefined;
  state.limitMs = limitMs;
  return limitMs;
}
