import { OverlayManager } from '../../overlayManager';
import { TelemetryPerfMetrics } from '../../perfMetrics';
import { getPerfRunConfig } from '../../perfRunConfig';
import {
  CarLeftRight,
  TELEMETRY_INSPECTOR_RATE_HZ,
  type IrSdkSourceBridge,
  type LmuTrackMap,
  type Session,
  type Telemetry,
} from '@irdashies/types';
import logger from '../../logger';
import type { SessionLifecycle } from '../../sessionLifecycle';
import type { ChannelBus } from '../channelBridge';
import { createDefaultProcessorHost } from '../../processors/processorRegistry';
import { mapLmuSession } from '../../irsdk/lmu/mapSession';
import { lmuSessionSignature } from '../../irsdk/lmu/sessionSignature';
import {
  createLmuMapperState,
  mapLmuTelemetry,
  resetLmuMapperState,
} from '../../irsdk/lmu/mapTelemetry';
import {
  findTinyPedalTrackMap,
  LmuTrackMapRecorder,
  LmuTrackMapStorage,
  tinyPedalTrackMapDirectories,
} from '../../irsdk/lmu/trackMap';
import { app } from 'electron';
import path from 'node:path';

/**
 * Poll cadence for the LMU shared-memory frame.
 *
 * LMU publishes telemetry at **100 Hz** (measured: 999 frames in 10 s, median
 * gap 9.92 ms) -- not the ~60 Hz this once assumed. The old 16 ms was close to
 * the worst value available on Windows: the timer tick is ~15.6 ms, so a 16 ms
 * request cannot be met by the next tick and waits for the second one. Measured
 * in the Electron main process, `setTimeout(16)` actually delivered a 30.7 ms
 * median -- 37 Hz against a 100 Hz writer, dropping ~60% of frames, which is
 * what made the trace plots jump.
 *
 * 8 ms rounds to a single tick (15.5 ms measured, 64 Hz). That is the ceiling
 * for a JS timer here; asking for 4 ms measured the same, and reaching 100 Hz
 * would need a native capture thread.
 *
 * Because the poll is slower than the writer, nearly every poll carries a new
 * frame — the measured duplicate rate is 0.3%. So there is no gate on delivery:
 * one would save almost nothing and can silence every consumer at once.
 */
const TELEMETRY_POLL_INTERVAL = 8;
// Session snapshots are rebuilt from shared memory on demand; 2 Hz is plenty
// for driver-grid changes and mirrors the iRacing bridge's session poll rate.
const SESSION_POLL_INTERVAL = 500;
// How often to re-check the shared-memory map's existence when LMU is closed.
const RETRY_INTERVAL = 1000;
const perfRunConfig = getPerfRunConfig();
const perfTelemetryDeliveryEnabled =
  !perfRunConfig.enabled || perfRunConfig.telemetryDelivery === 'on';

