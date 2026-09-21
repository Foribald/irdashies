import { useMemo } from 'react';
import { useStandingsSnapshot } from '@irdashies/context';

const EMPTY_POSITIONS: Record<number, number> = {};

/**
 * Live in-class positions indexed by CarIdx, from the telemetry channel.
 *
 * Two sources carry this, both at telemetry rate:
 *
 * - `carIdxClassPosition` — what the sim itself reports. Preferred, because the
 *   Relative widget reads this same array (see `useDriverPositions`), so taking
 *   it here keeps the two widgets showing one running order instead of two that
 *   drift apart.
 * - `liveClassPosition` — the processor's own ordering, derived from laps plus
 *   lap distance, with handling for tows and the checkered flag. The fallback
 *   for when the sim publishes no class position of its own, and the only
 *   source outside a green or checkered race session.
 *
 * Both beat the session channel's `ResultsPositions`, which is republished at
 * 2 Hz at best and lags a position change by up to half a second.
 */
export const useDriverLivePositions = ({
  enabled,
}: {
  enabled: boolean;
}): Record<number, number> => {
  const snapshot = useStandingsSnapshot(enabled);
  const simReported = snapshot?.carIdxClassPosition;
  const derived = snapshot?.liveClassPosition;

  return useMemo(() => {
    if (!enabled) return EMPTY_POSITIONS;

    // A slot holding 0 or a negative is "no position" in both arrays — an empty
    // grid slot, or a car the sim is not scoring — so it must not be published
    // as position zero.
    const positions: Record<number, number> = {};
    let hasSimReported = false;
    if (Array.isArray(simReported)) {
      for (let carIdx = 0; carIdx < simReported.length; carIdx += 1) {
        const position = Number(simReported[carIdx]);
        if (Number.isFinite(position) && position > 0) {
          positions[carIdx] = position;
          hasSimReported = true;
        }
      }
    }
    if (hasSimReported) return positions;

    if (!Array.isArray(derived)) return EMPTY_POSITIONS;
    const fallback: Record<number, number> = {};
    for (let carIdx = 0; carIdx < derived.length; carIdx += 1) {
      const position = Number(derived[carIdx]);
      if (Number.isFinite(position) && position > 0)
        fallback[carIdx] = position;
    }
    return fallback;
  }, [enabled, simReported, derived]);
};
