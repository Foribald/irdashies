import type { SimDefinition, SimProbe } from '../types';

/**
 * iRacing, the built-in telemetry source.
 *
 * Highest priority: it is the one simulator always present in the tree, so on
 * a build with no others `auto` resolves to it without probing at all.
 */
const iracing: SimDefinition = {
  id: 'iracing',
  priority: 100,

  createProbe: async (): Promise<SimProbe> => {
    const { NativeSDK } = await import('../../../../irsdk/native');
    const sdk = new NativeSDK();
    return {
      start: () => sdk.startSDK(),
      // A zero timeout makes this a poll rather than a block: auto-detect is
      // looping over several sims and must not stall on one of them.
      isActive: () => sdk.waitForData(0),
      stop: () => sdk.stopSDK(),
    };
  },

  loadBridge: async () => {
    const { publishIRacingSDKEvents } = await import('../../iracingSdkBridge');
    return publishIRacingSDKEvents;
  },
};

export default iracing;
