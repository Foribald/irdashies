import type { LmuRestData } from './state';

/**
 * What to fetch from LMU's REST API, and how to read it.
 *
 * Every piece of knowledge about LMU's JSON shapes lives in this file, and
 * nothing in it does IO or owns a timer -- which is what makes the shapes
 * testable against recorded payloads with no server and no sim. The structure
 * mirrors TinyPedal's RestAPITask/ResOutput, since that is the only
 * documentation of these endpoints that exists.
 *
 * Hard rule: **a parser never throws.** It returns undefined for anything it
 * does not recognise, and the caller keeps the previous value. LMU's payloads
 * change between builds, and a surprise there must cost one missing property,
 * not a dead poller.
 */

/** Where a value lands, which decides whether it forces a session republish. */
export type LmuRestTarget = 'telemetry' | 'session';

export interface LmuRestOutput {
  /** Identifies the value for logging and for the apply step. */
  readonly id: string;
  readonly target: LmuRestTarget;
  /** Returns undefined to leave the current value alone. */
  readonly parse: (payload: unknown) => unknown;
  /** Writes a parsed value into the data object. */
  readonly apply: (data: LmuRestData, value: unknown) => void;
}

export interface LmuRestTask {
  readonly id: string;
  readonly path: string;
  /**
   * `once` runs a single time per activation -- session settings and the
   * forecast cannot change mid-session. `repeat` polls, backing off while the
   * response is unchanged.
   */
  readonly mode: 'once' | 'repeat';
  readonly baseIntervalMs: number;
  readonly outputs: readonly LmuRestOutput[];
}

/** Walks a key path, giving up rather than throwing on anything unexpected. */
export const at = (payload: unknown, keys: readonly string[]): unknown => {
  let current = payload;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

/** A finite number, or undefined. Rejects NaN, Infinity, and numeric strings. */
export const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const cell = <T>(value: T): { readonly value: readonly T[] } => ({
  value: [value],
});

/** Reads a plain number at a key path and lands it in a telemetry cell. */
const numberCell = (
  id: string,
  keys: readonly string[],
  set: (data: LmuRestData, value: { readonly value: readonly number[] }) => void
): LmuRestOutput => ({
  id,
  target: 'telemetry',
  parse: (payload) => finiteNumber(at(payload, keys)),
  apply: (data, value) => set(data, cell(value as number)),
});

export const LMU_REST_TASKS: readonly LmuRestTask[] = [
  {
    id: 'pitstop-estimate',
    path: '/rest/strategy/pitstop-estimate',
    mode: 'repeat',
    // A second is plenty: the estimate only moves when damage or the pit menu
    // changes, and the backoff takes it further out while it is static.
    baseIntervalMs: 1000,
    outputs: [
      numberCell('pitStopTime', ['total'], (data, value) => {
        data.cells.pitStopTime = value;
      }),
      numberCell('repairTime', ['damage'], (data, value) => {
        data.cells.repairTime = value;
      }),
    ],
  },
];
