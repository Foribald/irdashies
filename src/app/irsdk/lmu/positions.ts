/**
 * Running order and class positions for LMU.
 *
 * LMU publishes `mPlace` — an overall position — and **no class position at
 * all**, so class ranks have to be computed. Two widgets need them from two
 * different places: the Standings table builds its rows from the session's
 * `ResultsPositions`, while the Relative reads the live `CarIdxClassPosition`
 * telemetry array. They must agree, so both derive from the single ranking
 * below rather than sorting independently.
 */

type RawTelemetry = import('../native/lmu').LmuRawTelemetry;

/** One car's ranking inputs, however the caller happened to obtain them. */
export interface LmuRankEntry {
  carIdx: number;
  classId: number;
  /** mPlace: overall position, 1-based. 0 when the car is not yet scored. */
  place: number;
  /** Best lap in seconds; <= 0 when no time has been set. */
  bestLapTime: number;
  /** mQualification: a grid POSITION, 1-based. 0 when unqualified. */
  qualification: number;
  totalLaps: number;
  /** 0..1 around the lap; negative when unknown. */
  lapDistPct: number;
}

/**
 * Which key leads the sort. Everything falls through to the same tie-breaks, so
 * this only picks the primary ordering, never a second algorithm.
 */
export type LmuRankMode = 'place' | 'lapTime' | 'qualifying';

export interface LmuRanking {
  /** carIdx in finishing/running order, leader first. */
  order: number[];
  /** Overall position by carIdx, 1-based. 0 for a car that was not ranked. */
  overall: number[];
  /** Class position by carIdx, **0-based**. -1 for a car that was not ranked. */
  classPosition: number[];
}

/** Sorts missing values last without the NaN that subtraction would produce. */
const rank = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;

const compare = (a: number, b: number): number =>
  a === b ? 0 : a < b ? -1 : 1;

/**
 * Orders `entries` and assigns overall and per-class positions.
 *
 * Comparisons are explicit rather than subtractions: unset values become
 * +Infinity so they sort last, and `Infinity - Infinity` is NaN, which would
 * quietly corrupt the sort. The tie-break chain ends at `carIdx` so the result
 * never depends on the order the caller supplied.
 */
export function rankLmuEntries(
  entries: readonly LmuRankEntry[],
  mode: LmuRankMode
): LmuRanking {
  const sorted = [...entries].sort((a, b) => {
    if (mode === 'lapTime') {
      const byTime = compare(rank(a.bestLapTime), rank(b.bestLapTime));
      if (byTime !== 0) return byTime;
    } else if (mode === 'qualifying') {
      const byQuali = compare(rank(a.qualification), rank(b.qualification));
      if (byQuali !== 0) return byQuali;
      const byTime = compare(rank(a.bestLapTime), rank(b.bestLapTime));
      if (byTime !== 0) return byTime;
    }

    const byPlace = compare(rank(a.place), rank(b.place));
    if (byPlace !== 0) return byPlace;
    // Further round the road is ahead, on the same lap or a later one.
    const byLaps = compare(b.totalLaps, a.totalLaps);
    if (byLaps !== 0) return byLaps;
    const byDist = compare(b.lapDistPct, a.lapDistPct);
    if (byDist !== 0) return byDist;
    return compare(a.carIdx, b.carIdx);
  });

  const size = entries.reduce((max, e) => Math.max(max, e.carIdx + 1), 0);
  const overall = new Array<number>(size).fill(0);
  const classPosition = new Array<number>(size).fill(-1);
  const seenPerClass = new Map<number, number>();

  const order = sorted.map((entry, index) => {
    const taken = seenPerClass.get(entry.classId) ?? 0;
    seenPerClass.set(entry.classId, taken + 1);
    overall[entry.carIdx] = index + 1;
    classPosition[entry.carIdx] = taken;
    return entry.carIdx;
  });

  return { order, overall, classPosition };
}

/**
 * Which slots in the per-car arrays hold a real car.
 *
 * The addon sizes those arrays at `max(mID) + 1` and zero-fills them, so a grid
 * with sparse ids leaves gaps that otherwise read as a car in class 0 at
 * position 0. `vehLapDistPct` is the one channel pre-filled with -1
 * (`lmu_node.cc`) and then overwritten with a value clamped to 0..1 for every
 * scored vehicle, so a negative entry means "no car here".
 */
export function lmuOccupiedSlots(
  raw: Pick<RawTelemetry, 'vehLapDistPct'>
): boolean[] {
  const pct = raw.vehLapDistPct;
  if (!pct) return [];
  return Array.from(pct, (value) => value >= 0);
}

/** iRacing-shaped session type for an LMU session index. */
export function lmuSessionType(session: number): string {
  if (session >= 10) return 'Race';
  if (session >= 5 && session <= 8) return 'Open Qualify';
  if (session >= 1) return 'Practice';
  return 'Offline Testing';
}

/**
 * How a session of this type is ordered. A race is ordered by track position;
 * everything else is ordered by best lap, as iRacing does.
 */
export function lmuRankModeFor(sessionTypeName: string): LmuRankMode {
  return sessionTypeName === 'Race' ? 'place' : 'lapTime';
}
