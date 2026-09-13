import { emptyAmounts } from './economy';
import type { Vec2 } from './geometry';
import { Industry, IndustryType } from './industry';
import { EMPTY_HINTERLAND, LandParcel, settledSuitability, type GroundSurvey } from './landUse';
import { Tier, TIER_FOOTPRINT, tierFor } from './tier';

/**
 * The first place. It is built the same way everything else on the map is:
 * a population that rises and falls with how well it is fed, and a tier read
 * off how well it has kept itself in wood and stone — see `development.ts`.
 * It owns none of its own population — that lives in `World`'s one shared
 * roster, same as every settlement's — so there is nothing here a place that
 * grew up on its own doesn't also have.
 */
export class Village {
  readonly name: string;
  readonly position: Vec2;
  readonly radius = 32;

  readonly storage = emptyAmounts();
  /** Goods already dispatched here but not yet arrived. */
  readonly incoming = emptyAmounts();
  /** Surplus already promised to somewhere else, so it isn't offered twice. */
  readonly outgoing = emptyAmounts();
  /** Rolling record of what has been arriving, per resource. */
  readonly throughput = emptyAmounts();
  /** What tier is read off — see `development.ts`. Starts at zero, a Hamlet, same as anywhere else. */
  development = 0;
  /** Synced once a tick by `World` from the shared roster — see `World.populationAt`. */
  population = 0;
  /** Running total, earned from industry output and selling surplus — see `economy.ts`'s wealth functions. */
  wealth = 0;
  /** Decaying accumulator behind `wealthIncomePerMin` — the same trick `throughput` uses. */
  wealthIncome = 0;
  /** Cumulative wood put toward housing — see `housing.ts` for what this actually unlocks. */
  housingInvestment = 0;
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

  constructor(name: string, x: number, y: number) {
    this.name = name;
    this.position = { x, y };
    this.ground = new LandParcel({
      key: 'village',
      kind: 'settled',
      origin: this.position,
      suitabilityOf: settledSuitability,
    });
  }

  get tier(): Tier {
    return tierFor(this.development, this.population);
  }

  /** How much ground this place sits on — its presence, not its reach. See `tier.ts`. */
  get footprintRadius(): number {
    return TIER_FOOTPRINT[this.tier];
  }
}
