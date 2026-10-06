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
