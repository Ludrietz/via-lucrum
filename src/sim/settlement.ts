import { emptyAmounts } from './economy';
import { dist, type Vec2 } from './geometry';
import { Industry, IndustryType } from './industry';
import { EMPTY_HINTERLAND, LandParcel, settledSuitability, type GroundSurvey } from './landUse';
import { Tier, TIER_FOOTPRINT, TIER_RADIUS, tierFor } from './tier';
import { ResourceType } from './types';

/**
 * How far along a place has come toward being founded at all. Nothing is
 * placed by the player; a spot on the network works its way up this ladder
 * and slides back down it if the traffic that made it interesting goes away.
 * Once founded, this stops mattering for how the place looks or behaves —
 * that is population's job now, via `tier.ts`. It sticks around purely to
 * decide *when* a candidate becomes a real settlement in the first place.
 */
export enum SettlementStage {
  /** A candidate the simulation is watching. Not drawn. */
  Site = 'site',
  /** A hut or two by the road. */
  Roadside = 'roadside',
  Hamlet = 'hamlet',
  Settlement = 'settlement',
}

/** Potential at which each stage is reached. Tuning lives here. */
export const STAGE_THRESHOLDS: ReadonlyArray<{ stage: SettlementStage; potential: number }> = [
  // A well-served spoke settles around 0.50-0.55, which comfortably makes a
  // hamlet but not a settlement: the last step needs the junction term, so a
  // place becomes a settlement by becoming a hub rather than merely a busy one.
  { stage: SettlementStage.Settlement, potential: 0.66 },
  { stage: SettlementStage.Hamlet, potential: 0.44 },
  { stage: SettlementStage.Roadside, potential: 0.28 },
];

export function stageFor(potential: number): SettlementStage {
  return (
    STAGE_THRESHOLDS.find((step) => potential >= step.potential)?.stage ?? SettlementStage.Site
  );
}

/**
 * What a place does for a living, taken from whatever has been moving through
 * it. Only raw goods exist today, but the shape is deliberately "a trade that
 * grew out of a good" so that milling, smelting and the rest can slot in later
 * without moving anything.
 */
export interface Trade {
  readonly key: string;
  readonly label: string;
  /** Names this trade draws on, in order of use. */
  readonly names: readonly string[];
}

export const TRADES: Record<string, Trade> = {
  wood: {
    key: 'wood',
    label: 'Timber',
    names: ['Timberton', 'Oakhurst', 'Sawmill Cross', 'Elmsgate', 'Bark Hollow'],
  },
  iron: {
    key: 'iron',
    label: 'Ironwork',
    names: ['Ironford', 'Forgeton', 'Slagmoor', 'Anvilrest', 'Cinderby'],
  },
  stone: {
    key: 'stone',
    label: 'Stonework',
    names: ['Marlstone', 'Chiselgate', 'Cairnwick', 'Flintbury', 'Gravelrun'],
  },
  food: {
    key: 'food',
    label: 'Grain',
    names: ['Grainham', 'Millbrook', 'Harvestly', 'Wheatfield', 'Barleywick'],
  },
  mixed: {
    key: 'mixed',
    label: 'Market',
    names: ['Crossroads', 'Waymeet', 'Tollbridge', 'Fivelanes', 'Marketstead'],
  },
};

/** The share one good must hold before a place is known for it. */
export const SPECIALISATION_SHARE = 0.55;

export function tradeFor(resource: ResourceType | null, share: number): Trade {
  if (!resource || share < SPECIALISATION_SHARE) return TRADES.mixed;
  return TRADES[resource] ?? TRADES.mixed;
}

/**
 * A place that grew on the network. Once founded it is a site in its own
 * right: roads can be drawn to it, routes pass through it, and it widens the
 * reach of the civilisation the same way the first village does.
 */
export class Settlement {
  readonly id: number;
  readonly position: Vec2;
  /** The patch of ground this grew out of. */
  readonly patch: number;
  readonly foundedHours: number;

