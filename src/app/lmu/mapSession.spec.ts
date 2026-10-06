import { describe, expect, it } from 'vitest';
import {
  deriveLmuShiftLightRpm,
  mapLmuSession,
  resolveLmuCarId,
  resolveLmuTrackId,
} from './mapSession';
import { fixture } from './rawSessionFixture';
import { LMU_CLASS_COLOURS } from '@irdashies/types';

describe('mapLmuSession', () => {
  it('maps weekend info', () => {
    const s = mapLmuSession(fixture());
    expect(s.WeekendInfo.TrackName).toBe('Spa Francorchamps');
    expect(s.WeekendInfo.TrackID).toBe(resolveLmuTrackId('Spa Francorchamps'));
    expect(s.WeekendInfo.TrackDisplayName).toBe('Spa Francorchamps');
    expect(s.WeekendInfo.TrackLength).toBe('7004 m');
    expect(s.WeekendInfo.SubSessionID).toBe(2);
    expect(s.WeekendInfo.NumCarClasses).toBe(2);
    expect(s.WeekendInfo.NumCarTypes).toBe(3);
  });

  it('reports the fixed 60 kph pit speed limit', () => {
    // LMU hardcodes the pit and rolling-start limit to 60 km/h on every
    // circuit, so this is a constant rather than something to measure or look
    // up per track.
    expect(mapLmuSession(fixture()).WeekendInfo.TrackPitSpeedLimit).toBe(
      '60.00 kph'
    );
  });

  it('maps driver info with the player flagged', () => {
    const s = mapLmuSession(fixture());
    expect(s.DriverInfo.DriverCarIdx).toBe(1);
    expect(s.DriverInfo.Drivers).toHaveLength(3);
    const player = s.DriverInfo.Drivers[1];
    expect(player.CarIdx).toBe(1);
    expect(player.UserName).toBe('Driver B');
    expect(player.CarScreenName).toBe('Ferrari 296 GT3');
    expect(player.CarID).toBe(10006);
    expect(s.DriverInfo.Drivers[0].CarID).toBe(10003);
    expect(player.CarClassShortName).toBe('LMGT3');
    expect(player.CarClassID).toBe(0);
    expect(s.DriverInfo.DriverCarRedLine).toBe(9000);
  });

  it('flags only AI-controlled cars as AI', () => {
    const raw = fixture();
    raw.drivers[0].control = 1;
    raw.drivers[1].control = 0;
    raw.drivers[2].control = 2;

    const drivers = mapLmuSession(raw).DriverInfo.Drivers;

    expect(drivers.map((d) => d.CarIsAIControlled)).toEqual([
      true,
      false,
      false,
    ]);
    expect(drivers.map((d) => d.CarIsAI)).toEqual([1, 0, 0]);
  });

  it('leaves AI state unknown when the addon does not report control', () => {
    const drivers = mapLmuSession(fixture()).DriverInfo.Drivers;

    expect(drivers.every((d) => d.CarIsAIControlled === undefined)).toBe(true);
    expect(drivers.every((d) => d.CarIsAI === 0)).toBe(true);
  });

  it('derives LMU shift lights from the engine limit', () => {
    expect(deriveLmuShiftLightRpm(9000)).toEqual({
      first: 8190,
      shift: 8550,
      last: 8730,
      blink: 8730,
    });
    expect(deriveLmuShiftLightRpm(0)).toEqual({
      first: 7735,
      shift: 8075,
      last: 8245,
      blink: 8245,
    });

    const driverInfo = mapLmuSession(fixture()).DriverInfo;
    expect(driverInfo.DriverCarSLFirstRPM).toBe(8190);
    expect(driverInfo.DriverCarSLShiftRPM).toBe(8550);
    expect(driverInfo.DriverCarSLLastRPM).toBe(8730);
    expect(driverInfo.DriverCarSLBlinkRPM).toBe(8730);
  });

  it.each([
    'Alpine A424',
    'Peugeot 9X8',
    'Lexus RC F GT3',
    'Genesis GMR-001',
    'Duqueine M30-D08',
    'Ginetta G61-LT-P3',
    'ADESS AD03 Evo',
    'Unknown Prototype',
  ])('leaves the unsupported LMU model %s without a logo id', (model) => {
    expect(resolveLmuCarId(model)).toBe(0);
  });

  it.each(['Ligier JS P320', 'Ligier JS P320 Nissan', 'Ligier JSP320'])(
    'resolves the LMP3 Ligier model %s',
    (model) => {
      expect(resolveLmuCarId(model)).toBe(10013);
    }
  );

  it('does not let LMP3 models collide with Hypercar or LMGT3 brands', () => {
    const lmp3 = ['Ligier JS P320', 'Duqueine M30-D08', 'ADESS AD03 Evo'].map(
      resolveLmuCarId
    );
    const others = [
      'Ferrari 499P',
      'Porsche 963',
      'Toyota GR010 Hybrid',
      'Cadillac V-Series.R',
      'BMW M Hybrid V8',
      'Aston Martin Valkyrie',
      'Ferrari 296 GT3',
      'Ford Mustang GT3',
      'Chevrolet Corvette Z06 GT3.R',
      'McLaren 720S GT3 Evo',
      'Lamborghini Huracan GT3 Evo2',
      'Mercedes-AMG GT3',
    ].map(resolveLmuCarId);

    expect(others).toEqual([
      10006, 10011, 10012, 10004, 10003, 10001, 10006, 10007, 10005, 10009,
      10008, 10010,
    ]);
    expect(lmp3.filter((id) => others.includes(id) && id !== 0)).toEqual([]);
  });

  it('builds qualifying results with per-class ranking', () => {
    // ClassPosition is zero-based and Position is one-based, which is the
    // contract iRacing's own results carry -- its recorded sessions show
    // ClassPosition [0, 1, 0, ...] against Position [1, 2, 3, ...]. The
    // standings add one when they read it, so publishing a one-based
    // ClassPosition here started every class at 2.
    const s = mapLmuSession(fixture());
    const qualy = s.QualifyResultsInfo?.Results ?? [];
    expect(qualy.map((r) => [r.CarIdx, r.Position, r.ClassPosition])).toEqual([
      [1, 1, 0],
      [0, 2, 1],
    ]);
  });

  it('skips drivers without a qualification time', () => {
    const s = mapLmuSession(fixture());
    expect(
      (s.QualifyResultsInfo?.Results ?? []).some((r) => r.CarIdx === 3)
    ).toBe(false);
  });

  it('shapes the session info list', () => {
    const s = mapLmuSession(fixture());
    expect(s.SessionInfo.Sessions).toHaveLength(1);
    expect(s.SessionInfo.Sessions[0].SessionLaps).toBe('12');
    expect(s.SessionInfo.Sessions[0].QualifyPositions).toHaveLength(2);
    expect(s.SplitTimeInfo.Sectors).toEqual([
      { SectorNum: 0, SectorStartPct: 0 },
      { SectorNum: 1, SectorStartPct: 1 / 3 },
      { SectorNum: 2, SectorStartPct: 2 / 3 },
    ]);
  });

  it('gives each LMU track a stable simulator-specific id', () => {
    expect(resolveLmuTrackId('Imola')).toBe(resolveLmuTrackId(' imola '));
    expect(resolveLmuTrackId('Imola')).not.toBe(resolveLmuTrackId('Lusail'));
    expect(resolveLmuTrackId('Imola')).toBeGreaterThanOrEqual(1_000_000);
  });

  it('includes a recorded LMU track map when available', () => {
    const trackMap = {
      active: {
        inside: 'M0,0 L1,1 Z',
        outside: 'M0,0 L1,1 Z',
        trackPathPoints: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        totalLength: 1,
      },
      startFinish: {
        line: 'M0,-1 L0,1',
        point: { x: 0, y: 0, length: 0 },
        direction: 'anticlockwise' as const,
      },
    };

    expect(mapLmuSession(fixture(), trackMap).LmuTrackMap).toEqual(trackMap);
  });

  it.each([
    [0, 'Offline Testing'],
    [1, 'Practice'],
    [4, 'Practice'],
    [5, 'Open Qualify'],
    [8, 'Open Qualify'],
    [9, 'Practice'],
    [10, 'Race'],
    [13, 'Race'],
  ])('maps LMU session %i to %s', (session, expected) => {
    const s = mapLmuSession({ ...fixture(), session });
    expect(s.SessionInfo.Sessions[0].SessionType).toBe(expected);
  });
});

