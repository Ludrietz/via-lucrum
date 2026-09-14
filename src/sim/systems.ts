import {
  BASE_VALUE,
  pledgeExport,
  pledgeTo,
  recordDelivery,
  recordWealth,
  shortage,
  supportedByResource,
  unpledgeExport,
  unpledgeFrom,
  withdraw,
  type Destination,
  type Trader,
} from './economy';
import { commitmentOf, forget, practise, takeUpCraft } from './craft';
import { Industry } from './industry';
import { ResourceNode } from './resourceNode';
import { dist, distSq, type Vec2 } from './geometry';
import { Route } from './roadNetwork';
import { Settlement } from './settlement';
import { findBestShipment } from './trade';
import { type TrafficField } from './traffic';
import { NodeState, ResourceType, VillagerRole, VillagerState, type WorldEvent } from './types';
import type { Village } from './village';
import { CARRY_CAPACITY, TransportLeg, WALK_SPEED, type Villager } from './villager';

/** What the systems are allowed to see of the world. */
export interface SimContext {
  village: Village;
  nodes: ResourceNode[];
  /** Every place goods can be delivered to: the village, and every settlement. */
  traders: Trader[];
  /** Every industry, at every trader, flattened — see `IndustrySystem`. */
  industries: Industry[];
  /** Everyone, everywhere — the one shared, mobile pool. */
  villagers: Villager[];
  traffic: TrafficField;
  routeTo(node: ResourceNode): Route | null;
  routeBetweenSites(from: ResourceNode | Trader, to: Destination): Route | null;
  /** How hard the ground at a point is to cross, relative to open plains. */
  costAt(point: Vec2): number;
  /** A delivery just came in along this route; mark the ground it used. */
  recordTrip(route: Route, resource: ResourceType | null, amount: number): void;
  emit(event: WorldEvent): void;
}

const LOAD_TIME = 1.2;
const UNLOAD_TIME = 1.0;
/** Gap between two villagers setting off, so they do not leave as a blob. */
const DISPATCH_INTERVAL = 0.7;
/** How much worse a shortage has to be before it's worth pulling a worker off another job for. */
const REASSIGN_MARGIN = 0.6;
/**
 * How much a person's standing in their own trade adds to that. Set so a
 * master is roughly three times as dear to move as a raw hand — enough that
 * settled crews genuinely stay settled, while a real famine (see
 * `laborPriority`, where a necessity in genuine trouble scores well past 2)
 * can still reach anyone in the realm.
 */
const COMMITMENT_WEIGHT = 1.2;
/** Idle hands per step up in how often loads set off — see `TransportSystem.dispatch`. */
const WAITING_PER_CARAVAN = 4;
/** Ceiling on that speed-up, so the dispatcher can never become a per-tick decision again. */
const MAX_DISPATCH_RATE = 8;

/**
 * One idle villager per place that has any.
 *
 * Everyone idle at the same place would get the identical route, so there is
 * never a reason to price them separately — and the roster does not change
 * while a single decision is being made, which is why it is gathered once and
 * passed around rather than rebuilt inside `nearestIdleAmong`.
 *
 * `craft` is what breaks the tie *within* a place: when a post is being
 * filled, the person sent is whoever there already follows that trade, and
 * failing that whoever has least to lose by taking it up. Carrying a load
 * needs no trade at all, so the dispatcher passes nothing and gets the old
 * first-idle-found behaviour.
 */
function idleByHome(villagers: Villager[], craft: ResourceType | null = null): Map<Trader, Villager> {
  const out = new Map<Trader, Villager>();
  for (const v of villagers) {
    if (!v.isFree) continue;
    const sitting = out.get(v.home);
    if (!sitting) {
      out.set(v.home, v);
      continue;
    }
    if (craft !== null && commitmentOf(v, craft) < commitmentOf(sitting, craft)) out.set(v.home, v);
  }
  return out;
}

/** Whichever idle villager would reach `target` most cheaply — a tradesman for preference. */
function nearestIdleTo(
  villagers: Villager[],
  target: ResourceNode | Trader,
  routeBetweenSites: (from: ResourceNode | Trader, to: Destination) => Route | null,
  craft: ResourceType | null = null,
): { villager: Villager; route: Route } | null {
  return nearestIdleAmong(idleByHome(villagers, craft), target, routeBetweenSites, craft);
}

/**
 * The same, against a roster already gathered — which is what the dispatcher
 * wants, since it asks this of every source in the realm before choosing one.
 *
 * A target that IS somebody's home costs them nothing at all: they are already
 * there.
 *
 * Where a trade is wanted, a man who already follows it is worth going a
 * little further for. `CRAFT_REACH` is what a full master's skill is worth in
 * road: enough that a sawyer two valleys over is fetched back to a mill
 * ahead of a farmhand stood next to it, and not so much that a realm ships
 * people across itself when somebody local would do. It is the counterpart of
 * the reassignment margin — one keeps a tradesman where they are, this one
 * puts them back at their own trade when they have come free.
 */
const CRAFT_REACH = 0.45;

function nearestIdleAmong(
  idle: Map<Trader, Villager>,
  target: ResourceNode | Trader,
  routeBetweenSites: (from: ResourceNode | Trader, to: Destination) => Route | null,
  craft: ResourceType | null = null,
): { villager: Villager; route: Route } | null {
  let best: { villager: Villager; route: Route; cost: number } | null = null;
  for (const [home, villager] of idle) {
    const route = home === target ? new Route([home.position, home.position], []) : routeBetweenSites(home, target);
    if (!route) continue;
    const match = craft !== null && villager.craft === craft ? villager.experience : 0;
    const cost = route.resistance * (1 - CRAFT_REACH * match);
    if (!best || cost < best.cost) best = { villager, route, cost };
  }
  return best;
}

/**
 * Whichever trader is geographically closest to a point — used to decide
 * where a worker newly settled at a resource node actually lives. Nodes
 * stay shared infrastructure with no owner of their own; this only ever
 * answers "who lives nearest here", for the person, not the node.
 */
export function nearestTrader(point: Vec2, traders: Trader[]): Trader {
  // Ordering by squared distance is the same ordering, and this is asked of
  // every site against every trader often enough for the square root to show
  // up on its own. The `reduce` it replaces also re-measured the running
  // winner on every step, so this is half the work again.
  let best = traders[0];
  let bestDistance = distSq(point, best.position);
  for (let i = 1; i < traders.length; i++) {
    const d = distSq(point, traders[i].position);
    if (d < bestDistance) {
      bestDistance = d;
      best = traders[i];
    }
  }
  return best;
}

/**
 * Whether this is genuinely someone to reassign, not a worker `node.workers`
 * still lists but who's actually out mid-delivery (see `WorkerDeliverySystem`
 * — a node's own worker stays on its roster the whole time they're out
 * carrying off its backlog, specifically so the post doesn't read as open).
 * Reassigning that person out from under their own delivery would strand
 * their cargo and the pledge riding on it, so both `rebalance` and the
 * poach in `post` have to filter through this before touching anyone.
 */
