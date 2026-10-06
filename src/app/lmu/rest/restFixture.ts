/**
 * Recorded LMU REST payloads, trimmed to the keys the tasks read.
 *
 * Sibling of ../rawFixture.ts. Shapes follow TinyPedal's adapter, which is the
 * only documentation of these endpoints that exists; the keys and nesting are
 * what matters, not the exact values.
 */

/** GET /rest/strategy/pitstop-estimate */
export const pitstopEstimateFixture = () => ({
  total: 32.5,
  damage: 12.25,
  // Real payloads carry more; kept so a parser that over-reaches is noticed.
  tires: 8.4,
  fuel: 6.1,
});

/** GET /rest/garage/UIScreen/RepairAndRefuel, a fuel car with litres. */
export const repairAndRefuelFixture = () => ({
  wearables: {
    body: { aero: 0.12 },
    brakes: [0.9, 0.88, 0.95, 0.94],
    suspension: [1, 1, 0.97, 1],
  },
  pitMenu: {
    pitMenu: [
      { name: 'TIRES:', currentSetting: 0, settings: [{ text: 'No Change' }] },
      {
        name: 'FUEL:',
        currentSetting: 2,
        settings: [{ text: '+0 L' }, { text: '+10 L' }, { text: '+45 L' }],
      },
    ],
  },
  fuelInfo: { maxVirtualEnergy: 100 },
});

/** The same screen for an energy-limited car: the menu offers VE, not fuel. */
export const repairAndRefuelVirtualEnergyFixture = () => ({
  ...repairAndRefuelFixture(),
  pitMenu: {
    pitMenu: [
      { name: 'VIRTUAL ENERGY:', currentSetting: 78, settings: [] },
      {
        name: 'FUEL:',
        currentSetting: 1,
        settings: [{ text: '+0 L' }, { text: '+30 L' }],
      },
    ],
  },
});

/** GET /rest/sessions */
export const sessionsFixture = () => ({
  SESSSET_race_timescale: { currentValue: 6 },
  SESSSET_private_qual: { currentValue: 1 },
});

/** One forecast point, as LMU nests it. */
const node = (sky: number, temp: number, rainPercent: number) => ({
  WNV_SKY: { currentValue: sky },
  WNV_TEMPERATURE: { currentValue: temp },
  WNV_RAIN_CHANCE: { currentValue: rainPercent },
});

/** GET /rest/sessions/weather */
export const weatherFixture = () => ({
  PRACTICE: {
    START: node(1, 22, 0),
    NODE_25: node(1, 23, 10),
    NODE_50: node(2, 23, 25),
    NODE_75: node(3, 22, 60),
    FINISH: node(4, 21, 90),
  },
  QUALIFY: {
    START: node(1, 24, 5),
    NODE_25: node(1, 24, 5),
    NODE_50: node(1, 25, 5),
    NODE_75: node(1, 25, 10),
    FINISH: node(1, 24, 10),
  },
  RACE: {
    START: node(2, 20, 30),
    NODE_25: node(3, 19, 55),
    NODE_50: node(5, 18, 100),
    NODE_75: node(4, 18, 80),
    FINISH: node(2, 19, 40),
  },
});
