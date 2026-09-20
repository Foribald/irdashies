/**
 * The LMU mappers against the real Standings builder.
 *
 * This is the test that encodes the reported bug. Unit tests on the mappers
 * alone all passed while Standings and Relative were showing the frozen
 * qualifying grid, because the defect was in what the mappers *omitted*:
 * `ResultsPositions` was null and `CarIdxClassPosition` was empty, so the
 * widgets fell through to a stale fallback. Only running the real consumer over
 * mapped output catches that.
 */
import { describe, expect, it } from 'vitest';
import type { LmuRawSession } from './app/irsdk/native/lmu';
import { mapLmuSession } from './app/irsdk/lmu/mapSession';
import { mapLmuTelemetry } from './app/irsdk/lmu/mapTelemetry';
import { createDriverStandings } from './frontend/domain/standings/createStandings';

/** Two GT3s and a GTE, mid-race, with the GTE running last. */
function raceFixture(): LmuRawSession {
  // The grid deliberately disagrees with the running order — the GTE qualified
  // on pole and has since dropped to last. Anything still reading the
  // qualifying grid orders these the other way round, which is the bug.
  const drivers = [
    {
      id: 0,
      className: 'GT3',
      classId: 0,
      place: 2,
      qual: 3,
      laps: 4,
      pct: 0.4,
    },
    {
      id: 1,
      className: 'GT3',
      classId: 0,
      place: 1,
      qual: 2,
      laps: 4,
      pct: 0.6,
    },
    {
      id: 4,
      className: 'GTE',
      classId: 1,
      place: 3,
      qual: 1,
      laps: 3,
      pct: 0.2,
    },
  ];
  // Slot 4 is deliberately sparse: the addon sizes per-car arrays at
  // max(mID) + 1, so slots 2 and 3 are holes that must not read as cars.
  const slots = 5;
  const bySlot = (pick: (d: (typeof drivers)[number]) => number, empty = 0) =>
    Array.from({ length: slots }, (_, i) => {
      const d = drivers.find((x) => x.id === i);
      return d ? pick(d) : empty;
    });

  const zeros = (n = slots) => new Float64Array(n);

  return {
    running: true,
    trackName: 'Spa Francorchamps',
    session: 10, // race
    maxLaps: 20,
    lapDist: 7004,
    numVehicles: drivers.length,
    gamePhase: 5,
    yellowFlagState: 0,
    sectorFlags: new Uint8Array([0, 0, 0]),
    playerVehicleIdx: 1,
    playerHasVehicle: true,
    activeVehicles: drivers.length,
    lapNumber: 5,
    // Scalars the mappers touch on the way past; none affect positions.
    gameVersion: 1902,
    maxPlayers: 32,
    isFixedSetup: 0,
    engineMaxRPM: 9000,
    maxGears: 6,
    fuelCapacity: 100,
    frontTireCompoundName: 'Soft',
    cloudCoverage: 0,
    raining: 0,
    avgPathWetness: 0,
    ambientTemp: 20,
    trackTemp: 30,
    timeOfDay: 43200,
    wind: [0, 0, 0],
    localAccel: [0, 0, 0],
    currentET: 300,
    elapsedTime: 300,
    endET: 3600,
    lapStartET: 200,
    sessionTimeRemaining: 3300,
    inRealtime: true,
    speed: 60,
    gear: 4,
    engineRPM: 7000,
    engineOilTemp: 100,
    engineWaterTemp: 90,
    fuel: 50,
    rearBrakeBias: 0.5,
    speedLimiterActive: 0,
    visualSteeringWheelRange: 6.28,
    filteredThrottle: 1,
    filteredBrake: 0,
    filteredClutch: 0,
    filteredSteering: 0,
    unfilteredThrottle: 1,
    unfilteredBrake: 0,
    unfilteredClutch: 0,
    absActive: 0,
    tyrePressure: zeros(4),
    tyreTemperature: zeros(12),
    tyreWear: zeros(4),
    suspensionDeflection: zeros(4),
    brakePressure: zeros(4),
    vehIds: new Int32Array(bySlot((d) => d.id, -1)),
    vehFlag: new Uint8Array(bySlot(() => 0)),
    vehUnderYellow: new Uint8Array(bySlot(() => 0)),
    vehBestSector1: zeros(),
    vehBestSector2: zeros(),
    vehLastSector1: zeros(),
    vehLastSector2: zeros(),
    vehCurSector1: zeros(),
    vehCurSector2: zeros(),
    vehPosX: zeros(),
    vehPosZ: zeros(),
    vehOriX: zeros(),
    vehOriZ: zeros(),
    vehPlaces: new Int32Array(bySlot((d) => d.place)),
    vehClass: new Int32Array(bySlot((d) => d.classId)),
    vehTotalLaps: new Int32Array(bySlot((d) => d.laps)),
    vehLapDistPct: new Float64Array(bySlot((d) => d.pct, -1)),
    vehBestLapTime: new Float64Array(
      bySlot((d) => (d.classId === 0 ? 134 : 165))
    ),
    vehLastLapTime: new Float64Array(
      bySlot((d) => (d.classId === 0 ? 135 : 166))
    ),
    vehEstimatedLapTime: new Float64Array(
      bySlot((d) => (d.classId === 0 ? 134 : 165))
    ),
    vehTimeIntoLap: new Float64Array(bySlot((d) => d.pct * 134)),
    vehTimeBehindLeader: new Float64Array(bySlot((d) => (d.place - 1) * 5)),
    vehTimeBehindNext: new Float64Array(bySlot(() => 5)),
    vehLapsBehindLeader: new Int32Array(bySlot(() => 0)),
    vehLapsBehindNext: new Int32Array(bySlot(() => 0)),
    vehQualification: new Float64Array(bySlot((d) => d.qual)),
    vehInPits: new Uint8Array(bySlot(() => 0)),
    vehInGarageStall: new Uint8Array(bySlot(() => 0)),
    vehPitState: new Uint8Array(bySlot(() => 0)),
    vehSector: new Int32Array(bySlot(() => 1)),
    vehFinishStatus: new Int32Array(bySlot(() => 0)),
    vehTelemetryAvailable: new Uint8Array(bySlot(() => 1)),
    classes: [
      { id: 0, name: 'GT3' },
      { id: 1, name: 'GTE' },
    ],
    drivers: drivers.map((d) => ({
      id: d.id,
      isPlayer: d.id === 1,
      name: `Driver ${d.id}`,
      vehicleName: 'Porsche 911 GT3 R',
      vehicleModel: 'Porsche 911 GT3 R',
      className: d.className,
      vehFilename: `car${d.id}.veh`,
      classId: d.classId,
      totalLaps: d.laps,
      place: d.place,
      lapDist: d.pct * 7004,
      bestLapTime: d.classId === 0 ? 134 : 165,
      lastLapTime: d.classId === 0 ? 135 : 166,
      estimatedLapTime: d.classId === 0 ? 134 : 165,
      qualification: d.qual,
      timeBehindLeader: (d.place - 1) * 5,
      timeBehindNext: 5,
      lapsBehindLeader: 0,
      lapsBehindNext: 0,
      finishStatus: 0,
      timeIntoLap: d.pct * 134,
      inPits: false,
      inGarageStall: false,
      pitState: 0,
      sector: 1,
      numPitstops: 0,
      numPenalties: 0,
    })),
  } as unknown as LmuRawSession;
}

