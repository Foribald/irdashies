import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSimulator, IrSdkSourceBridge } from '@irdashies/types';
import type { OverlayManager } from '../../overlayManager';
import type { SimDefinition } from './sims/types';

vi.mock('../../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const setup = vi.hoisted(() => ({ setActiveSimulator: vi.fn() }));
vi.mock('./setup', () => setup);

/**
 * A sim whose probe and bridge are both driven by hand: `probe.active` decides
 * what auto-detect sees while probing, and `emitRunningState` simulates the
 * attached bridge's own connect/disconnect events once selected.
 */
function fakeSim(id: ActiveSimulator, priority: number) {
  const probe = { active: false, stopped: false };
  let runningStateCallback: ((value: boolean) => void) | undefined;
  const bridge: IrSdkSourceBridge = {
    onTelemetry: () => () => undefined,
    onSessionData: () => () => undefined,
    onRunningState: (callback) => {
      runningStateCallback = callback;
      callback(true);
      return () => {
        runningStateCallback = undefined;
      };
    },
    stop: vi.fn(),
    changeCameraNumber: () => undefined,
    changeReplayPosition: () => undefined,
    triggerReplaySessionSearch: () => undefined,
  };
  const definition: SimDefinition = {
    id,
    priority,
    createProbe: async () => ({
      start: () => undefined,
      isActive: () => probe.active,
      stop: () => {
        probe.stopped = true;
      },
    }),
    loadBridge: async () => async () => bridge,
  };
  return {
    definition,
    probe,
    bridge,
    emitRunningState: (value: boolean) => runningStateCallback?.(value),
  };
}

const overlayManager = {
  publishMessage: vi.fn(),
} as unknown as OverlayManager;

describe('publishAutoDetectedSdkEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('selects the simulator that probes as active', async () => {
    const iracing = fakeSim('iracing', 100);
    const lmu = fakeSim('lmu', 90);
    iracing.probe.active = true;
    vi.doMock('./sims/registry', () => ({
      getSimDefinitions: () => [iracing.definition, lmu.definition],
    }));

    const { publishAutoDetectedSdkEvents } =
      await import('./autoDetectSdkBridge');
    await publishAutoDetectedSdkEvents(overlayManager);
    await vi.waitFor(() =>
      expect(setup.setActiveSimulator).toHaveBeenLastCalledWith(
        overlayManager,
        'iracing'
      )
    );
  });

  it('resumes detection and switches sims once the active one disconnects', async () => {
    const iracing = fakeSim('iracing', 100);
    const lmu = fakeSim('lmu', 90);
    lmu.probe.active = true;
    vi.doMock('./sims/registry', () => ({
      getSimDefinitions: () => [iracing.definition, lmu.definition],
    }));

    const { publishAutoDetectedSdkEvents } =
      await import('./autoDetectSdkBridge');
    const facade = await publishAutoDetectedSdkEvents(overlayManager);
    await vi.waitFor(() =>
      expect(setup.setActiveSimulator).toHaveBeenLastCalledWith(
        overlayManager,
        'lmu'
      )
    );

    const runningStates: boolean[] = [];
    facade.onRunningState((value) => runningStates.push(value));

    // LMU closes; iRacing has since started.
    lmu.probe.active = false;
    iracing.probe.active = true;
    lmu.emitRunningState(false);

    await vi.waitFor(() =>
      expect(setup.setActiveSimulator).toHaveBeenLastCalledWith(
        overlayManager,
        'iracing'
      )
    );
    expect(lmu.bridge.stop).toHaveBeenCalled();
    // Cleared before each cycle, then the sim that cycle settles on.
    expect(setup.setActiveSimulator.mock.calls).toEqual([
      [overlayManager, undefined],
      [overlayManager, 'lmu'],
      [overlayManager, undefined],
      [overlayManager, 'iracing'],
    ]);
    // The initial replay of the still-running lmu bridge, then its
    // disconnect, then the newly attached iracing bridge connecting.
    expect(runningStates).toEqual([true, false, true]);
  });

  it('does not restart detection on the bridge reporting inactive before it ever connects', async () => {
    const lmu = fakeSim('lmu', 90);
    lmu.probe.active = true;
    // Overrides onRunningState to replay `false` first, as a bridge that has
    // not connected yet would.
    lmu.bridge.onRunningState = (callback) => {
      callback(false);
      return () => undefined;
    };
    vi.doMock('./sims/registry', () => ({
      getSimDefinitions: () => [lmu.definition],
    }));

    const { publishAutoDetectedSdkEvents } =
      await import('./autoDetectSdkBridge');
    await publishAutoDetectedSdkEvents(overlayManager);
    await vi.waitFor(() =>
      expect(setup.setActiveSimulator).toHaveBeenLastCalledWith(
        overlayManager,
        'lmu'
      )
    );

    // A single cycle's worth of calls: cleared, then selected. No second
    // selection -- the bridge is left alone rather than being torn down and
    // re-probed for a disconnect that never happened.
    expect(setup.setActiveSimulator.mock.calls).toEqual([
      [overlayManager, undefined],
      [overlayManager, 'lmu'],
    ]);
  });
});
