import { describe, expect, it } from 'vitest';
import { resolveTrackMapId } from './useTrackId';

describe('resolveTrackMapId', () => {
  it.each(['Imola', 'Imola 2023', 'Autodromo Enzo e Dino Ferrari'])(
    'uses the bundled Imola map for LMU track %s',
    (trackName) => {
      expect(resolveTrackMapId(1_234_567, trackName, 'Le Mans Ultimate')).toBe(
        463
      );
    }
  );

  it('keeps iRacing track ids unchanged', () => {
    expect(resolveTrackMapId(463, 'imola gp', 'iRacing')).toBe(463);
  });

  it('does not guess unsupported LMU maps', () => {
    expect(resolveTrackMapId(1_234_567, 'Lusail', 'Le Mans Ultimate')).toBe(
      undefined
    );
  });
});
