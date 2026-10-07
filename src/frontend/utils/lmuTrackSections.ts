/**
 * Builds corner sections for Le Mans Ultimate from the track map it ships.
 *
 * The corner widgets were reading the bundled Lovely Sim Racing dataset, which
 * is keyed by iRacing's lowercase slugs ("lagunaseca", "spa combined"). LMU
 * publishes a full display name, so nothing ever matched exactly and every
 * lookup fell through to a token-overlap guess -- which returned the best
 * scoring *wrong* track rather than nothing. "WeatherTech Raceway Laguna Seca"
 * came back as "summit summit raceway", on the strength of the word "raceway".
 *
 * LMU already carries the right names, keyed by the exact name it reports, so
 * no matching is needed at all: LmuTrackMap.turns holds "Andretti Hairpin",
 * "La Source", "Courbe Dunlop" and the numbered turns beside them.
 *
 * What it does not carry is lap distance. Turns are points in the map's own
 * coordinate space, so each one is projected onto the path to find where round
 * the lap it sits. That is cheap and exact here because of two properties of
 * the bundled data, both verified across every layout in it:
 *
 * - the path is resampled to evenly spaced points, so a point's index is
 *   already proportional to distance along the lap -- no arc length to
 *   integrate;
 * - `startFinish.point.length` is 0, so index 0 *is* the start/finish line and
 *   the fraction needs no rotation.
 *
 * Direction was checked rather than assumed: projecting the numbered turns of
 * every layout gives fractions that ascend with the turn number, so the path
 * runs in the driving direction. Laguna Seca puts turn 1 at 6% of the lap and
 * Spa puts La Source at 6%, which is where they are.
 */

import type {
  LmuTrackMap,
  LovelyTrackInfo,
  LovelyTrackSection,
  SectionType,
} from '@irdashies/types';
import { slugify } from '@irdashies/utils/lovelyTrackData';

/**
 * How far either side of a corner its label applies, in metres.
 *
 * A turn is a point, and the widgets need a range. Tiling the whole lap by
 * nearest corner would name every metre of it, so the Mulsanne would be
 * labelled "Turn 8" for a kilometre; this bounds a corner to its own
 * surroundings and leaves the long straights unnamed, which is the honest
 * answer and what a driver would expect.
 *
 * Metres rather than a fraction of the lap because the layouts differ by
 * almost four times in length -- a fraction that suited Laguna Seca would
 * cover a third of a Le Mans straight.
 */
const CORNER_REACH_M = 110;

/** Fallback when the session has not reported a track length yet. */
const ASSUMED_TRACK_LENGTH_M = 5000;

const SECTION_TYPE_RULES: [RegExp, SectionType][] = [
  [/chicane|schikane|variante|bus\s*stop/i, 'chicane'],
  [/hairpin|kehre|epingle/i, 'hairpin'],
  [/ess(es)?|complex|senna/i, 'complex'],
  [
    /sweeper|kemmel|raidillon|carousel|karussell|courbe|curva|curve/i,
    'sweeper',
  ],
  [/kink|flugplatz/i, 'kink'],
  [/straight|gerade|reta|droite|rettilineo/i, 'straight'],
];

const inferType = (name: string): SectionType => {
  for (const [re, type] of SECTION_TYPE_RULES) {
    if (re.test(name)) return type;
  }
  return 'corner';
};

const isNumeric = (text: string): boolean => /^\d+$/.test(text.trim());

/** Where round the lap a map-space point sits, as a fraction in [0, 1). */
const projectToLapFraction = (
  points: { x: number; y: number }[],
  x: number,
  y: number
): number => {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i].x - x;
    const dy = points[i].y - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex / points.length;
};

/** One corner, before it is given a range. */
interface LmuCorner {
  fraction: number;
  /** The label when the map gives one, e.g. "La Source" or "Turn 9". */
  label?: string;
  /** The map's own marker index, which is not always the turn number. */
  marker?: number;
}

