import { describe, expect, it } from 'vitest';
import {
  createLmuPitSpeedState,
  PIT_SPEED_HOLD_MS,
  resetLmuPitSpeedState,
  updateLmuPitSpeedLimit,
  type LmuPitSpeedSample,
  type LmuPitSpeedState,
} from './pitSpeedLimit';

/** The bridge's own poll cadence, which is what the old threshold ignored. */
const POLL_MS = 8;

const limited = (speedMs: number): Omit<LmuPitSpeedSample, 'now'> => ({
  speedMs,
  inPits: true,
  limiterEngaged: true,
  throttle: 1,
  brake: 0,
});

/**
 * Drives the car at full throttle under the limiter: it accelerates at a
 * believable rate and then sits on the cap, sampled at the real poll rate.
 */
const driveToCap = (
  state: LmuPitSpeedState,
  capMs: number,
  {
    startMs = 0,
    accelMsPerS2 = 5,
    holdMs = PIT_SPEED_HOLD_MS * 2,
  }: { startMs?: number; accelMsPerS2?: number; holdMs?: number } = {}
) => {
  const published: number[] = [];
  let now = startMs;
  let speed = 1.5;
  const until = startMs + ((capMs - speed) / accelMsPerS2) * 1000 + holdMs;
  while (now <= until) {
    speed = Math.min(capMs, speed + (accelMsPerS2 * POLL_MS) / 1000);
    const change = updateLmuPitSpeedLimit(state, { now, ...limited(speed) });
    if (change !== undefined) published.push(change);
    now += POLL_MS;
  }
  return { published, endedAt: now };
};

const kph = (ms: number) => ms * 3.6;

describe('updateLmuPitSpeedLimit', () => {
  it('converges on the cap rather than the speed the limiter came on at', () => {
    const state = createLmuPitSpeedState();

    const { published } = driveToCap(state, 60 / 3.6);

    expect(published).toHaveLength(1);
    expect(kph(published[0])).toBeCloseTo(60, 1);
    expect(kph(state.limitMs ?? 0)).toBeCloseTo(60, 1);
  });

  it('does not commit while the car is still accelerating', () => {
    // The regression this replaces: at an 8 ms poll, a 5 m/s^2 climb gains
    // 0.04 m/s a frame, so a "risen by less than 0.1 m/s" test was already
    // true on the second frame and latched a half-speed limit.
    const state = createLmuPitSpeedState();
    let now = 0;
    let speed = 1.5;
    const cap = 60 / 3.6;

    while (speed < cap - 1) {
      speed += (5 * POLL_MS) / 1000;
      expect(
        updateLmuPitSpeedLimit(state, { now, ...limited(speed) })
      ).toBeUndefined();
      now += POLL_MS;
    }

    expect(state.limitMs).toBeUndefined();
  });

  it('reads an 80 kph lane as 80, not as whatever 60 kph lane came before', () => {
    // Track-dependent only because the measurement is, so a reset has to
    // actually forget the previous lane.
    const state = createLmuPitSpeedState();
    driveToCap(state, 60 / 3.6);
    expect(kph(state.limitMs ?? 0)).toBeCloseTo(60, 1);

    resetLmuPitSpeedState(state);
    const { published } = driveToCap(state, 80 / 3.6);

    expect(published).toHaveLength(1);
    expect(kph(published[0])).toBeCloseTo(80, 1);
  });

  it('publishes only on the frame the limit changes', () => {
    const state = createLmuPitSpeedState();

    const first = driveToCap(state, 60 / 3.6);
    expect(first.published).toHaveLength(1);

    // Another lap of the same pit lane says nothing new.
    const second = driveToCap(state, 60 / 3.6, { startMs: first.endedAt });
    expect(second.published).toEqual([]);
  });

  it('does not let a lift confirm a half-speed limit', () => {
    // Reaching 30 kph, lifting for ten seconds, then crawling. The pause must
    // not accumulate as time spent sitting at 30.
    const state = createLmuPitSpeedState();
    let now = 0;
    let speed = 1.5;

    while (speed < 30 / 3.6) {
      speed += (5 * POLL_MS) / 1000;
      updateLmuPitSpeedLimit(state, { now, ...limited(speed) });
      now += POLL_MS;
    }
    expect(state.limitMs).toBeUndefined();

    // Off the throttle for well over the hold window.
    for (let i = 0; i < 100; i++) {
      updateLmuPitSpeedLimit(state, {
        now,
        ...limited(speed),
        throttle: 0,
      });
      now += 100;
    }

    expect(state.limitMs).toBeUndefined();
  });

  it('revises an under-estimate upward', () => {
    // A burst that holds below the cap commits that lower figure; a later
    // run to the real cap has to correct it, because a cap cannot fall.
    const state = createLmuPitSpeedState();
    let now = 0;

    for (let i = 0; i <= PIT_SPEED_HOLD_MS / POLL_MS + 2; i++) {
      updateLmuPitSpeedLimit(state, { now, ...limited(40 / 3.6) });
      now += POLL_MS;
    }
    expect(kph(state.limitMs ?? 0)).toBeCloseTo(40, 1);

    const { published } = driveToCap(state, 60 / 3.6, { startMs: now });

    expect(published).toHaveLength(1);
    expect(kph(published[0])).toBeCloseTo(60, 1);
    expect(kph(state.limitMs ?? 0)).toBeCloseTo(60, 1);
  });

  it('ignores frames that say nothing about the cap', () => {
    const state = createLmuPitSpeedState();
    const now = 0;

    // Out of the pits, limiter off, braking, crawling, or no speed at all.
    const ignored: Omit<LmuPitSpeedSample, 'now'>[] = [
      { ...limited(16.6), inPits: false },
      { ...limited(16.6), limiterEngaged: false },
      { ...limited(16.6), brake: 0.5 },
      { ...limited(16.6), throttle: 0.5 },
      limited(0.5),
      { ...limited(16.6), speedMs: undefined },
      { ...limited(16.6), speedMs: Number.NaN },
    ];

    ignored.forEach((sample) => {
      expect(updateLmuPitSpeedLimit(state, { now, ...sample })).toBeUndefined();
    });
    expect(state.peakMs).toBeUndefined();
    expect(state.limitMs).toBeUndefined();
  });
});
