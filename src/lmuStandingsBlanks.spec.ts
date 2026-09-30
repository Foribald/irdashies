import { describe, expect, it } from 'vitest';
import { mapLmuTelemetry } from './app/irsdk/lmu/mapTelemetry';
import { fixture } from './app/irsdk/lmu/rawFixture';
import { formatTime } from './frontend/utils/time';

/**
 * The reported symptom, end to end: in LMU the standings showed a lap time of
 * "0:00.000" where there was no lap.
 *
 * formatTime treats a negative as absent and renders 0 as a real time, and the
 * standings cells hand it their value unguarded, so the whole fix rests on the
 * mapper emitting the negative sentinel. This asserts that across the boundary
 * rather than trusting each side separately.
 */

/** Slot 0 as the addon leaves an unoccupied one: zero everywhere but lapDistPct. */
const frameWithEmptySlot = () => {
  const raw = fixture();
  raw.vehLapDistPct = [-1, 0.6, 0.2] as unknown as typeof raw.vehLapDistPct;
  raw.vehBestLapTime = [
    0, 132.8, 137.1,
  ] as unknown as typeof raw.vehBestLapTime;
  raw.vehLastLapTime = [
    0, 133.4, 138.9,
  ] as unknown as typeof raw.vehLastLapTime;
  return raw;
};

describe('LMU standings lap times through to the formatter', () => {
  it('renders nothing for a slot with no car', () => {
    const t = mapLmuTelemetry(frameWithEmptySlot());
    const best = (t.CarIdxBestLapTime?.value as number[])[0];
    const last = (t.CarIdxLastLapTime?.value as number[])[0];

    expect(formatTime(best)).toBe('');
    expect(formatTime(last)).toBe('');
  });

  it('still renders a real lap time', () => {
    const t = mapLmuTelemetry(frameWithEmptySlot());
    const best = (t.CarIdxBestLapTime?.value as number[])[1];

    expect(formatTime(best)).toBe('2:12.800');
  });

  it('renders nothing for a car that has not set a lap yet', () => {
    // LMU writes -1 here, the addon's zero-fill writes 0; both are absent.
    const raw = fixture();
    raw.vehBestLapTime = [-1, 0, 137.1] as unknown as typeof raw.vehBestLapTime;
    const t = mapLmuTelemetry(raw);
    const times = t.CarIdxBestLapTime?.value as number[];

    expect(formatTime(times[0])).toBe('');
    expect(formatTime(times[1])).toBe('');
  });
});
