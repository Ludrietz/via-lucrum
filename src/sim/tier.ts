/**
 * How big a place has become, read straight off its population. The village
 * and every settlement share this ladder — nothing here treats the first
 * place specially, so a later settlement can climb straight past it.
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

/** Population at which each tier is reached. Tuning lives here. */
export const TIER_THRESHOLDS: ReadonlyArray<{ tier: Tier; population: number }> = [
  { tier: Tier.MajorCity, population: 100 },
  { tier: Tier.City, population: 40 },
  { tier: Tier.Town, population: 15 },
  { tier: Tier.Village, population: 5 },
  { tier: Tier.Hamlet, population: 0 },
];

export function tierFor(population: number): Tier {
  return TIER_THRESHOLDS.find((step) => population >= step.population)?.tier ?? Tier.Hamlet;
}

/** Ascending order, for telling a promotion from a demotion. */
export const TIER_ORDER: readonly Tier[] = [Tier.Hamlet, Tier.Village, Tier.Town, Tier.City, Tier.MajorCity];

export function tierIndex(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * How far a place's reach extends, before roads add anything to it. Hamlet
 * has to be generous: it is what a brand-new founding sees on population 1,
 * and the map's home-basin nodes are placed on the assumption that the
 * starting reach is at least this big.
 */
export const TIER_INFLUENCE: Record<Tier, number> = {
  [Tier.Hamlet]: 480,
  [Tier.Village]: 660,
  [Tier.Town]: 800,
  [Tier.City]: 950,
  [Tier.MajorCity]: 1150,
};

/** How many hands one workplace can host, once a place is big enough to spare them. */
export const TIER_WORKERS_PER_NODE: Record<Tier, number> = {
  [Tier.Hamlet]: 1,
  [Tier.Village]: 1,
  [Tier.Town]: 2,
  [Tier.City]: 2,
  [Tier.MajorCity]: 3,
};

/** Drawn size on the map. */
export const TIER_RADIUS: Record<Tier, number> = {
  [Tier.Hamlet]: 15,
  [Tier.Village]: 19,
  [Tier.Town]: 24,
  [Tier.City]: 30,
  [Tier.MajorCity]: 36,
};
