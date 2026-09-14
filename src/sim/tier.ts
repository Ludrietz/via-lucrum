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

/**
 * Development points at which each tier is reached. Tuning lives here.
 *
 * Denominated in *standing built fabric* now, not in accumulated comfort —
 * see `development.ts` and `construction.ts`. The numbers dropped by better
 * than an order of magnitude because they changed units: the old ones counted
 * seconds of being well-stocked, at up to a third of a point a second, and
 * these count material carried in and put up. A hundred is a place with every
 * house it can fill; the rungs above it are a place that has also built
 * workshops, and built them well.
 */
export const TIER_THRESHOLDS: ReadonlyArray<{ tier: Tier; threshold: number }> = [
  { tier: Tier.MajorCity, threshold: 190 },
  { tier: Tier.City, threshold: 110 },
  { tier: Tier.Town, threshold: 55 },
  { tier: Tier.Village, threshold: 20 },
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
 * How much ground a place *holds* — the size of its own presence on the map,
 * not its reach.
 *
 * This used to be `TIER_INFLUENCE`, and it decided which resource sites the
 * civilisation could see and use. That made expansion automatic: a place that
 * prospered climbed a tier, which widened its reach, which took in another
 * deposit, which made it prosper further, and the player was never asked
 * anything. Reach is now bought deliberately (see `expansion.ts` and
 * `territory.ts`) and this table only says how broadly a settlement sits on
 * the country it already holds — a city fills more of its valley than a
 * hamlet does.
 *
 * Much smaller numbers than the old reach, because it is answering a
 * different question: this is a town's skirts, not its horizon. Still
 * strictly increasing, which the old table embarrassingly wasn't — the first
 * promotion a place earned used to *shrink* it by a third.
 */
export const TIER_FOOTPRINT: Record<Tier, number> = {
  [Tier.Hamlet]: 430,
  [Tier.Village]: 540,
  [Tier.Town]: 660,
  [Tier.City]: 790,
  [Tier.MajorCity]: 920,
};

/** Drawn size on the map. */
export const TIER_RADIUS: Record<Tier, number> = {
  [Tier.Hamlet]: 15,
  [Tier.Village]: 19,
  [Tier.Town]: 24,
  [Tier.City]: 30,
  [Tier.MajorCity]: 36,
};