/**
 * Collapses the map's turn list into one corner per place on the track.
 *
 * LMU lists a marker index and a label separately for the same corner, at
 * identical coordinates: Laguna Seca carries "2" and "Andretti Hairpin" both
 * at (1195.38, 944.54). Keeping them apart would put two labels on one corner.
 *
 * Where the two disagree the label wins, because the index is the map's own
 * numbering rather than the circuit's. The same track pairs "7" with "The
 * Corkscrew", which is officially turn 8, and then "8" with "Turn 9" -- the
 * index runs one behind from there on. So the index is used only to name a
 * corner the map left unlabelled.
 */
const collectCorners = (
  turns: NonNullable<LmuTrackMap['turns']>,
  points: { x: number; y: number }[]
): LmuCorner[] => {
  const byFraction = new Map<number, LmuCorner>();

  for (const turn of turns) {
    const content = turn.content?.trim();
    if (!content || turn.x === undefined || turn.y === undefined) continue;

    const fraction = projectToLapFraction(points, turn.x, turn.y);
    const corner = byFraction.get(fraction) ?? { fraction };
    if (isNumeric(content)) {
      corner.marker ??= Number(content);
    } else {
      corner.label ??= content;
    }
    byFraction.set(fraction, corner);
  }

  return [...byFraction.values()]
    .filter(
      (corner) => corner.label !== undefined || corner.marker !== undefined
    )
    .sort((a, b) => a.fraction - b.fraction);
};

/**
 * Sections for the current LMU track, or an empty list when the map carries no
 * named turns.
 *
 * Thirteen of the bundled layouts have them; the rest -- Fuji, Bahrain,
 * Lusail, Paul Ricard -- ship an empty turn list, and an empty result is the
 * right answer there. It leaves the widgets blank rather than confident and
 * wrong, which is the whole point of this file.
 */
export const lmuTrackSections = (
  map: LmuTrackMap | undefined | null,
  trackName?: string,
  trackLengthM?: number
): { sections: LovelyTrackSection[]; info: LovelyTrackInfo | null } => {
  const points = map?.active?.trackPathPoints;
  const turns = map?.turns;
  if (!points?.length || !turns?.length) return { sections: [], info: null };

  const corners = collectCorners(turns, points);
  if (corners.length === 0) return { sections: [], info: null };

  const lengthM =
    trackLengthM !== undefined &&
    Number.isFinite(trackLengthM) &&
    trackLengthM > 0
      ? trackLengthM
      : ASSUMED_TRACK_LENGTH_M;
  const reach = CORNER_REACH_M / lengthM;

  const usedIds = new Set<string>();
  const sections = corners.map((corner, index) => {
    const name = corner.label ?? `Turn ${corner.marker ?? index + 1}`;
    // Only when the name itself states one, which is the rule the Lovely
    // mapper follows. Taking it from the marker index would have contradicted
    // the name on its face -- "T8" beside "Turn 9".
    const numbered = /^Turn\s+(\d+)$/i.exec(name);
    // Half the gap to each neighbour, so adjacent corners of a complex do not
    // overlap, capped at the reach so a straight stays unnamed.
    const previous = corners[index - 1];
    const next = corners[index + 1];
    const back = previous
      ? Math.min(reach, (corner.fraction - previous.fraction) / 2)
      : reach;
    const forward = next
      ? Math.min(reach, (next.fraction - corner.fraction) / 2)
      : reach;

    const start = corner.fraction - back;
    const end = corner.fraction + forward;
    const baseId = slugify(name);
    const sectionId = usedIds.has(baseId) ? `${baseId}_${index}` : baseId;
    usedIds.add(sectionId);

    return {
      section_id: sectionId,
      name,
      type: inferType(name),
      // Wrapped into [0, 1): a corner on the start/finish straight has a
      // start below zero, and lap distance is a circular space.
      start_pct: (start + 1) % 1,
      end_pct: end % 1,
      length_pct: back + forward,
      marker_pct: corner.fraction,
      corner_number: numbered ? `T${numbered[1]}` : undefined,
    };
  });

  return {
    sections,
    info: {
      track_id: slugify(trackName ?? 'lmu track'),
      name: trackName ?? 'Le Mans Ultimate',
      length_m: trackLengthM,
      // The map carries neither. Sector boundaries come from the sim's own
      // scoring block rather than from here, and LMU names no straights.
      sectors: [],
      straights: [],
    },
  };
};
