import type { WidgetRuntimeDefinition } from '../../widgetRuntime';

export default {
  id: 'tyrepanel',
  // TyrePanel calls useSessionVisibility, which needs session data to resolve
  // the session type. Without this the visibility setting only works when some
  // other widget on the same dashboard happens to request it.
  sessionData: true,
  channels: ['driver-controls.snapshot'],
  ratePreset: 'driverFocused',
} satisfies WidgetRuntimeDefinition;
