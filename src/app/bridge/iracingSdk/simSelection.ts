import {
  isActiveSimulator,
  type ActiveSimulator,
  type SimulatorPreference,
} from '@irdashies/types';

/**
 * A `--sim=` argument or IRDASHIES_SIM, if it names a simulator.
 *
 * This wins over the stored setting: it is the debugging escape hatch, and a
 * developer forcing a sim on the command line should not have to edit their
 * settings to do it. It is not checked against the registry here — forcing a
 * simulator this build cannot read is a mistake worth surfacing as a failure
 * rather than silently ignoring.
 */
export function getSimulatorOverride(
  argv: string[],
  envValue: string | undefined
): ActiveSimulator | undefined {
  const value =
    argv.find((argument) => argument.startsWith('--sim='))?.slice(6) ??
    envValue;
  return isActiveSimulator(value) ? value : undefined;
}

/**
 * The simulator to open, or undefined to probe for one at runtime.
 *
 * A preference naming a simulator this build cannot read resolves to undefined
 * rather than failing: the source may have been removed since the setting was
 * saved, and falling back to detection leaves the app working instead of
 * leaving it with no telemetry at all.
 */
export function resolveSimulatorPreference(
  preference: SimulatorPreference | undefined,
  override: ActiveSimulator | undefined,
  available: ActiveSimulator[]
): ActiveSimulator | undefined {
  if (override) return override;
  if (!isActiveSimulator(preference)) return undefined;
  return available.includes(preference) ? preference : undefined;
}

/**
 * Which simulator `auto` should open, when that can be decided without
 * probing.
 *
 * With one simulator in the build there is nothing to detect, so it is chosen
 * outright — that keeps a single-sim build on exactly the path it used before
 * simulator selection existed, with no probe loop in front of the bridge.
 * With several, the answer depends on what is running and the caller has to
 * probe for it.
 */
export function resolveWithoutProbing(
  available: ActiveSimulator[]
): ActiveSimulator | undefined {
  return available.length === 1 ? available[0] : undefined;
}

/**
 * The running simulator among those probed, highest priority first.
 *
 * `probeResults` is expected in registry order, so the first hit wins.
 */
export function selectDetectedSimulator(
  probeResults: { id: ActiveSimulator; active: boolean }[]
): ActiveSimulator | undefined {
  return probeResults.find((result) => result.active)?.id;
}
