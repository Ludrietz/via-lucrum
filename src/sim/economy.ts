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
  [ResourceType.Wood]: 0.3,
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
};

/** The same figure per second, which is the rate `consume` actually applies. */
export const CONSUMPTION_PER_CAPITA: Record<ResourceType, number> = Object.fromEntries(
  Object.entries(DEMAND_PER_CAPITA_PER_MIN).map(([resource, perMin]) => [resource, perMin / 60]),
) as Record<ResourceType, number>;

/** Goods an industry makes rather than the ground — kept for the places that treat them differently. */
export const PROCESSED_GOODS: readonly ResourceType[] = [
  ResourceType.Planks,
  ResourceType.StoneBlocks,
  ResourceType.Tools,
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
  [ResourceType.Planks]: 2.5,
  [ResourceType.StoneBlocks]: 2.5,
  [ResourceType.Tools]: 6,
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
  const quality = clamp01(traffic.wearAlong(route.points) / WEAR_FULL);
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
 * People eat, burn firewood, wear out tools. Every tracked good — raw and
 * processed alike — comes off the shelf at exactly the rate the same place's
 * demand is quoted at, which is what keeps `shortage` a live reading of how
 * a place is actually doing rather than a high-water mark it reached once.
 *
 * This is the counterpart to `targetStock`: a place wants
 * `TARGET_BUFFER_MINUTES` of demand on hand, and burns that demand down, so
 * a shelf holds steady exactly when deliveries keep pace and slides when
 * they don't. Nothing else in the economy has to be told a place is
 * struggling; the shelf says so.
 */
export function consume(trader: Trader, dt: number): void {
  for (const resource of TRACKED_GOODS) {
    const use = CONSUMPTION_PER_CAPITA[resource] * trader.population * dt;
    trader.storage[resource] = Math.max(0, trader.storage[resource] - use);
  }
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

/** How much of a resource a place would like to see arriving, per minute. */
export function demandPerMin(trader: Trader, resource: ResourceType): number {
  return trader.population * DEMAND_PER_CAPITA_PER_MIN[resource];
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
    out.push({ trader, distance: route.length, value, routeQuality, score: value * routeQuality, demand: demandLevel(trader, resource) });
  }
  return out.sort((a, b) => b.score - a.score);
}
