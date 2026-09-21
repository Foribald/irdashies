import { CarLeftRight } from '@irdashies/types';
import type { LmuRawTelemetry } from '../native/lmu';

export interface LmuRelativePositions {
  available: boolean[];
  lateral: number[];
  longitudinal: number[];
  heading: number[];
}

const VEHICLE_WIDTH = 2.2;
const VEHICLE_LENGTH = 4.6;

/**
 * Bounds for a car to *enter* the blind spot. Unchanged: a car must be beside
 * the player, neither overlapping nor a lane away, and roughly alongside.
 */
const LATERAL_MIN_ENTER = VEHICLE_WIDTH * 0.9; // 1.98 m
const LATERAL_MAX_ENTER = VEHICLE_WIDTH * 1.9; // 4.18 m
const LONGITUDINAL_MAX_ENTER = VEHICLE_LENGTH * 1.2; // 5.52 m

/**
 * Wider bounds for a car to *leave* it again — a Schmitt trigger.
 *
 * Without this the bounds were bare single-sided thresholds recomputed from
 * scratch each frame, and a car simply running alongside sits right on top of
 * the 1.98 m inner bound: normal lateral wander then toggled CarLeft/Clear at
 * the delivery rate, which is the reported flicker. The inner band is the one
 * that matters; 0.62 m is several seconds of ordinary side-by-side movement.
 *
 * A dwell band costs nothing in latency, unlike a time-based debounce: a car
 * that genuinely leaves crosses the exit bound immediately.
 */
const LATERAL_MIN_EXIT = VEHICLE_WIDTH * 0.62; // 1.36 m
const LATERAL_MAX_EXIT = VEHICLE_WIDTH * 2.2; // 4.84 m
const LONGITUDINAL_MAX_EXIT = VEHICLE_LENGTH * 1.4; // 6.44 m

/**
 * Which side each car is latched on: -1 left, 0 not latched, +1 right.
 *
 * Owned by the caller and mutated in place, so the classifier stays a pure
 * function of (positions, latch) with no hidden timers and no module state —
 * and so it can be stepped deterministically in a test.
 */
export interface LmuBlindSpotLatch {
  engaged: Int8Array;
}

export const createLmuBlindSpotLatch = (): LmuBlindSpotLatch => ({
  engaged: new Int8Array(0),
});

/** Forget every latch — on disconnect, or a track change that reuses slots. */
export const resetLmuBlindSpotLatch = (latch: LmuBlindSpotLatch): void => {
  latch.engaged.fill(0);
};

const latchFor = (latch: LmuBlindSpotLatch, size: number): Int8Array => {
  if (latch.engaged.length >= size) return latch.engaged;
  const grown = new Int8Array(size);
  grown.set(latch.engaged);
  latch.engaged = grown;
  return grown;
};

export function deriveLmuRelativePositions(
  raw: LmuRawTelemetry
): LmuRelativePositions | null {
  const playerIdx = raw.playerHasVehicle ? raw.playerVehicleIdx : -1;
  if (
    playerIdx < 0 ||
    raw.vehTelemetryAvailable?.[playerIdx] !== 1 ||
    !raw.vehPosX ||
    !raw.vehPosZ ||
    !raw.vehOriX ||
    !raw.vehOriZ
  ) {
    return null;
  }

  const playerX = raw.vehPosX[playerIdx];
  const playerZ = raw.vehPosZ[playerIdx];
  const playerYaw = Math.atan2(raw.vehOriX[playerIdx], raw.vehOriZ[playerIdx]);
  if (![playerX, playerZ, playerYaw].every(Number.isFinite)) return null;

  const sin = Math.sin(playerYaw - Math.PI);
  const cos = Math.cos(playerYaw - Math.PI);
  const length = raw.vehTelemetryAvailable.length;
  const result: LmuRelativePositions = {
    available: Array(length).fill(false),
    lateral: Array(length).fill(0),
    longitudinal: Array(length).fill(0),
    heading: Array(length).fill(0),
  };

  for (let carIdx = 0; carIdx < length; carIdx += 1) {
    if (carIdx === playerIdx || raw.vehTelemetryAvailable[carIdx] !== 1) {
      continue;
    }

    const deltaX = raw.vehPosX[carIdx] - playerX;
    const deltaZ = -(raw.vehPosZ[carIdx] - playerZ);
    const lateral = cos * deltaX - sin * deltaZ;
    const longitudinal = cos * deltaZ + sin * deltaX;
    const heading =
      Math.atan2(raw.vehOriX[carIdx], raw.vehOriZ[carIdx]) - playerYaw;
    if (![lateral, longitudinal, heading].every(Number.isFinite)) continue;

    result.available[carIdx] = true;
    result.lateral[carIdx] = lateral;
    result.longitudinal[carIdx] = longitudinal;
    result.heading[carIdx] = heading;
  }

  return result;
}

/**
 * Which side, if any, has a car alongside.
 *
 * Pass `latch` to get hysteresis: a car already alongside stays alongside until
 * it clears the wider exit bounds. Omit it and the behaviour is exactly what it
 * was before the latch existed, which is what the existing specs rely on.
 */
export function classifyLmuBlindSpot(
  positions: LmuRelativePositions | null,
  latch?: LmuBlindSpotLatch
): CarLeftRight | null {
  if (!positions) return null;

  const count = positions.available.length;
  const engaged = latch ? latchFor(latch, count) : null;

  let left = 0;
  let right = 0;
  for (let carIdx = 0; carIdx < count; carIdx += 1) {
    if (!positions.available[carIdx]) {
      if (engaged) engaged[carIdx] = 0;
      continue;
    }
    const lateral = positions.lateral[carIdx];
    const longitudinal = positions.longitudinal[carIdx];
    const wasEngaged = engaged ? engaged[carIdx] !== 0 : false;
    const lat = Math.abs(lateral);
    const lon = Math.abs(longitudinal);
    const inside = wasEngaged
      ? lat > LATERAL_MIN_EXIT &&
        lat < LATERAL_MAX_EXIT &&
        lon < LONGITUDINAL_MAX_EXIT
      : lat > LATERAL_MIN_ENTER &&
        lat < LATERAL_MAX_ENTER &&
        lon < LONGITUDINAL_MAX_ENTER;
    if (!inside) {
      if (engaged) engaged[carIdx] = 0;
      continue;
    }
    // The side is latched on entry. Flipping it would need the car to pass
    // through lateral 0, which is deep inside the inner reject band, so a
    // latched car cannot swap sides without releasing first.
    const side = wasEngaged && engaged ? engaged[carIdx] : lateral < 0 ? -1 : 1;
    if (engaged) engaged[carIdx] = side;
    if (side < 0) left += 1;
    else right += 1;
  }

  if (left && right) return CarLeftRight.CarLeftRight;
  if (left > 1) return CarLeftRight.Cars2Left;
  if (right > 1) return CarLeftRight.Cars2Right;
  if (left) return CarLeftRight.CarLeft;
  if (right) return CarLeftRight.CarRight;
  return CarLeftRight.Clear;
}
