import type { Trader } from './economy';
import { ResourceType } from './types';
import type { Villager } from './villager';

/**
 * How many hands one industry can host, grown into by the trader's own
 * population — the concrete "growth unlocks more economic capacity" the
 * vision asks for. This used to be keyed on the trader's tier instead, which
 * sounded like the same idea but wasn't: tier is itself driven substantially
 * by *this industry's* wealth (see `development.ts`), so tier and capacity
 * fed each other — a couple of lucky workers could push a small population's
 * tier up, which unlocked capacity for more workers than that population
 * could plausibly spare, compounding into a several-worker industry running
 * a population handful. Population is the one number in that loop nothing
 * feeds back into, so it's the only safe thing to key capacity on.
 */
function industryCapacityFor(population: number): number {
  if (population >= 45) return 5;
  if (population >= 28) return 4;
  if (population >= 16) return 3;
  if (population >= 8) return 2;
  return 1;
}

export enum IndustryType {
  Sawmill = 'sawmill',
  Masonry = 'masonry',
  Smithy = 'smithy',
}

export interface IndustryRecipe {
  input: ResourceType;
  inputPerOutput: number;
  output: ResourceType;
  /** Seconds one worker needs to produce a single unit, before diminishing returns. */
  workSeconds: number;
}

/**
 * A small, deliberately simple processing chain: wood and stone become the
 * building materials a settlement actually wants, and iron becomes the one
 * good worth clearly more than the raw material it came from — the whole
 * point of a smithy being worth running at all.
 */
export const INDUSTRY_RECIPES: Record<IndustryType, IndustryRecipe> = {
  [IndustryType.Sawmill]: { input: ResourceType.Wood, inputPerOutput: 2, output: ResourceType.Planks, workSeconds: 6 },
  [IndustryType.Masonry]: { input: ResourceType.Stone, inputPerOutput: 2, output: ResourceType.StoneBlocks, workSeconds: 8 },
  [IndustryType.Smithy]: { input: ResourceType.Iron, inputPerOutput: 1, output: ResourceType.Tools, workSeconds: 10 },
};

/** Same shape as `ResourceNode`'s diminishing returns, kept consistent. */
const DIMINISHING_EXPONENT = 0.7;

/**
 * A processing facility living inside a trader, not on the map — no
 * position, no rendering, no levelling. Every trader gets one of each type
 * at construction (see `Village`/`Settlement`); an industry with no workers
 * is simply inert, which is what makes "activation" an emergent staffing
 * outcome — workers only get posted here when there's demand for the
 * output, input on hand, and spare labour (see `IndustrySystem`) — rather
 * than something the player builds.
 */
export class Industry {
  readonly type: IndustryType;
  readonly owner: Trader;
  readonly workers: Villager[] = [];
  incomingWorkers = 0;

  private productionTimer = 0;

  constructor(type: IndustryType, owner: Trader) {
    this.type = type;
    this.owner = owner;
  }

  get workerCapacity(): number {
    return industryCapacityFor(this.owner.population);
  }

  get recipe(): IndustryRecipe {
    return INDUSTRY_RECIPES[this.type];
  }

  /** The good this industry makes — lets it slot into the same worst-shortage priority sort a resource node uses. */
  get resource(): ResourceType {
    return this.recipe.output;
  }

  /** Units produced per second at the current headcount — same diminishing-returns shape as a resource node. */
  get productionRate(): number {
    if (this.workers.length === 0) return 0;
    // Clamped to 1: a shrunk trader's population can leave an industry
    // holding more workers than `workerCapacity` currently allows (nothing
    // evicts a working villager just because the owner's population later
    // fell — see `industryCapacityFor`'s comment), and letting that read as
    // *over*-full would hand a shrunken place a production bonus for being
    // overstaffed relative to its own current size.
    const fraction = Math.min(1, this.workers.length / this.workerCapacity);
    return (this.workerCapacity / this.recipe.workSeconds) * fraction ** DIMINISHING_EXPONENT;
  }

  /** Whether there's enough raw material on hand right now to actually run. */
  get hasInput(): boolean {
    return this.owner.storage[this.recipe.input] >= this.recipe.inputPerOutput;
  }

  /** Converts input to output straight in the owner's own storage; returns units made this tick. */
  produce(dt: number): number {
    if (this.workers.length === 0) return 0;

    const { input, inputPerOutput, output } = this.recipe;
    this.productionTimer += dt;
    const perUnit = 1 / this.productionRate;

    let produced = 0;
    while (this.productionTimer >= perUnit && this.owner.storage[input] >= inputPerOutput) {
      this.owner.storage[input] -= inputPerOutput;
      this.owner.storage[output] += 1;
      this.productionTimer -= perUnit;
      produced++;
    }
    // Out of raw material: don't let the timer bank up while starved, or a
    // sudden delivery would cause an unrealistic burst of "backlogged" output.
    if (!this.hasInput) this.productionTimer = 0;

    return produced;
  }
}
