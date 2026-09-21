import { describe, expect, it } from 'vitest';
import {
  LMU_TRACK_ID_BASE,
  normalizeLmuTrackKey,
  resolveLmuTrackId,
} from './trackId';

/**
 * Real LMU circuit names, to check they all land on distinct ids.
 *
 * The companion assertion — that none of these can index a bundled iRacing
 * track drawing — lives in `src/lmuTrackMapSafety.spec.ts`, because app code
 * may not import from the frontend.
 */
export const LMU_TEST_CIRCUITS = [
  'Circuit de la Sarthe',
  'Autodromo Nazionale Monza',
  'Spa Francorchamps',
  'Autodromo Internazionale del Mugello',
  'Lusail',
  'Sebring',
  'Autodromo Jose Carlos Pace',
  'Fuji Speedway',
  'Bahrain International Circuit',
  'Circuit of the Americas',
  'Imola',
  'Portimao',
];

describe('resolveLmuTrackId', () => {
  it('is stable for the same track name', () => {
    expect(resolveLmuTrackId('Spa Francorchamps')).toBe(
      resolveLmuTrackId('Spa Francorchamps')
    );
  });

  it('gives every circuit its own id', () => {
    // Stored lap traces, personal bests and pit-lane data are all keyed on this,
    // so a shared id means a best lap set at Le Mans replays at Monza.
    const ids = LMU_TEST_CIRCUITS.map(resolveLmuTrackId);
    expect(new Set(ids).size).toBe(LMU_TEST_CIRCUITS.length);
  });

  it('returns 0 when there is no track name yet', () => {
    // The downstream guards are right to reject an unknown track; filing a lap
    // under a placeholder id would attribute it to the wrong circuit.
    expect(resolveLmuTrackId('')).toBe(0);
    expect(resolveLmuTrackId('   ')).toBe(0);
  });

  it('folds case, padding and diacritics into one id', () => {
    expect(resolveLmuTrackId('  SPA   Francorchamps ')).toBe(
      resolveLmuTrackId('spa francorchamps')
    );
    expect(resolveLmuTrackId('Autódromo')).toBe(resolveLmuTrackId('Autodromo'));
    expect(normalizeLmuTrackKey('  Le   MANS ')).toBe('le mans');
  });

  it('stays inside a range that survives int coercion', () => {
    for (const id of LMU_TEST_CIRCUITS.map(resolveLmuTrackId)) {
      expect(id).toBeGreaterThanOrEqual(LMU_TRACK_ID_BASE);
      expect(id).toBeLessThan(2 ** 31 - 1);
      // Would break if the value were ever pushed through an Int32Array.
      expect(id | 0).toBe(id);
    }
  });
});