  name: string;
  /** Still used to decide when a place is founded in the first place. */
  stage: SettlementStage;
  trade: Trade;
  /** 0..1, the same value the site was judged on; keeps moving after founding. */
  potential: number;
  /** Synced once a tick by `World` from the shared roster — see `World.populationAt`. */
  population = 0;
  /** What the traffic looked like when it first took hold. */
  readonly origin: { resource: ResourceType | null; share: number };

  /** Goods on the shelf, exactly like a village's. */
  readonly storage = emptyAmounts();
  /** Goods already dispatched here but not yet arrived. */
  readonly incoming = emptyAmounts();
  /** Surplus already promised to somewhere else, so it isn't offered twice. */
  readonly outgoing = emptyAmounts();
  /** Rolling record of what has been arriving, per resource. */
  readonly throughput = emptyAmounts();
  /** What tier is read off: standing built fabric — see `development.ts`. Founded as a Hamlet, same as anywhere else. */
  development = 0;
  /** Running total, earned from industry output and selling surplus — see `economy.ts`'s wealth functions. */
  wealth = 0;
  /** Decaying accumulator behind `wealthIncomePerMin` — the same trick `throughput` uses. */
  wealthIncome = 0;
  /** Fabric standing in houses — see `construction.ts`, and `housing.ts` for what it holds. */
  dwellings = 0;
  /** What the standing fabric was built out of, 0 (log and rubble) to 1 (plank and dressed stone). */
  fabricQuality = 0;
  /** How much building this place has in front of it, 0 to 1 — what its appetite for material is read off. */
  buildAppetite = 0;
  /** Net fabric laid per hour on the last pass — what the development trend is read off. */
  fabricRate = 0;
  /** One of each kind, present from the start; inert until staffed — see `industry.ts`. */
  readonly industries: Industry[] = Object.values(IndustryType).map((type) => new Industry(type, this));

  /** The ground this place is actually built over and farms from — see `landUse.ts`. */
  readonly ground: LandParcel;
  /** How urban this place has become, 0 to 1. Synced by `World`; see `landUse.ts`'s `urbanityFor`. */
  urbanity = 0;
  /**
   * How much of the ground it wants this place has actually got, 0 to 1.
   * Synced by `World` because the answer needs the terrain's cell size, and
   * `housing.ts` has to be able to ask it without reaching for the world.
   * Starts satisfied so nothing is held back before the land system has had
   * its first pass.
   */
  roomSatisfaction = 1;
  /**
   * What the country around this place looks like — how much is open and
   * settleable, how much is somebody's workings, how much could be built on
   * at all. Synced by `World`; `openness` is the other half of `urbanity`,
   * and the rest is what makes the answer legible rather than magic.
   */
  hinterland: GroundSurvey = EMPTY_HINTERLAND;

  constructor(params: {
    id: number;
    position: Vec2;
    patch: number;
    foundedHours: number;
    stage: SettlementStage;
    trade: Trade;
    potential: number;
    name: string;
    origin: { resource: ResourceType | null; share: number };
  }) {
    this.id = params.id;
    this.position = { ...params.position };
    this.patch = params.patch;
    this.foundedHours = params.foundedHours;
    this.stage = params.stage;
    this.trade = params.trade;
    this.potential = params.potential;
    this.name = params.name;
    this.origin = params.origin;
    this.ground = new LandParcel({
      key: `settlement:${params.id}`,
      kind: 'settled',
      origin: this.position,
      suitabilityOf: settledSuitability,
    });
  }

  /** How big this place has grown, read off what it has built and how many live there. */
  get tier(): Tier {
    return tierFor(this.development, this.population);
  }

  /** Drawn size, and the hit target for drawing roads to it. */
  get radius(): number {
    return TIER_RADIUS[this.tier];
  }

  /** How much ground this place sits on — its presence, not its reach. See `tier.ts`. */
  get footprintRadius(): number {
    return TIER_FOOTPRINT[this.tier];
  }

  ageInDays(nowHours: number): number {
    return Math.max(0, Math.floor((nowHours - this.foundedHours) / 24));
  }

  distanceTo(point: Vec2): number {
    return dist(this.position, point);
  }
}
