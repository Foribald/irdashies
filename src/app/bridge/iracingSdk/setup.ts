import { OverlayManager } from '../../overlayManager';
import { ipcMain } from 'electron';
import type { IrSdkSourceBridge } from '@irdashies/types';
import logger from '../../logger';
import {
  createSessionLifecycle,
  type SessionLifecycle,
} from '../../sessionLifecycle';
import type { ChannelBus } from '../channelBridge';
import type { ActiveSimulator } from '@irdashies/types';
import { getAvailableSimulators, getSimDefinition } from './sims/registry';
import {
  getSimulatorOverride,
  resolveSimulatorPreference,
  resolveWithoutProbing,
} from './simSelection';
import { getCurrentProfileId, getDashboard } from '../../storage/dashboards';

let isDemoMode = false;
let currentBridge: IrSdkSourceBridge | undefined;
/**
 * The simulator currently feeding telemetry, or undefined while auto-detection
 * is still probing. Published to the renderer so the settings window can name
 * it, and replayed to overlays that open later.
 */
let activeSimulator: ActiveSimulator | undefined;
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

export function getActiveSimulator(): ActiveSimulator | undefined {
  return activeSimulator;
}

/**
 * Records the running simulator and tells the renderer. Auto-detection calls
 * this once it has probed; the pinned paths call it up front.
 */
export function setActiveSimulator(
  overlayManager: OverlayManager,
  simulator: ActiveSimulator | undefined
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
  ipcMain.handle('getAvailableSimulators', () => getAvailableSimulators());

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
    const isMock =
      isDemoMode || (process.platform !== 'win32' && !isTapeReplay);
    const available = getAvailableSimulators();

    // Tape replay always feeds the iRacing bridge, whatever the preference
    // says: the tape is an iRacing recording.
    const simulator = isTapeReplay
      ? 'iracing'
      : (resolveSimulatorPreference(
          getDashboard(getCurrentProfileId())?.generalSettings?.simulator,
          getSimulatorOverride(process.argv, process.env.IRDASHIES_SIM),
          available
        ) ?? resolveWithoutProbing(available));

    const publishIRacingSDKEvents = isMock
      ? (await import('./mock-data/mockSdkBridge')).publishIRacingSDKEvents
      : simulator
        ? await loadSimBridge(simulator)
        : (await import('./autoDetectSdkBridge')).publishAutoDetectedSdkEvents;

    // Known now for a pinned sim, and for a build with only one source. On a
    // real 'auto' the answer is whatever the probe settles on, which
    // autoDetectSdkBridge reports itself; clear it meanwhile so the UI does
    // not name a stale sim.
    setActiveSimulator(overlayManager, isMock ? undefined : simulator);

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

async function loadSimBridge(simulator: ActiveSimulator) {
  const definition = getSimDefinition(simulator);
  if (!definition) {
    throw new Error(
      `No telemetry source for simulator '${simulator}' in this build`
    );
  }
  return definition.loadBridge();
}
