import { ResourceNode } from './resourceNode';
import type { Route } from './roadNetwork';
import type { Settlement } from './settlement';
import { TRACKED_GOODS, WEAR_FULL, type TrafficField } from './traffic';
import { ResourceType } from './types';
import type { Village } from './village';

/**
 * Anywhere goods can be delivered to and consumed. A village and a settlement
 * are the same thing here on purpose: nothing about how demand is measured
 * favours whichever one happens to be the first.
 */
export type Trader = Village | Settlement;

/** Anywhere a shipment can originate: a producer, or a trader with surplus to spare. */
export type TradeSource = ResourceNode | Trader;

/** Anywhere a shipment can end: a trader wanting stock, or a node wanting investment. */
export type Destination = Trader | ResourceNode;

/**
 * How many measures of grain one loaf is worth at table.
 *
 * Two grain and the fuel to fire the oven make one loaf, and the loaf feeds
 * three — so baking returns half again as much eating as the grain went in
 * with. Exactly the shape the timber chain already has (two wood make a plank
 * worth three wood of building), and deliberately so: this is the answer to
 * "what is a granary full of grain for", and the answer has to be the same
 * kind of answer as "what is a wood full of timber for".
 *
 * It buys a second thing, which for a game about roads may matter more. Grain
 * is *bulky*: feeding a town of sixty in grain is three times the cart-loads
 * of feeding it in bread. A realm that bakes near its farms and ships loaves
 * spends a third of the hauling on the same number of people fed, and gets
 * those hands back for something else.
 */
export const BREAD_NOURISHMENT = 3;

/**
 * What one resident gets through in a minute. **The** per-capita number:
 * demand, the stock a place wants to keep, how many people a food supply can
 * feed, and what actually comes off the shelf are all read from this one
 * table, so they cannot disagree.
 *
 * They used to. There were two tables — this one, and a separate
 * `CONSUMPTION_PER_CAPITA` at roughly double these rates — and the second
 * was switched off for raw goods because at that inflated rate it drained
 * faster than production could keep up. Switching it off is what produced
 * the single worst economic bug in the game: raw food was never taken off a
 * shelf by anything, so the moment a trader's larder filled to its target,
 * `shortage(food)` read zero *permanently*. Food then never scored as
 * something worth shipping, the trade system quietly stopped carrying it
 * altogether in favour of iron and stone, and population — which reads the
 * delivery *rate*, not the shelf — starved beside a full granary that
 * nothing was ever going to empty. Measured over 150 days, the civilisation
 * sat at 44 people against a sustainable 30 with every larder comfortably
 * "stocked".
 *
 * People eat. Making that literally true is what puts food back in the trade
 * system's sights and keeps the shelf and the flow telling the same story.
 */
export const DEMAND_PER_CAPITA_PER_MIN: Record<ResourceType, number> = {
  [ResourceType.Food]: 0.5,
  // Firewood, and only firewood — see `SUBSISTENCE` below for why this is no
  // longer also the timber a place builds with, and why it dropped when that
  // half moved out.
  [ResourceType.Wood]: 0.2,
  [ResourceType.Iron]: 0.1,
  [ResourceType.Stone]: 0.1,
  // Close to parity with the raw goods on purpose: a settlement's need for
  // planks and tools has to keep growing with its population the same way
  // its need for wood and food does, or a growing population always wins
  // the same priority race against industries (see `WorkforceSystem.post`,
  // which weighs every opening by demand) — industries would satisfy their
  // one small target once and then never be worth staffing again, and
  // wealth income (which depends on them) would crater as population grew,
  // not scale with it.
  [ResourceType.Planks]: 0.25,
  [ResourceType.StoneBlocks]: 0.25,
  [ResourceType.Tools]: 0.12,
  // Dearer per head than either plain building material, because a place
  // only ever wants a little of it and every unit is worth ten of rough
  // timber on the wall — see `construction.ts`'s MATERIALS.
  [ResourceType.Fittings]: 0.1,
  // In loaves, not in grain: one loaf is three measures' worth of eating
  // (see `BREAD_NOURISHMENT`), so a place that wants four minutes of food on
  // hand wants a third as many loaves as it would sacks.
  [ResourceType.Bread]: 0.5 / BREAD_NOURISHMENT,
};

