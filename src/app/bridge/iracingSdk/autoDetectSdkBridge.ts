import type {
  ActiveSimulator,
  IrSdkSourceBridge,
  Session,
  Telemetry,
} from '@irdashies/types';
import type { OverlayManager } from '../../overlayManager';
import logger from '../../logger';
import type { SessionLifecycle } from '../../sessionLifecycle';
import type { ChannelBus } from '../channelBridge';
import { getSimDefinitions } from './sims/registry';
import { selectDetectedSimulator } from './simSelection';
import type { SimProbe } from './sims/types';

const RETRY_INTERVAL = 1000;

/**
 * Polls every simulator in the registry until one is running, then hands over
 * to that simulator's bridge.
 *
 * Only reached when the build has more than one simulator to choose between —
 * with a single source, `setup` resolves it outright and never gets here.
 *
 * The returned bridge is a stable façade: it is handed to callers immediately,
 * while detection is still running, and forwards to the real bridge once one
 * exists. Subscribers therefore do not have to care that the source arrived
 * late.
 *
 * Detection also resumes after the attached sim disconnects, rather than
 * ending permanently the first time one is picked. Each sim's own bridge only
 * knows how to wait for that one sim to come back, so without this a session
 * that closes LMU and opens iRacing instead would sit deaf to iRacing until
 * the whole app restarted.
 */
