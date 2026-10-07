import { useMemo } from 'react';
import { useSessionStore } from '@irdashies/context';
import { loadTrackData } from '@irdashies/utils/trackData';
import type { LovelyTrackInfo, LovelyTrackSection } from '@irdashies/types';
import { lmuTrackDataId } from '@irdashies/types';
import { mapLovelyToTrackData } from '@irdashies/utils/lovelyTrackData';

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
 * One dataset for both sims, and one lookup -- only the key differs. iRacing's
 * TrackName is already the shape the dataset is keyed by; LMU publishes a full
 * display name, so it goes through LMU_TRACK_DATA_IDS first. Without that step
 * no LMU name matched, and the near-miss fallback answered "WeatherTech
 * Raceway Laguna Seca" with "summit summit raceway" -- so both corner widgets
 * showed another circuit's corners.
 *
 * Used by the Corner Names overlay and by the Lap Trace's corner comparison,
 * which is why it lives here rather than beside either of them.
 */
export const useLovelyTrackData = (): LovelyTrackData => {
  const trackName = useSessionStore((s) => s.session?.WeekendInfo?.TrackName);

  return useMemo(() => {
    if (!trackName) return EMPTY;
    const raw = loadTrackData(lmuTrackDataId(trackName) ?? trackName);
    if (!raw) return EMPTY;
    return mapLovelyToTrackData(raw);
  }, [trackName]);
};
