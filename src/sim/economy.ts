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

/** Stock a place would like to be holding, per resident. */
export const DESIRED_PER_CAPITA: Record<ResourceType, number> = {
  [ResourceType.Food]: 2.2,
  [ResourceType.Wood]: 1.6,
  [ResourceType.Iron]: 0.6,
  [ResourceType.Stone]: 0.6,
};

/** Stock burned per resident per second, quietly, whether or not it is watched. */
export const CONSUMPTION_PER_CAPITA: Record<ResourceType, number> = {
  [ResourceType.Food]: 0.02,
  [ResourceType.Wood]: 0.01,
  [ResourceType.Iron]: 0.004,
  [ResourceType.Stone]: 0.004,
};

/** How far a shipment's road is allowed to matter, in resistance units. */
const REFERENCE_RESISTANCE = 700;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function desiredStock(trader: Trader, resource: ResourceType): number {
  return Math.max(1, trader.population * DESIRED_PER_CAPITA[resource]);
}

/** Stock already accounted for: what is on the shelf plus what is already on the road. */
export function effectiveStock(trader: Trader, resource: ResourceType): number {
  return trader.storage[resource] + trader.incoming[resource];
}

/** How badly a place is short, 0 (fully stocked) to 1 (nothing coming, nothing held). */
export function shortage(trader: Trader, resource: ResourceType): number {
  const desired = desiredStock(trader, resource);
  return clamp01((desired - effectiveStock(trader, resource)) / desired);
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

/** Quiet upkeep: every place slowly eats into its own stock. */
export function consume(trader: Trader, dt: number): void {
  for (const resource of TRACKED_GOODS) {
    const use = CONSUMPTION_PER_CAPITA[resource] * trader.population * dt;
    trader.storage[resource] = Math.max(0, trader.storage[resource] - use);
  }
}

export function emptyAmounts(): Record<ResourceType, number> {
  return {
    [ResourceType.Wood]: 0,
    [ResourceType.Iron]: 0,
    [ResourceType.Stone]: 0,
    [ResourceType.Food]: 0,
  };
}

// -------------------------------------------------------------- throughput

/**
 * How quickly deliveries are smoothed into a rate. Short enough that a place
 * feels its supply within a minute or so, long enough that one big delivery
 * doesn't read as a permanent trend.
 */
const THROUGHPUT_TAU = 40;
/**
 * What one resident gets through in a minute, at a comfortable level — the
 * demand figure shown in the UI, and (for food) what population support is
 * measured against. Separate from `CONSUMPTION_PER_CAPITA` above, which is
 * the actual stock-draining rate and is currently switched off.
 */
export const DEMAND_PER_CAPITA_PER_MIN: Record<ResourceType, number> = {
  [ResourceType.Food]: 0.5,
  [ResourceType.Wood]: 0.3,
  [ResourceType.Iron]: 0.1,
  [ResourceType.Stone]: 0.1,
};
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

/** How many residents the food actually arriving here could feed. */
export function sustainablePopulation(trader: Trader): number {
  return Math.max(0, throughputPerMin(trader, ResourceType.Food) / DEMAND_PER_CAPITA_PER_MIN[ResourceType.Food]);
}

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
    const score = demandScore(trader, resource) * routeScore(route, traffic);
    out.push({ trader, distance: route.length, score, demand: demandLevel(trader, resource) });
  }
  return out.sort((a, b) => b.score - a.score);
}
