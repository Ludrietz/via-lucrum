import {
  bestDestinationFor,
  effectiveStock,
  exportableAmount,
  routeScore,
  shortage,
  targetStock,
  type Destination,
  type TradeSource,
  type Trader,
} from './economy';
import { levelsHeldBackByInvestment } from './nodeLevel';
import type { ResourceNode } from './resourceNode';
import type { Route } from './roadNetwork';
import { TRACKED_GOODS, type TrafficField } from './traffic';
import { ResourceType } from './types';
import { CONVOY_CLASSES, convoyFor, type Convoy } from './villager';

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
/**
 * How much each level a node has earned but not been paid for lifts its
 * claim on a shipment — see the `starvation` term below. Set so a site held
 * back by a single level competes with an ordinary trader shortage, and one
 * held back by two or three beats it.
 */
const INVESTMENT_STARVATION_WEIGHT = 1.4;
/**
 * How much each second a full node has been waiting for a collection lifts its
 * claim on the next trip, and how far that can go.
 *
 * Distance enters a shipment's score as a flat, permanent handicap
 * (`pickupRoute.resistance / 50`), while being full is worth a flat 400 to
 * everyone. Two equally-full sites therefore settle their contest purely on
 * which is nearer — and the nearer one wins it again on the very next tick,
 * and every tick after, for as long as anywhere closer keeps filling up. A
 * remote site never earns anything by having been passed over, so it is not
 * losing a contest so much as permanently excluded from one.
 *
 * That is not a mild inefficiency, because `produce()` stops dead while a shed
 * is full: measured across five seeds at day 150, sites within 360 units of a
 * seat were emptied about two seconds after filling and had collected 275
 * units each, while sites 1000-2000 units out sat full for 36 seconds at a
 * time and had collected *two*. They were staffed the whole while, doing
 * nothing.
 *
 * `fullSince` already measures exactly the right thing — time full with nobody
 * even dispatched — and already resets itself the moment someone is on the way,
 * so this grows only while a site is genuinely being ignored and closes as soon
 * as it is answered. Same shape as `systems.ts`'s `bootstrapWait`, for the same
 * reason. Capped so a long-ignored site can outrank distance without ever
 * outranking the question of whether anyone is hungry.
 */
const WAITING_WEIGHT = 1;
const WAITING_MAX = 300;

export interface Shipment {
  source: TradeSource;
  destination: Destination;
  resource: ResourceType;
  amount: number;
  pickupRoute: Route;
  /** What this load travels as — see `convoyFor`. */
  convoy: Convoy;
}

/** A node waiting on materials, and everything about that no source can change. */
interface InvestmentCandidate {
  node: ResourceNode;
  unmet: number;
  progress: number;
  heldBack: number;
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

  // Which nodes are waiting on a delivery to level up, and everything about
  // how badly they want it that does not depend on where the load would come
  // from — which turns out to be all of it but the route.
  //
  // This was derived inside `consider`, so every deposit in the realm was
  // re-examined once per candidate source, and `investmentProgress` and
  // `levelsHeldBackByInvestment` recomputed with it: a few hundred sources
  // against a few hundred nodes, eleven times a second. It depends on the
  // nodes alone. Grouping by what each is waiting for also means a source
  // only ever looks at the nodes that could actually want what it is
  // carrying. Built in `query.nodes` order, so ties still fall to whichever
  // node comes first, exactly as before.
  const investing = new Map<ResourceType, InvestmentCandidate[]>();
  for (const node of query.nodes) {
    if (!node.isConnected || node.requiredResource === null) continue;

    const shortfall = investmentShortage(node);
    if (shortfall <= 0) continue;

    const next = node.investmentProgress.next ?? 0;
    const candidate: InvestmentCandidate = {
      node,
      unmet: Math.max(1, Math.ceil(next - node.effectiveInvestment)),
      progress: 1 - shortfall,
      heldBack: levelsHeldBackByInvestment(node.cumulativeCollected, node.investedResource),
    };

    const bucket = investing.get(node.requiredResource);
    if (bucket) bucket.push(candidate);
    else investing.set(node.requiredResource, [candidate]);
  }

  const pickupRoutes = new Map<TradeSource, Route | null>();