export async function publishIRacingSDKEvents(
  overlayManager: OverlayManager,
  lifecycle?: SessionLifecycle,
  channelBus?: ChannelBus
): Promise<IrSdkSourceBridge> {
  logger.info(
    '[lmuSdkBridge] Loading Le Mans Ultimate shared-memory bridge...'
  );
  const { NativeLmu } = await import('../../irsdk/native/lmu');
  const sdk = new NativeLmu();
  const mapRecorder = new LmuTrackMapRecorder();
  const mapStorage = new LmuTrackMapStorage(
    path.join(app.getPath('userData'), 'lmu-track-maps.json')
  );

  const perfMetrics = new TelemetryPerfMetrics(undefined, channelBus);
  perfMetrics.startReporting();
  const referenceLapStorage = channelBus
    ? await import('../../storage/referenceLaps')
    : undefined;
  const processorHost =
    channelBus && referenceLapStorage
      ? createDefaultProcessorHost({
          bus: channelBus,
          lifecycle,
          metrics: perfMetrics,
          aggregateReplay: false,
          logError: (message, error) => logger.error(message, error),
          referenceLapPersistence: {
            load: referenceLapStorage.getReferenceLap,
            save: referenceLapStorage.saveReferenceLap,
          },
        })
      : undefined;

  let shouldStop = false;
  let lastRunningState: boolean | undefined = undefined;
  let latestSession: Session | null = null;
  let lastSessionSignature: string | null = null;
  let activeTrackName = '';
  let trackMap: LmuTrackMap | null = null;
  let lastBlindSpotDataIssue: string | null | undefined;
  // State the mapper carries between frames: blind-spot hysteresis, so a car
  // running alongside stops flickering, and the lap-distance integrator that
  // lifts the player's position from LMU's 5 Hz scoring rate to the poll rate.
  const mapperState = createLmuMapperState();

  const telemetryCallbacks = new Set<(value: Telemetry) => void>();
  const sessionCallbacks = new Set<(value: Session) => void>();
  const runningStateCallbacks = new Set<(value: boolean) => void>();

  const publishRunningState = (isSimRunning: boolean) => {
    if (isSimRunning === lastRunningState) return;
    lastRunningState = isSimRunning;
    logger.info('[lmuSdkBridge] Sending running state to window', isSimRunning);
    overlayManager.publishMessage('runningState', isSimRunning);
    runningStateCallbacks.forEach((callback) => callback(isSimRunning));
  };

  overlayManager.onOverlayReady((id) => {
    if (lastRunningState !== undefined)
      overlayManager.publishMessageToOverlay(
        id,
        'runningState',
        lastRunningState
      );
    if (latestSession)
      overlayManager.publishMessageToOverlay(id, 'sessionData', latestSession);
  });

  // Try to connect to the shared-memory map immediately so the renderer isn't
  // left on a stale running state while LMU loads.
  sdk.start();
  const initialRunningState = sdk.isRunning();
  lastRunningState = initialRunningState;
  overlayManager.publishMessage('runningState', initialRunningState);

  (async () => {
    let lastInspectorTelemetryPublishTime = Number.NEGATIVE_INFINITY;
    let lastSessionPollTime = Number.NEGATIVE_INFINITY;
    let wasRunning = false;
    let consecutiveFailures = 0;

    while (!shouldStop) {
      const pollStartedAt = performance.now();
      try {
        const shouldPollSession =
          pollStartedAt - lastSessionPollTime >= SESSION_POLL_INTERVAL;

        perfMetrics.markStart('processTelemetry');
        perfMetrics.markStart(
          shouldPollSession ? 'sdkSessionRead' : 'sdkTelemetryRead'
        );
        const rawSession = shouldPollSession ? sdk.readSession() : null;
        const raw = rawSession ?? sdk.read();
        perfMetrics.markEnd(
          shouldPollSession ? 'sdkSessionRead' : 'sdkTelemetryRead'
        );
        if (!raw.running) {
          perfMetrics.markEnd('processTelemetry');
          if (wasRunning) {
            logger.info('[lmuSdkBridge] LMU no longer publishing telemetry');
            publishRunningState(false);
            latestSession = null;
            overlayManager.clearLatestSessionData?.();
            lifecycle?._onDisconnect();
            wasRunning = false;
            lastSessionSignature = null;
            resetLmuMapperState(mapperState);
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
          if (shouldStop) break;
          sdk.start();
          continue;
        }

        if (raw.trackName !== activeTrackName) {
          activeTrackName = raw.trackName;
          // Slots are keyed on mID and can be reused by a different car, and a
          // new track invalidates the lap-distance anchor.
          resetLmuMapperState(mapperState);
          trackMap = mapStorage.load(activeTrackName);
          if (!trackMap) {
            const imported = findTinyPedalTrackMap(
              activeTrackName,
              tinyPedalTrackMapDirectories()
            );
            if (imported) {
              trackMap = imported.map;
              try {
                mapStorage.save(activeTrackName, imported.map);
                logger.info(
                  `[lmuSdkBridge] Imported track map for ${activeTrackName} from ${imported.filePath}`
                );
              } catch (error) {
                logger.error(
                  '[lmuSdkBridge] Failed to save imported track map',
                  error
                );
              }
            }
          }
          mapRecorder.reset(activeTrackName);
          lastSessionSignature = null;
          logger.info(
            `[lmuSdkBridge] Track ${activeTrackName}; map ${trackMap ? 'loaded' : 'not found; recording starts at the next finish-line crossing'}`
          );
        }
        if (!wasRunning) {
          logger.info(
            `[lmuSdkBridge] LMU is running; version=${raw.gameVersion} session=${raw.session} phase=${raw.gamePhase} vehicles=${raw.numVehicles}/${raw.activeVehicles} player=${raw.playerVehicleIdx} trackLength=${raw.lapDist}`
          );
          wasRunning = true;
          publishRunningState(true);
          lifecycle?._onEnter({ replay: false });
        }

        const tickTime = performance.now();
        let session: Session | null = null;
        if (rawSession) {
          lastSessionPollTime = tickTime;
          const signature = lmuSessionSignature(rawSession);
          if (signature !== lastSessionSignature) {
            lastSessionSignature = signature;
            session = mapLmuSession(rawSession, trackMap);
            const playerIdx = rawSession.playerVehicleIdx;
            logger.info(
              `[lmuSdkBridge] Session snapshot track=${rawSession.trackName} session=${rawSession.session} phase=${rawSession.gamePhase} flags=${Array.from(rawSession.sectorFlags).join(',')} sector=${rawSession.vehSector[playerIdx] ?? -1} sectors=${rawSession.vehLastSector1[playerIdx] ?? -1},${rawSession.vehLastSector2[playerIdx] ?? -1},${rawSession.vehLastLapTime[playerIdx] ?? -1}`
            );
          }
        }

        // Every poll that gets here delivers a frame. Suppressing delivery for an
        // unchanged frame clock was tried and removed: the measured duplicate rate
        // is 0.3% (the poll is slower than the writer, so repeats are rare), and
        // every consumer that matters -- the lap-trace recorder, the blind-spot
        // monitor, the processors -- lives behind this call. A gate here buys
        // almost nothing and can silence all of them at once.
        perfMetrics.markStart('lifecycleTelemetry');
        const telemetry = mapLmuTelemetry(raw, mapperState);

        // Read off the built frame rather than deriving the geometry a third
        // time. CarLeftRight.Off means the geometry was unavailable, which is a
        // distinct value from Clear.
        const blindSpotDataIssue =
          telemetry.CarLeftRight?.value[0] === CarLeftRight.Off
            ? 'vehicle world positions or player orientation are unavailable'
            : raw.lapDist <= 0
              ? `track length is invalid (${raw.lapDist} m)`
              : null;
        if (blindSpotDataIssue !== lastBlindSpotDataIssue) {
          lastBlindSpotDataIssue = blindSpotDataIssue;
          if (blindSpotDataIssue) {
            logger.warn(
              `[lmuSdkBridge] Blind spot monitor unavailable: ${blindSpotDataIssue}`
            );
          } else {
            logger.info('[lmuSdkBridge] Blind spot monitor data available');
          }
        }

        if (!trackMap) {
          // Runs after the frame is built because it consumes the smoothed lap
          // fraction: LMU's own vehLapDistPct only moves at 5 Hz, and the
          // recorder rejects any sample that has not advanced, so it was
          // discarding almost every position it sampled. A map first recorded on
          // this frame is picked up on the next poll, which the signature reset
          // below already forces.
          const recordedMap = mapRecorder.update(
            raw,
            telemetry.LapDistPct?.value[0] as number | undefined
          );
          if (recordedMap) {
            try {
              mapStorage.save(activeTrackName, recordedMap);
              trackMap = recordedMap;
              lastSessionSignature = null;
              logger.info(
                `[lmuSdkBridge] Recorded track map for ${activeTrackName}`
              );
            } catch (error) {
              logger.error('[lmuSdkBridge] Failed to save track map', error);
            }
          }
        }

        lifecycle?._onTelemetry(telemetry);
        perfMetrics.markEnd('lifecycleTelemetry');
        processorHost?.onFrame(telemetry);

        if (
          perfTelemetryDeliveryEnabled &&
          overlayManager.hasTelemetryInspectorSubscribers() &&
          tickTime - lastInspectorTelemetryPublishTime >=
            1000 / TELEMETRY_INSPECTOR_RATE_HZ
        ) {
          lastInspectorTelemetryPublishTime = tickTime;
          overlayManager.publishMessage(
            'telemetryInspector:telemetry',
            telemetry
          );
        }
        telemetryCallbacks.forEach((callback) => callback(telemetry));
        perfMetrics.tick(telemetry);

        if (session) {
          latestSession = session;
          lifecycle?._onSession(session);
          processorHost?.onSession(session);
          overlayManager.publishMessage('sessionData', session);
          sessionCallbacks.forEach((callback) => callback(session));
        }

        perfMetrics.markEnd('processTelemetry');
        consecutiveFailures = 0;
      } catch (error) {
        // This loop is the only source of telemetry for every widget, and it
        // used to be an unguarded async IIFE: one throw ended it for the life of
        // the process, with no log and no failed state — the overlays simply
        // stopped updating while still reporting the sim as connected. A bad
        // frame, or a call into an addon build that predates the JS, must cost
        // one poll rather than the whole session.
        consecutiveFailures += 1;
        if (consecutiveFailures === 1 || consecutiveFailures % 100 === 0) {
          logger.error(
            `[lmuSdkBridge] Telemetry poll failed (${consecutiveFailures} in a row); continuing`,
            error
          );
        }
      }

      const remainingDelay = Math.max(
        0,
        TELEMETRY_POLL_INTERVAL - (performance.now() - pollStartedAt)
      );
      await new Promise((resolve) => setTimeout(resolve, remainingDelay));
    }
  })();

  return {
    onTelemetry: (callback: (value: Telemetry) => void) => {
      telemetryCallbacks.add(callback);
      return () => {
        telemetryCallbacks.delete(callback);
      };
    },
    onSessionData: (callback: (value: Session) => void) => {
      sessionCallbacks.add(callback);
      if (latestSession) callback(latestSession);
      return () => {
        sessionCallbacks.delete(callback);
      };
    },
    onRunningState: (callback: (value: boolean) => void) => {
      runningStateCallbacks.add(callback);
      if (lastRunningState !== undefined) callback(lastRunningState);
      return () => {
        runningStateCallbacks.delete(callback);
      };
    },
    stop: () => {
      shouldStop = true;
      overlayManager.clearLatestSessionData?.();
      sdk.stop();
      telemetryCallbacks.clear();
      sessionCallbacks.clear();
      runningStateCallbacks.clear();
      processorHost?.dispose();
      perfMetrics.stopReporting();
    },
    // LMU has no broadcast/replay API; camera/replay controls are no-ops.
    changeCameraNumber: () => undefined,
    changeReplayPosition: () => undefined,
    triggerReplaySessionSearch: () => undefined,
  };
}
