import { useMemo } from 'react';
import { useSessionStore } from '@irdashies/context';
import { loadTrackData } from '@irdashies/utils/trackData';
import type { LovelyTrackInfo, LovelyTrackSection } from '@irdashies/types';
import { mapLovelyToTrackData } from '@irdashies/utils/lovelyTrackData';
import { lmuTrackSections } from '@irdashies/utils/lmuTrackSections';

interface LovelyTrackData {
  sections: LovelyTrackSection[];
  info: LovelyTrackInfo | null;
}

const EMPTY: LovelyTrackData = {
  sections: [],
  info: null,
};

/**
 * Track sections for the running session: corner names and where they are.
 *
 * Two sources, because the two sims carry this differently.
 *
 * LMU ships its own track maps with named turns, keyed by the exact name it
 * reports, so they are used whenever one is present. The Lovely dataset cannot
 * serve LMU: it is keyed by iRacing's lowercase slugs, LMU reports a full
 * display name, and the near-miss fallback used to answer "WeatherTech Raceway
 * Laguna Seca" with "summit summit raceway" -- so both corner widgets showed
 * another circuit's corners.
 *
 * iRacing keeps the Lovely dataset, whose shape it matches.
 *
 * Used by the Corner Names overlay and by the Lap Trace's corner comparison,
 * which is why it lives here rather than beside either of them.
 */
export const useLovelyTrackData = (): LovelyTrackData => {
  const trackName = useSessionStore((s) => s.session?.WeekendInfo?.TrackName);
  const trackLength = useSessionStore(
    (s) => s.session?.WeekendInfo?.TrackLength
  );
  const lmuTrackMap = useSessionStore((s) => s.session?.LmuTrackMap);

  return useMemo(() => {
    // Kilometres, as "20.6383 km", which is the shape iRacing publishes and
    // the LMU mapper follows.
    const lengthM = trackLength
      ? Number.parseFloat(String(trackLength)) * 1000
      : undefined;

    const lmu = lmuTrackSections(lmuTrackMap, trackName, lengthM);
    if (lmu.sections.length > 0) return lmu;

    if (!trackName) return EMPTY;
    const raw = loadTrackData(trackName);
    if (!raw) return EMPTY;
    return mapLovelyToTrackData(raw);
  }, [trackName, trackLength, lmuTrackMap]);
};
