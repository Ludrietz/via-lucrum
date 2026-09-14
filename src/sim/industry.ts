import { crewSkill } from './craft';
import { builtSlots } from './construction';
import { targetStock, WORKING_RESERVE, type Trader } from './economy';
import { ResourceType } from './types';
import type { Villager } from './villager';

export enum IndustryType {
  Sawmill = 'sawmill',
  Masonry = 'masonry',
  Smithy = 'smithy',
  Joinery = 'joinery',
  Bakery = 'bakery',
}

export interface RecipeInput {
  resource: ResourceType;
  per: number;
}

export interface IndustryRecipe {
  inputs: readonly RecipeInput[];
  output: ResourceType;
  /** Seconds one worker needs to produce a single unit, before diminishing returns. */
  workSeconds: number;
}

/**
 * The processing chain. Wood and stone become the building materials a
 * settlement actually wants; iron and fuel become tools; and sawn timber and
 * tools together become the finished joinery and ironwork that separates a
 * house from a shed.
 *
 * **Two of these need more than one thing, and that is the point.** With one
 * input apiece, a workshop asked only "does this place have a surplus of its
 * own raw good?" — and since every place keeps a buffer of every raw good,
 * the answer was yes nearly everywhere. Measured on seed 1234 at day 151:
 * twenty-one of thirty-three places ran two or more industries and twelve ran
 * all three. Nowhere specialised in anything, because nothing ever made
 * specialising necessary. A civilisation of identical little factories is not
 * a trade network; it is thirty-three autarkies sharing a map.
 *
 * A recipe that wants two goods can only run where both actually arrive, and
 * what decides that is the road network — which is the one thing in this game
 * the player draws. A smithy now wants charcoal as well as ore, so ironwork
 * happens where the ore country meets the timber country rather than wherever
 * an ore cart happened to stop. A joinery wants sawn plank *and* finished
 * tools, which means the two other chains both have to reach it: in practice
 * a hub, which is exactly the sort of place a city should be.
 */
export const INDUSTRY_RECIPES: Record<IndustryType, IndustryRecipe> = {
  [IndustryType.Sawmill]: {
    inputs: [{ resource: ResourceType.Wood, per: 2 }],
    output: ResourceType.Planks,
    workSeconds: 6,
  },
  [IndustryType.Masonry]: {
    inputs: [{ resource: ResourceType.Stone, per: 2 }],
    output: ResourceType.StoneBlocks,
    workSeconds: 8,
  },
  // Charcoal, without modelling charcoal. A forge burns several times its own
  // weight of fuel per unit of iron worked, and adding a burner as a fourth
  // good would have bought nothing the timber requirement does not already
  // buy — see the note at the top of this table about what multi-input
  // recipes are actually for.
  [IndustryType.Smithy]: {
    inputs: [
      { resource: ResourceType.Iron, per: 1 },
      { resource: ResourceType.Wood, per: 2 },
    ],
    output: ResourceType.Tools,
    workSeconds: 10,
  },
  [IndustryType.Joinery]: {
    inputs: [
      { resource: ResourceType.Planks, per: 2 },
      { resource: ResourceType.Tools, per: 1 },
    ],
    output: ResourceType.Fittings,
    workSeconds: 14,
  },
  /**
   * The food side of the same idea, and the answer to "what is a granary
   * full of grain actually *for*".
   *
   * A place with more farmland than it can eat had nowhere to put the
   * surplus: food is not a building material, so the only sink was the
   * population it already had, and the excess simply decayed off the shelf.
   * Baking gives grain the same treatment timber gets — two measures of grain
   * and the fuel to fire the oven make one of bread, and bread feeds three
   * (see `BREAD_NOURISHMENT`). So a bakery turns a farming county's surplus
   * into half again as much food as the grain was worth, and — because
   * nourishment travels in the loaf rather than the sack — into a third as
   * many cart-loads for the same number of people fed.
   *
   * Sited by the same two-sided rule as everything else, which is what makes
   * it land in both the places the design wants it: out among the farms, where
   * the grain is spare, and in a town, where grain from a dozen farms is
   * already being centralised and the fuel is already arriving.
   */
  [IndustryType.Bakery]: {
    inputs: [
      { resource: ResourceType.Food, per: 2 },
      { resource: ResourceType.Wood, per: 1 },
    ],
    output: ResourceType.Bread,
    workSeconds: 5,
  },
};

