import { describe, expect, it } from 'vitest';
import { at, finiteNumber, LMU_REST_TASKS } from './tasks';
import { createLmuRestData } from './state';
import {
  pitstopEstimateFixture,
  repairAndRefuelFixture,
  repairAndRefuelVirtualEnergyFixture,
} from './restFixture';

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

describe('repair-and-refuel task', () => {
  it('reads wear and damage from the wearables block', () => {
    const { data } = apply('repair-and-refuel', repairAndRefuelFixture());

    expect(data.cells.aeroDamage?.value[0]).toBe(0.12);
    // LF, RF, LR, RR -- LMU's order and this repo's are the same, so there is
    // no remapping here and nobody should add one.
    expect(data.cells.brakeWear?.value).toEqual([0.9, 0.88, 0.95, 0.94]);
    expect(data.cells.suspensionDamage?.value).toEqual([1, 1, 0.97, 1]);
  });

  it('reads a fuel target in litres and flags it as fuel', () => {
    const { data } = apply('repair-and-refuel', repairAndRefuelFixture());

    expect(data.cells.refuelTarget?.value[0]).toBe(45);
    expect(data.cells.refuelTargetIsVirtualEnergy?.value[0]).toBe(false);
  });

  it('converts a gallon target to litres', () => {
    const payload = repairAndRefuelFixture();
    payload.pitMenu.pitMenu[1].settings = [{ text: '+12.5 gal' }];
    payload.pitMenu.pitMenu[1].currentSetting = 0;

    const { data } = apply('repair-and-refuel', payload);

    // 12.5 US gallons at 3.7854118 L/gal.
    expect(data.cells.refuelTarget?.value[0]).toBeCloseTo(47.32, 2);
    expect(data.cells.refuelTargetIsVirtualEnergy?.value[0]).toBe(false);
  });

  it('reads a virtual-energy target as a percentage and flags it', () => {
    // An energy-limited car. The flag is the only thing distinguishing 78%
    // from 78 litres, so it has to travel with the number.
    const { data } = apply(
      'repair-and-refuel',
      repairAndRefuelVirtualEnergyFixture()
    );

    expect(data.cells.refuelTarget?.value[0]).toBe(78);
    expect(data.cells.refuelTargetIsVirtualEnergy?.value[0]).toBe(true);
  });

  it('prefers virtual energy when the menu offers both', () => {
    // The VE fixture also carries a FUEL entry; VE comes first and wins,
    // matching how the sim presents an energy-limited car.
    const { data } = apply(
      'repair-and-refuel',
      repairAndRefuelVirtualEnergyFixture()
    );

    expect(data.cells.refuelTargetIsVirtualEnergy?.value[0]).toBe(true);
  });

  it('sends maxVirtualEnergy to the session, not to telemetry', () => {
    // A per-car constant. On telemetry it would force a session rebuild on
    // every one of these 5 Hz polls.
    const { data } = apply('repair-and-refuel', repairAndRefuelFixture());

    expect(data.session.maxVirtualEnergy).toBe(100);
    const output = LMU_REST_TASKS.find(
      (task) => task.id === 'repair-and-refuel'
    )?.outputs.find((o) => o.id === 'maxVirtualEnergy');
    expect(output?.target).toBe('session');
  });

  it('rejects a corner array that is not exactly four long', () => {
    // Publishing three would leave a consumer indexing corner 3 with
    // undefined, which is worse than publishing nothing.
    const payload = repairAndRefuelFixture();
    payload.wearables.brakes = [0.9, 0.88, 0.95];

    const { data } = apply('repair-and-refuel', payload);

    expect(data.cells.brakeWear).toBeUndefined();
    expect(data.cells.suspensionDamage?.value).toHaveLength(4);
  });

  it('rejects a corner array holding a non-number', () => {
    const payload = repairAndRefuelFixture();
    payload.wearables.brakes = [0.9, 0.88, 0.95, null] as number[];

    expect(
      apply('repair-and-refuel', payload).data.cells.brakeWear
    ).toBeUndefined();
  });

  it('ignores a fuel entry whose text holds no number', () => {
    const payload = repairAndRefuelFixture();
    payload.pitMenu.pitMenu[1].settings = [{ text: 'No Change' }];
    payload.pitMenu.pitMenu[1].currentSetting = 0;

    const { data } = apply('repair-and-refuel', payload);

    expect(data.cells.refuelTarget).toBeUndefined();
  });

  it('ignores a fuel entry whose index is out of range', () => {
    const payload = repairAndRefuelFixture();
    payload.pitMenu.pitMenu[1].currentSetting = 99;

    const { data } = apply('repair-and-refuel', payload);

    expect(data.cells.refuelTarget).toBeUndefined();
  });

  it('survives a garbage payload without throwing', () => {
    [
      { error: 'nope' },
      null,
      'string',
      { pitMenu: 7 },
      { wearables: [] },
    ].forEach((payload) => {
      expect(() => apply('repair-and-refuel', payload)).not.toThrow();
    });
  });
});
