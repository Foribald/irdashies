/**
 * Placeholder shown in a delta-style cell (gap, interval, delta, lap time
 * deltas) when no value is available yet. Reserves the same character
 * width as a formatted value at the given decimal precision (e.g. "1.2" or
 * "12.34"), so the column doesn't shrink and shift the rest of the row
 * around as real values load in lap after lap - but renders as a single
 * centered dash padded with non-breaking spaces rather than a string of
 * dashes that reads like a fake number.
 */
export const buildDeltaPlaceholder = (decimalPlaces: number): string => {
  // Matches the length of "--.-" / "--.--" etc: two leading digits, the
  // decimal point, and `decimalPlaces` digits.
  const width = 2 + 1 + decimalPlaces;
  const leftPad = Math.floor((width - 1) / 2);
  const rightPad = width - 1 - leftPad;
  return `${' '.repeat(leftPad)}-${' '.repeat(rightPad)}`;
};