/** The same figure per second, which is the rate `consume` actually applies. */
export const CONSUMPTION_PER_CAPITA: Record<ResourceType, number> = Object.fromEntries(
  Object.entries(DEMAND_PER_CAPITA_PER_MIN).map(([resource, perMin]) => [resource, perMin / 60]),
) as Record<ResourceType, number>;

/**
 * What people genuinely get through simply by being alive: they eat, and they
 * burn firewood. Nothing else on the table is metabolised.
 *
 * Everything else — stone, iron, and every worked good — is drawn by
 * `construction.ts` instead, when and only when something is actually being
 * built out of it. This is the single change that made a processing economy
 * possible at all, and the diagnosis is worth keeping because it was invisible
 * for a long time behind a system that looked correct.
 *
 * Every raw good used to be a per-capita metabolic sink, at a rate scaling
 * with population, while the stock a place *wants* on hand (`targetStock`)
 * scales with population too. So a place's shelf converged to its buffer and
 * stayed there, by construction, forever — and an industry may only work
 * material above `WORKING_RESERVE` of that same buffer. Measured on seed 1234
 * at day 61 with a hundred residents: one plank existed in the entire realm,
 * no blocks, no tools, and the tools shortage had read 1.00 without
 * interruption since the first tick. The industry gates were not too strict;
 * there was structurally never anything spare to put through them, because
 * the population ate the whole supply of every raw good no matter how large
 * the supply got.
 *
 * A villager chewing on a block of limestone was never believable anyway. Now
 * stone piles up at a place with a quarry and no work for it, which is
 * exactly the condition under which someone should start dressing it.
 */
export const SUBSISTENCE: readonly ResourceType[] = [ResourceType.Food, ResourceType.Wood, ResourceType.Bread];


/**
 * Goods a place wants because it is *building* something — see
 * `construction.ts`. Wood appears on both lists, and honestly: a village
 * burns it and builds with it, and the two appetites are genuinely different
 * things that happen to want the same stuff.
 *
 * What a place on this list wants scales with how much building it actually
 * has in front of it, not with its headcount alone. That is the difference
 * between a market and a warehouse. With a flat per-capita target, the
 * largest place in the realm wanted the largest stack of planks *because it
 * was largest* — so a finished capital sat on ninety-six planks it had no
 * use for, below its own export line and therefore invisible to trade, while
 * five hamlets that were actually trying to build held none and could not
 * outbid it. Measured on seed 1234, day 61, the first run after industries
 * started working at all.
 *
 * Tying the target to the appetite makes the same pile read as what it is:
 * surplus, at a place that has finished building, worth carrying to somebody
 * who hasn't. Nothing had to be added to the trade system — it was already
 * asking the right question, it was just being told the wrong answer.
 */
export const CONSTRUCTION_GOODS: readonly ResourceType[] = [
  ResourceType.Wood,
  ResourceType.Stone,
  ResourceType.Planks,
  ResourceType.StoneBlocks,
  ResourceType.Tools,
  ResourceType.Fittings,
  // Nobody builds a wall out of iron. It is here because everything it is
  // *for* is on this list: iron becomes tools, and tools are consumed by
  // building and make the building go faster. A place that has stopped
  // building has no more use for iron than for the tools it would become.
  //
  // Leaving it off was quietly fatal to the entire smithy chain, in a way
  // worth recording because the mechanism is not obvious. On the flat
  // per-capita reading a place of seventy wanted twenty-eight iron on the
  // shelf, and a smithy may only work what is spare above `WORKING_RESERVE`
  // of that — seventeen. The realm's two iron deposits could not deliver
  // seventeen units to one place, so the surplus was never reached, so no
  // smithy was ever built, so no tool was ever made, anywhere, on any seed.
  // Scaled by appetite the same target falls to the `MIN_TARGET_STOCK` floor
  // of eight — and eight iron on a shelf *is* three spare, which is a smithy.
  // The floor is doing real work here: it is what lets a chain bootstrap at
  // all, since a place with no smithy has no appetite that would ever call
  // for the iron that would justify one.
  ResourceType.Iron,
];

