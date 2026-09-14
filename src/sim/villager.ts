import type { TradeSource, Trader } from './economy';
import type { Vec2 } from './geometry';
import type { Industry } from './industry';
import type { ResourceNode } from './resourceNode';
import type { Route } from './roadNetwork';
import { DAYS_JOURNEY_METRES, HOURS_PER_DAY, METRES_PER_UNIT } from './scale';
import { ROAD_DEVELOPED, WEAR_FULL } from './traffic';
import { ResourceType, VillagerRole, VillagerState } from './types';

/**
 * How fast a villager covers open ground, in world units per in-game hour.
 *
 * Derived rather than chosen, so it cannot drift away from what the rest of
 * the map means — see `scale.ts`. It was 82 for most of this project's life,
 * which is a fifth of this, and the discrepancy only became visible when a
 * map of a real place turned up: at 82 a villager managed a third of a
 * kilometre an hour, or eight kilometres in a day, and a trip to the wood at
 * the edge of the parish took the better part of a day each way. The economy
 * was built on top of that, so nearly half the workforce was always out
 * carrying — not because hauling is genuinely that dear at three kilometres,
 * but because everyone was walking at the pace of a slow tortoise.
 *
 * Ground still has its say on top of this (`TERRAIN_COSTS`), as does the
 * state of the road (`wearEffort`).
 */
export const WALK_SPEED = DAYS_JOURNEY_METRES / HOURS_PER_DAY / METRES_PER_UNIT;
/** How much one villager can carry on their own back, with no road to help them. */
export const CARRY_CAPACITY = 3;

/**
 * How goods travel: on a back, on a cart, or in a train of them.
 *
 * This is the whole of "dedicated traders", and it is deliberately *not* a
 * job. Nobody is hired as a caravaneer, no settlement decides to raise one,
 * and the labour market is not told about any of this — which matters,
 * because every stall this simulation has produced so far came from adding
 * another claimant to the same small pool of people. A carter is simply what
 * a carrier *is* when the road under them will take a cart.
 *
 * So the road is the gate, and it gates the one thing that actually matters:
 * how much one person can move in one trip. A track through the woods will
 * carry a man with a sack. A packed road will take a cart. A highway, kept up
 * by the traffic already on it, will take a train of them. That is the loop
 * the whole design turns on — use packs the ground, packed ground carries
 * heavier loads, heavier loads pack it harder still — and it is bounded at
 * both ends: by `ROAD_DEVELOPED`, the scale a road is measured against, and by the
 * fact that there is only ever as much to carry as the country produces.
 *
 * The gate is the *weakest* stretch of the route, not its average. A caravan
 * is stopped by the worst bottleneck on its way, not consoled by the good
 * miles either side of it, and that single choice is what makes a player's
 * half-finished trunk road behave the way one should: it does nothing at all
 * until the last gap in it is closed, and then it does everything at once.
 */
export enum Convoy {
  Porter = 'porter',
  Carter = 'carter',
  Caravan = 'caravan',
}

export interface ConvoyClass {
  capacity: number;
  /** Multiplier on walking pace — a laden cart is slower than a man. */
  speed: number;
  /**
   * Wear the worst stretch of the route must actually carry, in the wear
   * field's own units.
   *
   * These were fractions of `ROAD_DEVELOPED` (18), and that turned out to be
   * the wrong scale for the lower rung, in a way that quietly switched off
   * most of this system. A cart needed 0.3 × 18 = 5.4 — which is *above*
   * `WEAR_FULL` (4.5), the point at which the model itself says the ground
   * has finished packing down and stops changing. So a cart required a road
   * firmer than the simulation admits ground can get, and got it only where
   * several routes overlapped.
   *
   * Measured on seed 1234 at day 120, across every connected deposit's road
   * home: weakest-stretch wear ran p10 0.00, median 0.38, p90 4.08. Fifty-seven
   * of sixty-one hauls were long enough to want a cart and could not have one;
   * the realm ran forty porters averaging a two-thousand-seven-hundred-unit
   * round, which is exactly the "why is nobody using a waggon" the design was
   * built to avoid.
   *
   * The two rungs are now measured against the two scales the project already
   * separated, because they are asking those scales' two different questions.
   * A **cart** needs firm ground — a made track — and that is a question about
   * soil, so it is priced against `WEAR_FULL` and saturates where soil does. A
   * **waggon train** needs standing in the network rather than merely dry mud,
   * so it is priced against `ROAD_DEVELOPED` and keeps answering long after
   * the ground has stopped changing. That is the same split, applied one level
   * down, that fixed every road in the realm reading as a highway.
   */
  needsWear: number;
  /**
   * How long the haul has to be before this is worth harnessing up at all.
   *
   * Without it, a cart forms for a two-hundred-unit hop between neighbouring
   * sheds — which is not wrong exactly, but it is not what a cart is *for*,
   * and it put trains of mules on every short local errand the moment the
   * ground around a village packed down. Distance is what distinguishes the
   * haulage this is meant to represent from ordinary fetching and carrying.
   */
  needsDistance: number;
}

