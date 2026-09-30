import { describe, expect, it } from 'vitest';
import { CarLeftRight } from '@irdashies/types';
import type { LmuRawTelemetry } from '../native/lmu';
import { mapLmuSectorTimes, mapLmuTelemetry } from './mapTelemetry';
import { fixture } from './rawFixture';
import { createLmuLapDistanceState } from './lapDistance';

describe('mapLmuTelemetry', () => {
  it('maps session scalars', () => {
    const t = mapLmuTelemetry(fixture());
    expect(t.SessionTick.value[0]).toBe(1250.5);
    expect(t.SessionTime.value[0]).toBe(1250.5);
    expect(t.SessionTimeTotal.value[0]).toBe(3600);
    expect(t.SessionTimeRemain.value[0]).toBe(2349.5);
    expect(t.SessionLapsTotal.value[0]).toBe(12);
    expect(t.SessionLapsRemain.value[0]).toBe(9);
    expect(t.SessionNum.value[0]).toBe(1);
    expect(t.SessionState.value[0]).toBe(3);
    expect(t.SessionTimeOfDay.value[0]).toBe(0.45);
  });

  it('maps game phase to iRacing session state', () => {
    const base = fixture();
    const phases: [number, number][] = [
      [0, 0],
      [1, 2],
      [2, 1],
      [3, 3],
      [4, 3],
      [5, 4],
      [6, 4],
      [7, 5],
      [8, 6],
      [9, 4],
    ];
    for (const [phase, state] of phases) {
      expect(
        mapLmuTelemetry({ ...base, gamePhase: phase }).SessionState.value[0]
      ).toBe(state);
    }
  });

  it('maps player telemetry', () => {
    const t = mapLmuTelemetry(fixture());
    expect(t.PlayerCarIdx.value[0]).toBe(1);
    expect(t.Speed.value[0]).toBeCloseTo(51.234);
    expect(t.FuelLevel.value[0]).toBe(42);
    expect(t.FuelLevelPct.value[0]).toBeCloseTo(42 / 110);
    expect(t.WaterTemp.value[0]).toBe(95);
    expect(t.OilTemp.value[0]).toBe(110);
    expect(t.Gear.value[0]).toBe(5);
    expect(t.RPM.value[0]).toBe(8200);
    expect(t.LapCurrentLapTime.value[0]).toBeCloseTo(50.4);
    expect(t.Throttle.value[0]).toBeCloseTo(0.79);
    expect(t.Brake.value[0]).toBe(0);
    expect(t.Clutch.value[0]).toBe(1);
    expect(t.ClutchRaw.value[0]).toBe(1);
    expect(t.RadioTransmitCarIdx.value[0]).toBe(-1);
    expect(t.BrakeABSactive.value[0]).toBe(true);
    expect(t.Speed).toBeDefined();
    expect(t.SteeringWheelAngle.value[0]).toBeCloseTo(
      0.29 * ((480 * Math.PI) / 360)
    );
    expect(t.dcBrakeBias.value[0]).toBeCloseTo(0.45);
    expect(t.dcPitSpeedLimiterToggle.value[0]).toBe(false);
    expect(t.LatAccel.value[0]).toBeCloseTo(9.80665);
    expect(t.LongAccel.value[0]).toBeCloseTo(-19.6133);
    expect(t.LFtempCL.value[0]).toBe(80);
    expect(t.RRcoldPressure.value[0]).toBe(183);
    expect(t.LRwearM.value[0]).toBe(0.7);
    expect(t.RFbrakeLinePress.value[0]).toBe(0.5);
    expect(t.RRshockDefl.value[0]).toBe(0.07);
  });

  it('maps the LMU pit limiter switch, not only active intervention', () => {
    const t = mapLmuTelemetry({
      ...fixture(),
      speedLimiter: 1,
      speedLimiterActive: false,
    });

    expect(t.dcPitSpeedLimiterToggle.value[0]).toBe(true);
  });

  it('handles the no-player case', () => {
    const rest: Record<string, unknown> = { ...fixture() };
    delete rest.speed;
    rest.playerHasVehicle = false;
    rest.playerVehicleIdx = -1;
    const t = mapLmuTelemetry(rest as unknown as LmuRawTelemetry);
    expect(t.PlayerCarIdx.value[0]).toBe(-1);
    expect(t.Speed.value[0]).toBe(0);
    expect(t.OnPitRoad.value[0]).toBe(false);
    expect(t.IsOnTrack.value[0]).toBe(false);
  });

  it('maps per-car arrays by slot', () => {
    const t = mapLmuTelemetry(fixture());
    expect(t.CarIdxPosition.value).toEqual([2, 1, 3]);
    expect(t.CarIdxLapDistPct.value).toEqual([0.4, 0.6, 0.2]);
    expect(t.CarIdxLap.value).toEqual([2, 3, 1]);
    expect(t.CarIdxClass.value).toEqual([0, 0, 1]);
    expect(t.CarIdxBestLapTime.value).toEqual([134.5, 132.8, 137.1]);
    expect(t.CarIdxEstTime.value).toEqual([50, 60, 20]);
    expect(t.CarIdxOnPitRoad.value).toEqual([false, false, true]);
    expect(t.CarIdxTrackSurface.value).toEqual([3, 3, 1]);
  });

  it('clamps LMU lap distance progress for map positioning', () => {
    const t = mapLmuTelemetry({
      ...fixture(),
      vehLapDistPct: new Float64Array([-0.1, 0.6, 1.2]),
    });
    expect(t.CarIdxLapDistPct.value).toEqual([-1, 0.6, 1]);
    expect(t.LapDistPct.value[0]).toBe(0.6);
  });

  it('maps nearby world positions to iRacing blind-spot states', () => {
    const base = {
      ...fixture(),
      playerVehicleIdx: 0,
      vehTelemetryAvailable: new Uint8Array([1, 1, 1]),
      vehPosX: new Float64Array([0, 3, 20]),
      vehPosZ: new Float64Array([0, 0, 20]),
      vehOriX: new Float64Array([0, 0, 0]),
      vehOriZ: new Float64Array([1, 1, 1]),
    };

    expect(mapLmuTelemetry(base).CarLeftRight.value[0]).toBe(
      CarLeftRight.CarLeft
    );
    expect(
      mapLmuTelemetry({
        ...base,
        vehPosX: new Float64Array([0, -3, 20]),
      }).CarLeftRight.value[0]
    ).toBe(CarLeftRight.CarRight);
    expect(
      mapLmuTelemetry({
        ...base,
        vehPosX: new Float64Array([0, 3, -3]),
        vehPosZ: new Float64Array([0, 0, 0]),
      }).CarLeftRight.value[0]
    ).toBe(CarLeftRight.CarLeftRight);
  });

  it('rotates world positions into the player frame', () => {
    const t = mapLmuTelemetry({
      ...fixture(),
      playerVehicleIdx: 0,
      vehTelemetryAvailable: new Uint8Array([1, 1]),
      vehPosX: new Float64Array([0, 0]),
      vehPosZ: new Float64Array([0, 3]),
      vehOriX: new Float64Array([1, 1]),
      vehOriZ: new Float64Array([0, 0]),
    });

    expect(t.CarLeftRight.value[0]).toBe(CarLeftRight.CarLeft);
  });

  it('turns the blind-spot signal off when native position data is missing', () => {
    const t = mapLmuTelemetry({
      ...fixture(),
      vehTelemetryAvailable: new Uint8Array([0, 0, 0]),
    });

    expect(t.CarLeftRight.value[0]).toBe(CarLeftRight.Off);
  });

  it('computes wind magnitude', () => {
    const t = mapLmuTelemetry(fixture());
    expect(t.WindVel.value[0]).toBeCloseTo(Math.hypot(2, 0, -3));
  });

  it('maps LMU race flags', () => {
    const base = fixture();
    expect(
      mapLmuTelemetry({ ...base, gamePhase: 5 }).SessionFlags.value[0]
    ).toBe(0);
    expect(
      mapLmuTelemetry({
        ...base,
        sectorFlags: new Uint8Array([0, 1, 0]),
      }).SessionFlags.value[0]
    ).toBe(8);
    expect(
      mapLmuTelemetry({ ...base, gamePhase: 8 }).SessionFlags.value[0]
    ).toBe(1);
    expect(
      mapLmuTelemetry({
        ...base,
        gamePhase: 5,
        sectorFlags: new Uint8Array([255, 0, 0]),
      }).SessionFlags.value[0]
    ).toBe(0);
    expect(
      mapLmuTelemetry({
        ...base,
        gamePhase: 5,
        vehFlag: new Uint8Array([0, 6, 0]),
      }).SessionFlags.value[0]
    ).toBe(32);
  });

  it('converts cumulative LMU sector times and invalid sentinels', () => {
    const times = mapLmuSectorTimes(32.4, 73.4, 133.4);
    expect(times[0]).toBeCloseTo(32.4);
    expect(times[1]).toBeCloseTo(41);
    expect(times[2]).toBeCloseTo(60);
    expect(mapLmuSectorTimes(-1, -1, -1)).toEqual([null, null, null]);
    expect(mapLmuSectorTimes(32.4, -1, 133.4)).toEqual([32.4, null, null]);
  });

  it('maps direct LMU sector timing telemetry', () => {
    const t = mapLmuTelemetry(fixture());
    expect(t.LmuSectorIdx?.value[0]).toBe(1);
    expect(t.LmuCurrentSectorTimes?.value[0]).toBeCloseTo(32.8);
    expect(t.LmuCurrentSectorTimes?.value[1]).toBeCloseTo(41.4);
    expect(t.LmuCurrentSectorTimes?.value[2]).toBeNull();
    expect(t.LmuLastSectorTimes?.value[0]).toBeCloseTo(32.4);
    expect(t.LmuLastSectorTimes?.value[1]).toBeCloseTo(41);
    expect(t.LmuLastSectorTimes?.value[2]).toBeCloseTo(60);
  });
});

