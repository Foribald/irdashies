import { describe, expect, it } from 'vitest';
import { SampleBuffer } from './frontend/domain/lapTrace/lapSamples';
import { createLmuLapDistanceState } from './app/lmu/lapDistance';
import { mapLmuTelemetry } from './app/lmu/mapTelemetry';
import { fixture } from './app/lmu/rawFixture';

/**
 * The outcome the reconstruction exists for, end to end and offline.
 *
 * LMU publishes lap distance only in its 5 Hz scoring block, so across a 64 Hz
 * poll the fraction is repeatedly byte-identical. LapTrace's SampleBuffer
 * drops anything that has not advanced by MIN_SAMPLE_SPACING_M, so the trace
 * was built from roughly one poll in thirteen -- about five samples a second,
 * ~14 m apart at racing speed, which cannot show a braking point.
 *
 * This drives a synthetic sequence through the real mapper and the real buffer
 * and counts what is actually stored.
 */

const TRACK_M = 7004; // the fixture's own lapDist
const SPEED_MS = 70;
const POLL_SEC = 0.015;
const SCORING_SEC = 0.2;
const FRAMES = 200;
const START_ET = 250.4; // the fixture's own elapsedTime

/** Scoring steps at 5 Hz; the poll runs far faster. */
const scoringAt = (elapsedTime: number) => {
  const steps = Math.floor((elapsedTime - START_ET) / SCORING_SEC);
  return Math.min(0.99, (steps * SCORING_SEC * SPEED_MS) / TRACK_M);
};

const frameAt = (elapsedTime: number) => {
  const raw = fixture();
  raw.elapsedTime = elapsedTime;
  raw.speed = SPEED_MS;
  raw.vehLapDistPct = new Float64Array([scoringAt(elapsedTime)]);
  raw.playerVehicleIdx = 0;
  raw.playerHasVehicle = true;
  return raw;
};

const run = (withReconstruction: boolean) => {
  const buffer = new SampleBuffer();
  const state = createLmuLapDistanceState();
  const results = new Set<string>();

  for (let i = 0; i < FRAMES; i += 1) {
    const elapsedTime = START_ET + i * POLL_SEC;
    const telemetry = mapLmuTelemetry(
      frameAt(elapsedTime),
      withReconstruction ? state : undefined
    );
    const lapDistPct = telemetry.LapDistPct?.value[0] as number;
    results.add(
      buffer.push(
        lapDistPct * TRACK_M,
        elapsedTime - START_ET,
        0,
        1,
        SPEED_MS,
        4,
        0
      )
    );
  }

  return { stored: buffer.length, results };
};

describe('LMU lap distance through to the LapTrace sample buffer', () => {
  it('stores a sample per poll instead of one per scoring update', () => {
    const before = run(false).stored;
    const after = run(true).stored;

    // Without it, only the 5 Hz scoring steps land: 200 polls x 15 ms is 3 s,
    // so about fifteen samples.
    expect(before).toBeLessThanOrEqual((FRAMES * POLL_SEC) / SCORING_SEC + 1);
    // With it, essentially every poll lands.
    expect(after).toBeGreaterThan(FRAMES * 0.95);
    expect(after / before).toBeGreaterThan(10);
  });

  it('never feeds the buffer a backward step', () => {
    // A reversal over MAX_BACKWARD_M marks the lap dirty, and a dirty lap is
    // never promoted to a reference -- with nothing logged anywhere.
    expect(run(true).results.has('backward')).toBe(false);
  });
});