const standingsFor = (raw: LmuRawSession) => {
  const session = mapLmuSession(raw);
  const telemetry = mapLmuTelemetry(raw);
  const current = session.SessionInfo.Sessions[0];

  return createDriverStandings(
    {
      playerIdx: session.DriverInfo?.DriverCarIdx,
      drivers: session.DriverInfo?.Drivers,
      qualifyingResults: session.QualifyResultsInfo?.Results ?? undefined,
    },
    {
      carIdxBestLapTime: telemetry.CarIdxBestLapTime?.value,
      carIdxLastLapTime: telemetry.CarIdxLastLapTime?.value,
      carIdxF2TimeValue: telemetry.CarIdxF2Time?.value,
      carIdxOnPitRoadValue: telemetry.CarIdxOnPitRoad?.value,
      carIdxTrackSurfaceValue: telemetry.CarIdxTrackSurface?.value,
      isOnTrack: true,
    },
    {
      resultsPositions: current.ResultsPositions ?? undefined,
      resultsFastestLap: current.ResultsFastestLap ?? undefined,
      sessionType: current.SessionType ?? undefined,
    },
    [],
    [],
    []
  );
};

describe('LMU standings contract', () => {
  it('shows live race positions rather than the qualifying grid', () => {
    const standings = standingsFor(raceFixture());

    // Leader first, and the GTE last despite sharing nothing with the GT3s.
    expect(standings.map((s) => s.carIdx)).toEqual([1, 0, 4]);
    // Class positions are contiguous from 1 within each class.
    expect(standings.map((s) => s.classPosition)).toEqual([1, 2, 1]);
  });

  it('follows an overtake instead of freezing on the grid', () => {
    const raw = raceFixture();
    // Slot 0 takes the lead; qualification is untouched, so anything still
    // reading the grid would not move.
    raw.drivers[0].place = 1;
    raw.drivers[1].place = 2;
    raw.vehPlaces = new Int32Array([1, 2, 0, 0, 3]);

    const standings = standingsFor(raw);

    expect(standings.map((s) => s.carIdx)).toEqual([0, 1, 4]);
    expect(standings.map((s) => s.classPosition)).toEqual([1, 2, 1]);
  });

  it('never lets an empty array slot become a car', () => {
    const standings = standingsFor(raceFixture());
    // Slots 2 and 3 hold no car and must not appear at any position.
    expect(standings.map((s) => s.carIdx)).not.toContain(2);
    expect(standings.map((s) => s.carIdx)).not.toContain(3);
    expect(standings).toHaveLength(3);
  });

  it('agrees with the live telemetry array the Relative reads', () => {
    // The two widgets read different sources. They diverged once; this keeps
    // them tied to the same ranking.
    const raw = raceFixture();
    const telemetry = mapLmuTelemetry(raw);
    const standings = standingsFor(raw);

    for (const entry of standings) {
      expect(telemetry.CarIdxClassPosition?.value[entry.carIdx]).toBe(
        entry.classPosition
      );
    }
  });
});
