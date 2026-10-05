import { describe, expect, it } from 'vitest';
import { WIDGET_MAP } from '../frontend/WidgetIndex';
import { widgetItems } from '../frontend/components/Settings/menuItems';
import { SIMULATOR_IDS } from './simulators';
import {
  DEFAULT_SIM_WIDGET_SUPPORT,
  isWidgetDisabledForSim,
  normalizeSimWidgetSupport,
  widgetDisabledMessage,
  widgetIncompatibleLabel,
  type SimWidgetSupportConfig,
} from './simWidgetSupport';

/**
 * A config that actually disables something.
 *
 * The shipped defaults disable nothing for any simulator, so they cannot
 * demonstrate the lookup -- these specs are about the function, not about
 * which widgets happen to be listed today.
 */
const configured: SimWidgetSupportConfig = {
  message: DEFAULT_SIM_WIDGET_SUPPORT.message,
  disabledWidgets: { iracing: [], lmu: ['blindspotmonitor'] },
};

const config = DEFAULT_SIM_WIDGET_SUPPORT;

const allDefaultIds = SIMULATOR_IDS.flatMap(
  (simulator) => config.disabledWidgets[simulator]
);

describe('per-simulator widget support', () => {
  it('names only widgets that actually exist', () => {
    // A typo here would silently disable nothing at all, which is the one
    // failure mode of a hand-maintained list of ids. This is also what stops
    // the defaults naming a widget that only exists on another branch.
    const known = new Set(Object.keys(WIDGET_MAP));
    expect(allDefaultIds.filter((id) => !known.has(id))).toEqual([]);
  });

  it('names only widgets the settings menu can grey out', () => {
    const inMenu = new Set(
      widgetItems.map((item) => item.widgetType).filter(Boolean)
    );
    expect(allDefaultIds.filter((id) => !inMenu.has(id))).toEqual([]);
  });

  it('covers every known simulator', () => {
    // A sim id with no entry would throw on lookup rather than simply
    // disabling nothing.
    SIMULATOR_IDS.forEach((simulator) => {
      expect(Array.isArray(config.disabledWidgets[simulator])).toBe(true);
    });
  });

  it('disables a widget only under the sim that lists it', () => {
    expect(isWidgetDisabledForSim(configured, 'blindspotmonitor', 'lmu')).toBe(
      true
    );
    expect(
      isWidgetDisabledForSim(configured, 'blindspotmonitor', 'iracing')
    ).toBe(false);
    expect(isWidgetDisabledForSim(configured, 'standings', 'lmu')).toBe(false);
    expect(isWidgetDisabledForSim(configured, 'standings', 'iracing')).toBe(
      false
    );
  });

  it('ships with nothing disabled for either simulator', () => {
    // The blind spot monitor was listed for LMU while its data was thought
    // unavailable. It works, so nothing is hidden by default any more.
    SIMULATOR_IDS.forEach((simulator) => {
      expect(config.disabledWidgets[simulator]).toEqual([]);
    });
  });

  it('disables nothing while no simulator is known', () => {
    // Nothing detected yet, or demo mode. Hiding widgets would be guessing at
    // which sim the user is about to run.
    expect(isWidgetDisabledForSim(config, 'blindspotmonitor', null)).toBe(
      false
    );
    expect(isWidgetDisabledForSim(config, 'blindspotmonitor', undefined)).toBe(
      false
    );
    expect(widgetDisabledMessage(config, 'blindspotmonitor', null)).toBeNull();
  });

  it('gives a message only for a widget that is actually disabled', () => {
    expect(widgetDisabledMessage(configured, 'blindspotmonitor', 'lmu')).toBe(
      configured.message
    );
    expect(widgetDisabledMessage(configured, 'standings', 'lmu')).toBeNull();
  });

  it('names the sim in the toggle label', () => {
    expect(widgetIncompatibleLabel('iracing')).toBe('Not iRacing compatible');
    expect(widgetIncompatibleLabel('lmu')).toBe(
      'Not Le Mans Ultimate compatible'
    );
    expect(widgetIncompatibleLabel(null)).toBeNull();
  });

  it('uses whatever the file says, not the defaults', () => {
    // The point of the JSON: an edited file changes behaviour without a
    // rebuild, including for widgets the defaults never mention.
    const edited = normalizeSimWidgetSupport({
      message: 'Nope',
      disabledWidgets: { iracing: ['standings'], lmu: [] },
    });
    expect(isWidgetDisabledForSim(edited, 'standings', 'iracing')).toBe(true);
    expect(isWidgetDisabledForSim(edited, 'blindspotmonitor', 'lmu')).toBe(
      false
    );
    expect(widgetDisabledMessage(edited, 'standings', 'iracing')).toBe('Nope');
  });

  it('repairs a hand-edited file rather than crashing on it', () => {
    // Someone editing JSON by hand will eventually delete a key or leave a
    // stray value; none of that may take the app down.
    expect(normalizeSimWidgetSupport(undefined)).toEqual(
      DEFAULT_SIM_WIDGET_SUPPORT
    );
    expect(normalizeSimWidgetSupport({}).disabledWidgets.lmu).toEqual(
      DEFAULT_SIM_WIDGET_SUPPORT.disabledWidgets.lmu
    );

    const partial = normalizeSimWidgetSupport({
      disabledWidgets: { iracing: ['standings', 42, null] },
    });
    // Missing sim falls back to defaults; non-strings are dropped.
    expect(partial.disabledWidgets.iracing).toEqual(['standings']);
    expect(partial.disabledWidgets.lmu).toEqual(
      DEFAULT_SIM_WIDGET_SUPPORT.disabledWidgets.lmu
    );
    expect(partial.message).toBe(DEFAULT_SIM_WIDGET_SUPPORT.message);

    // An empty list is a deliberate "disable nothing", not a missing key.
    expect(
      normalizeSimWidgetSupport({ disabledWidgets: { iracing: [], lmu: [] } })
        .disabledWidgets.lmu
    ).toEqual([]);
  });
});