/**
 * The share of its own wanted stock a place keeps back for its own living —
 * the line between "we have this" and "we have this to spare".
 *
 * One number, shared by the two claims that may only ever eat surplus: an
 * industry working raw material (`industry.ts`) and a place building with it
 * (`construction.ts`). They have to agree, or the looser of the two silently
 * decides the stricter one's behaviour.
 *
 * It has to sit comfortably below 1, because storage settles *at* target and
 * never above it: deliveries stop being called for the moment a shelf reaches
 * `targetStock`, so a threshold at 0.9 — which reads as "just under a full
 * larder" — is in fact above anything the supply chain will ever deliver. At
 * 0.9 every industry in the game read `hasInput = false` forever, including
 * sawmills at places whose own wood shortage was exactly 0.00. The lesson is
 * one this project keeps relearning: a threshold's meaning depends on the
 * distribution it is compared against.
 */
export const WORKING_RESERVE = 0.6;

/** Goods an industry makes rather than the ground — kept for the places that treat them differently. */
export const PROCESSED_GOODS: readonly ResourceType[] = [
  ResourceType.Planks,
  ResourceType.StoneBlocks,
  ResourceType.Tools,
  ResourceType.Fittings,
  ResourceType.Bread,
];

/**
 * What one unit of a good is worth, before scarcity has any say — this is
 * what turns "goods moved" into "wealth earned" (see `recordWealth` and its
 * call sites). Processed goods are worth clearly more than the raw material
 * that went into them: the whole point of running an industry is that the
 * labour adds value, and tools especially so — a smithy is meant to be the
 * most profitable thing a settlement can run.
 */
export const BASE_VALUE: Record<ResourceType, number> = {
  [ResourceType.Wood]: 1,
  [ResourceType.Stone]: 1,
  [ResourceType.Food]: 1,
  [ResourceType.Iron]: 2,
  // Milling and dressing were marked up only a quarter over the raw material
  // — 2.5 against two units of wood worth 1 apiece — and that was set at a
  // time when no sawmill in the game had ever run, so nothing ever tested it.
  // Once wealth became a margin rather than the output's whole price (see
  // `world.ts`), a quarter's markup meant a four-man sawmill earned about a
  // third of a unit an hour: an industry that occupied real people and moved
  // real goods and was, in wealth terms, indistinguishable from nothing. A
  // sawn board really was worth several times the log it came out of, and
  // more to the point the vision asks industry to be a *source* of wealth
  // rather than a rounding error on one.
  [ResourceType.Planks]: 3.5,
  [ResourceType.StoneBlocks]: 3.5,
  [ResourceType.Tools]: 9,
  // Two planks and a tool go in (sixteen), and what comes out is worth more
  // than the sum: that margin is the reason a joiner exists, and a joinery is
  // the hardest shop in the game to site — it needs two finished chains to
  // both reach the same place.
  [ResourceType.Fittings]: 20,
  // Two grain and the fuel to bake them (three) become one loaf worth four:
  // a modest margin, because the real return on baking is not coin, it is
  // that the loaf feeds three and travels as one.
  [ResourceType.Bread]: 4,
};

/** How far a shipment's road is allowed to matter, in resistance units. */
const REFERENCE_RESISTANCE = 700;

/**
 * The target stock a place holds is measured in minutes of its own demand,
 * not a flat per-head number — a bigger, hungrier place naturally wants a
 * bigger buffer. This is also what makes trade decisions look ahead rather
 * than react to a bare storage count: point 10 of the trade brief.
 */
const TARGET_BUFFER_MINUTES = 4;
/**
 * A floor under that buffer so a place just founded isn't trivially "full"
 * after a single delivery. Without this, a population-1 settlement's target
 * is met by the very first wagonload, shortage drops to zero, and it never
 * looks hungry enough to win another trip — so it never receives the
 * throughput that would let its population actually grow. The floor keeps a
 * young place a real destination for a while, long enough for growth to
 * take hold and the formula above to overtake it on its own.
 */
const MIN_TARGET_STOCK = 8;
/**
 * The hysteresis band. Nothing imports above `IMPORT_LINE` of target and
 * nothing exports below `EXPORT_LINE`; the gap between them is neutral
 * ground a place just sits in, which is what stops two settlements from
 * endlessly shuttling the same wagonload back and forth at each other.
 */
const IMPORT_LINE = 0.8;
const EXPORT_LINE = 1.5;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** How much stock a place wants on hand: a buffer measured in minutes of its own demand. */
export function targetStock(trader: Trader, resource: ResourceType): number {
  // A genuinely empty place wants nothing — the floor below exists to keep
  // a young, populated place from looking trivially "full" after one
  // delivery, not to keep a ghost town perpetually "short" of everything
  // and attracting goods nobody is there to use.
  if (trader.population === 0) return 0;
  return Math.max(MIN_TARGET_STOCK, demandPerMin(trader, resource) * TARGET_BUFFER_MINUTES);
}

