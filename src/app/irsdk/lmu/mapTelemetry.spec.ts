import { describe, expect, it } from 'vitest';
import { CarLeftRight } from '@irdashies/types';
import type { LmuRawTelemetry } from '../native/lmu';
import { mapLmuSectorTimes, mapLmuTelemetry } from './mapTelemetry';

function fixture(): LmuRawTelemetry {
  return {
    running: true,
    gameVersion: 1902,
    trackName: 'Spa Francorchamps',
    playerName: 'Alonso',
    serverName: 'Server',
    session: 1,
    currentET: 1250.5,
    endET: 3600,
    maxLaps: 12,
    lapDist: 7004,
    numVehicles: 3,
    gamePhase: 4,
    yellowFlagState: 0,
    sectorFlags: new Uint8Array([0, 0, 0]),
    inRealtime: true,
    gameMode: 3,
    isFixedSetup: false,
    maxPlayers: 60,
    sessionTimeRemaining: 2349.5,
    timeOfDay: 0.45,
    trackGripLevel: 1,
    cloudCoverage: 20,
    raining: 0,
    darkCloud: 0,
    ambientTemp: 23.5,
    trackTemp: 31.2,
    minPathWetness: 0,
    maxPathWetness: 0,
    avgPathWetness: 0.05,
    wind: [2, 0, -3],
    playerVehicleIdx: 1,
    playerHasVehicle: true,
    activeVehicles: 2,
    gear: 5,
    engineRPM: 8200,
    engineWaterTemp: 95,
    engineOilTemp: 110,
    clutchRPM: 8200,
    unfilteredThrottle: 0.8,
    unfilteredBrake: 0,
    unfilteredSteering: -0.3,
    unfilteredClutch: 0,
    filteredThrottle: 0.79,
    filteredBrake: 0,
    filteredSteering: -0.29,
    filteredClutch: 0,
    steeringShaftTorque: 1.2,
    fuel: 42,
    fuelCapacity: 110,
    engineMaxRPM: 9000,
    rearBrakeBias: 0.55,
    lapNumber: 3,
    elapsedTime: 250.4,
    lapStartET: 200,
    currentSector: 1,
    lapInvalidated: false,
    speedLimiterActive: false,
    speedLimiter: 0,
    absActive: 1,
    tcActive: 0,
    ignitionStarter: 0,
    maxGears: 6,
    visualSteeringWheelRange: 480,
    deltaBest: 0.2,
    batteryChargeFraction: 1,
    turboBoostPressure: 0,
    frontTireCompoundName: 'Dry',
    vehicleName: 'Ferrari 296 GT3',
    speed: 51.234,
    localVel: [50, 0, 11],
    localAccel: [9.80665, 0, -19.6133],
    pos: [0, 0, 0],
    tyreTemperature: new Float64Array([80, 81, 82, 83]),
    tyrePressure: new Float64Array([180, 181, 182, 183]),
    tyreWear: new Float64Array([0.9, 0.8, 0.7, 0.6]),
    brakePressure: new Float64Array([0.4, 0.5, 0.3, 0.35]),
    suspensionDeflection: new Float64Array([0.04, 0.05, 0.06, 0.07]),
    vehIds: [0, 1, 1],
    vehIsPlayer: [0, 1, 0],
    vehPlaces: [2, 1, 3],
    vehLapDistPct: [0.4, 0.6, 0.2],
    vehTotalLaps: [2, 3, 1],
    vehBestLapTime: [134.5, 132.8, 137.1],
    vehLastLapTime: [135.6, 133.4, 138.9],
    vehInPits: [0, 0, 1],
    vehInGarageStall: [0, 0, 0],
    vehPitState: [0, 0, 3],
    vehClass: [0, 0, 1],
    vehTimeIntoLap: [50, 60, 20],
    vehEstimatedLapTime: [134, 132, 136],
    vehTimeBehindNext: [1.2, 3.4, 5.6],
    vehTimeBehindLeader: [0, 1.2, 10.5],
    vehLapsBehindNext: [0, 0, 1],
    vehLapsBehindLeader: [0, 0, 1],
    vehQualification: [0, 132.1, 0],
    vehFinishStatus: [0, 0, 0],
    vehIndividualPhase: [10, 9, 8],
    vehLapStartET: [1000, 1100, 900],
    vehSector: [1, 2, 0],
    vehFlag: [0, 0, 6],
    vehUnderYellow: [0, 0, 0],
    vehBestSector1: [32.5, 32.1, 40.1],
    vehBestSector2: [73.7, 72.9, 91.6],
    vehLastSector1: [33.1, 32.4, 41],
    vehLastSector2: [75.1, 73.4, 93],
    vehCurSector1: [-1, 32.8, -1],
    vehCurSector2: [-1, 74.2, -1],
    vehTelemetryAvailable: [1, 1, 1],
    vehPosX: [3, 0, 20],
    vehPosZ: [0, 0, 20],
    vehOriX: [0, 0, 0],
    vehOriZ: [1, 1, 1],
  } as unknown as LmuRawTelemetry;
}