describe('mapLmuSession absent lap times', () => {
  it('reports a driver with no lap as absent, not as zero', () => {
    // These results are the fallback createStandings uses whenever the
    // telemetry frame has no time for a car, so a zero here reaches
    // formatTime and renders "0:00.000" -- which is what kept showing in the
    // standings even after the telemetry frame was normalised.
    const raw = fixture();
    raw.drivers[0].bestLapTime = 0;
    raw.drivers[0].lastLapTime = 0;
    raw.drivers[1].bestLapTime = -1;
    raw.drivers[1].lastLapTime = -1;

    const s = mapLmuSession(raw);
    const quali = s.SessionInfo?.Sessions?.[0]?.QualifyPositions ?? [];
    const byCar = new Map(quali.map((q) => [q.CarIdx, q]));

    expect(byCar.get(0)?.FastestTime).toBe(-1);
    expect(byCar.get(1)?.FastestTime).toBe(-1);
  });

  it('leaves a real lap time alone', () => {
    const s = mapLmuSession(fixture());
    const quali = s.SessionInfo?.Sessions?.[0]?.QualifyPositions ?? [];
    const byCar = new Map(quali.map((q) => [q.CarIdx, q]));

    expect(byCar.get(0)?.FastestTime).toBe(134.5);
  });
});

