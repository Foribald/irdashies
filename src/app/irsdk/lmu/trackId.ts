/**
 * A synthetic `WeekendInfo.TrackID` for LMU, which publishes none.
 *
 * The previous hardcoded 0 was deliberate — it stops the track map indexing the
 * bundled iRacing drawings and drawing the wrong circuit — but four guards treat
 * a non-positive id as "track unknown" and switch features off, LapTrace among
 * them. So the id has to be positive, and then two properties become mandatory:
 *
 * - **stable across restarts**, because it keys stored lap traces
 *   (`${trackId}:${carPath}:${kind}`), personal bests and pit-lane data;
 * - **unique per track**, or every LMU circuit shares one key and a best lap set
 *   at Le Mans is replayed at Monza.
 *
 * Hashing the track name gives both without persisting anything. The name is
 * already trusted as the stable per-layout key elsewhere — the bridge keys its
 * whole LMU track-map store on it.
 */
import { createHash } from 'node:crypto';

/**
 * Synthetic ids occupy [1e9, 2e9).
 *
 * Three orders of magnitude above the bundled iRacing drawings (ids 1..599), so
 * `tracks[id]` is always `undefined` and the map behaves exactly as it did with
 * 0. Below 2^31, so it survives an accidental `| 0` or a trip through an
 * Int32Array. Distinct from the 10001+ range `resolveLmuCarId` uses for
 * manufacturers.
 */
export const LMU_TRACK_ID_BASE = 1_000_000_000;
const LMU_TRACK_ID_SPAN = 1_000_000_000;

/**
 * Folds case, surrounding and repeated whitespace, and diacritics, so that
 * "Autódromo  Internazionale " and "autodromo internazionale" are one track
 * rather than two sets of saved laps.
 */
export const normalizeLmuTrackKey = (trackName: string): string =>
  trackName
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Stable positive id for an LMU track name, or 0 when there is no name yet.
 *
 * Returning 0 before a session is loaded is intentional: the downstream guards
 * are right to reject an unknown track, and recording a lap under a placeholder
 * id would file it against the wrong circuit.
 */
export function resolveLmuTrackId(trackName: string): number {
  const key = normalizeLmuTrackKey(trackName);
  if (!key) return 0;
  const digest = createHash('sha1').update(key, 'utf8').digest();
  return LMU_TRACK_ID_BASE + (digest.readUInt32BE(0) % LMU_TRACK_ID_SPAN);
}
