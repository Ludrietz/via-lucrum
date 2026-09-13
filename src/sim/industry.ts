import { targetStock, type Trader } from './economy';
import { ResourceType } from './types';
import type { Villager } from './villager';

/**
 * How much of its own wanted stock a place has to be holding before an
 * industry may start eating into the rest — a miller works the surplus
 * grain, not the seed corn.
 *
 * This was 0.9, which reads as "just under a full larder" and is in fact
 * *above the ceiling storage can reach*. Deliveries are driven by
 * `shortage`, which stops calling for more the moment a shelf reaches
 * `targetStock`, and `consume` draws it back down continuously — so a place
 * doing perfectly well oscillates just under its target and never above it.
 * At 0.9 an industry needed `0.9 × target + inputPerOutput` on the shelf,
 * roughly a fifth more than the supply chain will ever deliver. Measured at
 * day 111 on seed 1234: every industry at all five places read `hasInput =
 * false`, including sawmills and masonries at places whose own shortage of
 * the input was exactly 0.00. It was not a strict gate, it was an
 * unreachable one, and an entire pillar of the design — raw goods becoming
 * more valuable worked goods — had therefore never run once, in any realm,
 * on any seed. Tools have never been made in this game; that is why every
 * playtest ever printed reports a tools shortage of 1.00 forever.
 *
 * The lesson is the one this project keeps relearning: a threshold's meaning
 * depends on the distribution it is compared against. Check what the
 * quantity actually settles at before picking a line across it. Storage
 * settles *at* target, so "genuine surplus" has to be a fraction of target
 * comfortably below 1, not a hair under it.
 */
const INDUSTRY_INPUT_LINE = 0.6;

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

  /**
   * Whether there is raw material genuinely *spare* to work — not merely
   * present.
   *
   * This used to read `>= inputPerOutput`, i.e. two units of wood, which
   * meant a sawmill ran the village's timber down to nothing and then kept
   * running on every delivery as it landed. The wood shortage that produced
   * never closed, so `shortage(wood)` sat pinned at 1.0 civilisation-wide
   * forever, which starved node investment (see `trade.ts` — investment is
   * outbid whenever a trader is short), which froze every deposit at level
   * one, which capped raw production at one worker per site, which meant the
   * only place left for labour to go was... more industry. Thirty of
   * forty-four people ended up milling nothing while eight connected
   * deposits sat unstaffed and every raw shelf read zero.
   *
   * A miller works the surplus grain, not the seed corn: an industry only
   * runs on input above what its own place wants to keep on hand. That one
   * change turns the industry from a drain that competes with the raw
   * economy into what it is supposed to be — the thing a place does once it
   * genuinely has more than it needs.
   */
  get hasInput(): boolean {
    const { input, inputPerOutput } = this.recipe;
    const spare = this.owner.storage[input] - targetStock(this.owner, input) * INDUSTRY_INPUT_LINE;
    return spare >= inputPerOutput;
  }

  /** Converts input to output straight in the owner's own storage; returns units made this tick. */
  produce(dt: number): number {
    if (this.workers.length === 0) return 0;

    const { input, inputPerOutput, output } = this.recipe;
    this.productionTimer += dt;
    const perUnit = 1 / this.productionRate;

    // The same line `hasInput` draws, applied per unit: an industry stops the
    // moment it would be eating into what its own place needs, rather than
    // running the shelf to zero the instant a delivery lands.
    const floor = targetStock(this.owner, input) * INDUSTRY_INPUT_LINE;

    let produced = 0;
    while (this.productionTimer >= perUnit && this.owner.storage[input] - floor >= inputPerOutput) {
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
