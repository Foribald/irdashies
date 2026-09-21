import type { SimulatorPreference } from '@irdashies/types';

export type Simulator = 'iracing' | 'lmu';

export function getSimulatorOverride(
  argv: string[],
  envValue: string | undefined
): Simulator | undefined {
  const value =
    argv.find((argument) => argument.startsWith('--sim='))?.slice(6) ??
    envValue;
  return value === 'iracing' || value === 'lmu' ? value : undefined;
}

export function selectDetectedSimulator(
  iracingActive: boolean,
  lmuActive: boolean
): Simulator | undefined {
  if (lmuActive) return 'lmu';
  if (iracingActive) return 'iracing';
  return undefined;
}

/**
 * The simulator to open, or undefined to probe for one at runtime.
 *
 * A `--sim=` argument or IRDASHIES_SIM wins over the stored setting: it is the
 * debugging escape hatch, and a developer forcing a sim on the command line
 * should not have to edit their settings to do it.
 */
export function resolveSimulatorPreference(
  preference: SimulatorPreference | undefined,
  override: Simulator | undefined
): Simulator | undefined {
  if (override) return override;
  return preference === 'iracing' || preference === 'lmu'
    ? preference
    : undefined;
}
