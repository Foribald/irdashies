/**
 * LMU's synthetic track ids must never index a bundled iRacing track drawing.
 *
 * `WeekendInfo.TrackID` was hardcoded to 0 for LMU precisely to avoid that:
 * `FlatTrackMap` does `tracks[trackId]`, so an id inside the drawing range would
 * render a real circuit's map for an LMU track. The 0 also read as "track
 * unknown" to four guards and switched LapTrace off, so the ids are now hashed
 * into a range far above the drawings — and this is the test that keeps them
 * there if the bundled set ever grows.
 *
 * It lives at the src root rather than beside `trackId.ts` because app code may
 * not import from the frontend.
 */
import { describe, expect, it } from 'vitest';
import tracks from './frontend/components/TrackMap/tracks/tracks.json';
import { LMU_TRACK_ID_BASE, resolveLmuTrackId } from './app/irsdk/lmu/trackId';
import { LMU_TEST_CIRCUITS } from './app/irsdk/lmu/trackId.spec';

describe('LMU track ids versus bundled iRacing drawings', () => {
  const drawingIds = Object.keys(tracks).map(Number).filter(Number.isFinite);

  it('keeps every bundled drawing id below the LMU range', () => {
    expect(drawingIds.length).toBeGreaterThan(0);
    expect(Math.max(...drawingIds)).toBeLessThan(LMU_TRACK_ID_BASE);
  });

  it('never resolves an LMU track onto a drawing', () => {
    const drawings = tracks as unknown as Record<number, unknown>;
    for (const name of LMU_TEST_CIRCUITS) {
      expect(drawings[resolveLmuTrackId(name)]).toBeUndefined();
    }
  });
});