function isAtPost(villager: Villager): boolean {
  return villager.role === VillagerRole.Worker;
}

/**
 * The worker a site can most afford to lose — its greenest hand. Every path
 * that takes somebody away from a post goes through this rather than through
 * `find(isAtPost)`, so a site's masters are the last people it gives up
 * regardless of *why* it is being asked.
 */
function leastCommitted(site: ResourceNode | Industry): Villager | null {
  let best: Villager | null = null;
  for (const worker of site.workers) {
    if (!isAtPost(worker)) continue;
    if (!best || worker.experience < best.experience) best = worker;
  }
  return best;
}

/** How badly the whole civilisation, not just one trader, wants this good. */
function worstShortage(traders: Trader[], resource: ResourceType): number {
  return Math.max(...traders.map((t) => shortage(t, resource)));
}

// Food is sticky, not sacred: scales with how hungry the civilisation
// actually is, rather than either a flat nudge or a permanent emergency
// flag. A flag-based override was tried here and reverted — once
// population outgrew whatever a couple of farm workers could support
// (which happens easily once industries are also competing for hands), the
// flag got stuck permanently on, gave food an unconditional +2 no other
// shortage could ever outweigh, and nothing — not a starving smithy, not a
// maxed-out shortage of planks — could ever win a hand back. Scaling with
// the *current* shortage instead means the bonus shrinks back down the
// moment food genuinely recovers, so it can never get stuck the same way.
// The base bonus alone still wins any tie and shrugs off a mild
// disadvantage while comfortably supplied (protecting against the tie-break
// extinction this was first added for); `FAMINE_WEIGHT` is what makes a
// real famine — not just an ordinary shortage — reliably outrank anything
// else in the civilisation, including another resource sitting at its own
// worst possible shortage, rather than only nudging a close call.
//
// Applied to both necessities now, not food alone. Population is gated on
// grain *and* timber (see `economy.ts`'s `sustainablePopulation`), so a
// civilisation freezing for want of firewood is exactly as fatal as one
// starving, and the labour market has to be able to see both. Food keeps the
// larger standing nudge — a hungry week bites sooner than a cold one — but a
// real timber famine now outranks an ordinary food shortage, which is what
// stops the two from taking turns starving each other.
const NECESSITY_BASE_BONUS: Partial<Record<ResourceType, number>> = {
  [ResourceType.Food]: 0.4,
  [ResourceType.Wood]: 0.25,
};
const FAMINE_WEIGHT = 1.2;

/**
 * How far a necessity's civilisation-wide *throughput* has fallen behind
 * population — 0 once deliveries are keeping pace, up to 1 once
 * essentially nothing is arriving.
 *
 * This was originally a workaround: raw food was never consumed from storage,
 * so a topped-up shelf made `shortage` read comfortable forever even with
 * every farm unstaffed, and throughput was the only signal that could still
 * see the famine. Raw goods are genuinely eaten now (see `economy.ts`'s `consume`),
 * so `shortage` is honest again and this is no longer covering for a blind
 * spot — but it is kept because the two answer different questions and the
 * difference matters. A shelf tells you where a place *is*; throughput tells
 * you which way it is *heading*. Watching both is what lets a farm win a
 * worker back while the larder is still half full, rather than after it has
 * emptied and the population has already started falling.
 */
function throughputDeficit(traders: Trader[], resource: ResourceType): number {
  const totalPopulation = traders.reduce((sum, t) => sum + t.population, 0);
  if (totalPopulation === 0) return 0;
  // This good's *own* arrivals, not the civilisation's combined
  // sustainability. Asking the combined question here deadlocks the labour
  // market the moment the two necessities are short by different amounts: a
  // timber famine drove the combined figure to zero, which maxed out the
  // *food* bonus, so every spare hand went to a farm, so no forest was ever
  // staffed, so the timber famine never ended. Observed running for a
  // hundred and twenty days at a population of three, beside a full granary
  // and forty-four connected deposits.
  return Math.max(0, Math.min(1, 1 - supportedByResource(traders, resource) / totalPopulation));
}

/** How badly this opening's good is needed, civilisation-wide — shared between hiring and reassignment/rebalancing. */
function laborPriority(traders: Trader[], resource: ResourceType): number {
  const s = worstShortage(traders, resource);
  const base = NECESSITY_BASE_BONUS[resource];
  if (base === undefined) return s;
  const severity = Math.max(s, throughputDeficit(traders, resource));
  return severity + base + severity * FAMINE_WEIGHT;
}

/**
 * How badly the civilisation wants another pair of hands *at this specific
 * workplace* — which, for an industry, is not the same question as how badly
 * it wants the industry's output.
 *
 * Shortage of the output alone gets industries catastrophically wrong. A
 * processed good sits at shortage 1.0 at every place in the game until an
 * industry is actually running, and stays there for as long as the industry
 * is starved — so "how short are we of planks" reads *maximal* precisely
 * when the sawmill has no wood, which is exactly when nobody should be sent
 * to work at one. Labour poured into idle mills, the mills ate whatever raw
 * material did arrive, and the shortage that justified them never closed:
 * the classic unintended positive feedback, where a subsystem's own damage
 * is what keeps feeding it.
 *
 * An industry's claim is therefore scaled by how spare its *input* is. A
 * sawmill in a civilisation drowning in timber outranks nearly everything; a
 * sawmill in one that is short of timber ranks below the forest that would
 * fix that, which is both obviously correct and, mechanically, what lets the
 * reassignment path (see `post`) pull a miller back out to the woods.
 */
function sitePriority(site: ResourceNode | Industry, traders: Trader[]): number {
  const wanted = laborPriority(traders, site.resource);
  if (!(site instanceof Industry)) return wanted;
  // The scarcest input decides — a two-input recipe is only as staffable as
  // whichever of the two the realm is shortest of.
  let inputSpare = 1;
  for (const { resource } of site.recipe.inputs) inputSpare = Math.min(inputSpare, 1 - worstShortage(traders, resource));
  return wanted * inputSpare;
}

/**
 * Below this population, a settlement isn't a going concern yet and civil-
 * wide shortage alone can't be trusted to ever staff it: a settlement was
 * founded specifically because real work exists near it (see
 * `settlementSystem.ts`'s founding gate), but that local node still has to
 * win the same civilisation-wide shortage contest every other opening does
 * — and if wood, say, is already comfortably supplied by the founding
 * village, a fresh timber settlement's own forest never wins a single hand,
 * and it sits at population zero forever despite having a real reason to
 * exist. This is what actually gets a new settlement its first residents.
 */
const SETTLEMENT_BOOTSTRAP_FLOOR = 5;
/** How strong a nudge this is — has to be enough to beat an ordinary shortage gap, not just a tie. */
const SETTLEMENT_BOOTSTRAP_BONUS = 0.5;