export async function publishAutoDetectedSdkEvents(
  overlayManager: OverlayManager,
  lifecycle?: SessionLifecycle,
  channelBus?: ChannelBus
): Promise<IrSdkSourceBridge> {
  let activeBridge: IrSdkSourceBridge | undefined;
  let detachActiveBridge: (() => void) | undefined;
  let shouldStop = false;
  let stopProbes: (() => void) | undefined;
  const telemetryCallbacks = new Set<(value: Telemetry) => void>();
  const sessionCallbacks = new Set<(value: Session) => void>();
  const runningStateCallbacks = new Set<(value: boolean) => void>();
  let lastRunningState: boolean | undefined;

  overlayManager.publishMessage('runningState', false);

  const detachAndStopActiveBridge = () => {
    detachActiveBridge?.();
    detachActiveBridge = undefined;
    activeBridge?.stop();
    activeBridge = undefined;
  };

  const attachBridge = (
    bridge: IrSdkSourceBridge,
    simulator: ActiveSimulator
  ) => {
    activeBridge = bridge;
    // Only a transition from running to not-running is a disconnect worth
    // reacting to -- the initial callback replay of a bridge that has not
    // connected yet must not immediately restart detection.
    let sawRunning = false;
    const subscriptions = [
      bridge.onTelemetry((value) =>
        telemetryCallbacks.forEach((callback) => callback(value))
      ),
      bridge.onSessionData((value) =>
        sessionCallbacks.forEach((callback) => callback(value))
      ),
      bridge.onRunningState((value) => {
        lastRunningState = value;
        runningStateCallbacks.forEach((callback) => callback(value));
        if (value) {
          sawRunning = true;
          return;
        }
        if (sawRunning && !shouldStop) {
          logger.info(
            `[autoDetectSdkBridge] ${simulator} disconnected; resuming detection`
          );
          detachAndStopActiveBridge();
          void runDetectionCycle();
        }
      }),
    ];
    detachActiveBridge = () =>
      subscriptions.forEach((unsubscribe) => unsubscribe?.());
  };

  const definitions = getSimDefinitions();

  /**
   * Probes every registered sim until one is running, then hands off to it.
   * Re-entered from attachBridge whenever the attached sim disconnects, so
   * a build with several sources keeps looking for whichever one is actually
   * running rather than freezing on the first pick.
   */
  const runDetectionCycle = async () => {
    // Per-definition rather than a bare Promise.all: one source whose native
    // module is missing or wedged should drop out of the running, not reject
    // the batch and end detection for every other simulator.
    const probes = (
      await Promise.all(
        definitions.map(async (definition) => {
          try {
            return { id: definition.id, probe: await definition.createProbe() };
          } catch (error) {
            logger.error(
              `[autoDetectSdkBridge] Failed to create ${definition.id} probe`,
              error
            );
            return undefined;
          }
        })
      )
    ).filter((entry) => entry !== undefined);
    if (shouldStop) return;

    stopProbes = () =>
      probes.forEach(({ id, probe }) => {
        try {
          probe.stop();
        } catch (error) {
          logger.error(
            `[autoDetectSdkBridge] Failed to stop ${id} probe`,
            error
          );
        }
      });

    const readProbe = ({ id, probe }: { id: string; probe: SimProbe }) => {
      try {
        probe.start();
        return probe.isActive();
      } catch (error) {
        // One unhappy source must not end detection for the others — a sim
        // whose native module is missing or wedged should look inactive, not
        // take the whole probe loop down.
        logger.error(`[autoDetectSdkBridge] ${id} probe failed`, error);
        return false;
      }
    };

    // Only known once the probe settles, so the settings window shows
    // nothing -- rather than a sim that has just disconnected -- while this
    // cycle looks for whatever runs next.
    const { setActiveSimulator } = await import('./setup');
    if (shouldStop) return;
    setActiveSimulator(overlayManager, undefined);

    let simulator: ReturnType<typeof selectDetectedSimulator>;
    let lastProbeState = '';
    while (!shouldStop && !simulator) {
      const results = probes.map((entry) => ({
        id: entry.id,
        active: readProbe(entry),
      }));
      const probeState = results
        .map(({ id, active }) => `${id}=${active ? 'active' : 'inactive'}`)
        .join(' ');
      if (probeState !== lastProbeState) {
        lastProbeState = probeState;
        logger.info(`[autoDetectSdkBridge] Probe ${probeState}`);
      }
      simulator = selectDetectedSimulator(results);
      if (!simulator)
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
    }

    stopProbes();
    stopProbes = undefined;
    if (shouldStop || !simulator) return;

    logger.info(
      `[autoDetectSdkBridge] Selected ${simulator} (${lastProbeState})`
    );

    const definition = definitions.find(({ id }) => id === simulator);
    if (!definition) return;

    // A newer setupBridge may have stopped this detector while it awaited the
    // import. Writing the simulator now would name a sim the newer setup has
    // already replaced, and rebuild every overlay for it.
    if (shouldStop) return;
    setActiveSimulator(overlayManager, simulator);

    const publishEvents = await definition.loadBridge();
    if (shouldStop) return;
    const bridge = await publishEvents(overlayManager, lifecycle, channelBus);
    if (shouldStop) {
      bridge.stop();
      return;
    }
    attachBridge(bridge, simulator);
  };

  void runDetectionCycle().catch((error) => {
    logger.error('[autoDetectSdkBridge] Failed to detect simulator', error);
    stopProbes?.();
  });

  return {
    onTelemetry: (callback) => {
      telemetryCallbacks.add(callback);
      return () => telemetryCallbacks.delete(callback);
    },
    onSessionData: (callback) => {
      sessionCallbacks.add(callback);
      return () => sessionCallbacks.delete(callback);
    },
    onRunningState: (callback) => {
      runningStateCallbacks.add(callback);
      if (lastRunningState !== undefined) callback(lastRunningState);
      return () => runningStateCallbacks.delete(callback);
    },
    stop: () => {
      shouldStop = true;
      stopProbes?.();
      detachAndStopActiveBridge();
      telemetryCallbacks.clear();
      sessionCallbacks.clear();
      runningStateCallbacks.clear();
    },
    changeCameraNumber: (...args) => activeBridge?.changeCameraNumber(...args),
    changeReplayPosition: (...args) =>
      activeBridge?.changeReplayPosition(...args),
    triggerReplaySessionSearch: (...args) =>
      activeBridge?.triggerReplaySessionSearch(...args),
  };
}