/** Stock already accounted for: what is on the shelf plus what is already on the road. */
export function effectiveStock(trader: Trader, resource: ResourceType): number {
  return trader.storage[resource] + trader.incoming[resource];
}

/** Units short of the import line — zero anywhere in or above the neutral band. */
export function shortageAmount(trader: Trader, resource: ResourceType): number {
  const importLine = targetStock(trader, resource) * IMPORT_LINE;
  return Math.max(0, importLine - effectiveStock(trader, resource));
}

/**
 * Units genuinely spare: stock above the export line, less whatever is
 * already promised to another delivery. A place sitting on 90 of 100
 * capacity is not thereby offering up 90 — only what it holds past its own
 * comfortable buffer, which is usually a much smaller number.
 */
export function exportableAmount(trader: Trader, resource: ResourceType): number {
  const exportLine = targetStock(trader, resource) * EXPORT_LINE;
  const spare = trader.storage[resource] - exportLine - trader.outgoing[resource];
  return Math.max(0, spare);
}

/** How badly a place is short, 0 (comfortable or better) to 1 (nothing on hand or coming). */
export function shortage(trader: Trader, resource: ResourceType): number {
  const importLine = targetStock(trader, resource) * IMPORT_LINE;
  if (importLine <= 0) return 0;
  return clamp01(shortageAmount(trader, resource) / importLine);
}

/**
 * A shortage turned into a score a destination competes with. Never quite
 * zero — a well-stocked place still occasionally takes a little more — and
 * over 1 once a place is genuinely empty, so desperation can outweigh a
 * merely-closer alternative.
 */
export function demandScore(trader: Trader, resource: ResourceType): number {
  return 0.1 + 1.1 * shortage(trader, resource);
}

export type DemandLevel = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';

export function demandLevel(trader: Trader, resource: ResourceType): DemandLevel {
  const s = shortage(trader, resource);
  if (s <= 0.05) return 'NONE';
  if (s < 0.35) return 'LOW';
  if (s < 0.6) return 'MODERATE';
  if (s < 0.9) return 'HIGH';
  return 'EXTREME';
}

/** How good a road is worth using, from its length-weighted cost and how packed it is. */
export function routeScore(route: Route, traffic: TrafficField): number {
  const distance = 1 / (1 + route.resistance / REFERENCE_RESISTANCE);
  const quality = clamp01(route.wear(traffic) / WEAR_FULL);
  return distance * (0.4 + 0.6 * quality);
}

/** Reserve stock for a delivery that has been dispatched but not yet arrived. */
export function pledge(trader: Trader, resource: ResourceType, amount: number): void {
  trader.incoming[resource] += amount;
}

export function unpledge(trader: Trader, resource: ResourceType, amount: number): void {
  trader.incoming[resource] = Math.max(0, trader.incoming[resource] - amount);
}

/** Reserve surplus that a villager is already on their way to collect. */
export function pledgeExport(trader: Trader, resource: ResourceType, amount: number): void {
  trader.outgoing[resource] += amount;
}

export function unpledgeExport(trader: Trader, resource: ResourceType, amount: number): void {
  trader.outgoing[resource] = Math.max(0, trader.outgoing[resource] - amount);
}

/** Reserve a delivery against whichever kind of destination it's actually headed to. */
export function pledgeTo(destination: Destination, resource: ResourceType, amount: number): void {
  if (destination instanceof ResourceNode) destination.pendingInvestment += amount;
  else pledge(destination, resource, amount);
}

export function unpledgeFrom(destination: Destination, resource: ResourceType, amount: number): void {
  if (destination instanceof ResourceNode) {
    destination.pendingInvestment = Math.max(0, destination.pendingInvestment - amount);
  } else {
    unpledge(destination, resource, amount);
  }
}

/** Take stock off a trader's own shelf — a settlement acting as a source, not a node. */
export function withdraw(trader: Trader, resource: ResourceType, amount: number): number {
  const taken = Math.min(amount, trader.storage[resource]);
  trader.storage[resource] -= taken;
  return taken;
}

