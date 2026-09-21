import { describe, expect, it } from 'vitest';
import { WIDGET_MAP } from '../frontend/WidgetIndex';
import { widgetItems } from '../frontend/components/Settings/menuItems';
import {
  DEFAULT_SIM_WIDGET_SUPPORT,
  isWidgetDisabledForSim,
  normalizeSimWidgetSupport,
  widgetDisabledMessage,
  widgetIncompatibleLabel,
} from './simWidgetSupport';

const config = DEFAULT_SIM_WIDGET_SUPPORT;

describe('per-simulator widget support', () => {
  it('names only widgets that actually exist', () => {
    // A typo here would silently disable nothing at all, which is the one
    // failure mode of a hand-maintained list of ids.
    const known = new Set(Object.keys(WIDGET_MAP));
    const unknown = [
      ...config.disabledWidgets.iracing,
      ...config.disabledWidgets.lmu,
    ].filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('names only widgets the settings menu can grey out', () => {
    const inMenu = new Set(
      widgetItems.map((item) => item.widgetType).filter(Boolean)
    );
    const missing = [
      ...config.disabledWidgets.iracing,
      ...config.disabledWidgets.lmu,
    ].filter((id) => !inMenu.has(id));
    expect(missing).toEqual([]);
  });

  it('disables a widget only under the sim that lists it', () => {
    expect(isWidgetDisabledForSim(config, 'radar', 'iracing')).toBe(true);
    expect(isWidgetDisabledForSim(config, 'radar', 'lmu')).toBe(false);
    expect(isWidgetDisabledForSim(config, 'blindspotmonitor', 'lmu')).toBe(
      true
    );
    expect(isWidgetDisabledForSim(config, 'blindspotmonitor', 'iracing')).toBe(
      false
    );
    expect(isWidgetDisabledForSim(config, 'standings', 'iracing')).toBe(false);
  });

  it('disables nothing while no simulator is known', () => {
    // Nothing detected yet, or demo mode. Hiding widgets would be guessing at
    // which sim the user is about to run.
    expect(isWidgetDisabledForSim(config, 'radar', null)).toBe(false);
    expect(isWidgetDisabledForSim(config, 'radar', undefined)).toBe(false);
    expect(widgetDisabledMessage(config, 'radar', null)).toBeNull();
  });

  it('gives a message only for a widget that is actually disabled', () => {
    expect(widgetDisabledMessage(config, 'radar', 'iracing')).toBe(
      config.message
    );
    expect(widgetDisabledMessage(config, 'standings', 'iracing')).toBeNull();
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
    expect(isWidgetDisabledForSim(edited, 'radar', 'iracing')).toBe(false);
    expect(widgetDisabledMessage(edited, 'standings', 'iracing')).toBe('Nope');
  });

  it('repairs a hand-edited file rather than crashing on it', () => {
    // Someone editing JSON by hand will eventually delete a key or leave a
    // stray value; none of that may take the app down.
    expect(normalizeSimWidgetSupport(undefined)).toEqual(
      DEFAULT_SIM_WIDGET_SUPPORT
    );
    expect(normalizeSimWidgetSupport({}).disabledWidgets.iracing).toEqual(
      DEFAULT_SIM_WIDGET_SUPPORT.disabledWidgets.iracing
    );

    const partial = normalizeSimWidgetSupport({
      disabledWidgets: { lmu: ['radar', 42, null] },
    });
    // Missing sim falls back to defaults; non-strings are dropped.
    expect(partial.disabledWidgets.lmu).toEqual(['radar']);
    expect(partial.disabledWidgets.iracing).toEqual(
      DEFAULT_SIM_WIDGET_SUPPORT.disabledWidgets.iracing
    );
    expect(partial.message).toBe(DEFAULT_SIM_WIDGET_SUPPORT.message);

    // An empty list is a deliberate "disable nothing", not a missing key.
    expect(
      normalizeSimWidgetSupport({ disabledWidgets: { iracing: [], lmu: [] } })
        .disabledWidgets.iracing
    ).toEqual([]);
  });
});