export const CONVOY_CLASSES: Record<Convoy, ConvoyClass> = {
  [Convoy.Porter]: { capacity: CARRY_CAPACITY, speed: 1, needsWear: 0, needsDistance: 0 },
  [Convoy.Carter]: { capacity: 9, speed: 0.88, needsWear: 0.55 * WEAR_FULL, needsDistance: 420 },
  [Convoy.Caravan]: { capacity: 24, speed: 0.74, needsWear: 0.62 * ROAD_DEVELOPED, needsDistance: 950 },
};

/**
 * Heaviest thing that can travel this route, given its worst stretch and its
 * length — and, where a load is known, no heavier than the load warrants.
 *
 * That second clause matters more than it sounds. The class used to be decided
 * by the road alone, while how much actually went on it was capped separately
 * by whatever the source had spare. So a caravan regularly formed to carry
 * four units: a train of waggons harnessed up, moving a porter's load, at
 * three quarters of a porter's pace, packing the road no harder for it.
 * Strictly worse than walking, every time. Nobody harnesses a mule train to
 * carry one sack, and now nothing in the simulation does either.
 */
export function convoyFor(weakestWear: number, length: number, load = Infinity): Convoy {
  for (const convoy of [Convoy.Caravan, Convoy.Carter] as const) {
    const spec = CONVOY_CLASSES[convoy];
    if (weakestWear < spec.needsWear || length < spec.needsDistance) continue;
    // The smallest class that still carries the whole load: stepping down
    // costs nothing here, because a lighter class is never slower.
    return smallestFor(convoy, load);
  }
  return Convoy.Porter;
}

/** The lightest class at or below `allowed` that can still take `load` in one trip. */
function smallestFor(allowed: Convoy, load: number): Convoy {
  const ladder = [Convoy.Porter, Convoy.Carter, Convoy.Caravan] as const;
  const ceiling = ladder.indexOf(allowed);
  for (let i = 0; i < ceiling; i++) {
    if (load <= CONVOY_CLASSES[ladder[i]].capacity) return ladder[i];
  }
  return allowed;
}

export interface Cargo {
  resource: ResourceType;
  amount: number;
}

/** Which leg of a delivery round a transporter is currently walking. */
export enum TransportLeg {
  /** Village to the resource node. */
  ToPickup = 'toPickup',
  /** Resource node to wherever the goods are going. */
  ToDestination = 'toDestination',
  /** Back to the village, empty-handed, to rejoin the idle pool. */
  Returning = 'returning',
}

/**
 * One person. The same class covers idlers, resource workers and transporters;
 * what separates them is `role` and where their feet are pointed.
 */
export class Villager {
  readonly id: number;
  /**
   * Wherever this person currently calls home — the founding village or a
   * settlement, whichever they most recently settled at. Mutable: migration
   * is just this changing once someone's finished walking somewhere better.
   */
  home: Trader;

  role: VillagerRole = VillagerRole.Idle;
  state: VillagerState = VillagerState.Waiting;

  /**
   * The trade this person follows — see `craft.ts`. Not the workplace: a
   * woodcutter who moves from one forest to the next is the same woodcutter,
   * and it is changing what you do for a living that costs something.
   */
  craft: ResourceType | null = null;
  /**
   * How far into that trade they are, 0 to 1. Worth real output at the site
   * they work, mostly lost on taking up a different trade, and what makes
   * the labour market think twice before moving them.
   */
  experience = 0;

  /** Where a worker lives permanently, once it has arrived. */
  workplace: ResourceNode | null = null;
  /** Same idea, for a worker posted to an industry instead of a resource node. */
  industryWorkplace: Industry | null = null;
  /**
   * Where a transporter is currently headed to collect from — a resource
   * node's production, or a trader's own surplus. The road network treats
   * both the same way; this is the one place that has to know which it is.
   */
  task: TradeSource | null = null;
  /** Which good this trip is actually carrying, since `task` might not have just one. */
  resource: ResourceType | null = null;
  /** Where a transporter's cargo is bound for: the village, a settlement, or a node being invested in. */
  destination: Trader | ResourceNode | null = null;
  leg: TransportLeg = TransportLeg.ToPickup;

  route: Route | null = null;
  travelled = 0;
  /** Units this transporter reserved at its task, so nobody double-books them. */
  claim = 0;

