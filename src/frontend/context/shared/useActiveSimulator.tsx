import { useEffect, useState } from 'react';
import { SIMULATOR_IDS, type ActiveSimulator } from '@irdashies/types';

/**
 * The simulator currently feeding telemetry, or null when none has been
 * detected yet. Seeded from the main process because the settings window is
 * usually opened long after the bridge picked one, so waiting for the next
 * change event would leave it blank for the whole session.
 */
export const useActiveSimulator = (): ActiveSimulator | null => {
  const [simulator, setSimulator] = useState<ActiveSimulator | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.dashboardBridge?.getActiveSimulator?.().then((value) => {
      if (!cancelled) setSimulator(value);
    });
    const unsubscribe = window.dashboardBridge?.onSimulatorChanged?.((value) =>
      setSimulator(value)
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return simulator;
};

/**
 * The simulators this build can actually read, as reported by the sim registry
 * in the main process.
 *
 * Every known simulator is still listed in the settings dropdown; the ones
 * missing from here are shown greyed out. Telling the user a sim exists but
 * this build cannot talk to it is more useful than silently omitting it, which
 * reads as the feature being gone.
 *
 * Falls back to every known id when the bridge does not answer, so an older
 * preload cannot grey out the whole dropdown.
 */
export const useAvailableSimulators = (): ActiveSimulator[] => {
  const [available, setAvailable] = useState<ActiveSimulator[]>(SIMULATOR_IDS);

  useEffect(() => {
    let cancelled = false;
    const request = window.dashboardBridge?.getAvailableSimulators?.();
    if (!request) return;
    void request.then((value) => {
      if (!cancelled && value) setAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
};