/** Same shape as `ResourceNode`'s diminishing returns, kept consistent. */
const DIMINISHING_EXPONENT = 0.7;

/**
 * A processing facility living inside a trader, not on the map — no
 * position, no rendering, no levelling. Every trader has one of each type as
 * a *possibility* (see `Village`/`Settlement`); until something is actually
 * built into it, it has no room for anyone and does not exist in any sense
 * the world can feel. Workers are then posted here only when there's demand
 * for the output, input on hand, and spare labour (see `IndustrySystem`) —
 * so both whether a workshop exists and whether it runs are consequences,
 * never things the player places.
 */
export class Industry {
  readonly type: IndustryType;
  readonly owner: Trader;
  readonly workers: Villager[] = [];
  incomingWorkers = 0;

  /**
   * Fabric built into this workshop — see `construction.ts`. This is the
   * whole of "how big is the sawmill", and it is bought with material
   * somebody carried here.
   *
   * It replaces a table keyed on the owner's population and how urban its
   * hinterland was. That table was the last place in the simulation where an
   * economic capacity was handed out by a *category* a place fell into rather
   * than by anything it had done, and it read exactly as arbitrary as it was:
   * a village of sixteen could host three sawyers and one of fifteen could
   * host two, on a map where nothing in the world looked any different either
   * side of the line. Worse, it answered the wrong question entirely. Whether
   * a place should be milling planks has nothing to do with how many people
   * live there and everything to do with whether there is timber going spare
   * and anyone wanting planks — which is precisely what `worksWant` now asks
   * before a single point of this gets laid.
   */
  built = 0;

  private productionTimer = 0;

  constructor(type: IndustryType, owner: Trader) {
    this.type = type;
    this.owner = owner;
  }

  get workerCapacity(): number {
    return builtSlots(this.built);
  }

  /** Whether this workshop exists at all yet — anything unbuilt is not a workplace. */
  get exists(): boolean {
    return this.workerCapacity > 0;
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
    // Clamped to 1: a workshop that has decayed below what its current crew
    // needs can be left holding more workers than `workerCapacity` allows
    // (nothing evicts a working villager just because the roof fell in on
    // half the shed), and letting that read as *over*-full would hand a
    // crumbling mill a production bonus for being overstaffed.
    const capacity = Math.max(1, this.workerCapacity);
    const fraction = Math.min(1, this.workers.length / capacity);
    return (capacity / this.recipe.workSeconds) * fraction ** DIMINISHING_EXPONENT * crewSkill(this.workers);
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
    return this.batchesAvailable() >= 1;
  }

  /**
   * How many units this workshop could make right now out of material
   * genuinely spare — the scarcest input decides, which is what makes a
   * two-input recipe a real question about where a place sits on the network
   * rather than about how rich it is.
   */
  private batchesAvailable(): number {
    let batches = Infinity;
    for (const { resource, per } of this.recipe.inputs) {
      const spare = this.owner.storage[resource] - targetStock(this.owner, resource) * WORKING_RESERVE;
      batches = Math.min(batches, spare / per);
    }
    return batches;
  }

  /** Converts input to output straight in the owner's own storage; returns units made this tick. */
  produce(dt: number): number {
    if (this.workers.length === 0) return 0;

    const { inputs, output } = this.recipe;
    this.productionTimer += dt;
    const perUnit = 1 / this.productionRate;

    let produced = 0;
    // The same line `hasInput` draws, applied per unit: an industry stops the
    // moment it would be eating into what its own place needs, rather than
    // running the shelf to zero the instant a delivery lands.
    while (this.productionTimer >= perUnit && this.batchesAvailable() >= 1) {
      for (const { resource, per } of inputs) this.owner.storage[resource] -= per;
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
