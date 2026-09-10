import {
  destinationsFor,
  effectiveStock,
  exportableAmount,
  routeScore,
  shortage,
  targetStock,
  type Destination,
  type TradeSource,
  type Trader,
} from './economy';
import type { ResourceNode } from './resourceNode';
import type { Route } from './roadNetwork';
import { TRACKED_GOODS, type TrafficField } from './traffic';
import { ResourceType } from './types';
import { CARRY_CAPACITY } from './villager';

/**
 * A settlement's surplus has to clear this bar before it is worth a
 * villager's trip — point 7 of the brief: nearby, meaningful trades should
 * win out over distant, token ones.
 */
const MIN_TRADE_UNIT = 2;
/**
 * Below this, a trader counts as comfortably stocked rather than genuinely
 * short. Feeding a real shortage always outranks investing in a node — a
 * place that's actually short of wood or stone should never lose a shipment
 * to a quarry's timbering budget.
 */
const TRADER_COMFORTABLE = 0.05;

export interface Shipment {
  source: TradeSource;
  destination: Destination;
  resource: ResourceType;
  amount: number;
  pickupRoute: Route;
}

export interface ShipmentQuery {
  nodes: ResourceNode[];
  traders: Trader[];
  traffic: TrafficField;
  /** The route a villager, starting at the village, would walk to reach this source. */
  pickupRouteTo(source: TradeSource): Route | null;
  routeBetween(a: TradeSource, b: Destination): Route | null;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** How badly a node wants its next investment delivered: 0 (met) to 1 (nothing shipped yet). */
function investmentShortage(node: ResourceNode): number {
  const next = node.investmentProgress.next;
  if (next === null || next <= 0) return 0;
  return clamp01(1 - node.effectiveInvestment / next);
}

/**
 * The one decision the whole trade layer exists to make: of everything
 * sitting somewhere with somewhere else that wants it, which single load is
 * most worth a villager's time right now?
 *
 * Production, a settlement's own surplus, and a node's unmet investment are
 * all weighed the same way here: to the road network, a forest with wood, a
 * granary with too much food, and a quarry waiting on timber to dig deeper
 * are all just a place with more of something than it needs, and a place
 * that would put it to use. Distance is a cost subtracted from the trip;
 * scarcity — or unmet investment — at the far end is the value that makes
 * the trip worth it.
 */
export function findBestShipment(query: ShipmentQuery): Shipment | null {
  let best: Shipment | null = null;
  let bestScore = -Infinity;

  // How hungry the civilisation actually is right now, and — separately —
  // whether each tracked good is currently wanted by anyone at all. Both
  // feed into how willing a trip is to go toward investment (levelling up a
  // node) rather than toward feeding someone: a real famine has to be able
  // to pull labour off "advanced" work — stocking up nodes, running
  // industries — before anything else, and a node whose own output nobody
  // is short of has no business being levelled up in the meantime either.
  const foodFamine = Math.max(...query.traders.map((t) => shortage(t, ResourceType.Food)));
  const relevance = new Map<ResourceType, number>();
  for (const resource of TRACKED_GOODS) {
    relevance.set(resource, Math.max(...query.traders.map((t) => shortage(t, resource))));
  }

  const consider = (source: TradeSource, resource: ResourceType, available: number, urgency: number): void => {
    if (available <= 0) return;

    const pickupRoute = query.pickupRouteTo(source);
    if (!pickupRoute) return;

    let winner: { destination: Destination; score: number; unmet: number } | null = null;
    let traderNeedsIt = false;

    const traderCandidates = query.traders.filter((t) => t !== source);
    const traderOptions = destinationsFor(
      resource,
      traderCandidates,
      (trader) => query.routeBetween(source, trader),
      query.traffic,
    );
    if (traderOptions.length > 0) {
      const top = traderOptions[0];
      const target = targetStock(top.trader, resource);
      const unmet = Math.max(1, Math.ceil(target - effectiveStock(top.trader, resource)));
      winner = { destination: top.trader, score: top.score, unmet };
      traderNeedsIt = shortage(top.trader, resource) > TRADER_COMFORTABLE;
    }

    // A connected node short on the material it needs to level up competes
    // for the same trip, exactly like a trader running low would. Feeding a
    // real shortage still comes first, but only as a heavy discount on the
    // node's score, not a hard exclusion — a hard exclusion meant that as
    // long as a trader's own demand stayed even slightly above comfortable
    // (which thin early production keeps happening forever, since the
    // trader's demand absorbs every marginal unit before it's ever truly
    // "comfortable"), investment could never win a single trip and a node
    // would stall short of its threshold permanently. A steep discount lets
    // investment still occasionally win when it's clearly the better trip
    // (very close, or very near its threshold), while a genuine shortage
    // keeps outscoring it almost every time.
    {
      // A real famine pulls a trip toward feeding people even harder than
      // an ordinary trader shortage does — investment is "advanced" work
      // (growing a node's future capacity), and that has to wait behind
      // "does anyone actually eat today" rather than just behind whichever
      // trader happens to want this resource most right now.
      const investmentPenalty = (traderNeedsIt ? 0.5 : 1) * (1 - foodFamine * 0.9);
      for (const node of query.nodes) {
        if (node === source || !node.isConnected || node.requiredResource !== resource) continue;

        const shortfall = investmentShortage(node);
        if (shortfall <= 0) continue;

        const next = node.investmentProgress.next ?? 0;
        const unmet = Math.max(1, Math.ceil(next - node.effectiveInvestment));

        const route = query.routeBetween(source, node);
        if (!route) continue;

        // A mild tilt toward whichever node is closer to its threshold, not
        // a dominant one: weighting purely by remaining shortfall let a
        // freshly-founded node's empty bar permanently outscore (and
        // starve) anything close to finishing, since there's always a
        // newer, emptier one somewhere. But swinging the other way and
        // rewarding progress just as strongly would starve brand-new nodes
        // instead, since they'd score near zero until someone happens to
        // start them. Keep the baseline high enough that a fresh node is
        // still a competitive pick, and let progress only nudge the choice
        // between otherwise-similar candidates.
        const progress = 1 - shortfall;
        // Also discounted, not gated, when nobody's actually short of what
        // this node makes: a hard "skip entirely" here was tried and
        // reverted — once ordinary demand was reliably kept satisfied (the
        // whole point of weighing food properly), nodes whose output
        // happened to be comfortable *right now* never got to grow ahead of
        // future demand at all, so production capacity quietly stopped
        // keeping pace with a growing population and wealth (from selling
        // the surplus that growing capacity would have produced) dried up
        // civilisation-wide. A steep discount still lets a genuine shortage
        // elsewhere win almost every time, without permanently forbidding
        // the trip the moment things look briefly comfortable.
        const relevancePenalty = (relevance.get(node.resource) ?? 0) > 0 ? 1 : 0.15;
        const score = (0.6 + 0.5 * progress) * routeScore(route, query.traffic) * investmentPenalty * relevancePenalty;
        if (winner && winner.score >= score) continue;
        winner = { destination: node, score, unmet };
      }
    }

    if (!winner) return;

    const score = urgency - pickupRoute.resistance / 50 + winner.score * 60;
    if (score <= bestScore) return;

    const amount = Math.min(CARRY_CAPACITY, available, winner.unmet);
    if (amount <= 0) return;

    bestScore = score;
    best = { source, destination: winner.destination, resource, amount, pickupRoute };
  };

  // Production: a node with a backlog is urgent in proportion to how full it is.
  for (const node of query.nodes) {
    if (!node.isConnected) continue;
    const urgency = (node.isFull ? 400 : 0) + node.available * 20;
    consider(node, node.resource, node.available, urgency);
  }

  // Settlement (and village) surplus: a bigger cushion above the export line
  // is worth more to move, but never as urgent as a resource site backing up.
  for (const trader of query.traders) {
    for (const resource of TRACKED_GOODS) {
      const surplus = exportableAmount(trader, resource);
      if (surplus < MIN_TRADE_UNIT) continue;
      consider(trader, resource, surplus, surplus * 8);
    }
  }

  return best;
}