/**
 * Once a settlement has ever reached the bootstrap floor, its founding push
 * is done for good — checking live population instead would re-fire this
 * every time a settlement's small headcount dipped for any of the ordinary
 * reasons population fluctuates (a bad food week, someone out on the road),
 * which kept yanking workers between settlements that were each nudging the
 * other below the floor in turn, and none of them ever grew past it. A
 * settlement that has genuinely gotten going should sink or swim on the
 * same shortage economics as everywhere else.
 */
const everBootstrapped = new WeakSet<Settlement>();

/**
 * How long a still-empty opening has sat passed over while its settlement
 * is bootstrapping. `SETTLEMENT_BOOTSTRAP_BONUS` alone was a flat number,
 * which works to get a *single* new settlement its first residents but
 * falls apart the moment two or three found around the same time: they all
 * get the identical bonus, so the tie is actually broken by whichever
 * resource happens to be scarcer civilisation-wide — usually food — and an
 * iron mine or quarry bootstrapping a different settlement can lose that
 * tie every single time, forever. A mine sitting right beside a brand-new
 * settlement went unstaffed for over 80 in-game days this way, the
 * settlement stuck at population zero the whole time. This grows the bonus
 * the longer a specific opening goes unstaffed, the same "scale with live
 * severity, not a flat flag" shape the food-famine bonus already uses
 * (see `laborPriority`) — so whichever bootstrapping settlement has been
 * waiting longest eventually outranks the others regardless of what good
 * its site happens to produce, and the moment it gets a worker the timer
 * clears, so an already-resolved settlement doesn't keep an edge forever.
 */
const bootstrapWait = new Map<ResourceNode | Industry, { waited: number; sweep: number }>();
/** Which pass of `advanceBootstrapWaits` each entry was last seen on. */
let bootstrapSweep = 0;
/** Seconds of being passed over before the wait bonus fully ramps in. */
const BOOTSTRAP_WAIT_RAMP_SECONDS = 60;
/** Extra bonus at full ramp, on top of the flat `SETTLEMENT_BOOTSTRAP_BONUS`. */
const BOOTSTRAP_WAIT_MAX_BONUS = 1.2;

/** Whether this opening's nearest resident trader is a settlement still finding its first feet. */
function bootstrappingHome(site: ResourceNode | Industry, traders: Trader[]): Settlement | null {
  const home = site instanceof Industry ? site.owner : nearestTrader(site.position, traders);
  if (!(home instanceof Settlement) || everBootstrapped.has(home)) return null;
  if (home.population >= SETTLEMENT_BOOTSTRAP_FLOOR) {
    everBootstrapped.add(home);
    return null;
  }
  return home;
}

/**
 * Ticks every opening's wait timer once a frame, independent of whether a
 * hire actually happens this tick — `settlementBootstrapBonus` below only
 * ever reads this, so it stays correct no matter how many times (or from
 * how many call sites) that function is consulted in a single tick.
 */
function advanceBootstrapWaits(dt: number, ctx: SimContext): void {
  // Whether anywhere is bootstrapping at all is one cheap question about the
  // settlements; whose home is bootstrapping is an expensive one about every
  // deposit and every industry in the realm. Asking the cheap one first costs
  // nothing and skips the whole sweep for good once the last young settlement
  // finds its feet — which, in a realm of any age, is nearly always.
  const anyBootstrapping = ctx.traders.some(
    (t) => t instanceof Settlement && !everBootstrapped.has(t) && t.population < SETTLEMENT_BOOTSTRAP_FLOOR,
  );
  if (!anyBootstrapping) {
    bootstrapWait.clear();
    return;
  }

  const sweep = ++bootstrapSweep;
  const visit = (site: ResourceNode | Industry): void => {
    if (site.workers.length > 0 || !bootstrappingHome(site, ctx.traders)) {
      bootstrapWait.delete(site);
      return;
    }
    const entry = bootstrapWait.get(site);
    const waited = Math.min(1, (entry?.waited ?? 0) + dt / BOOTSTRAP_WAIT_RAMP_SECONDS);
    if (entry) {
      entry.waited = waited;
      entry.sweep = sweep;
    } else {
      bootstrapWait.set(site, { waited, sweep });
    }
  };
  for (const node of ctx.nodes) visit(node);
  for (const industry of ctx.industries) visit(industry);

  // Anything that no longer exists (a node or industry from a prior tick's
  // list — nothing is ever actually removed today, but this keeps the map
  // from quietly growing if that ever changes) never gets read again. Stamped
  // rather than collected into a set, so the common case — a few sites
  // waiting out of several hundred — costs nothing per tick.
  for (const [site, entry] of bootstrapWait) if (entry.sweep !== sweep) bootstrapWait.delete(site);
}

/** Extra pull toward staffing a site whose nearest resident trader is a settlement still finding its first feet. */
function settlementBootstrapBonus(site: ResourceNode | Industry, traders: Trader[]): number {
  if (!bootstrappingHome(site, traders)) return 0;
  const waited = bootstrapWait.get(site)?.waited ?? 0;
  return SETTLEMENT_BOOTSTRAP_BONUS + waited * BOOTSTRAP_WAIT_MAX_BONUS;
}

/**
 * How much of a haul the network the player drew actually is: how many pairs
 * of hands it takes to keep what is being produced moving.
 *
 * This used to be a flat share of the workforce (15%, rounded). Two things
 * are wrong with a share. It is arbitrary — nothing about "one in seven
 * people" follows from anything in the world. And, worse, hiring stopped
 * *exactly* at it, so the civilisation sat pinned to the floor forever: at
 * forty-four people it ran seven carriers no matter whether the deposits
 * were next door or half a map away, deliveries fell behind, and since
 * population reads the delivery rate the whole thing quietly starved with
 * every post filled.
 *
 * What actually decides how many carriers a civilisation needs is Little's
 * law over the roads it has: goods appear at some rate, each round trip
 * takes as long as the road makes it take, and one person can only be on one
 * trip at a time. Deriving it that way makes road-building matter in the
 * most direct possible sense — a shorter, better-placed road is fewer people
 * spent walking and more people left to produce, which is the entire
 * proposition of a game about drawing roads.
 *
 * Deliberately built from production *rate* and route *length* — properties
 * of the geography and of who is posted where — rather than from the pile of
 * uncollected goods, which is a consequence of the carrier count and would
 * oscillate against it. (The same trap `MigrationSystem.workDraw` fell into
 * and had to be pulled back out of.)
 */
