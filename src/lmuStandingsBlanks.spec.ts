import { describe, expect, it } from 'vitest';
import { mapLmuSession } from './app/irsdk/lmu/mapSession';
import { mapLmuTelemetry } from './app/irsdk/lmu/mapTelemetry';
import { fixture } from './app/irsdk/lmu/rawFixture';
import { fixture as sessionFixture } from './app/irsdk/lmu/rawSessionFixture';
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

describe('LMU session results through to the formatter', () => {
  it('renders nothing for a driver with no lap', () => {
    // createStandings falls back to these whenever the telemetry frame has no
    // time, so normalising only the frame left the zero showing here.
    const raw = sessionFixture();
    raw.drivers[0].bestLapTime = 0;
    raw.drivers[0].lastLapTime = 0;

    const s = mapLmuSession(raw);
    const quali = s.SessionInfo?.Sessions?.[0]?.QualifyPositions ?? [];
    const entry = quali.find((q) => q.CarIdx === 0);

    expect(formatTime(entry?.FastestTime)).toBe('');
  });
});