/**
 * People eat and burn firewood. Those two come off the shelf at exactly the
 * rate the same place's demand is quoted at, which is what keeps `shortage` a
 * live reading of how a place is actually doing rather than a high-water mark
 * it reached once.
 *
 * This is the counterpart to `targetStock`: a place wants
 * `TARGET_BUFFER_MINUTES` of demand on hand, and burns that demand down, so
 * a shelf holds steady exactly when deliveries keep pace and slides when
 * they don't. Nothing else in the economy has to be told a place is
 * struggling; the shelf says so.
 *
 * Everything else on the table keeps its `targetStock` — a place still likes
 * a stack of stone and a few tools about — but is only ever drawn down by
 * something actually being built with it. See `SUBSISTENCE`, which is where
 * the reasoning lives, and `construction.ts`, which is now the draw.
 */
export function consume(trader: Trader, dt: number): void {
  const firewood = CONSUMPTION_PER_CAPITA[ResourceType.Wood] * trader.population * dt;
  trader.storage[ResourceType.Wood] = Math.max(0, trader.storage[ResourceType.Wood] - firewood);

  // Eating is one need, and two goods can meet it. Bread goes first — it is
  // what the grain was baked into, and leaving it on the shelf while grain
  // came off would have had a place hoard loaves and starve. Whatever the
  // loaves do not cover comes out of the sacks.
  let hunger = CONSUMPTION_PER_CAPITA[ResourceType.Food] * trader.population * dt;
  const loaves = Math.min(trader.storage[ResourceType.Bread], hunger / BREAD_NOURISHMENT);
  if (loaves > 0) {
    trader.storage[ResourceType.Bread] -= loaves;
    hunger -= loaves * BREAD_NOURISHMENT;
  }
  trader.storage[ResourceType.Food] = Math.max(0, trader.storage[ResourceType.Food] - hunger);
}

/**
 * How quickly stock held well past what a place could ever ask for bleeds
 * back off. Only the portion above the export line is touched — anything a
 * place might plausibly still want is left alone — so this can't compete
 * with legitimate growth, only with a shrunken place coasting forever on a
 * bigger version of itself's leftovers.
 */
const EXCESS_DECAY_TAU = 60;

export function decayExcessStorage(trader: Trader, dt: number): void {
  const factor = 1 - Math.exp(-dt / EXCESS_DECAY_TAU);
  for (const resource of TRACKED_GOODS) {
    const ceiling = targetStock(trader, resource);
    const excess = trader.storage[resource] - ceiling;
    if (excess > 0) trader.storage[resource] -= excess * factor;
  }
}

export function emptyAmounts(): Record<ResourceType, number> {
  return {
    [ResourceType.Wood]: 0,
    [ResourceType.Iron]: 0,
    [ResourceType.Stone]: 0,
    [ResourceType.Food]: 0,
    [ResourceType.Planks]: 0,
    [ResourceType.StoneBlocks]: 0,
    [ResourceType.Tools]: 0,
    [ResourceType.Fittings]: 0,
    [ResourceType.Bread]: 0,
  };
}

// -------------------------------------------------------------- throughput

/**
 * How quickly deliveries are smoothed into a rate. Long enough that a single
 * burst — the flurry of trips a newly-founded, completely-empty settlement
 * attracts before anything else can compete for a villager's time — reads as
 * what it actually is, a one-off top-up, rather than getting amplified into
 * a population number the place has no way to keep sustaining once normal
 * competition for deliveries resumes.
 */
const THROUGHPUT_TAU = 180;
/** Seconds for population to close most of the way to its sustainable size. */
const POPULATION_TIME_CONSTANT = 100;

/**
 * How much of a resource a place would like to see arriving, per minute:
 * what its people get through simply living, plus what it is currently
 * putting into the ground. See `CONSTRUCTION_GOODS`.
 *
 * Anything on neither list — iron, which is a smithy's feedstock and nobody's
 * dinner or doorframe — keeps the plain per-capita reading, which is really a
 * statement about how big a working stock a place of that size likes to keep.
 */
export function demandPerMin(trader: Trader, resource: ResourceType): number {
  const perCapita = trader.population * DEMAND_PER_CAPITA_PER_MIN[resource];
  const subsistence = SUBSISTENCE.includes(resource);
  const building = CONSTRUCTION_GOODS.includes(resource);
  if (!subsistence && !building) return perCapita;
  return (subsistence ? perCapita : 0) + (building ? perCapita * trader.buildAppetite : 0);
}

