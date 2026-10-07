/**
 * Le Mans Ultimate's track names, against the bundled Lovely Sim Racing ids.
 *
 * The corner widgets look their sections up in the Lovely dataset, which is
 * keyed by iRacing's lowercase slugs. LMU reports a full display name, so
 * nothing matched and the near-miss fallback answered with whatever shared a
 * word -- "WeatherTech Raceway Laguna Seca" resolved to "summit summit
 * raceway", and both widgets showed Summit Point's corners.
 *
 * A table rather than a cleverer matcher, because the two naming schemes are
 * unrelated: no amount of normalising turns "Circuit de la Sarthe" into
 * "lemans full". Every entry maps a name LMU publishes to a dataset entry that
 * carries real corner names and real start/end ranges.
 *
 * The same table also feeds tools/generate-lmu-track-maps.ts, which borrows
 * these names for the turn labels on its track maps. It lives here so the two
 * cannot disagree about which circuit is which.
 *
 * LMU layouts absent from this table have no corner data at all: Fuji,
 * Bahrain, Lusail and Paul Ricard are not in the Lovely dataset under any
 * spelling, so there is nothing to point them at. They show no corner names,
 * which is the honest answer rather than a wrong one.
 */
export const LMU_TRACK_DATA_IDS: Readonly<Record<string, string>> = {
  'Algarve International Circuit': 'algarve gp',
  'Autodromo Enzo e Dino Ferrari': 'imola gp',
  'Autodromo Nazionale Monza': 'monza full',
  'Autódromo José Carlos Pace': 'interlagos gp',
  'Circuit de Barcelona': 'barcelona gp',
  'Circuit de la Sarthe': 'lemans full',
  'Circuit de la Sarthe Mulsanne': 'lemans nochicane',
  'Circuit de Spa-Francorchamps': 'spa 2024 combined',
  'Circuit of the Americas': 'cota-gp',
  'Daytona International Speedway Road Course': 'daytona 2011 road',
  'Sebring International Raceway': 'sebring international',
  'Silverstone Grand Prix Circuit - WEC': 'silverstone 2019 gp',
  'WeatherTech Raceway Laguna Seca': 'lagunaseca',
};

/**
 * The dataset id for a track name, or undefined when there is no entry.
 *
 * Matched on the name as published, then case-insensitively, because the
 * accented names are the ones most likely to be transcribed differently by a
 * future build of the sim. No fuzzy matching: a wrong circuit's corner names
 * are worse than none, which is the whole reason this table exists.
 */
export const lmuTrackDataId = (
  trackName: string | undefined
): string | undefined => {
  if (!trackName) return undefined;
  const direct = LMU_TRACK_DATA_IDS[trackName];
  if (direct) return direct;

  const wanted = trackName.trim().toLowerCase();
  for (const [name, id] of Object.entries(LMU_TRACK_DATA_IDS)) {
    if (name.toLowerCase() === wanted) return id;
  }
  return undefined;
};
