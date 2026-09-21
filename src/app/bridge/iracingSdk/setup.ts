import { OverlayManager } from '../../overlayManager';
import { ipcMain } from 'electron';
import type { IrSdkSourceBridge } from '@irdashies/types';
import logger from '../../logger';
import {
  createSessionLifecycle,
  type SessionLifecycle,
} from '../../sessionLifecycle';
import type { ChannelBus } from '../channelBridge';
import {
  getSimulatorOverride,
  resolveSimulatorPreference,
  type Simulator,
} from './simSelection';
import { getCurrentProfileId, getDashboard } from '../../storage/dashboards';

let isDemoMode = false;
let currentBridge: IrSdkSourceBridge | undefined;
/**
 * The simulator currently feeding telemetry, or undefined while auto-detection
 * is still probing. Published to the renderer so the settings window can name
 * it, and replayed to overlays that open later.
 */
let activeSimulator: Simulator | undefined;
const onBridgeChangedCallbacks = new Set<(bridge: IrSdkSourceBridge) => void>();

// Singleton lifecycle — created once; survives bridge restarts so subscribers
// registered before a demo-mode toggle are preserved.
let sessionLifecycle: SessionLifecycle | undefined;

export function getSessionLifecycle(): SessionLifecycle {
  if (!sessionLifecycle) {
    sessionLifecycle = createSessionLifecycle();
  }
  return sessionLifecycle;
}

export function getCurrentBridge(): IrSdkSourceBridge | undefined {
  return currentBridge;
}

export function getIsDemoMode(): boolean {
  return isDemoMode;
}

export function getActiveSimulator(): Simulator | undefined {
  return activeSimulator;
}

/**
 * Records the running simulator and tells the renderer. Auto-detection calls
 * this once it has probed; the forced paths call it up front.
 */
export function setActiveSimulator(
  overlayManager: OverlayManager,
  simulator: Simulator | undefined
) {
  if (simulator === activeSimulator) return;
  activeSimulator = simulator;
  overlayManager.publishMessage('simulatorChanged', simulator ?? null);
}

export function onBridgeChanged(callback: (bridge: IrSdkSourceBridge) => void) {
  onBridgeChangedCallbacks.add(callback);
  return () => onBridgeChangedCallbacks.delete(callback);
}

export async function iRacingSDKSetup(
  overlayManager: OverlayManager,
  channelBus?: ChannelBus
) {
  ipcMain.on('toggleDemoMode', async (_, value: boolean) => {
    isDemoMode = value;
    if (currentBridge) {
      currentBridge.stop();
      currentBridge = undefined;
    }

    // Flip the UI immediately; the data source swaps underneath. Otherwise the
    // mode change is gated behind the full bridge teardown/rebuild below
    // (dynamic import, native SDK load, sdk.ready()).
    overlayManager.publishMessage('demoModeChanged', value);
    const { notifyDemoModeChanged } =
      await import('../dashboard/dashboardBridge');
    notifyDemoModeChanged(value);

    await setupBridge(overlayManager, channelBus);
  });

  // The preference itself is persisted with the rest of the dashboard; this
  // only rebuilds the bridge so the change takes effect without a restart.
  ipcMain.on('simulatorPreferenceChanged', async () => {
    await setupBridge(overlayManager, channelBus);
  });

  ipcMain.handle('getActiveSimulator', () => activeSimulator ?? null);

  await setupBridge(overlayManager, channelBus);
}

async function setupBridge(
  overlayManager: OverlayManager,
  channelBus?: ChannelBus
) {
  try {
    if (currentBridge) {
      currentBridge.stop();
      currentBridge = undefined;
    }

    const isTapeReplay = Boolean(process.env.IRDASHIES_TELEMETRY_REPLAY);
    const simulator = resolveSimulatorPreference(
      getDashboard(getCurrentProfileId())?.generalSettings?.simulator,
      getSimulatorOverride(process.argv, process.env.IRDASHIES_SIM)
    );
    const isMock =
      isDemoMode || (process.platform !== 'win32' && !isTapeReplay);
    const module = isMock
      ? await import('./mock-data/mockSdkBridge')
      : isTapeReplay || simulator === 'iracing'
        ? await import('./iracingSdkBridge')
        : simulator === 'lmu'
          ? await import('./lmuSdkBridge')
          : await import('./autoDetectSdkBridge');

    // Pinned to one simulator, so it is known now. On 'auto' the answer is
    // whatever the probe settles on, which autoDetectSdkBridge reports itself;
    // clear it meanwhile so the UI does not name a stale sim.
    setActiveSimulator(
      overlayManager,
      isMock ? undefined : isTapeReplay ? 'iracing' : simulator
    );

    const publishIRacingSDKEvents =
      'publishAutoDetectedSdkEvents' in module
        ? module.publishAutoDetectedSdkEvents
        : module.publishIRacingSDKEvents;
    const lifecycle = isDemoMode ? undefined : getSessionLifecycle();
    currentBridge = await publishIRacingSDKEvents(
      overlayManager,
      lifecycle,
      channelBus
    );

    if (onBridgeChangedCallbacks.size > 0 && currentBridge) {
      const bridge = currentBridge;
      onBridgeChangedCallbacks.forEach((cb) => cb(bridge));
    }
  } catch (err) {
    logger.error('Failed to load bridge');
    throw err;
  }
}
