import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SIM_WIDGET_SUPPORT,
  normalizeSimWidgetSupport,
  type SimWidgetSupportConfig,
} from '@irdashies/types';
import logger from '../logger';

/**
 * Its own file rather than a key in config.json: this is a list a user is
 * expected to open and edit by hand, and config.json is machine-written on
 * every settings change.
 */
const FILENAME = 'simWidgetSupport.json';

const filePath = () => path.join(app.getPath('userData'), FILENAME);

let cached: SimWidgetSupportConfig | undefined;

/**
 * Reads the list, seeding the file with defaults the first time.
 *
 * Cached after the first read: it is consulted on every window build and on
 * every settings render, and a hand-edited file is only meant to be picked up
 * on restart.
 */
export const getSimWidgetSupport = (): SimWidgetSupportConfig => {
  if (cached) return cached;

  const target = filePath();
  try {
    if (fs.existsSync(target)) {
      cached = normalizeSimWidgetSupport(
        JSON.parse(fs.readFileSync(target, 'utf8'))
      );
      return cached;
    }
  } catch (error) {
    // A malformed file must not take the app down; fall back to the defaults
    // and say so, because the user's edit is silently not in effect.
    logger.error(`[simWidgetSupport] Failed to read ${FILENAME}`, error);
    cached = { ...DEFAULT_SIM_WIDGET_SUPPORT };
    return cached;
  }

  cached = { ...DEFAULT_SIM_WIDGET_SUPPORT };
  try {
    fs.writeFileSync(target, JSON.stringify(cached, null, 2));
    logger.info(`[simWidgetSupport] Created ${FILENAME} with defaults`);
  } catch (error) {
    logger.error(`[simWidgetSupport] Failed to create ${FILENAME}`, error);
  }
  return cached;
};

/** Drops the cache so the next read picks the file up again. Tests only. */
export const resetSimWidgetSupportCache = (): void => {
  cached = undefined;
};