function haulageDemand(ctx: SimContext): number {
  let needed = 0;

  for (const node of ctx.nodes) {
    if (!node.isConnected) continue;
    const rate = node.productionRate;
    if (rate <= 0) continue;

    // Straight-line to whoever would receive it, marked up for the fact that
    // no road runs straight. Cheap on purpose: this is consulted every tick,
    // and pricing a real route per node per tick buys precision the answer
    // does not need.
    const home = nearestTrader(node.position, ctx.traders);
    needed += (rate * roundTripFrom(node.position, home.position)) / CARRY_CAPACITY;
  }

  // The second hop, which this used to be blind to.
  //
  // Raw goods come out of the ground and are carried to the nearest place
  // that can take them — that is the loop above, and for most of this
  // project's life it was the whole of the freight. It stopped being the
  // whole of it when the processing economy started actually running: a
  // worked good is made at a workshop and then has to travel *again*, to
  // whoever is building with it, and a realm of thirty places redistributing
  // planks, blocks, tools and fittings among themselves is running a great
  // deal of traffic this formula could not see.
  //
  // The consequence was a reserve sized for half the work being done, so the
  // labour market kept posting people to workplaces well past the point where
  // another pair of hands on the road was worth more than another pair at a
  // face. Measured on seed 1234 at day 151: simply doubling this number —
  // crudely, as an experiment — lifted food actually arriving by a tenth and
  // wealth income by a fifth, on identical population. That is the signature
  // of a binding constraint, and the fix is to price the trip rather than to
  // multiply by two.
  //
  // Same shape as the loop above and for the same reason: built from the
  // production *rate* of each workshop and the length of the road out, both
  // properties of staffing and geography, never from the pile of goods
  // waiting — which is a consequence of the carrier count and would oscillate
  // against it.
  for (const industry of ctx.industries) {
    const rate = industry.productionRate;
    if (rate <= 0) continue;
    const owner = industry.owner;
    let nearest = Infinity;
    for (const trader of ctx.traders) {
      if (trader === owner) continue;
      nearest = Math.min(nearest, dist(owner.position, trader.position));
    }
    if (!Number.isFinite(nearest)) continue;
    needed += (rate * roundTripFrom({ x: 0, y: 0 }, { x: nearest, y: 0 })) / CARRY_CAPACITY;
  }

  // A ceiling, or a civilisation with a long supply line would put literally
  // everyone on the road and produce nothing for them to carry.
  return Math.max(1, Math.min(Math.round(needed), Math.floor(ctx.villagers.length * MAX_LOGISTICS_SHARE)));
}

/**
 * How long one out-and-back costs, straight-line marked up for the fact that
 * no road runs straight. Cheap on purpose: this is consulted every tick for
 * every node and every workshop, and pricing a real route each time buys
 * precision the answer does not need.
 */
function roundTripFrom(from: Vec2, to: Vec2): number {
  const oneWay = (dist(from, to) * ROUTE_DETOUR) / WALK_SPEED;
  return 2 * oneWay + LOAD_TIME + UNLOAD_TIME;
}

/** How much longer a real road is than the straight line it approximates. */
const ROUTE_DETOUR = 1.3;
/** No more than this share of the workforce may ever be out carrying. */
const MAX_LOGISTICS_SHARE = 0.5;

/**
 * Turns idle villagers into transporters and runs their delivery rounds.
 *
 * Every dispatch asks `trade.ts` for the single most worthwhile shipment on
 * the board — production backing up at a node, or a settlement's own
 * surplus — and just carries it out. Where a load starts and ends is not
 * fixed to any one pairing: a forest, a farm with too much grain, and a
 * granary running short are all just sources and destinations to this system.
 */
export class TransportSystem {
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.dispatch(ctx);