  const consider = (source: TradeSource, resource: ResourceType, available: number, urgency: number): void => {
    if (available <= 0) return;

    // A trader source is considered once per good it might export, and where
    // the nearest free pair of hands is does not change between those.
    let pickupRoute = pickupRoutes.get(source);
    if (pickupRoute === undefined) {
      pickupRoute = query.pickupRouteTo(source);
      pickupRoutes.set(source, pickupRoute);
    }
    if (!pickupRoute) return;

    let winner: { destination: Destination; score: number; unmet: number; route: Route } | null = null;
    let traderNeedsIt = false;

    const traderCandidates = query.traders.filter((t) => t !== source);
    const top = bestDestinationFor(
      resource,
      traderCandidates,
      (trader) => query.routeBetween(source, trader),
      query.traffic,
    );
    if (top !== null) {
      const target = targetStock(top.trader, resource);
      const unmet = Math.max(1, Math.ceil(target - effectiveStock(top.trader, resource)));
      winner = { destination: top.trader, score: top.score, unmet, route: top.route };
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
      for (const candidate of investing.get(resource) ?? []) {
        const node = candidate.node;
        if (node === source) continue;

        const unmet = candidate.unmet;

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
        const progress = candidate.progress;
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
        // ...but a site that has visibly outrun its own investment is worth
        // growing even while its output happens to be comfortable this
        // minute, so being starved lifts the floor. Left flat at 0.15 this
        // penalty was the dominant blocker in practice rather than the mild
        // discount it reads as: in a well-fed civilisation almost *every*
        // node's output is comfortable almost all the time, so almost every
        // node was permanently cut to a sixth and investment never happened
        // anywhere.
        const heldBack = candidate.heldBack;
        const relevancePenalty =
          (relevance.get(node.resource) ?? 0) > 0 ? 1 : Math.min(1, 0.15 + heldBack * 0.4);
        // How badly this site is being held back by logistics rather than by
        // effort — see `levelsHeldBackByInvestment`. Without this, investment
        // simply never happened: a trader wanting a good scores
        // `0.1 + 1.1 * shortage`, which beats investment's flat baseline
        // whenever anyone is even slightly short, and with a dozen traders
        // each keeping a buffer of stone somebody always is. Measured over a
        // hundred in-game days, not one unit of investment had *ever* been
        // delivered to any node: every site sat at level one with a lifetime
        // haul of 50-165 units behind it, which in turn froze worker
        // capacity, settlement growth and the reveal frontier all at once.
        // Scaling by how far a node's earned level has outrun its paid-for
        // one puts a demonstrably starved site ahead of an ordinary buffer
        // top-up, and costs a fresh node nothing — it closes itself the
        // moment the materials land.
        const starvation = 1 + heldBack * INVESTMENT_STARVATION_WEIGHT;
        const score =
          (0.6 + 0.5 * progress) * starvation * routeScore(route, query.traffic) * investmentPenalty * relevancePenalty;
        if (winner && winner.score >= score) continue;
        winner = { destination: node, score, unmet, route };
      }
    }

    if (!winner) return;

    const score = urgency - pickupRoute.resistance / 50 + winner.score * 60;
    if (score <= bestScore) return;

    // What can be moved in one trip is the road's answer, not the person's.
    // The route the *goods* travel decides it — not the empty walk out to the
    // pickup, which may well come from somewhere else entirely.
    // What the road will bear, then what there actually is to put on it. The
    // heaviest class the road allows sets the ceiling on the load; the load
    // then decides what is actually harnessed up, so nobody walks a waggon
    // train out for four sacks.
    const weakest = winner.route.weakestWear(query.traffic);
    const allowed = convoyFor(weakest, winner.route.length);
    const amount = Math.min(CONVOY_CLASSES[allowed].capacity, available, winner.unmet);
    const convoy = convoyFor(weakest, winner.route.length, amount);
    if (amount <= 0) return;

    bestScore = score;
    best = { source, destination: winner.destination, resource, amount, pickupRoute, convoy };
  };

  // Production: a node with a backlog is urgent in proportion to how full it
  // is, and — separately — to how long it has been waiting for anyone to come.
  for (const node of query.nodes) {
    if (!node.isConnected) continue;
    const waiting = Math.min(WAITING_MAX, node.fullSince * WAITING_WEIGHT);
    const urgency = (node.isFull ? 400 : 0) + node.available * 20 + waiting;
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
