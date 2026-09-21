import { useEffect, useState } from 'react';
import type { ActiveSimulator } from '@irdashies/types';

const SIMULATOR_NAMES: Record<ActiveSimulator, string> = {
  iracing: 'iRacing',
  lmu: 'Le Mans Ultimate',
};

export const simulatorDisplayName = (
  simulator: ActiveSimulator | null
): string | null => (simulator ? SIMULATOR_NAMES[simulator] : null);

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
