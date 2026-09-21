import { useSessionStore } from '@irdashies/context';

export const resolveTrackMapId = (
  trackId: number | undefined,
  trackName: string | undefined,
  simMode: string | undefined
) => {
  if (simMode !== 'Le Mans Ultimate') return trackId;
  const normalized = trackName?.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (
    normalized?.includes('imola') ||
    normalized?.includes('enzoedinoferrari')
  ) {
    return 463;
  }
  return undefined;
};

export const useTrackId = () => {
  const session = useSessionStore((state) => state.session);
  return resolveTrackMapId(
    session?.WeekendInfo?.TrackID,
    session?.WeekendInfo?.TrackName,
    session?.WeekendInfo?.SimMode
  );
};
