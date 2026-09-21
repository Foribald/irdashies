import { renderHook } from '@testing-library/react';
import { describe, it, vi, expect, afterEach } from 'vitest';
import { useStandingsSnapshot } from '@irdashies/context';
import { useDriverLivePositions } from './useDriverLivePositions';

vi.mock('@irdashies/context');

type Snapshot = Parameters<typeof mockSnapshot>[0];

const mockSnapshot = (snapshot: {
  carIdxClassPosition?: number[];
  liveClassPosition?: number[];
}) => {
  vi.mocked(useStandingsSnapshot).mockReturnValue(
    snapshot as unknown as ReturnType<typeof useStandingsSnapshot>
  );
};

const render = (snapshot: Snapshot, enabled = true) => {
  mockSnapshot(snapshot);
  return renderHook(() => useDriverLivePositions({ enabled })).result.current;
};

describe('useDriverLivePositions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers what the sim reports, so it agrees with the Relative widget', () => {
    // The Relative reads carIdxClassPosition. If this returned the derived
    // ordering instead, the two widgets would show different running orders
    // from the same frame — which is the bug this indirection exists to avoid.
    expect(
      render({
        carIdxClassPosition: [2, 1, 1],
        liveClassPosition: [1, 2, 1],
      })
    ).toEqual({ 0: 2, 1: 1, 2: 1 });
  });

  it('falls back to the derived ordering when the sim reports none', () => {
    // Outside a green race, or for a sim that publishes no class position, the
    // processor's laps-plus-distance ordering is all there is.
    expect(
      render({ carIdxClassPosition: [], liveClassPosition: [1, 2, 3] })
    ).toEqual({ 0: 1, 1: 2, 2: 3 });

    expect(render({ liveClassPosition: [1, 2] })).toEqual({ 0: 1, 1: 2 });
  });

  it('treats a zero or negative slot as no position, not as position zero', () => {
    // Empty grid slots read 0 or -1. Publishing those as a position would put
    // phantom cars at the front of their class.
    expect(
      render({ carIdxClassPosition: [1, 0, 2, -1], liveClassPosition: [] })
    ).toEqual({ 0: 1, 2: 2 });
  });

  it('falls back when every sim-reported slot is empty', () => {
    expect(
      render({ carIdxClassPosition: [0, 0, 0], liveClassPosition: [1, 2, 3] })
    ).toEqual({ 0: 1, 1: 2, 2: 3 });
  });

  it('returns nothing when disabled or without a snapshot', () => {
    expect(render({ carIdxClassPosition: [1, 2] }, false)).toEqual({});

    vi.mocked(useStandingsSnapshot).mockReturnValue(
      undefined as unknown as ReturnType<typeof useStandingsSnapshot>
    );
    expect(
      renderHook(() => useDriverLivePositions({ enabled: true })).result.current
    ).toEqual({});
  });
});