describe('mapLmuSession car classes', () => {
  const driverClass = (s: ReturnType<typeof mapLmuSession>, idx: number) =>
    s.DriverInfo?.Drivers?.[idx];

  it('gives each class the series livery for it', () => {
    // LMU reports no class colour, so these come from LMU_CLASS_COLOURS rather
    // than the rank-ordered fallback palette.
    const raw = fixture();
    raw.drivers[0].className = 'Hypercar';
    raw.drivers[1].className = 'LMP2';
    raw.drivers[2].className = 'LMGTE';

    const s = mapLmuSession(raw);

    const colours = [0, 1, 2].map((i) => driverClass(s, i)?.CarClassColor);
    expect(new Set(colours).size).toBe(3);
    expect(colours[0]).toBe(LMU_CLASS_COLOURS.Hypercar);
    expect(colours[1]).toBe(LMU_CLASS_COLOURS.LMP2);
    expect(colours[2]).toBe(LMU_CLASS_COLOURS.LMGTE);
  });

  it('resolves a championship-qualified class name to its class', () => {
    // LMU reports "LMP2_ELMS", not "LMP2". Left unmatched it took no rank and
    // no colour, which is why LMP2 cars showed none under their number while
    // LMP3 -- reported unqualified -- did.
    const raw = fixture();
    raw.drivers[0].className = 'LMP2_ELMS';
    raw.drivers[1].className = 'GT3';
    raw.drivers[2].className = 'GTE';

    const s = mapLmuSession(raw);

    expect(driverClass(s, 0)?.CarClassShortName).toBe('LMP2');
    expect(driverClass(s, 0)?.CarClassColor).toBe(LMU_CLASS_COLOURS.LMP2);
    expect(driverClass(s, 1)?.CarClassShortName).toBe('LMGT3');
    expect(driverClass(s, 1)?.CarClassColor).toBe(LMU_CLASS_COLOURS.LMGT3);
    expect(driverClass(s, 2)?.CarClassShortName).toBe('LMGTE');
    expect(driverClass(s, 2)?.CarClassColor).toBe(LMU_CLASS_COLOURS.LMGTE);
  });

  it('resolves an abbreviated class name to its class', () => {
    // LMU reports "Hyper", not "Hypercar" -- the opposite direction to the
    // championship-qualified names, and it left Hypercar with no colour too.
    const raw = fixture();
    raw.drivers[0].className = 'Hyper';

    const s = mapLmuSession(raw);

    expect(driverClass(s, 0)?.CarClassShortName).toBe('Hypercar');
    expect(driverClass(s, 0)?.CarClassColor).toBe(LMU_CLASS_COLOURS.Hypercar);
  });

  it('refuses an abbreviation that names more than one class', () => {
    // "LMGT" prefixes both LMGT3 and LMGTE. Guessing between them would put
    // cars in the wrong class; no match is the honest answer.
    const raw = fixture();
    raw.drivers[0].className = 'LMGT';

    const s = mapLmuSession(raw);

    expect(driverClass(s, 0)?.CarClassShortName).toBe('LMGT');
    expect(driverClass(s, 0)?.CarClassColor).toBe(0);
  });

  it('keeps an unknown class name rather than dropping it', () => {
    const raw = fixture();
    raw.drivers[0].className = 'Garage56';

    const s = mapLmuSession(raw);

    expect(driverClass(s, 0)?.CarClassShortName).toBe('Garage56');
    expect(driverClass(s, 0)?.CarClassColor).toBe(0);
  });

  it('orders relative speed so the faster class compares greater', () => {
    // FasterCarsFromBehind compares these directly; with every class at 0 it
    // could never fire.
    const raw = fixture();
    raw.drivers[0].className = 'Hypercar';
    raw.drivers[1].className = 'LMP2';
    raw.drivers[2].className = 'LMGTE';

    const s = mapLmuSession(raw);
    const speeds = [0, 1, 2].map(
      (i) => driverClass(s, i)?.CarClassRelSpeed ?? 0
    );

    expect(speeds[0]).toBeGreaterThan(speeds[1]);
    expect(speeds[1]).toBeGreaterThan(speeds[2]);
  });

  it('accepts a class name written with or without its LM prefix', () => {
    // The same class is written both ways; only the prefix is optional.
    const withPrefix = fixture();
    withPrefix.drivers[0].className = 'LMGT3';
    const without = fixture();
    without.drivers[0].className = 'GT3';

    expect(driverClass(mapLmuSession(withPrefix), 0)?.CarClassColor).toBe(
      driverClass(mapLmuSession(without), 0)?.CarClassColor
    );
  });

  it('ignores spacing and case', () => {
    const raw = fixture();
    raw.drivers[0].className = 'lm gt3';

    const spaced = driverClass(mapLmuSession(raw), 0)?.CarClassColor;

    const plain = fixture();
    plain.drivers[0].className = 'LMGT3';
    expect(spaced).toBe(driverClass(mapLmuSession(plain), 0)?.CarClassColor);
  });

  it('gives an unknown class no colour rather than another class colour', () => {
    // Borrowing a colour would claim two classes share a speed tier.
    const raw = fixture();
    raw.drivers[0].className = 'Something Else';

    const s = mapLmuSession(raw);

    expect(driverClass(s, 0)?.CarClassColor).toBe(0);
    expect(driverClass(s, 0)?.CarClassRelSpeed).toBe(0);
  });
});

