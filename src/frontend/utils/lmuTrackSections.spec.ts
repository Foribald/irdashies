import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { LmuTrackMap } from '@irdashies/types';
import { lmuTrackSections } from './lmuTrackSections';

/**
 * Read at test time rather than imported.
 *
 * Frontend code cannot import from app/, and rightly so -- the production path
 * never touches this file, it receives the map over IPC as
 * SessionData.LmuTrackMap. The specs below want the real thing rather than a
 * hand-made fixture, and reading it here keeps one copy of the data without
 * putting an app/ import into a frontend module.
 */
const maps = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'src/app/lmu/lmu-track-maps.json'),
    'utf8'
  )
) as Record<string, LmuTrackMap>;

/**
 * Asserted against the bundled maps rather than a fixture.
 *
 * The whole point of this module is that it reads LMU's own data correctly, so
 * a hand-written fixture would only prove the arithmetic. These assertions are
 * checkable against the circuits themselves: the Corkscrew really is about
 * two thirds round Laguna Seca, and La Source really is the first corner at
 * Spa.
 */
const sectionsFor = (key: string, lengthM: number) =>
  lmuTrackSections(maps[key], key, lengthM).sections;

describe('lmuTrackSections', () => {
  it('names the corners of Laguna Seca where they actually are', () => {
    const sections = sectionsFor('WeatherTech Raceway Laguna Seca', 3602);
    const byName = (name: string) => sections.find((s) => s.name === name);

    expect(sections).toHaveLength(10);
    // Turn 1 just after the line, the Corkscrew about two thirds round.
    expect(byName('Turn 1')?.marker_pct).toBeCloseTo(0.063, 2);
    expect(byName('The Corkscrew')?.marker_pct).toBeCloseTo(0.691, 2);
    expect(byName('Andretti Hairpin')?.marker_pct).toBeCloseTo(0.137, 2);
    // The last corner is 11, which is how many the circuit has.
    expect(sections[sections.length - 1].name).toBe('Turn 11');
  });

  it('puts the corners in lap order', () => {
    const sections = sectionsFor('Circuit de Spa-Francorchamps', 7004);
    const markers = sections.map((s) => s.marker_pct ?? 0);

    expect(sections[0].name).toBe('La Source');
    expect(sections[1].name).toBe('Eau Rouge');
    expect(sections[sections.length - 1].name).toBe('Chicane');
    for (let i = 1; i < markers.length; i += 1) {
      expect(markers[i]).toBeGreaterThan(markers[i - 1]);
    }
  });

  it('merges the marker index into the corner it labels', () => {
    // LMU lists both at identical coordinates. Two sections on one corner
    // would put two labels on it.
    const sections = sectionsFor('WeatherTech Raceway Laguna Seca', 3602);
    const atHairpin = sections.filter(
      (s) => Math.abs((s.marker_pct ?? 0) - 0.137) < 0.001
    );

    expect(atHairpin).toHaveLength(1);
    expect(atHairpin[0].name).toBe('Andretti Hairpin');
  });

  it('numbers a corner from its own label, never from the marker index', () => {
    // The two disagree after the Corkscrew: LMU pairs index "8" with the label
    // "Turn 9". Taking the index would contradict the name on its face.
    const sections = sectionsFor('WeatherTech Raceway Laguna Seca', 3602);
    const turn9 = sections.find((s) => s.name === 'Turn 9');

    expect(turn9?.corner_number).toBe('T9');
    // A proper name carries no number, which is the Lovely mapper's rule too.
    expect(
      sections.find((s) => s.name === 'The Corkscrew')?.corner_number
    ).toBeUndefined();
  });

  it('keeps a corner to its own stretch of track', () => {
    // Tiling the lap by nearest corner would label the whole Mulsanne. Every
    // section stays within the reach either side of its apex.
    const sections = sectionsFor('Circuit de la Sarthe', 13626);

    for (const section of sections) {
      expect(section.length_pct).toBeLessThanOrEqual(2 * (110 / 13626) + 1e-9);
      expect(section.length_pct).toBeGreaterThan(0);
    }
  });

  it('scales the reach with the length of the circuit', () => {
    // 110 m is a bigger share of Laguna Seca than of Le Mans, and a fraction
    // that suited one would cover a third of a straight at the other.
    const short = sectionsFor('WeatherTech Raceway Laguna Seca', 3602);
    const long = sectionsFor('Circuit de la Sarthe', 13626);

    expect(short[0].length_pct).toBeGreaterThan(long[0].length_pct);
  });

  it('infers a type from the name', () => {
    const sections = sectionsFor('Circuit de Spa-Francorchamps', 7004);

    expect(sections.find((s) => s.name === 'Raidillon')?.type).toBe('sweeper');
    expect(sections.find((s) => s.name === 'Chicane')?.type).toBe('chicane');
  });

  it('returns nothing for a layout with no named turns', () => {
    // Fuji, Bahrain, Lusail and Paul Ricard ship an empty turn list. Blank is
    // the right answer; the bug this replaced was being confident and wrong.
    expect(sectionsFor('Fuji Speedway', 4563)).toEqual([]);
    expect(sectionsFor('Lusail International Circuit', 5419)).toEqual([]);
  });

  it('returns nothing when there is no map at all', () => {
    expect(lmuTrackSections(undefined).sections).toEqual([]);
    expect(lmuTrackSections(null).sections).toEqual([]);
    expect(lmuTrackSections({} as LmuTrackMap).sections).toEqual([]);
  });

  it('reports the track it was given', () => {
    const { info } = lmuTrackSections(
      maps['WeatherTech Raceway Laguna Seca'],
      'WeatherTech Raceway Laguna Seca',
      3602
    );

    expect(info?.name).toBe('WeatherTech Raceway Laguna Seca');
    expect(info?.length_m).toBe(3602);
    expect(info?.sectors).toEqual([]);
  });
});
