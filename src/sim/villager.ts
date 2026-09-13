import type { TradeSource, Trader } from './economy';
import type { Vec2 } from './geometry';
import type { Industry } from './industry';
import type { ResourceNode } from './resourceNode';
import type { Route } from './roadNetwork';
import { DAYS_JOURNEY_METRES, HOURS_PER_DAY, METRES_PER_UNIT } from './scale';
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
/** How much one villager can carry per trip. */
export const CARRY_CAPACITY = 3;
/** Share of every birth that grows up able to work — the rest are dependents. */
export const WORKING_POPULATION_SHARE = 0.7;

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
  /**
   * Decided once, at birth, and permanent — roughly `WORKING_POPULATION_SHARE`
   * of everyone never becomes a worker at all. This is the prototype's stand-in
   * for an age structure: no children/elderly simulation, just a stable split
   * so population growth doesn't translate one-for-one into labour capacity.
   * Decided by whoever calls the constructor (see `World.addVillager`) against
   * the *actual* running ratio, not a coin flip — a coin flip can unluckily
   * leave a tiny starting population with no workers at all, which is a real
   * softlock risk this game deliberately avoids everywhere else.
   */
  readonly isDependent: boolean;

  role: VillagerRole = VillagerRole.Idle;
  state: VillagerState = VillagerState.Waiting;

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
  timer = 0;

  position: Vec2;
  heading = 0;
  /** Current walking speed, after the ground has had its say. */
  speed = WALK_SPEED;
  /** Stable scatter so idlers do not stack on the village centre. */
  readonly restOffset: Vec2;

  constructor(id: number, home: Trader, isDependent: boolean) {
    this.id = id;
    this.home = home;
    this.isDependent = isDependent;
    this.position = { ...home.position };

    const angle = (id * 2.39996) % (Math.PI * 2);
    const radius = home.radius + 16 + ((id * 7) % 18);
    this.restOffset = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.7 };
  }

  /**
   * Not currently committed to anything — idle and not mid-walk — regardless
   * of whether they're a worker at all. This is "safe to touch," not
   * "eligible for a job"; a dependent is just as free to be counted here as
   * anyone else not busy, which matters when population has to shrink (see
   * `World.reconcilePopulation`) — removal must not be able to only ever
   * take non-dependents, or a shrinking population drifts toward nothing
   * but dependents and the labour force quietly vanishes.
   */
  get isFree(): boolean {
    return this.role === VillagerRole.Idle && this.state !== VillagerState.Walking;
  }

  get isAvailable(): boolean {
    // Idle but already walking means migrating to a new home — spoken for,
    // even though `role` alone wouldn't show it. A dependent is free but
    // never available for a job — they don't work, though they still
    // migrate with everyone else (see `MigrationSystem`, which tracks idle
    // time off `role` directly rather than `isAvailable`).
    return this.isFree && !this.isDependent;
  }

  get isWalking(): boolean {
    return this.state === VillagerState.Walking;
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
    this.speed = WALK_SPEED / going;

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
    this.claim = 0;
    this.timer = 0;
    this.restAtHome();
  }
}