describe('mapLmuSession REST session values', () => {
  it('omits LmuRest when nothing was polled', () => {
    expect(mapLmuSession(fixture()).LmuRest).toBeUndefined();
  });

  it('omits LmuRest when the API answered with nothing usable', () => {
    // Absent means "not polled"; an empty object would claim the API answered
    // and reported nothing, which is a different thing.
    expect(mapLmuSession(fixture(), null, {}).LmuRest).toBeUndefined();
  });

  it('carries the session values it is given', () => {
    const s = mapLmuSession(fixture(), null, {
      timeScale: 6,
      privateQualifying: true,
      maxVirtualEnergy: 100,
    });

    expect(s.LmuRest).toEqual({
      timeScale: 6,
      privateQualifying: true,
      maxVirtualEnergy: 100,
    });
  });

  it('coexists with a track map, the other out-of-band source', () => {
    const trackMap = {
      active: {
        inside: '',
        outside: '',
        trackPathPoints: [{ x: 0, y: 0 }],
        totalLength: 1,
      },
      startFinish: {
        line: '',
        point: { x: 0, y: 0, length: 0 },
        direction: 'anticlockwise' as const,
      },
    };

    const s = mapLmuSession(fixture(), trackMap, { timeScale: 2 });

    expect(s.LmuTrackMap).toEqual(trackMap);
    expect(s.LmuRest?.timeScale).toBe(2);
  });
});
