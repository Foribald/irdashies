import type {
  Session,
  SessionResults,
  Driver,
  LmuTrackMap,
} from '@irdashies/types';

import {
  lmuRankModeFor,
  lmuSessionType,
  rankLmuEntries,
  type LmuRankEntry,
} from './positions';

type Raw = import('../native/lmu').LmuRawSession;
type RawVehicle = import('../native/lmu').LmuRawVehicle;

// LMU shared memory has no car numbers or series metadata. Drivers are
// presented by their slot index; replace CarNumber sourcing if a REST/league
// datasource is added later.
const DEFAULT_CAR_NUMBER = (carIdx: number) => String(carIdx + 1);

const LMU_MANUFACTURER_CAR_IDS: readonly [RegExp, number][] = [
  [/\baston martin\b/i, 10001],
  [/\baudi\b/i, 10002],
  [/\bbmw\b/i, 10003],
  [/\bcadillac\b/i, 10004],
  [/\b(?:chevrolet|corvette)\b/i, 10005],
  [/\bferrari\b/i, 10006],
  [/\bford\b/i, 10007],
  [/\blamborghini\b/i, 10008],
  // LMP3 chassis maker. Must precede engine-supplier brands so a
  // "Ligier JS P320 Nissan" style model never resolves to the engine badge.
  [/\bligier\b/i, 10013],
  [/\bmclaren\b/i, 10009],
  [/\bmercedes(?:-amg)?\b/i, 10010],
  [/\bporsche\b/i, 10011],
  [/\btoyota\b/i, 10012],
];

export function resolveLmuCarId(vehicleModel: string): number {
  return (
    LMU_MANUFACTURER_CAR_IDS.find(([pattern]) =>
      pattern.test(vehicleModel)
    )?.[1] ?? 0
  );
}

/** iRacing reports "no time" as -1, not 0. */
const timeOrUnset = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : -1;

/**
 * finishStatus (mFinishStatus) in the ReasonOut shape iRacing uses.
 * 0 none / 1 finished are both "Running"; 2 DNF; 3 DQ.
 */
function reasonOut(finishStatus: number): { id: number; str: string } {
  if (finishStatus === 2) return { id: 1, str: 'DNF' };
  if (finishStatus === 3) return { id: 2, str: 'Disqualified' };
  return { id: 0, str: 'Running' };
}

/**
 * Builds the iRacing-shaped Session object from an LMU session snapshot.
 * Fields with no LMU equivalent keep safe defaults so widgets degrade
 * gracefully instead of crashing on missing data.
 */
