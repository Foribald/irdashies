import { describe, expect, it } from 'vitest';
import { at, finiteNumber, LMU_REST_TASKS } from './tasks';
import { createLmuRestData } from './state';
import { pitstopEstimateFixture } from './restFixture';

const taskById = (id: string) => {
  const task = LMU_REST_TASKS.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

/** Runs a task's outputs over a payload, as the poller does. */
const apply = (id: string, payload: unknown) => {
  const data = createLmuRestData();
  const applied: string[] = [];
  taskById(id).outputs.forEach((output) => {
    const value = output.parse(payload);
    if (value === undefined) return;
    output.apply(data, value);
    applied.push(output.id);
  });
  return { data, applied };
};

describe('at', () => {
  it('walks a key path', () => {
    expect(at({ a: { b: { c: 7 } } }, ['a', 'b', 'c'])).toBe(7);
  });

  it('gives up rather than throwing on a missing or non-object link', () => {
    expect(at({ a: 1 }, ['a', 'b'])).toBeUndefined();
    expect(at({}, ['a', 'b', 'c'])).toBeUndefined();
    expect(at(null, ['a'])).toBeUndefined();
    expect(at(undefined, ['a'])).toBeUndefined();
    expect(at('a string', ['length'])).toBeUndefined();
  });

  it('returns the payload itself for an empty path', () => {
    expect(at({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe('finiteNumber', () => {
  it('accepts only finite numbers', () => {
    expect(finiteNumber(0)).toBe(0);
    expect(finiteNumber(-1.5)).toBe(-1.5);
  });

  it('rejects everything else, including numeric strings', () => {
    // A numeric string would otherwise reach a telemetry cell typed number.
    [NaN, Infinity, -Infinity, '12', '', null, undefined, {}, [], true].forEach(
      (value) => expect(finiteNumber(value)).toBeUndefined()
    );
  });
});

describe('pitstop-estimate task', () => {
  it('reads the stop and repair estimates', () => {
    const { data, applied } = apply(
      'pitstop-estimate',
      pitstopEstimateFixture()
    );

    expect(data.cells.pitStopTime?.value[0]).toBe(32.5);
    expect(data.cells.repairTime?.value[0]).toBe(12.25);
    expect(applied).toEqual(['pitStopTime', 'repairTime']);
  });

  it('is a repeating task, since the estimate moves with damage', () => {
    expect(taskById('pitstop-estimate').mode).toBe('repeat');
  });

  it('writes nothing to the session, so it cannot force a republish', () => {
    // Everything here is on the ungated telemetry path by design -- a session
    // target would rebuild the whole snapshot on every poll.
    taskById('pitstop-estimate').outputs.forEach((output) =>
      expect(output.target).toBe('telemetry')
    );
  });

  it('applies nothing when the keys are missing', () => {
    const { data, applied } = apply('pitstop-estimate', {});

    expect(applied).toEqual([]);
    expect(data.cells.pitStopTime).toBeUndefined();
  });

  it('applies only what it recognises from a partial payload', () => {
    const { data, applied } = apply('pitstop-estimate', { total: 20 });

    expect(data.cells.pitStopTime?.value[0]).toBe(20);
    expect(data.cells.repairTime).toBeUndefined();
    expect(applied).toEqual(['pitStopTime']);
  });

  it('survives a wholesale garbage payload without throwing', () => {
    // LMU's shapes change between builds; a surprise must cost one missing
    // property, not a dead poller.
    [
      { error: 'nope' },
      null,
      undefined,
      'a string',
      42,
      [],
      { total: 'soon', damage: null },
      { total: { nested: 1 } },
    ].forEach((payload) => {
      expect(() => apply('pitstop-estimate', payload)).not.toThrow();
      expect(apply('pitstop-estimate', payload).applied).toEqual([]);
    });
  });
});

describe('LMU_REST_TASKS', () => {
  it('gives every task a distinct id and a sane interval', () => {
    const ids = LMU_REST_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    LMU_REST_TASKS.forEach((task) => {
      expect(task.baseIntervalMs).toBeGreaterThan(0);
      expect(task.path.startsWith('/rest/')).toBe(true);
      expect(task.outputs.length).toBeGreaterThan(0);
    });
  });

  it('gives every output a distinct id within its task', () => {
    LMU_REST_TASKS.forEach((task) => {
      const ids = task.outputs.map((output) => output.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
