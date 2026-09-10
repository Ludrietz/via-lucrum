/**
 * How big a place has become, read straight off its development — see
 * `development.ts`. The village and every settlement share this ladder;
 * nothing here treats the first place specially, so a later settlement can
 * climb straight past it, and a neglected one can just as easily fall back
 * down it.
 */
export enum Tier {
  Hamlet = 'hamlet',
  Village = 'village',
  Town = 'town',
  City = 'city',
  MajorCity = 'major_city',
}

export const TIER_LABELS: Record<Tier, string> = {
  [Tier.Hamlet]: 'HAMLET',
  [Tier.Village]: 'VILLAGE',
  [Tier.Town]: 'TOWN',
  [Tier.City]: 'CITY',
  [Tier.MajorCity]: 'MAJOR CITY',
};

/** Development points at which each tier is reached. Tuning lives here. */
export const TIER_THRESHOLDS: ReadonlyArray<{ tier: Tier; threshold: number }> = [
  { tier: Tier.MajorCity, threshold: 1800 },
  { tier: Tier.City, threshold: 700 },
  { tier: Tier.Town, threshold: 280 },
  { tier: Tier.Village, threshold: 80 },
  { tier: Tier.Hamlet, threshold: 0 },
];

/**
 * The population a tier's label has to be able to back up, independent of
 * development. `development.ts`'s comfort already leans on population, but
 * only through a low, flat floor (5) meant to keep a ghost town from ever
 * looking comfortable — it was never meant to be the only thing standing
 * between a seven-resident hamlet and "Major City", which is exactly what
 * happened once that hamlet inherited a couple of industry workers from a
 * wealthier past (see `industry.ts`). This is the same "whichever of two
 * ladders is behind" idiom `nodeLevel.ts` uses for a node's level (worked
 * enough vs invested enough): a place is only ever as high a tier as
 * *both* its earned development and its actual headcount support.
 */
export const TIER_POPULATION_THRESHOLDS: ReadonlyArray<{ tier: Tier; population: number }> = [
  { tier: Tier.MajorCity, population: 50 },
  { tier: Tier.City, population: 32 },
  { tier: Tier.Town, population: 18 },
  { tier: Tier.Village, population: 8 },
  { tier: Tier.Hamlet, population: 0 },
];

export function tierFor(development: number, population: number): Tier {
  const earned = TIER_THRESHOLDS.find((step) => development >= step.threshold)?.tier ?? Tier.Hamlet;
  const peopled = TIER_POPULATION_THRESHOLDS.find((step) => population >= step.population)?.tier ?? Tier.Hamlet;
  return tierIndex(earned) <= tierIndex(peopled) ? earned : peopled;
}

/** Ascending order, for telling a promotion from a demotion. */
export const TIER_ORDER: readonly Tier[] = [Tier.Hamlet, Tier.Village, Tier.Town, Tier.City, Tier.MajorCity];

export function tierIndex(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * How far a place's reach extends, before roads add anything to it — and
 * therefore how much country it reveals and keeps generated around itself
 * (see `World.influenceCentres`).
 *
 * Strictly increasing, which it embarrassingly wasn't: Hamlet had been
 * bumped to 960 as a one-off fix for a slow opening while Village sat at
 * 660, so the *first* promotion a place ever earned made its reach shrink
 * by a third. Nothing broke loudly — revealed nodes stay revealed — but it
 * quietly inverted the core loop this ladder exists for, where growing is
 * what lets you reach further. The opening is still generous (a hamlet can
 * see a decent way) but every rung now genuinely opens more ground than
 * the one below it.
 */
export const TIER_INFLUENCE: Record<Tier, number> = {
  [Tier.Hamlet]: 900,
  [Tier.Village]: 1250,
  [Tier.Town]: 1650,
  [Tier.City]: 2100,
  [Tier.MajorCity]: 2600,
};

/** Drawn size on the map. */
export const TIER_RADIUS: Record<Tier, number> = {
  [Tier.Hamlet]: 15,
  [Tier.Village]: 19,
  [Tier.Town]: 24,
  [Tier.City]: 30,
  [Tier.MajorCity]: 36,
};