/** A delivery has landed; feed it into the place's rolling throughput. */
export function recordDelivery(trader: Trader, resource: ResourceType, amount: number): void {
  trader.throughput[resource] += amount;
}

/** Ground the rolling figures lose a little every tick, deliveries or not. */
export function decayThroughput(trader: Trader, dt: number): void {
  const factor = Math.exp(-dt / THROUGHPUT_TAU);
  for (const resource of TRACKED_GOODS) trader.throughput[resource] *= factor;
}

/**
 * Units of a resource arriving per minute, smoothed over roughly a minute of
 * deliveries rather than read off the last one. An exponentially decaying
 * pool converges to `rate * tau`, so dividing back out by `tau` recovers the
 * rate — the same trick the traffic field uses for wear.
 */
export function throughputPerMin(trader: Trader, resource: ResourceType): number {
  return (trader.throughput[resource] / THROUGHPUT_TAU) * 60;
}

/**
 * How many residents what is actually arriving here could support — the
 * lower of what the grain feeds and what the firewood keeps warm.
 *
 * Food alone was the whole of this, and it let population run away from
 * every other part of the economy. Farmland is the commonest ground on any
 * map, so food sites outnumber woodland better than two to one; population
 * therefore grew on grain until it was three times what the forests could
 * supply. Wood sat at maximum shortage permanently, which starved node
 * investment and left every industry with nothing to work, which meant no
 * wealth, no development, and — measured at two hundred and thirty
 * residents — eighty people standing idle with nothing in the civilisation
 * for them to do. A population is not fed by grain alone, and pretending
 * otherwise doesn't make the timber appear.
 *
 * The same "whichever ladder is behind" shape `nodeLevel` uses for a node's
 * level and `tier` uses for a place's rung. Deliberately only the
 * necessities: stone and iron are what a civilisation builds and arms
 * itself with, not what it survives on, and gating headcount on them would
 * make an ordinary poor-in-ore seed unliveable rather than merely modest.
 */
export function sustainablePopulation(trader: Trader): number {
  return supportedBy([trader]);
}

/**
 * The same reading for the whole civilisation — and it has to be computed
 * this way round, not by adding up each place's own answer.
 *
 * Summing per-place minimums asks every settlement to be independently
 * self-sufficient in both necessities, which is precisely what a trade
 * network exists to make unnecessary: a timber hamlet legitimately grows no
 * food, and a farming one legitimately cuts no wood. Adding their minimums
 * gives zero for both and reports a starving civilisation sitting on a
 * surplus of everything. Taking the minimum of the *totals* asks the
 * question that actually matters — is enough of each thing arriving,
 * anywhere, for the people there are — and leaves distributing it to the
 * trade system, which is its job.
 */
export function sustainablePopulationAcross(traders: readonly Trader[]): number {
  return supportedBy(traders);
}

function supportedBy(traders: readonly Trader[]): number {
  let supported = Infinity;
  for (const resource of NECESSITIES) supported = Math.min(supported, supportedByResource(traders, resource));
  return Math.max(0, supported);
}

/**
 * How many residents the arrivals of *one* good could support, on its own.
 *
 * Kept separate from the combined reading above because the labour market
 * needs to know **which** necessity is short, not merely that one of them is.
 * Feeding the combined figure into food's famine bonus produced a genuine
 * deadlock: a *timber* famine drove the combined number to zero, which
 * maxed out the *food* bonus, so every spare hand was sent to a farm, so no
 * forest was ever staffed, so the timber famine never ended. A civilisation
 * of three sat like that for a hundred and twenty days with forty-four
 * connected deposits and a full granary.
 */
export function supportedByResource(traders: readonly Trader[], resource: ResourceType): number {
  let arriving = 0;
  for (const trader of traders) arriving += throughputPerMin(trader, resource);
  // Loaves are food arriving, and have to be counted as such or a realm that
  // bakes would read as starving on the strength of the grain it no longer
  // needs to ship. This is the one place the substitution in `consume` has to
  // be mirrored: population is read off what is *arriving*, not off shelves.
  if (resource === ResourceType.Food) {
    for (const trader of traders) {
      arriving += throughputPerMin(trader, ResourceType.Bread) * BREAD_NOURISHMENT;
    }
  }
  return arriving / DEMAND_PER_CAPITA_PER_MIN[resource];
}