describe('mapLmuTelemetry', () => {
  it('maps session scalars', () => {
    const t = mapLmuTelemetry(fixture());
    // Both clocks follow the player's 100 Hz mElapsedTime (250.4), not the 5 Hz
    // scoring mCurrentET (1250.5). LapTrace timestamps every sample with
    // SessionTime, so the coarse clock quantised the whole trace.
    expect(t.SessionTick.value[0]).toBe(250.4);
    expect(t.SessionTime.value[0]).toBe(250.4);
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
    // NOT_IN_WORLD, the sentinel CarIdxTrackSurface already uses for an empty
    // slot. ON_TRACK told TrackStateProcessor the player was out driving.
    expect(t.PlayerTrackSurface.value[0]).toBe(-1);
  });

  it('maps per-car arrays by slot', () => {
    const t = mapLmuTelemetry(fixture());
    expect(t.CarIdxPosition.value).toEqual([2, 1, 3]);
    expect(t.CarIdxLapDistPct.value).toEqual([0.4, 0.6, 0.2]);
    // iRacing's CarIdxLap is the lap in progress; mTotalLaps is laps completed.
    expect(t.CarIdxLap.value).toEqual([3, 4, 2]);
    expect(t.CarIdxLapCompleted.value).toEqual([2, 3, 1]);
    expect(t.CarIdxClass.value).toEqual([0, 0, 1]);
    expect(t.CarIdxBestLapTime.value).toEqual([134.5, 132.8, 137.1]);
    expect(t.CarIdxEstTime.value).toEqual([50, 60, 20]);
    expect(t.CarIdxOnPitRoad.value).toEqual([false, false, true]);
    expect(t.CarIdxTrackSurface.value).toEqual([3, 3, 1]);
  });

  it('falls back to the scoring clock when there is no player car', () => {
    // mElapsedTime is only published for a player vehicle; spectating or sitting
    // in the garage must not leave the session clock at 0.
    const raw: Record<string, unknown> = { ...fixture() };
    delete raw.elapsedTime;
    const t = mapLmuTelemetry(raw as unknown as LmuRawTelemetry);
    expect(t.SessionTime.value[0]).toBe(1250.5);
  });

  it('reports the clutch in iRacing engagement terms, not pedal travel', () => {
    // iRacing's Clutch is 1.0 with the pedal UP, and the Input widget inverts
    // what it receives. LMU's mFilteredClutch is the pedal, so passing it
    // through showed a full clutch bar at rest.
    const released = mapLmuTelemetry({ ...fixture(), filteredClutch: 0 });
    expect(released.Clutch.value[0]).toBe(1);

    const pressed = mapLmuTelemetry({ ...fixture(), filteredClutch: 1 });
    expect(pressed.Clutch.value[0]).toBe(0);

    // ClutchRaw needs the identical flip: the Input widget reads it instead of
    // Clutch when "raw values" is enabled, and inverts it just the same.
    const rawReleased = mapLmuTelemetry({ ...fixture(), unfilteredClutch: 0 });
    expect(rawReleased.ClutchRaw.value[0]).toBe(1);

    const rawPressed = mapLmuTelemetry({ ...fixture(), unfilteredClutch: 1 });
    expect(rawPressed.ClutchRaw.value[0]).toBe(0);

    // Throttle and brake share the 0 = off convention and must not be flipped.
    const t = mapLmuTelemetry(fixture());
    expect(t.Throttle.value[0]).toBeCloseTo(0.79);
    expect(t.Brake.value[0]).toBe(0);
    expect(t.ThrottleRaw.value[0]).toBeCloseTo(0.8);
    expect(t.BrakeRaw.value[0]).toBe(0);
  });

  it('reports nobody on the radio, since LMU has no radio chat', () => {
    // RadioProcessor reads any index >= 0 as someone transmitting, so the old
    // hardcoded 0 pinned a speaker icon on whoever held car index 0. iRacing's
    // idle value is -1.
    const t = mapLmuTelemetry(fixture());
    expect(t.RadioTransmitCarIdx.value[0]).toBe(-1);
  });

  it('ranks class positions, 1-based, from the same order as the session', () => {
    // Slots 0 and 1 share class 0 and run P2/P1; slot 2 is alone in class 1.
    const t = mapLmuTelemetry(fixture());
    expect(t.CarIdxClassPosition.value).toEqual([2, 1, 1]);
  });

  it('reports time into the lap, not the whole-lap estimate', () => {
    // CarIdxEstTime is "how far into the lap this car is" — feeding it the
    // ~130s lap estimate made every relative delta meaningless.
    const raw = fixture();
    const t = mapLmuTelemetry(raw);
    expect(t.CarIdxEstTime.value).toEqual(Array.from(raw.vehTimeIntoLap));
  });

  it('falls back when LMU cannot estimate time into the lap', () => {
    const raw = fixture();
    raw.vehTimeIntoLap = new Float64Array([-1, 60, 20]);
    const t = mapLmuTelemetry(raw);
    // -1 is finite and would sail through as a real value, so slot 0 is
    // reconstructed from its progress around the lap instead.
    expect(t.CarIdxEstTime.value[0]).toBeCloseTo(
      0.4 * raw.vehEstimatedLapTime[0],
      6
    );
    expect(t.CarIdxEstTime.value[1]).toBe(60);
  });

  it('marks empty slots with the sentinels iRacing uses', () => {
    // The addon sizes arrays at max(mID)+1, so a sparse grid leaves holes.
    // Zero-filled they read as a real car in class 0 sitting at position 0.
    const raw = fixture();
    raw.vehLapDistPct = new Float64Array([0.4, -1, 0.2]);
    const t = mapLmuTelemetry(raw);
    expect(t.CarIdxTrackSurface.value[1]).toBe(-1);
    expect(t.CarIdxClass.value[1]).toBe(-1);
    expect(t.CarIdxPosition.value[1]).toBe(0);
    expect(t.CarIdxClassPosition.value[1]).toBe(0);
    expect(t.CarIdxLap.value[1]).toBe(-1);
    expect(t.CarIdxLapCompleted.value[1]).toBe(-1);
    // The remaining cars still rank against each other.
    expect(t.CarIdxPosition.value[0]).toBeGreaterThan(0);
    expect(t.CarIdxPosition.value[2]).toBeGreaterThan(0);
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

  it('gives the wind a bearing, in the same frame as the car heading', () => {
    // Every widget renders WindDir - YawNorth and nothing else, so the two must
    // agree; a hardcoded 0 for both drew a fixed arrow that read as a bearing.
    // mWind points where the wind blows TO, iRacing's WindDir where it blows
    // FROM, hence the half turn.
    const t = mapLmuTelemetry(fixture());
    expect(t.WindDir.value[0]).toBeCloseTo(Math.atan2(2, -3) + Math.PI);
    // Fixture car faces +Z: atan2(0, 1) = 0.
    expect(t.YawNorth.value[0]).toBe(0);

    // Turn the car to face +X and the relative bearing swings with it.
    const turned = mapLmuTelemetry({
      ...fixture(),
      vehOriX: new Float64Array([1, 1, 1]),
      vehOriZ: new Float64Array([0, 0, 0]),
    } as unknown as LmuRawTelemetry);
    expect(turned.YawNorth.value[0]).toBeCloseTo(Math.PI / 2);
    expect(turned.WindDir.value[0]).toBeCloseTo(Math.atan2(2, -3) + Math.PI);
  });

  it('leaves humidity and fog absent rather than reporting zero', () => {
    // LMU publishes neither. WeatherHumidity renders "- %" for undefined, so an
    // empty value array is honest where num(0) invented a 0% reading.
    const t = mapLmuTelemetry(fixture());
    expect(t.RelativeHumidity.value).toEqual([]);
    expect(t.FogLevel.value).toEqual([]);
  });

  it('flags a timed race with iRacing 32767, not a derived lap count', () => {
    // The fuel calculator picks its timed-race branch on the literal 32767.
    // LMU marks "no lap limit" with a sentinel instead, and which one varies:
    // 0 when absent, a huge int when "unlimited". Both used to pass straight
    // through -- 0 told the calculator the race ended inside the current lap.
    const absent = mapLmuTelemetry({ ...fixture(), maxLaps: 0 });
    expect(absent.SessionLapsRemain.value[0]).toBe(32767);
    expect(absent.SessionLapsTotal.value[0]).toBe(32767);

    const unlimited = mapLmuTelemetry({ ...fixture(), maxLaps: 2147483647 });
    expect(unlimited.SessionLapsRemain.value[0]).toBe(32767);

    // A real lap limit still counts down. Fixture player has 3 of 12 laps.
    const limited = mapLmuTelemetry(fixture());
    expect(limited.SessionLapsRemain.value[0]).toBe(9);
    expect(limited.SessionLapsTotal.value[0]).toBe(12);
  });

  it('reports metric units, not iRacing imperial', () => {
    // LMU has no units setting and is metric-native; 0 gave every 'auto' widget
    // mph. Per-widget overrides still win.
    expect(mapLmuTelemetry(fixture()).DisplayUnits.value[0]).toBe(1);
  });

  it('raises the pit limiter bit so auto-limiter detection can fire', () => {
    // usePitLimiterWarning tests EngineWarnings.PitSpeedLimiter (0x10) to tell
    // an auto-limiter series from a manual one.
    const off = mapLmuTelemetry(fixture());
    expect(off.EngineWarnings.value[0]).toBe(0);

    const on = mapLmuTelemetry({ ...fixture(), speedLimiterActive: true });
    expect(on.EngineWarnings.value[0]).toBe(0x10);
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