    for (const villager of ctx.villagers) {
      if (villager.role === VillagerRole.Transporter) this.step(villager, dt, ctx);
    }
  }

  private dispatch(ctx: SimContext): void {
    if (this.cooldown > 0) return;
    if (!ctx.villagers.some((v) => v.isFree)) return;

    // Charged up front, not only on success. `findBestShipment` prices every
    // source against every destination — routes included — so it is by far
    // the most expensive decision in the game, and when it comes back empty
    // (which it does constantly, since a civilisation with nothing worth
    // moving is the *normal* state) it used to be re-asked on every single
    // tick. Answering a question this heavy more often than a villager could
    // possibly act on it buys nothing.
    //
    // How long the gap is scales with how many people are actually standing
    // about waiting for work. A flat interval is a global serial queue: one
    // load leaves every 0.7 seconds no matter how big the civilisation gets,
    // which put a hard ceiling of a few hundred units a minute on *all* trade
    // everywhere — a ceiling two hundred residents comfortably outgrew, at
    // which point eighty of them simply stood idle while the shelves emptied
    // around them. The interval exists so a village's carriers don't set off
    // in one clump, and a busier place genuinely does send more of them.
    const waiting = ctx.villagers.reduce((n, v) => n + (v.isFree ? 1 : 0), 0);
    this.cooldown = DISPATCH_INTERVAL / Math.max(1, Math.min(MAX_DISPATCH_RATE, waiting / WAITING_PER_CARAVAN));

    const idleHomes = idleByHome(ctx.villagers);
    const shipment = findBestShipment({
      nodes: ctx.nodes,
      traders: ctx.traders,
      traffic: ctx.traffic,
      // Priced from whichever idle villager is actually nearest the source —
      // not always the founding village any more.
      pickupRouteTo: (source) => nearestIdleAmong(idleHomes, source, ctx.routeBetweenSites)?.route ?? null,
      routeBetween: (a, b) => ctx.routeBetweenSites(a, b),
    });
    if (!shipment) return;

    const picked = nearestIdleAmong(idleHomes, shipment.source, ctx.routeBetweenSites);
    if (!picked) return;
    const idle = picked.villager;

    idle.role = VillagerRole.Transporter;
    idle.task = shipment.source;
    idle.resource = shipment.resource;
    idle.destination = shipment.destination;
    // Set for the whole round, including the empty walk out: someone who has
    // gone to fetch a cart is travelling with a cart, and arrives at the
    // pickup no faster than the cart does.
    idle.convoy = shipment.convoy;
    idle.leg = TransportLeg.ToPickup;
    idle.setRoute(picked.route);
    idle.claim = shipment.amount;

    if (shipment.source instanceof ResourceNode) shipment.source.claimed += idle.claim;
    else pledgeExport(shipment.source, shipment.resource, idle.claim);
    pledgeTo(shipment.destination, shipment.resource, idle.claim);
  }

  private step(villager: Villager, dt: number, ctx: SimContext): void {
    const task = villager.task;
    const destination = villager.destination;
    const resource = villager.resource;
    if (!task || !destination || !resource) {
      villager.release();
      return;
    }

    switch (villager.state) {
      case VillagerState.Walking: {
        if (!villager.advance(dt, ctx.costAt(villager.position))) return;

        if (villager.leg === TransportLeg.Returning) {
          if (villager.workplace) this.resumePost(villager);
          else villager.release();
          return;
        }

        if (villager.leg === TransportLeg.ToPickup) {
          villager.state = VillagerState.Loading;
          villager.timer = LOAD_TIME;
        } else {
          villager.state = VillagerState.Unloading;
          villager.timer = UNLOAD_TIME;
        }
        return;
      }

      case VillagerState.Loading: {
        villager.timer -= dt;
        if (villager.timer > 0) return;

        const claimed = villager.claim;
        villager.claim = 0;
        let amount: number;

        if (task instanceof ResourceNode) {
          task.claimed = Math.max(0, task.claimed - claimed);
          amount = task.collect(claimed);
        } else {
          amount = withdraw(task, resource, claimed);
          unpledgeExport(task, resource, claimed);
          // Selling surplus, not just moving it home — the source trader
          // earns for it. Raw production landing straight from a node is
          // deliberately not a wealth event; see `economy.ts`'s comment.
          if (amount > 0) recordWealth(task, BASE_VALUE[resource] * amount);
        }

        if (amount > 0) {
          villager.cargo = { resource, amount };
          ctx.emit({ type: 'pickup', at: { ...task.position }, resource, amount });
        }
        // Whatever the pledge overstated (the source came up short), the
        // destination should stop counting on it arriving.
        if (claimed > amount) unpledgeFrom(destination, resource, claimed - amount);

        const onward = ctx.routeBetweenSites(task, destination);
        if (!onward) {
          villager.release();
          return;
        }
        villager.leg = TransportLeg.ToDestination;
        villager.setRoute(onward);
        return;
      }

      case VillagerState.Unloading: {
        villager.timer -= dt;
        if (villager.timer > 0) return;

        const cargo = villager.cargo;
        if (cargo) {
          if (destination instanceof ResourceNode) {
            destination.invest(cargo.amount);
          } else {
            destination.storage[cargo.resource] += cargo.amount;
            recordDelivery(destination, cargo.resource, cargo.amount);
          }
          unpledgeFrom(destination, cargo.resource, cargo.amount);
          ctx.emit({
            type: 'deposit',
            at: { ...destination.position },
            resource: cargo.resource,
            amount: cargo.amount,
          });
        }

        if (villager.route) ctx.recordTrip(villager.route, cargo?.resource ?? null, cargo?.amount ?? 0);

        // An ordinary transporter's round trip ends by rejoining the
        // general labour pool at wherever they actually call home, not by
        // walking back to wherever they started — that's what lets a
        // newly-revealed, more urgent shortage win the next hand instead of
        // the old job reclaiming it by default. A worker who only stepped
        // away to clear their own node's backlog is different: that post
        // was never vacated (see `WorkerDeliverySystem`), so they go
        // straight back to it — walking it through the idle pool first
        // would let someone else be dispatched into a job that was never
        // actually open.
        const returnTarget = villager.workplace ?? villager.home;
        if (destination === returnTarget) {
          if (villager.workplace) this.resumePost(villager);
          else villager.release();
          return;
        }

        const route = ctx.routeBetweenSites(destination, returnTarget);
        if (!route) {
          if (villager.workplace) this.resumePost(villager);
          else villager.release();
          return;
        }
        villager.leg = TransportLeg.Returning;
        villager.cargo = null;
        villager.setRoute(route);
        return;
      }

      default:
        villager.release();
    }
  }

  /**
   * A worker who only left their post to carry off their own node's
   * backlog (see `WorkerDeliverySystem`) was never actually taken off its
   * roster, so coming home means picking the same job back up directly —
   * no re-hire, no detour through the general idle pool where someone else
   * could claim the opening in the meantime. Deliberately doesn't touch
   * `workplace`/`industryWorkplace`, position, or the node's own `workers`
   * array — none of that ever changed while they were out.
   */
  private resumePost(villager: Villager): void {
    villager.role = VillagerRole.Worker;
    villager.state = VillagerState.Working;
    villager.route = null;
    villager.task = null;
    villager.resource = null;
    villager.destination = null;
    villager.leg = TransportLeg.ToPickup;
    villager.cargo = null;
    villager.claim = 0;
    villager.timer = 0;
  }
}

/**
 * Posts villagers to connected resource nodes. Unlike transporters they make
 * the trip once and then stay for good.
 */
export class WorkforceSystem {
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    advanceBootstrapWaits(dt, ctx);
    this.rebalance(ctx);
    this.post(ctx);

