import { OverlayManager } from '../../overlayManager';
import { TelemetryPerfMetrics } from '../../perfMetrics';
import { getPerfRunConfig } from '../../perfRunConfig';
import {
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
  mapLmuCarLeftRight,
  mapLmuTelemetry,
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
 * would need a native capture thread. Wasted polls are cheap because
 * `sdk.frameClock()` gates the work below.
 */
const TELEMETRY_POLL_INTERVAL = 8;

/**
 * How long the frame clock may stand still before a full read happens anyway.
 *
 * Skipping work while the clock is unchanged also skips the running-state
 * check, so a stalled clock (sim paused, or gone) must not be able to suppress
 * disconnect detection indefinitely.
 */
const FRAME_STALL_RECHECK_MS = 250;
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
    // The player's telemetry clock for the frame last delivered. mElapsedTime
    // advances once per published physics frame, which SME_UPDATE_TELEMETRY was
    // measured not to do. Compared with !== rather than >, so a clock that
    // resets when the session restarts still counts as new.
    let lastFrameClock: number | undefined;
    let lastFullReadTime = Number.NEGATIVE_INFINITY;

    while (!shouldStop) {
      const pollStartedAt = performance.now();
      const shouldPollSession =
        pollStartedAt - lastSessionPollTime >= SESSION_POLL_INTERVAL;

      // Polling faster than the sim publishes means most polls carry nothing.
      // frameClock() is an 8-byte read off the mapped block, where read() copies
      // 325 KB and builds a JS object of roughly forty per-car arrays, so
      // checking first is what makes the higher poll rate affordable. A negative
      // clock means there is no player car and nothing to compare, so read on.
      const liveClock = sdk.frameClock();
      const clockStalled =
        liveClock >= 0 &&
        lastFrameClock !== undefined &&
        liveClock === lastFrameClock;
      if (
        clockStalled &&
        !shouldPollSession &&
        pollStartedAt - lastFullReadTime < FRAME_STALL_RECHECK_MS
      ) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(
              0,
              TELEMETRY_POLL_INTERVAL - (performance.now() - pollStartedAt)
            )
          )
        );
        continue;
      }
      // Reached only when a full read is about to happen, so this also paces the
      // stalled-clock recheck: read now, then skip for up to FRAME_STALL_RECHECK_MS
      // rather than reading on every poll for as long as the sim stays paused.
      lastFullReadTime = pollStartedAt;

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
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
        if (shouldStop) break;
        sdk.start();
        continue;
      }

      if (raw.trackName !== activeTrackName) {
        activeTrackName = raw.trackName;
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
      if (!trackMap) {
        const recordedMap = mapRecorder.update(raw);
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

      const blindSpotDataIssue =
        mapLmuCarLeftRight(raw) === null
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

      // Only deliver a frame the sim has actually published. The poll is a
      // fixed 16 ms that is not synchronised to LMU's writer, so without this
      // the same frame is mapped and broadcast more than once whenever the two
      // rates drift past each other — an object and an IPC hop to tell every
      // widget what it already knows, and a duplicate sample that makes the
      // trace plots hold still and then jump.
      //
      // Absent when there is no player car (spectating, garage), in which case
      // there is no clock to compare and every poll is delivered as before.
      const frameClock = raw.elapsedTime;
      const isNewTelemetryFrame =
        typeof frameClock !== 'number' ||
        !Number.isFinite(frameClock) ||
        frameClock !== lastFrameClock;
      lastFrameClock = typeof frameClock === 'number' ? frameClock : undefined;

      if (isNewTelemetryFrame) {
        perfMetrics.markStart('lifecycleTelemetry');
        const telemetry = mapLmuTelemetry(raw);
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
      }

      if (session) {
        latestSession = session;
        lifecycle?._onSession(session);
        processorHost?.onSession(session);
        overlayManager.publishMessage('sessionData', session);
        sessionCallbacks.forEach((callback) => callback(session));
      }

      perfMetrics.markEnd('processTelemetry');
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
