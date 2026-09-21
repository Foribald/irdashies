import { describe, expect, it } from 'vitest';
import { CarLeftRight } from '@irdashies/types';
import type { LmuRawTelemetry } from '../native/lmu';
import {
  classifyLmuBlindSpot,
  createLmuBlindSpotLatch,
  deriveLmuRelativePositions,
  resetLmuBlindSpotLatch,
} from './proximity';

const fixture = (
  positions: [number, number][],
  orientation: [number, number] = [0, 1]
) =>
  ({
    playerHasVehicle: true,
    playerVehicleIdx: 0,
    vehTelemetryAvailable: new Uint8Array(positions.map(() => 1)),
    vehPosX: new Float64Array(positions.map(([x]) => x)),
    vehPosZ: new Float64Array(positions.map(([, z]) => z)),
    vehOriX: new Float64Array(positions.map(() => orientation[0])),
    vehOriZ: new Float64Array(positions.map(() => orientation[1])),
  }) as LmuRawTelemetry;

describe('LMU proximity', () => {
  it('matches TinyPedal local-frame rotation', () => {
    const positions = deriveLmuRelativePositions(
      fixture([
        [100, 200],
        [103, 190],
      ])
    );

    expect(positions?.lateral[1]).toBeCloseTo(-3);
    expect(positions?.longitudinal[1]).toBeCloseTo(-10);
    expect(positions?.heading[1]).toBeCloseTo(0);
  });

  it('rotates positions with player orientation', () => {
    const positions = deriveLmuRelativePositions(
      fixture(
        [
          [0, 0],
          [0, 3],
        ],
        [1, 0]
      )
    );

    expect(positions?.lateral[1]).toBeCloseTo(-3);
    expect(positions?.longitudinal[1]).toBeCloseTo(0);
  });

  it('applies blind-spot overlap thresholds', () => {
    expect(
      classifyLmuBlindSpot(
        deriveLmuRelativePositions(
          fixture([
            [0, 0],
            [3, 0],
            [-3, 0],
          ])
        )
      )
    ).toBe(CarLeftRight.CarLeftRight);

    expect(
      classifyLmuBlindSpot(
        deriveLmuRelativePositions(
          fixture([
            [0, 0],
            [1, 0],
            [3, 8],
          ])
        )
      )
    ).toBe(CarLeftRight.Clear);
  });
});

describe('blind-spot hysteresis', () => {
  /**
   * Classify a car `distance` metres to the player's LEFT.
   *
   * Note the sign: the local-frame transform is a reflection, so a car at
   * POSITIVE world x lands at negative lateral, which is the left side. Worth
   * pinning in a test rather than reasoning about.
   */
  const leftAt = (
    distance: number,
    latch?: ReturnType<typeof createLmuBlindSpotLatch>
  ) =>
    classifyLmuBlindSpot(
      deriveLmuRelativePositions(
        fixture([
          [0, 0],
          [distance, 0],
        ])
      ),
      latch
    );

  it('holds a car that drifts inside the entry bound', () => {
    const latch = createLmuBlindSpotLatch();
    // Enters cleanly at 3 m, then wanders in to 1.5 m — inside the 1.98 m entry
    // bound but still outside the 1.36 m exit bound, so it stays alongside.
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
    expect(leftAt(1.5, latch)).toBe(CarLeftRight.CarLeft);
    // Without a latch the same frame reads Clear, which is the old behaviour.
    expect(leftAt(1.5)).toBe(CarLeftRight.Clear);
  });

  it('does not flicker while a car runs alongside', () => {
    // The reported bug: ordinary lateral wander across the 1.98 m bound made the
    // bars blink at the delivery rate.
    const latch = createLmuBlindSpotLatch();
    expect(leftAt(2.05, latch)).toBe(CarLeftRight.CarLeft);
    for (const lateral of [1.95, 2.02, 1.9, 2.1, 1.96]) {
      expect(leftAt(lateral, latch)).toBe(CarLeftRight.CarLeft);
    }
  });

  it('releases a car that genuinely leaves, with no added latency', () => {
    const latch = createLmuBlindSpotLatch();
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
    // Past the 1.36 m exit bound: overlapping, so no longer a blind spot.
    expect(leftAt(1.2, latch)).toBe(CarLeftRight.Clear);
    // And past the outer 4.84 m exit bound: a lane away.
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
    expect(leftAt(5, latch)).toBe(CarLeftRight.Clear);
  });

  it('releases when the car stops being available', () => {
    const latch = createLmuBlindSpotLatch();
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
    const gone = deriveLmuRelativePositions(
      fixture([
        [0, 0],
        [3, 0],
      ])
    );
    expect(gone).not.toBeNull();
    if (gone) gone.available[1] = false;
    expect(classifyLmuBlindSpot(gone, latch)).toBe(CarLeftRight.Clear);
    // The latch is cleared, so re-entry must cross the entry bound again.
    expect(leftAt(1.5, latch)).toBe(CarLeftRight.Clear);
  });

  it('keeps the latched side, so a car cannot swap sides while alongside', () => {
    const latch = createLmuBlindSpotLatch();
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
    // A sign flip would have to pass through lateral 0, deep inside the exit
    // bound, so the latch releases first rather than reporting the wrong side.
    expect(leftAt(-3, latch)).toBe(CarLeftRight.CarLeft);
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
  });

  it('grows with the grid without reading past the latch', () => {
    const latch = createLmuBlindSpotLatch();
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft); // latch sized for 2
    const bigger = deriveLmuRelativePositions(
      fixture([
        [0, 0],
        [-3, 0],
        [3, 0],
        [40, 40],
      ])
    );
    expect(classifyLmuBlindSpot(bigger, latch)).not.toBe(CarLeftRight.Off);
    expect(latch.engaged.length).toBeGreaterThanOrEqual(4);
  });

  it('counts both sides at once on a fresh latch', () => {
    const both = deriveLmuRelativePositions(
      fixture([
        [0, 0],
        [-3, 0],
        [3, 0],
      ])
    );
    expect(classifyLmuBlindSpot(both, createLmuBlindSpotLatch())).toBe(
      CarLeftRight.CarLeftRight
    );
  });

  it('forgets every latch on reset', () => {
    const latch = createLmuBlindSpotLatch();
    expect(leftAt(3, latch)).toBe(CarLeftRight.CarLeft);
    resetLmuBlindSpotLatch(latch);
    // Back to needing the entry bound, not the wider exit bound.
    expect(leftAt(1.5, latch)).toBe(CarLeftRight.Clear);
  });
});