    for (const villager of ctx.villagers) {
      if (villager.role === VillagerRole.Worker && villager.workplace) this.step(villager, dt, ctx);
      // A trade is kept up by working at it and fades when it isn't — see
      // `craft.ts`. Everyone is asked once a tick, here rather than in each
      // of the three systems that can hold a person, so nobody can quietly
      // fall between them and keep a master's hands forever.
      if (villager.state === VillagerState.Working) practise(villager, dt);
      else forget(villager, dt);
    }
  }

  /**
   * Hiring alone only ever pulls people *into* permanent work, never back
   * out — so if a burst of new openings (a couple of settlements each
   * spawning a fresh farm and quarry around the same time) pushes the
   * transporter pool below its reserve in one go, nothing ever gave those
   * hands back, and logistics stayed collapsed for good even as the workers
   * it starved sat there fully staffed. This is the other half of the
   * reserve: if the transporter pool is short of its target and nobody is
   * currently free to make up the difference, give up the least-needed
   * worker back to the general pool so the next dispatch can pick them up.
   */
  private rebalance(ctx: SimContext): void {
    if (ctx.villagers.some((v) => v.isFree)) return;

    const totalTransporters = ctx.villagers.filter((v) => v.role === VillagerRole.Transporter).length;
    if (totalTransporters >= haulageDemand(ctx)) return;

    const staffedNodes = ctx.nodes.filter((n) => n.workers.some(isAtPost));
    const staffedIndustries = ctx.industries.filter((ind) => ind.workers.some(isAtPost));
    const allStaffed = [...staffedNodes, ...staffedIndustries];
    // A settlement still bootstrapping its first residents (see
    // `settlementBootstrapBonus`) is exactly the kind of low
    // civilisation-wide-priority post this would otherwise demote first,
    // undoing the bootstrap the moment logistics gets tight. Only reach
    // into one if there's truly nowhere else to pull from.
    const notBootstrapping = allStaffed.filter((s) => settlementBootstrapBonus(s, ctx.traders) === 0);
    const pool = notBootstrapping.length > 0 ? notBootstrapping : allStaffed;
    const donor = pool.sort((a, b) => sitePriority(a, ctx.traders) - sitePriority(b, ctx.traders))[0];
    if (!donor) return;

    const worker = leastCommitted(donor);
    if (!worker) return;
    donor.workers.splice(donor.workers.indexOf(worker), 1);
    if (donor instanceof ResourceNode && donor.workers.length === 0) donor.state = NodeState.Connected;
    worker.workplace = null;
    worker.industryWorkplace = null;
    worker.release();
  }

  private post(ctx: SimContext): void {
    if (this.cooldown > 0) return;

    // One labour market, not two: a resource node and an industry both
    // compete for the same idle hands on equal footing, priced the same
    // way. Keeping industries in a separate system with their own claim on
    // idle labour was tried and reverted — nothing stopped a sawmill and a
    // masonry from both grabbing a worker on the same tick a farm badly
    // needed one, and population collapsed within the hour. There has to
    // be exactly one decision-maker for "who's most needed right now".
    //
    // Whichever good the civilisation as a whole is shortest on gets staffed
    // first — not just the founding village's own larder. A settlement can't
    // grow a farm of its own, so if nobody weighs its hunger here, nothing
    // ever answers it: production stays sized to the village alone while
    // settlements pile on demand it was never staffed to meet.

    // A node's or industry's own growth decides how many hands it can host
    // now — not whichever trader happens to be nearest it — and an industry
    // additionally needs raw material actually on hand before it's worth
    // anyone's time.
    //
    // There used to be a third condition here: a population floor at the
    // owning place, to answer "is this a village at all, or a pair of huts
    // with no business hosting a workshop?". It is gone, and nothing replaced
    // it, because the question is no longer this system's to ask. A workshop
    // has to be *built* now (see `construction.ts`), out of material carried
    // here, and it only ever gets built where the realm is short of the
    // worked good and this place has raw material going spare. A pair of huts
    // with no timber surplus has no sawmill to staff — not because a rule
    // forbids it, but because nobody ever built one. That is the same answer
    // arrived at one layer down, where it costs something and is visible.
    //
    // Worth recording what the floor cost while it stood, since the shape
    // recurs: it was a per-place headcount in a game whose entire design
    // spreads population across many small places, so every settlement a
    // prospering realm founded divided the population further and made
    // industry strictly *less* likely. A gate that gets harder to pass the
    // better the game goes is not a safety rail, it is an off switch.
    const nodeOpenings = ctx.nodes.filter((n) => n.isConnected && n.workers.length + n.incomingWorkers < n.workerCapacity);
    const industryOpenings = ctx.industries.filter(
      (ind) => ind.exists && ind.hasInput && ind.workers.length + ind.incomingWorkers < ind.workerCapacity,
    );
    const openings: (ResourceNode | Industry)[] = [...nodeOpenings, ...industryOpenings];
    if (openings.length === 0) return;
    const priority = (site: ResourceNode | Industry) => sitePriority(site, ctx.traders);
    // Which specific opening wins also weighs whether it would give a
    // still-empty settlement its first residents, not just which resource
    // is shortest civilisation-wide — see `settlementBootstrapBonus`.
    const openingScore = (site: ResourceNode | Industry) =>
      priority(site) + settlementBootstrapBonus(site, ctx.traders);
    openings.sort((a, b) => openingScore(b) - openingScore(a));
    const target = openings[0];
    const targetSite = target instanceof Industry ? target.owner : target;

    // Staffed from whoever is actually nearest, not always the founding
    // village's own pool — a wood camp beside a struggling settlement gets
    // worked by that settlement's own idle people first.
    const nearest = nearestIdleTo(ctx.villagers, targetSite, ctx.routeBetweenSites, target.resource);
    if (nearest) {
      // Posting every last person, anywhere, would leave nobody free to
      // physically carry anything, so a growing share is always held back
      // for logistics — civilisation-wide now, not per place. A flat "at
      // least one" was tried and reverted: a tiny new settlement already has
      // several flows going at once (wood, stone, food, maybe an investment
      // run), and one person can only ever be running one of them —
      // production was fine, but goods stopped reliably *arriving*, and
      // population depends on delivered throughput, not what's sitting
      // produced at the node. How big that reserve is comes from the roads
      // themselves — see `haulageDemand` — so a sprawling network genuinely
      // costs a civilisation the hands to service it.
      const totalWorkers = ctx.villagers.filter((v) => v.role === VillagerRole.Worker).length;
      if (ctx.villagers.length - totalWorkers <= haulageDemand(ctx)) return;

      nearest.villager.role = VillagerRole.Worker;
      // `release()` already guarantees an idle candidate holds neither
      // field, but setting both explicitly here — the same as the poach
      // path below already does — costs nothing and keeps every place a
      // job gets assigned equally safe against a future hire path that
      // skips `release()`.
      if (target instanceof Industry) {
        nearest.villager.industryWorkplace = target;
        nearest.villager.workplace = null;
      } else {
        nearest.villager.workplace = target;
        nearest.villager.industryWorkplace = null;
      }
      nearest.villager.setRoute(nearest.route);
      target.incomingWorkers++;
      this.cooldown = DISPATCH_INTERVAL;
      return;
    }

    // Nobody spare anywhere. With a small population every workplace can end
    // up permanently staffed by whoever got there first, so a newly-reachable
    // shortage — a farm the village only just grew far enough to see, say —
    // can otherwise never win a hand at all. If it is dramatically worse off
    // than what an existing worker is currently addressing, move one over —
    // out of an industry just as readily as out of another node, since
    // they're the same labour market now. The gap has to be wide, not just
    // "a bit worse", so two openings don't sit there trading the same pair
    // of hands back and forth.
    const staffedNodes = ctx.nodes.filter((n) => n !== target && n.workers.some(isAtPost));
    const staffedIndustries = ctx.industries.filter((ind) => ind !== target && ind.workers.some(isAtPost));
    // A site still bootstrapping a settlement's first residents is exempt
    // from being raided, same as in `rebalance` — otherwise two still-empty
    // settlements just trade the same handful of workers back and forth,
    // each one's bonus in turn justifying poaching from the other, and
    // neither ever actually grows.
    const allStaffed = [...staffedNodes, ...staffedIndustries];
    const donorPool = allStaffed.filter((s) => settlementBootstrapBonus(s, ctx.traders) === 0);
    const donor = (donorPool.length > 0 ? donorPool : allStaffed).sort(
      (a, b) => priority(a) - priority(b),
    )[0];
    if (!donor) return;

    // Whoever the donor can most afford to lose: its greenest hand, not
    // whichever name happens to sit first on its roster. A site with a
    // master and an apprentice gives up the apprentice, which is both
    // obviously right and the thing that lets a long-standing crew survive
    // being raided at all.
    const worker = leastCommitted(donor);
    if (!worker) return;
    // And the gap has to be wider the deeper that person is into a different
    // trade. A flat margin could never be right for both cases it had to
    // cover: small enough that a genuinely urgent shortage wins, large enough
    // that two openings don't trade the same pair of hands forever. Pricing
    // the *person* instead of the threshold resolves it — a green hand moves
    // for very little, a lifelong woodcutter only for a famine — and it is
    // what makes a civilisation settle into tradesmen without anything
    // deciding that it should.
    const cost = REASSIGN_MARGIN + COMMITMENT_WEIGHT * commitmentOf(worker, target.resource);
    if (openingScore(target) - priority(donor) < cost) return;

    const route = ctx.routeBetweenSites(worker.home, targetSite);
    if (!route) return;

    donor.workers.splice(donor.workers.indexOf(worker), 1);
    if (donor instanceof ResourceNode && donor.workers.length === 0) donor.state = NodeState.Connected;
    if (target instanceof Industry) {
      worker.industryWorkplace = target;
      worker.workplace = null;
    } else {
      worker.workplace = target;
      worker.industryWorkplace = null;
    }
    worker.setRoute(route);
    target.incomingWorkers++;
    this.cooldown = DISPATCH_INTERVAL;
  }

  private step(villager: Villager, dt: number, ctx: SimContext): void {
    if (villager.state !== VillagerState.Walking) return;

    const workplace = villager.workplace;
    if (!workplace) {
      villager.release();
      return;
    }

    if (!villager.advance(dt, ctx.costAt(villager.position))) return;

    villager.state = VillagerState.Working;
    villager.route = null;
    // Taking up the trade, not merely turning up: returning to one's own
    // craft costs nothing, changing craft costs most of a working life's
    // skill. See `craft.ts` — this is the one place a resource worker's
    // trade is ever set, and the arrival is the right moment for it because
    // it is the point of no return for a reassignment.
    takeUpCraft(villager, workplace.resource);
    // Settling in, not commuting forever: whoever's actually nearest this
    // node is now who the person who works it lives with, the same way a
    // real farmhand moves near the fields rather than walking in from a
    // hamlet three valleys over. This is what lets a settlement's own
    // population actually grow out of its own nodes getting staffed.
    // Housing (see `housing.ts`) caps the civilisation's total on purpose,
    // but deliberately doesn't block a specific settle-in like this one —
    // that was tried and reverted: it destabilised a young settlement's
    // population every time it dipped even briefly, since nothing could
    // ever settle back in to answer it once the one-time bootstrap
    // priority had already fired (see `settlementBootstrapBonus`).
    villager.home = nearestTrader(workplace.position, ctx.traders);
    workplace.incomingWorkers = Math.max(0, workplace.incomingWorkers - 1);
    workplace.workers.push(villager);
    workplace.state = NodeState.Operational;

    // Stand just off the node centre so the glyph stays readable.
    const slot = workplace.workers.length - 1;
    const angle = -Math.PI / 2 + slot * 1.1;
    villager.position = {
      x: workplace.position.x + Math.cos(angle) * (workplace.radius + 12),
      y: workplace.position.y + Math.sin(angle) * (workplace.radius + 12),
    };

    ctx.emit({
      type: 'workerArrived',
      at: { ...workplace.position },
      resource: workplace.resource,
    });
  }
}

