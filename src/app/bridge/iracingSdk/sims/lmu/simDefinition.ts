import type { SimDefinition, SimProbe } from '../types';

/**
 * Le Mans Ultimate, read through its shared-memory map.
 *
 * Priority is higher than iRacing's: LMU's shared-memory map can linger
 * briefly after the sim closes, so when both read as active at once during
 * auto-detect, LMU wins the tie rather than iRacing.
 */
const lmu: SimDefinition = {
  id: 'lmu',
  priority: 110,

  createProbe: async (): Promise<SimProbe> => {
    const { NativeLmu } = await import('../../../../irsdk/native/lmu');
    const sdk = new NativeLmu();
    return {
      start: () => sdk.start(),
      isActive: () => {
        const frame = sdk.read();
        return (
          frame.running && frame.trackName.length > 0 && frame.numVehicles > 0
        );
      },
      stop: () => sdk.stop(),
    };
  },

  loadBridge: async () => {
    const { publishLmuSDKEvents } = await import('../../lmuSdkBridge');
    return publishLmuSDKEvents;
  },
};

export default lmu;
