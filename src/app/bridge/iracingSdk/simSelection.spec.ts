import { describe, expect, it } from 'vitest';
import {
  getSimulatorOverride,
  resolveSimulatorPreference,
  selectDetectedSimulator,
} from './simSelection';

describe('simulator selection', () => {
  it('honors CLI and environment overrides', () => {
    expect(getSimulatorOverride(['--sim=lmu'], 'iracing')).toBe('lmu');
    expect(getSimulatorOverride([], 'iracing')).toBe('iracing');
  });

  it('selects LMU when only its live connection is available', () => {
    expect(selectDetectedSimulator(false, true)).toBe('lmu');
  });

  it('prefers LMU when both simulators have active sessions', () => {
    expect(selectDetectedSimulator(true, true)).toBe('lmu');
    expect(selectDetectedSimulator(true, false)).toBe('iracing');
    expect(selectDetectedSimulator(false, false)).toBeUndefined();
  });

  it('pins the simulator the user chose in settings', () => {
    expect(resolveSimulatorPreference('lmu', undefined)).toBe('lmu');
    expect(resolveSimulatorPreference('iracing', undefined)).toBe('iracing');
  });

  it('leaves auto, and an unset preference, to runtime detection', () => {
    // undefined means "probe for it", which is what an existing install with no
    // simulator saved must keep doing.
    expect(resolveSimulatorPreference('auto', undefined)).toBeUndefined();
    expect(resolveSimulatorPreference(undefined, undefined)).toBeUndefined();
  });

  it('lets a CLI or environment override beat the stored preference', () => {
    // --sim= is the debugging escape hatch; forcing a sim there should not
    // require editing settings first.
    expect(resolveSimulatorPreference('iracing', 'lmu')).toBe('lmu');
    expect(resolveSimulatorPreference('auto', 'iracing')).toBe('iracing');
  });
});