/** How long an idle villager waits, finding nothing worthwhile nearby, before looking elsewhere. */
const MIGRATION_GRACE = 24;
/** How much better a reachable place's opportunity has to be before it's worth the walk. */
const MIGRATION_MARGIN = 0.35;
/** Gap between one person deciding to move and the next, so a place doesn't empty out in one tick. */
const MIGRATION_COOLDOWN = 2;
/**
 * How much one unstaffed job in a place's catchment is worth to somebody
 * deciding where to live — see `MigrationSystem.workDraw`. Set so a single
 * open post already clears `MIGRATION_MARGIN` against a comfortable
 * neighbour: one unworked deposit is a real reason to move out there, which
 * is exactly the pull a new settlement needs to stop being a hamlet of two.
 */
const WORK_DRAW_PER_SLOT = 0.4;
/**
 * What one unit per second of production in a place's catchment is worth to
 * somebody deciding where to live — goods that come out of the ground have
 * to be carried by somebody, and that somebody may as well live here.
 *
 * This deliberately measures what the catchment *generates*, not what is
 * currently piled up in it unclaimed. Backlog was tried first and is the
 * more obvious signal — a full shed nobody has come for is exactly the
 * inefficiency this whole rule exists to answer — but it is a *consequence*
 * of where people live, which makes it violently unstable: the population
 * moves to the worst backlog, clears it between them, the draw collapses to
 * nothing, everybody leaves again, and the backlog rebuilds. Settlements
 * were swinging between twenty residents and zero. Production rate is the
 * same information taken from the geography instead of from the symptom, so
 * it doesn't evaporate the moment anyone shows up to help.
 */
const PRODUCTION_DRAW_PER_UNIT = 1.0;
/** Brings work-per-resident back into the same 0-1 range the migration margin is tuned against. */
const WORK_DRAW_SCALE = 6;
/** Keeps an empty place's work-per-resident finite, and stops a hamlet of one from reading as infinitely needy. */
const WORK_DRAW_POPULATION_BASE = 3;

/**
 * Nobody is stuck. An idle villager who's found nothing worth doing near
 * home for a while looks at everywhere else reachable and, if somewhere is
 * genuinely more promising, walks there and settles in — the same shape as
 * any other trip on the network, just ending in a change of address instead
 * of a delivery or a workplace. A struggling timber town's people drift
 * toward wherever the opportunity actually is; nobody idles away at a
 * floor, and nobody has to disappear.
 */