describe('mapLmuTelemetry lap-distance reconstruction', () => {
  it('advances the fraction between scoring updates', () => {
    // LMU only publishes lap distance at 5 Hz, so two polls 15 ms apart carry
    // a byte-identical scoring fraction. Without the integrator LapTrace's
    // sample buffer drops the second one.
    const state = createLmuLapDistanceState();
    const first = fixture();
    const second = fixture();
    second.elapsedTime = (first.elapsedTime ?? 0) + 0.015;

    const a = mapLmuTelemetry(first, state).LapDistPct?.value[0] as number;
    const b = mapLmuTelemetry(second, state).LapDistPct?.value[0] as number;

    expect(b).toBeGreaterThan(a);
  });

  it('leaves CarIdxLapDistPct at the scoring rate', () => {
    // The per-car array feeds the blind-spot monitor and the relative-gap
    // processor. Smoothing only the player's slot makes gaps to other cars
    // step backwards between scoring updates, so that is deliberately a
    // separate change from this one.
    const state = createLmuLapDistanceState();
    const first = fixture();
    const second = fixture();
    second.elapsedTime = (first.elapsedTime ?? 0) + 0.015;

    mapLmuTelemetry(first, state);
    const t = mapLmuTelemetry(second, state);

    expect(t.CarIdxLapDistPct?.value).toEqual([0.4, 0.6, 0.2]);
  });

  it('is byte-identical to the raw scoring value without a state object', () => {
    const withoutState = mapLmuTelemetry(fixture());
    expect(withoutState.LapDistPct?.value[0]).toBe(0.6);
  });

  it('leaves the no-player path untouched even when given a state object', () => {
    // Spectating or in the garage there is no elapsedTime either, so feeding
    // the integrator would anchor it on a fabricated (pct 0, t -1) pair.
    const state = createLmuLapDistanceState();
    const raw = fixture();
    raw.playerHasVehicle = false;
    raw.playerVehicleIdx = -1;

    const bare = fixture();
    bare.playerHasVehicle = false;
    bare.playerVehicleIdx = -1;

    expect(mapLmuTelemetry(raw, state).LapDistPct?.value[0]).toBe(
      mapLmuTelemetry(bare).LapDistPct?.value[0]
    );
  });

  it('never publishes a backward step within a lap', () => {
    // A reversal reaches LapTrace as a dirty lap, which is then never promoted
    // to a reference -- silently. See lapDistance.spec.ts for the unit-level
    // property; this is the same invariant at the mapper boundary.
    const state = createLmuLapDistanceState();
    let previous = -Infinity;
    for (let i = 0; i < 200; i += 1) {
      const raw = fixture();
      raw.elapsedTime = 250.4 + i * 0.008;
      const value = mapLmuTelemetry(raw, state).LapDistPct?.value[0] as number;
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});