/** What a population cannot do without: it eats, and it burns and builds with timber. */
const NECESSITIES: readonly ResourceType[] = [ResourceType.Food, ResourceType.Wood];

/**
 * A rough single number for how alive a place's trade is: everything it is
 * actually receiving, against everything it would like to be receiving.
 */
export function economicActivity(trader: Trader): number {
  let demand = 0;
  let supply = 0;
  for (const resource of TRACKED_GOODS) {
    demand += demandPerMin(trader, resource);
    supply += throughputPerMin(trader, resource);
  }
  return demand > 0 ? clamp01(supply / demand) : 0;
}

// ------------------------------------------------------------------ wealth

/**
 * A place earns wealth two ways: running an industry (see `Industry.produce`
 * in `industry.ts`) and selling its own surplus elsewhere (a trader-sourced
 * shipment — see `TransportSystem.step`'s `Loading` case in `systems.ts`).
 * Raw production flowing straight from a node to wherever it's carried is
 * deliberately not a wealth event: nodes are shared infrastructure, nobody
 * "owns" their output in a way that would make sense to pay out.
 *
 * `wealth` is the running total (spendable once development projects exist
 * to spend it on); `wealthIncome` is the same decaying-accumulator trick
 * `throughput` already uses, so tier can read a smoothed rate rather than a
 * single instant.
 */
export function recordWealth(trader: Trader, amount: number): void {
  trader.wealth += amount;
  trader.wealthIncome += amount;
}

export function decayWealthIncome(trader: Trader, dt: number): void {
  trader.wealthIncome *= Math.exp(-dt / THROUGHPUT_TAU);
}

/** Wealth earned per minute, smoothed the same way goods throughput is. */
export function wealthIncomePerMin(trader: Trader): number {
  return (trader.wealthIncome / THROUGHPUT_TAU) * 60;
}

/**
 * Ease a population reading toward its sustainable size. Proportional to the
 * gap, so a place far short of its food supply grows quickly and one nearly
 * there barely moves — the same shape the settlement-potential system uses,
 * just on a slower clock, and it works just as well backwards: a place that
 * has outrun its food supply shrinks by the identical rule.
 */
export function easePopulation(current: number, target: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / POPULATION_TIME_CONSTANT));
}

export interface DestinationInfo {
  trader: Trader;
  /** The road the goods would actually take — what decides how much can go at once. */
  route: Route;
  distance: number;
  /** How much a unit is worth here — scarcity alone, before distance is charged against it. */
  value: number;
  /** How cheap the road there is, 0 to 1. */
  routeQuality: number;
  score: number;
  demand: DemandLevel;
}

/** Every reachable place a node's goods could go, best first — for UI and dispatch alike. */
export function destinationsFor(
  resource: ResourceType,
  traders: Trader[],
  routeBetween: (to: Trader) => Route | null,
  traffic: TrafficField,
): DestinationInfo[] {
  const out: DestinationInfo[] = [];
  for (const trader of traders) {
    const route = routeBetween(trader);
    if (!route) continue;
    const value = demandScore(trader, resource);
    const routeQuality = routeScore(route, traffic);
    out.push({ trader, route, distance: route.length, value, routeQuality, score: value * routeQuality, demand: demandLevel(trader, resource) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The one destination that would win, without ranking the rest.
 *
 * Every caller in the simulation takes `destinationsFor(...)[0]` and drops
 * the tail — only the inspector panel ever shows more than the winner — and
 * the dispatcher asks this of every source in the realm, for every good, many
 * times a second. Ties fall to whichever trader comes first in the list, which
 * is what a stable sort by descending score already did.
 */
export function bestDestinationFor(
  resource: ResourceType,
  traders: Trader[],
  routeBetween: (to: Trader) => Route | null,
  traffic: TrafficField,
): DestinationInfo | null {
  let best: DestinationInfo | null = null;
  for (const trader of traders) {
    const route = routeBetween(trader);
    if (!route) continue;
    const value = demandScore(trader, resource);
    const routeQuality = routeScore(route, traffic);
    const score = value * routeQuality;
    if (best !== null && score <= best.score) continue;
    best = { trader, route, distance: route.length, value, routeQuality, score, demand: demandLevel(trader, resource) };
  }
  return best;
}