export class MigrationSystem {
  private readonly idleSince = new Map<Villager, number>();
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);

    for (const villager of ctx.villagers) {
      if (villager.role !== VillagerRole.Idle) {
        this.idleSince.delete(villager);
        continue;
      }
      if (villager.state === VillagerState.Walking) {
        this.stepMigrant(villager, dt, ctx);
        continue;
      }
      this.idleSince.set(villager, (this.idleSince.get(villager) ?? 0) + dt);
    }

    this.relocate(ctx);
  }

  private stepMigrant(villager: Villager, dt: number, ctx: SimContext): void {
    if (!villager.advance(dt, ctx.costAt(villager.position))) return;

    const destination = villager.task;
    villager.task = null;
    villager.state = VillagerState.Waiting;
    if (destination && !(destination instanceof ResourceNode)) villager.home = destination;
    villager.restAtHome();
  }

  /**
   * How badly this place could use another pair of hands right now — the
   * whole basis for anyone deciding to move house.
   *
   * Shortage of goods alone is not enough, and gets the answer backwards at
   * exactly the moment it matters. A trader's `targetStock` scales with its
   * population, and is flatly zero at population zero, so a freshly founded
   * settlement out by a new deposit is short of *nothing* — it has nobody to
   * be short on behalf of — and scores zero, permanently, while the big old
   * village with hundreds of mouths always has some shortage somewhere and
   * scores highest. Left there, migration is a rule that concentrates
   * everyone at whichever place is already largest, and every settlement
   * founded out in the country stays a hamlet of three forever (or, worse, a
   * ghost at zero that nothing can ever repopulate).
   *
   * Worse than backwards, in fact: it was inert. Taking the max shortage
   * across *every* tracked good includes the processed ones, and planks,
   * stone blocks and tools sit at a flat 1.0 shortage at every place in the
   * game until industries are running — so `opportunity` returned exactly
   * 1.0 for everywhere, always, and no destination could ever clear
   * `MIGRATION_MARGIN` over any home. Migration has quietly never moved a
   * single villager. Nothing looked broken; people simply stayed where they
   * were born, which is indistinguishable from "nobody wanted to move".
   *
   * What a villager is actually deciding is where the *work* is — it is
   * more efficient to live by the deposits than to keep walking back to
   * where you were born, which is the whole reason a distant deposit grows
   * a settlement around itself. That signal discriminates properly between
   * places, so it is the only one here now.
   */
  private opportunity(trader: Trader, ctx: SimContext): number {
    return this.workDraw(trader, ctx);
  }

  /**
   * Work waiting in a trader's own catchment — the nodes it is the nearest
   * place to. Two kinds, and the second one turns out to matter far more:
   *
   * - a post nobody is standing at, and
   * - goods piling up that nobody is carrying.
   *
   * Open posts alone read as zero almost all the time: a level-one node
   * holds exactly one worker, so the moment every node has its one person
   * the whole map reports "no work anywhere" even while deposits three
   * valleys out are visibly choking on uncollected stock. Backlog is the
   * honest signal, and it is precisely the one a villager would actually
   * act on — a shed full of timber nobody has come for means whoever *does*
   * come for it is walking too far, and would be better off living here.
   * That is the entire reason a distant deposit grows a settlement around
   * itself instead of being serviced forever by long hauls from the place
   * everyone happened to be born in.
   */
  private workDraw(trader: Trader, ctx: SimContext): number {
    let openSlots = 0;
    let production = 0;

    for (const node of ctx.nodes) {
      if (!node.isConnected) continue;
      if (nearestTrader(node.position, ctx.traders) !== trader) continue;

      openSlots += Math.max(0, node.workerCapacity - node.workers.length - node.incomingWorkers);
      // Summed, so a catchment of five deposits pulls harder than one —
      // which is what spreads people across the country rather than
      // collecting them all in one place.
      production += node.productionRate;
    }

    // A trader's own industries are work too, and are most of why the
    // founding village stays worth living in at all once the deposits
    // around it are taken: it is a place that *makes* things, not a
    // catchment.
    for (const industry of trader.industries) {
      if (!industry.hasInput) continue;
      openSlots += Math.max(0, industry.workerCapacity - industry.workers.length - industry.incomingWorkers);
    }

    const work = openSlots * WORK_DRAW_PER_SLOT + production * PRODUCTION_DRAW_PER_UNIT;

    // Per resident, not in total — and this is what keeps the whole thing
    // from oscillating. Raw backlog is an undamped signal: whichever
    // catchment is worst off attracts *everybody*, who clear it between
    // them, at which point somewhere else is worst off and the entire
    // population walks there instead. Measured per head, a place's pull
    // falls as people actually arrive, so migration settles at the point
    // where work per resident is roughly even everywhere — which is both
    // stable and exactly the efficient answer the villagers are supposed to
    // be reaching. The base stops a place with nobody in it from dividing
    // by zero into infinite appeal.
    const perCapita = (work * WORK_DRAW_SCALE) / (trader.population + WORK_DRAW_POPULATION_BASE);

    // Headroom above 1 on purpose: if this saturated, a whole frontier of
    // badly-served catchments would read as identically needy and stop
    // discriminating between them, which is the exact failure the goods
    // term above had.
    return Math.min(1.5, perCapita);
  }

  private relocate(ctx: SimContext): void {
    if (this.cooldown > 0) return;
    // Charged whether or not anyone actually moves. The cooldown used to be
    // set only on a successful relocation, which meant that in the ordinary
    // case — nobody has a good enough reason to move — the whole scan below
    // ran again on the very next tick, and every tick after that. Since the
    // scan is a route lookup per idle villager per destination, its cost
    // grows with the square of how well the civilisation is doing, and at a
    // hundred residents it was the single most expensive thing in the game.
    // Nothing here changes fast enough to be worth answering more often than
    // this anyway.
    this.cooldown = MIGRATION_COOLDOWN;

    // A place's appeal is a property of the place, not of who is asking, so
    // it is worth computing once rather than once per candidate per villager.
    const opportunity = new Map<Trader, number>();
    for (const trader of ctx.traders) opportunity.set(trader, this.opportunity(trader, ctx));

    for (const [villager, idleTime] of this.idleSince) {
      if (idleTime < MIGRATION_GRACE) continue;

      const home = villager.home;
      let bestOpportunity = (opportunity.get(home) ?? 0) + MIGRATION_MARGIN;
      let best: { trader: Trader; route: Route } | null = null;

      for (const trader of ctx.traders) {
        if (trader === home) continue;
        const value = opportunity.get(trader) ?? 0;
        if (value < bestOpportunity) continue;
        const route = ctx.routeBetweenSites(home, trader);
        if (!route) continue;
        bestOpportunity = value;
        best = { trader, route };
      }

      if (!best) continue;

      villager.task = best.trader;
      villager.setRoute(best.route);
      this.idleSince.delete(villager);
      return;
    }
  }
}

/**
 * Posts villagers to industries the same way `WorkforceSystem` posts them to
 * resource nodes — worst civilisation-wide shortage of the output wins,
 * staffed from whoever's nearest — except an industry also has to actually
 * have raw material on hand before it's worth anyone's time. This is the
 * whole of "activation": an industry with nobody posted to it is just inert,
 * so a sawmill only ever runs because wood is abundant and planks are
 * short, never because the player asked for one.
 */
export class IndustrySystem {
  update(dt: number, ctx: SimContext): void {
    for (const villager of ctx.villagers) {
      if (villager.role === VillagerRole.Worker && villager.industryWorkplace) this.step(villager, dt, ctx);
    }
  }

  private step(villager: Villager, dt: number, ctx: SimContext): void {
    if (villager.state !== VillagerState.Walking) return;

    const workplace = villager.industryWorkplace;
    if (!workplace) {
      villager.release();
      return;
    }

    if (!villager.advance(dt, ctx.costAt(villager.position))) return;

    villager.state = VillagerState.Working;
    villager.route = null;
    takeUpCraft(villager, workplace.resource);
    // An industry already has one unambiguous owner — no need to hunt for
    // whoever's nearest, unlike a shared resource node.
    villager.home = workplace.owner;
    workplace.incomingWorkers = Math.max(0, workplace.incomingWorkers - 1);
    workplace.workers.push(villager);

    // Stand just off the owner's own centre, same trick a node uses to keep
    // its glyph readable with several workers stood around it.
    const owner = workplace.owner;
    const slot = workplace.workers.length - 1;
    const angle = -Math.PI / 2 + slot * 1.1;
    villager.position = {
      x: owner.position.x + Math.cos(angle) * (owner.radius + 12),
      y: owner.position.y + Math.sin(angle) * (owner.radius + 12),
    };
  }
}
