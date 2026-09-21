import type { ActiveSimulator } from './dashboardLayout';

/**
 * Which widgets cannot work under a given simulator, and what to tell the user.
 *
 * The live values come from `simWidgetSupport.json` in the app's user-data
 * folder, next to config.json — edit that file and restart to change them, no
 * rebuild needed. The defaults below seed it on first run and stand in if it is
 * missing or unreadable.
 *
 * Nothing here touches the user's own enabled/disabled choice. A widget listed
 * for the running sim is hidden and rendered as if it were switched off, and
 * its saved setting is left exactly as it was, so it comes back when the sim
 * changes or the widget gains support.
 */
export interface SimWidgetSupportConfig {
  /** Shown when hovering a disabled widget, and under its greyed-out toggle. */
  message: string;
  /**
   * Widget ids as used in WIDGET_MAP and in menuItems.ts (`widgetType`), not
   * display names.
   */
  disabledWidgets: Record<ActiveSimulator, string[]>;
}

/** Seeds the JSON on first run, and the fallback if it cannot be read. */
export const DEFAULT_SIM_WIDGET_SUPPORT: SimWidgetSupportConfig = {
  message: 'This widget is not compatible with the running sim',
  disabledWidgets: {
    iracing: [
      'accelerationtimer',
      'brakepressure',
      'cruiseodometer',
      'frictioncircle',
      'radar',
      'steeringmeter',
      'stinthistory',
      'suspensionposition',
      'trackclock',
      'tracknotes',
      'tyrepanel',
    ],
    lmu: ['blindspotmonitor'],
  },
};

/** Human-readable simulator names, for messages like "Not iRacing compatible". */
export const SIMULATOR_LABELS: Record<ActiveSimulator, string> = {
  iracing: 'iRacing',
  lmu: 'Le Mans Ultimate',
};

/**
 * Whether a widget is unavailable under the running sim.
 *
 * An unknown simulator — nothing detected yet, or demo mode — disables
 * nothing: with no sim to be incompatible with, hiding widgets would be
 * guessing.
 */
export const isWidgetDisabledForSim = (
  config: SimWidgetSupportConfig,
  widgetId: string | undefined,
  simulator: ActiveSimulator | null | undefined
): boolean =>
  !!widgetId &&
  !!simulator &&
  (config.disabledWidgets[simulator] ?? []).includes(widgetId);

/** The hover text for a disabled widget, or null when it is available. */
export const widgetDisabledMessage = (
  config: SimWidgetSupportConfig,
  widgetId: string | undefined,
  simulator: ActiveSimulator | null | undefined
): string | null =>
  isWidgetDisabledForSim(config, widgetId, simulator) ? config.message : null;

/** The label under a greyed-out toggle, e.g. "Not iRacing compatible". */
export const widgetIncompatibleLabel = (
  simulator: ActiveSimulator | null | undefined
): string | null =>
  simulator ? `Not ${SIMULATOR_LABELS[simulator]} compatible` : null;

/**
 * Repairs whatever was read from disk into a usable config, so a hand-edited
 * file cannot crash the app. Unknown keys are dropped, missing ones fall back
 * to the defaults, and non-string entries are ignored.
 */
export const normalizeSimWidgetSupport = (
  raw: unknown
): SimWidgetSupportConfig => {
  const source = (raw ?? {}) as Partial<SimWidgetSupportConfig>;
  const listFor = (simulator: ActiveSimulator): string[] => {
    const value = source.disabledWidgets?.[simulator];
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [...DEFAULT_SIM_WIDGET_SUPPORT.disabledWidgets[simulator]];
  };
  return {
    message:
      typeof source.message === 'string' && source.message.length > 0
        ? source.message
        : DEFAULT_SIM_WIDGET_SUPPORT.message,
    disabledWidgets: {
      iracing: listFor('iracing'),
      lmu: listFor('lmu'),
    },
  };
};