  cargo: Cargo | null = null;
  /** What this trip is travelling as — decided by the road, not by the person. */
  convoy: Convoy = Convoy.Porter;
  timer = 0;

  position: Vec2;
  heading = 0;
  /** Current walking speed, after the ground has had its say. */
  speed = WALK_SPEED;
  /** Stable scatter so idlers do not stack on the village centre. */
  readonly restOffset: Vec2;

  constructor(id: number, home: Trader) {
    this.id = id;
    this.home = home;
    this.position = { ...home.position };

    const angle = (id * 2.39996) % (Math.PI * 2);
    const radius = home.radius + 16 + ((id * 7) % 18);
    this.restOffset = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.7 };
  }

  /**
   * Not currently committed to anything — idle and not mid-walk. Idle but
   * already walking means migrating to a new home — spoken for, even though
   * `role` alone wouldn't show it.
   */
  get isFree(): boolean {
    return this.role === VillagerRole.Idle && this.state !== VillagerState.Walking;
  }

  get isWalking(): boolean {
    return this.state === VillagerState.Walking;
  }

  /**
   * The pace penalty for whatever this person is hauling with — and only while
   * they are actually hauling.
   *
   * Derived from the role rather than trusted to be cleared, which is the
   * lesson `release()` below already records the hard way. `convoy` is set
   * when a round is dispatched, and a transporter who finishes a round and
   * goes back to a resource post does *not* go through `release()` — it goes
   * through `resumePost`, which tidies eight other fields. Add a ninth and the
   * miss is silent and permanent: a miner who once drove a waggon walks at
   * three quarters pace for the rest of their life, and nothing anywhere looks
   * wrong enough to find. Asked this way the question answers itself — you are
   * only slowed by a cart while you are the one driving it.
   */
  private get convoySpeed(): number {
    return this.role === VillagerRole.Transporter ? CONVOY_CLASSES[this.convoy].speed : 1;
  }

  setRoute(route: Route): void {
    this.route = route;
    this.travelled = 0;
    this.state = VillagerState.Walking;
    this.syncPosition();
  }

  /**
   * Advance along the current route; true once the far end is reached.
   *
   * `terrainCost` is the ground under this villager's feet right now, so they
   * visibly labour up a hill road and stride out again on the flat. Route
   * choice uses each road's average of the same number, which means the way
   * villagers pick really is the way they cover fastest.
   */
  advance(dt: number, terrainCost = 1): boolean {
    const route = this.route;
    if (!route) return true;

    const going = Number.isFinite(terrainCost) && terrainCost > 0 ? terrainCost : 1;
    this.speed = (WALK_SPEED / going) * this.convoySpeed;

    this.travelled += this.speed * dt;
    this.syncPosition();

    if (this.travelled >= route.length) {
      this.travelled = route.length;
      return true;
    }
    return false;
  }

  private syncPosition(): void {
    if (!this.route) return;
    const sample = this.route.sample(this.travelled);
    this.position = { x: sample.x, y: sample.y };
    this.heading = sample.angle;
  }

  restAtHome(): void {
    this.position = {
      x: this.home.position.x + this.restOffset.x,
      y: this.home.position.y + this.restOffset.y,
    };
    this.route = null;
    this.travelled = 0;
  }

  /**
   * The one place a villager becomes properly idle again — and so the one
   * place that has to guarantee `workplace`/`industryWorkplace` are both
   * clear. They used to survive a `release()` untouched, on the assumption
   * that whatever hired this person next would only ever set the one field
   * it cared about. That held right up until someone who'd once worked a
   * resource node (say, a mine) later got hired into an industry instead:
   * the industry hire set `industryWorkplace` but the mine's stale
   * `workplace` reference lived on, so both fields read truthy at once and
   * this one villager got processed by both `WorkforceSystem` and
   * `IndustrySystem` every tick. The mine's own `incomingWorkers` count,
   * bumped when it first dispatched this person, then never got decremented
   * — nobody was ever coming to fill it, but nothing knew that — so the
   * opening looked permanently filled and the mine sat unstaffed for good.
   * "Idle" should just mean "holds no job"; enforcing that here, once, is
   * simpler than trusting every future hire site to clean up a job it
   * didn't know its target used to have.
   */
  release(): void {
    this.role = VillagerRole.Idle;
    this.state = VillagerState.Waiting;
    this.workplace = null;
    this.industryWorkplace = null;
    this.task = null;
    this.resource = null;
    this.destination = null;
    this.leg = TransportLeg.ToPickup;
    this.cargo = null;
    this.convoy = Convoy.Porter;
    this.claim = 0;
    this.timer = 0;
    this.restAtHome();
  }
}