export function mapLmuSession(
  raw: Raw,
  trackMap?: LmuTrackMap | null
): Session {
  const trackLengthM = raw.lapDist;

  /**
   * LMU has no class relative speed. Rank classes by their estimated lap time
   * so the faster class scores higher — that is the order groupStandingsByClass
   * sorts the class blocks by, and with a flat 0 it was arbitrary. Keyed on the
   * class name: numeric class ids are interned in encounter order by the addon
   * and are not stable across restarts.
   */
  const classBestEstimate = new Map<string, number>();
  for (const d of raw.drivers) {
    const estimate = timeOrUnset(d.estimatedLapTime ?? 0);
    if (estimate < 0) continue;
    const current = classBestEstimate.get(d.className);
    if (current === undefined || estimate < current) {
      classBestEstimate.set(d.className, estimate);
    }
  }
  const classesByPace = [...classBestEstimate.entries()]
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name);
  const relSpeedByClass = new Map(
    classesByPace.map((name, index) => [name, classesByPace.length - index])
  );

  const drivers: Driver[] = raw.drivers.map((d) => ({
    CarIdx: d.id,
    UserName: d.name,
    AbbrevName: null,
    Initials: null,
    UserID: 0,
    TeamID: 0,
    TeamName: d.name,
    CarNumber: DEFAULT_CAR_NUMBER(d.id),
    CarNumberRaw: d.id + 1,
    CarPath: d.vehFilename,
    CarClassID: d.classId,
    CarID: resolveLmuCarId(d.vehicleModel ?? d.vehicleName),
    CarIsPaceCar: 0,
    CarIsAI: 0,
    CarIsElectric: 0,
    CarScreenName: d.vehicleName,
    CarScreenNameShort: d.vehicleName.split(' ')[0] ?? '',
    CarCfg: 0,
    CarCfgName: null,
    CarCfgCustomPaintExt: null,
    CarClassShortName: d.className,
    CarClassRelSpeed: relSpeedByClass.get(d.className) ?? 0,
    CarClassLicenseLevel: 0,
    CarClassMaxFuelPct: '',
    CarClassWeightPenalty: '',
    CarClassPowerAdjust: '',
    CarClassDryTireSetLimit: '',
    CarClassColor: 0,
    CarClassEstLapTime: d.estimatedLapTime,
    IRating: 0,
    LicLevel: 0,
    LicSubLevel: 0,
    LicString: 'LMU',
    LicColor: 0,
    IsSpectator: 0,
    CarDesignStr: '',
    HelmetDesignStr: '',
    SuitDesignStr: '',
    BodyType: 0,
    FaceType: 0,
    HelmetType: 0,
    CarNumberDesignStr: '',
    CarSponsor_1: 0,
    CarSponsor_2: 0,
    ClubName: '',
    ClubID: 0,
    FlairName: '',
    FlairID: 0,
    DivisionName: '',
    DivisionID: 0,
    CurDriverIncidentCount: 0,
    TeamIncidentCount: 0,
  }));

  const playerDriver = raw.drivers.find((d) => d.isPlayer);
  const playerIdx = playerDriver?.id ?? -1;
  const currentSessionType = lmuSessionType(raw.session);

  const rankEntry = (d: RawVehicle): LmuRankEntry => ({
    carIdx: d.id,
    classId: d.classId,
    place: d.place,
    bestLapTime: d.bestLapTime,
    qualification: d.qualification,
    totalLaps: d.totalLaps,
    lapDistPct: trackLengthM > 0 ? d.lapDist / trackLengthM : -1,
  });
  const rankEntries = raw.drivers.map(rankEntry);
  const driversByCarIdx = new Map(raw.drivers.map((d) => [d.id, d]));

  /**
   * The two arrays do not share a convention, which is checked against a real
   * captured iRacing session (irsdk/node/utils/mock-data/session.json):
   * ResultsPositions has a 1-based Position and a 0-based ClassPosition, while
   * QualifyResultsInfo is 0-based in both. Consumers add 1 to ClassPosition.
   */
  const resultRow = (
    d: RawVehicle,
    position: number,
    classPosition: number,
    isRace: boolean
  ): SessionResults => {
    const out = reasonOut(d.finishStatus);
    return {
      Position: position,
      ClassPosition: classPosition,
      CarIdx: d.id,
      Lap: 0,
      // Race: gap to the leader. Otherwise the best lap, as iRacing reports it.
      Time: isRace
        ? Math.max(0, d.timeBehindLeader)
        : timeOrUnset(d.bestLapTime),
      FastestLap: 0,
      FastestTime: timeOrUnset(d.bestLapTime),
      LastTime: timeOrUnset(d.lastLapTime),
      LapsLed: 0,
      LapsComplete: d.totalLaps,
      JokerLapsComplete: 0,
      LapsDriven: d.totalLaps,
      Incidents: 0,
      ReasonOutId: out.id,
      ReasonOutStr: out.str,
    };
  };

  // The live running order. Without this the Standings table has no row source
  // at all and silently falls back to the qualifying grid for the whole
  // session — which is what it used to do.
  const isRace = currentSessionType === 'Race';
  const running = rankLmuEntries(
    rankEntries,
    lmuRankModeFor(currentSessionType)
  );
  const resultsPositions: SessionResults[] = running.order
    .map((carIdx, index) => {
      const d = driversByCarIdx.get(carIdx);
      if (!d) return null;
      // Position is 1-based here; ClassPosition is not.
      return resultRow(d, index + 1, running.classPosition[carIdx], isRace);
    })
    .filter((row): row is SessionResults => row !== null);

  // Whoever holds the session's best lap, in the shape the Relative reads to
  // flag it.
  const fastest = raw.drivers.reduce<RawVehicle | null>((best, d) => {
    if (!(d.bestLapTime > 0)) return best;
    return best === null || d.bestLapTime < best.bestLapTime ? d : best;
  }, null);
  const fastestLap = fastest
    ? [
        {
          CarIdx: fastest.id,
          FastestLap: 0,
          FastestTime: timeOrUnset(fastest.bestLapTime),
        },
      ]
    : [];

  // Qualifying grid. `qualification` is mQualification, an int32 grid POSITION
  // (lmu_struct.h) rather than a lap time. Cars without one are ranked last
  // rather than dropped, so they still reach the standings.
  const qualifying = rankLmuEntries(rankEntries, 'qualifying');
  const qualiResults: SessionResults[] = qualifying.order
    .map((carIdx, index) => {
      const d = driversByCarIdx.get(carIdx);
      if (!d) return null;
      // Both are 0-based in QualifyResultsInfo.
      return resultRow(d, index, qualifying.classPosition[carIdx], false);
    })
    .filter((row): row is SessionResults => row !== null);

  return {
    WeekendInfo: {
      TrackName: raw.trackName,
      TrackID: 0,
      TrackLength: `${trackLengthM} m`,
      TrackLengthOfficial: `${trackLengthM} m`,
      TrackDisplayName: raw.trackName,
      TrackDisplayShortName: raw.trackName,
      TrackConfigName: null,
      TrackCity: '',
      TrackState: 'green',
      TrackCountry: '',
      TrackAltitude: '',
      TrackLatitude: '',
      TrackLongitude: '',
      TrackNorthOffset: '',
      TrackNumTurns: 0,
      TrackPitSpeedLimit: '',
      TrackPaceSpeed: '0',
      TrackNumPitStalls: 0,
      TrackType: '',
      TrackDirection: '',
      TrackWeatherType: 'Realistic',
      TrackSkies: raw.cloudCoverage > 50 ? 'Cloudy' : 'Clear',
      TrackSurfaceTemp: '',
      TrackAirTemp: '',
      TrackAirPressure: '',
      TrackAirDensity: '',
      TrackWindVel: String(Math.hypot(raw.wind[0] ?? 0, raw.wind[2] ?? 0)),
      TrackWindDir: '',
      TrackRelativeHumidity: '',
      TrackFogLevel: '',
      TrackPrecipitation: raw.raining > 0 ? 'Rain' : 'Dry',
      TrackCleanup: 0,
      TrackDynamicTrack: 0,
      TrackVersion: `0.0.${raw.gameVersion}`,
      SeriesID: 0,
      SeasonID: 0,
      SessionID: raw.session,
      SubSessionID: raw.session,
      LeagueID: 0,
      Official: 0,
      RaceWeek: 0,
      EventType: currentSessionType,
      Category: 'Sports Car',
      SimMode: 'Le Mans Ultimate',
      TeamRacing: 0,
      MinDrivers: 0,
      MaxDrivers: raw.maxPlayers,
      DCRuleSet: '',
      QualifierMustStartRace: 0,
      NumCarClasses: new Set(raw.drivers.map((d) => d.classId)).size,
      NumCarTypes: new Set(
        raw.drivers.map((d) => d.vehicleModel ?? d.vehicleName)
      ).size,
      HeatRacing: 0,
      BuildType: 'release',
      BuildTarget: 'linux',
      BuildVersion: String(raw.gameVersion),
      RaceFarm: 'lm',
      WeekendOptions: {
        NumStarters: 0,
        StartingGrid: '',
        QualifyScoring: '',
        CourseCautions: '',
        StandingStart: 0,
        ShortParadeLap: 0,
        Restarts: '',
        WeatherType: '',
        Skies: '',
        WindDirection: '',
        WindSpeed: '',
        WeatherTemp: '',
        RelativeHumidity: '',
        FogLevel: '',
        TimeOfDay: '',
        Date: '',
        EarthRotationSpeedupFactor: 0,
        Unofficial: 1,
        CommercialMode: '',
        NightMode: '',
        IsFixedSetup: raw.isFixedSetup ? 1 : 0,
        StrictLapsChecking: '',
        HasOpenRegistration: 0,
        HardcoreLevel: 0,
        NumJokerLaps: 0,
        IncidentLimit: '',
        IncidentWarningInitialLimit: 0,
        IncidentWarningSubsequentLimit: 0,
        FastRepairsLimit: 0,
        GreenWhiteCheckeredLimit: 0,
      },
      TelemetryOptions: {
        TelemetryDiskFile: '',
      },
    },
    SessionInfo: {
      Sessions: [
        {
          SessionNum: raw.session,
          SessionLaps: `${raw.maxLaps}`,
          SessionTime: '',
          SessionNumLapsToAvg: 0,
          SessionType: currentSessionType,
          SessionTrackRubberState: '',
          SessionName: currentSessionType,
          SessionSubType: null,
          SessionSkipped: 0,
          SessionRunGroupsUsed: 0,
          ResultsPositions: resultsPositions,
          ResultsFastestLap: fastestLap,
          QualifyPositions: qualiResults.map((q) => ({
            Position: q.Position,
            ClassPosition: q.ClassPosition,
            CarIdx: q.CarIdx,
            FastestLap: q.FastestLap,
            FastestTime: q.FastestTime,
          })),
          ResultsAverageLapTime: 0,
          ResultsNumCautionFlags: 0,
          ResultsNumCautionLaps: 0,
          ResultsNumLeadChanges: 0,
          ResultsLapsComplete: 0,
          ResultsOfficial: 0,
        },
      ],
    },
    CameraInfo: { Groups: [] },
    RadioInfo: { SelectedRadioNum: 0, Radios: [] },
    DriverInfo: {
      DriverCarIdx: playerIdx,
      DriverUserID: 0,
      PaceCarIdx: -1,
      DriverHeadPosX: 0,
      DriverHeadPosY: 0,
      DriverHeadPosZ: 0,
      DriverCarIsElectric: 0,
      DriverCarIdleRPM: 800,
      DriverCarRedLine: raw.engineMaxRPM ?? 8500,
      DriverCarEngCylinderCount: 0,
      DriverCarFuelKgPerLtr: 0,
      DriverCarFuelMaxLtr: raw.fuelCapacity ?? 0,
      DriverCarMaxFuelPct: 1,
      DriverCarGearNumForward: raw.maxGears ?? 6,
      DriverCarGearNeutral: 0,
      DriverCarGearReverse: -1,
      DriverCarSLFirstRPM: 0,
      DriverCarSLShiftRPM: raw.engineMaxRPM ?? 8500,
      DriverCarSLLastRPM: raw.engineMaxRPM ?? 8500,
      DriverCarSLBlinkRPM: raw.engineMaxRPM ?? 8500,
      DriverCarVersion: '',
      DriverPitTrkPct: 0,
      DriverCarEstLapTime: playerDriver?.estimatedLapTime ?? 0,
      DriverSetupName: '',
      DriverSetupIsModified: 0,
      DriverSetupLoadTypeName: '',
      DriverSetupPassedTech: 0,
      DriverIncidentCount: 0,
      DriverBrakeCurvingFactor: 0,
      DriverTires: [
        {
          TireIndex: 0,
          TireCompoundType: raw.frontTireCompoundName ?? '',
        },
      ],
      Drivers: drivers,
    },
    // ponytail: nominal thirds only label the direct LMU timing; replace when LMU exposes boundary distances.
    SplitTimeInfo: {
      Sectors: [
        { SectorNum: 0, SectorStartPct: 0 },
        { SectorNum: 1, SectorStartPct: 1 / 3 },
        { SectorNum: 2, SectorStartPct: 2 / 3 },
      ],
    },
    CarSetup: { UpdateCount: 0 },
    QualifyResultsInfo: { Results: qualiResults },
    ...(trackMap ? { LmuTrackMap: trackMap } : {}),
  };
}
