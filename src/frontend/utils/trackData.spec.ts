import { describe, expect, it } from 'vitest';
import { loadTrackData } from './trackData';

/**
 * Covers the name matching, which is the part that can be confidently wrong.
 *
 * The bundle is keyed by iRacing's lowercase slugs, and the near-miss fallback
 * exists for the small drift between two spellings of the same circuit. It had
 * no way to answer "no match", so a name from another sim came back as a real
 * track on the strength of one shared generic word -- and the corner widgets
 * showed that circuit's corners.
 */
describe('loadTrackData', () => {
  it('matches an iRacing track name exactly', () => {
    expect(loadTrackData('nurburgring nordschleife')?.trackId).toBe(
      'nurburgring nordschleife'
    );
    expect(loadTrackData('lagunaseca')?.trackId).toBe('lagunaseca');
    expect(loadTrackData('spa combined')?.trackId).toBe('spa combined');
  });

  it('still bridges the drift it was written for', () => {
    // iRacing says "silverstone gp", the dataset says "silverstone 2019 gp".
    expect(loadTrackData('silverstone gp')?.trackId).toBe(
      'silverstone 2019 gp'
    );
  });

  it('refuses a match that rests on a generic word alone', () => {
    // "WeatherTech Raceway Laguna Seca" used to resolve to "summit summit
    // raceway", because both contain "raceway". An LMU track name shares no
    // distinctive word with any entry, so the honest answer is none.
    expect(loadTrackData('WeatherTech Raceway Laguna Seca')).toBeNull();
    expect(loadTrackData('Bahrain International Circuit')).toBeNull();
    expect(loadTrackData('Lusail International Circuit')).toBeNull();
  });

  it('still matches when a distinctive word is shared', () => {
    // The guard is about generic words, not about rejecting near misses:
    // "sebring" is distinctive, so this is a real match.
    expect(loadTrackData('Sebring International Raceway')?.trackId).toBe(
      'sebring international'
    );
  });

  it('returns null for nothing usable', () => {
    expect(loadTrackData('')).toBeNull();
    expect(loadTrackData('   ')).toBeNull();
    expect(loadTrackData('International Circuit')).toBeNull();
  });
});
